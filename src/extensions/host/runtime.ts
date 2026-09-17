/**
 * Host 进程内的扩展运行时循环。
 *
 * 这个循环是 host 侧唯一的协议参与者：它求值工厂、把注册结果序列化回
 * owner、顺序派发事件（逐 handler 超时 + 错误隔离）并把动作请求转成
 * `action` 帧。它**不**安装 `uncaughtException` / `unhandledRejection`
 * 处理器：扩展触发的裸 timer 或 detached promise 抛错必须让 host 进程
 * 退出，由 owner 把该 generation 标记为 failed（D2）。这正是与 omp 相反的
 * 行为，并由 P1 测试固定。
 */

import type { ExtensionHostFrame } from "../../contracts/extensions/host-protocol.ts";
import { EXTENSION_HOST_PROTOCOL_VERSION } from "../../contracts/extensions/host-protocol.ts";
import { extensionDiagnostic, type ExtensionDiagnostic } from "../diagnostics.ts";
import type { ExtensionHostBootstrap } from "./bootstrap.ts";
import { encodeExtensionHostFrame } from "./protocol.ts";
import { createExtensionApi, type ExtensionApi, type ExtensionActionResult, type ExtensionActionRequest } from "./runtime-api.ts";

/** 与 omp 的 `ExtensionFactory` 同形态；可同步可异步。 */
export type ExtensionFactory = (api: ExtensionApi) => void | Promise<void>;

/**
 * host 侧双向通道。生产实现是 stdin/stdout JSONL；测试实现是内存管道。
 * 它是 host 与 owner 之间唯一的接口，因此两种实现都只能看到行。
 */
export interface ExtensionHostDuplex {
	send(line: string): void;
	/** 注册行回调；返回取消订阅函数。 */
	onLine(handler: (line: string) => void): () => void;
	/** owner 侧关闭输入（EOF）。owner 消失时 host 不得继续存活。 */
	onEnd(handler: () => void): () => void;
	close(): void;
}

export interface ExtensionHostRunResult {
	readonly exitCode: number;
	readonly diagnostics: readonly ExtensionDiagnostic[];
	readonly reason: "shutdown" | "fatal";
}

export interface RunExtensionHostOptions {
	readonly bootstrap: ExtensionHostBootstrap;
	readonly factory: ExtensionFactory;
	readonly duplex: ExtensionHostDuplex;
	readonly pid: number;
	readonly onDiagnostic?: (diagnostic: ExtensionDiagnostic) => void;
}

const MAX_HANDLER_RESULT_BYTES = 64 * 1024;

/**
 * 唯一并行派发的事件：shutdown 使用短预算，并发的 handler 之间没有顺序
 * 依赖（与 omp 的 `session_shutdown` 语义一致）。其余事件严格按注册顺序
 * 串行，handler 结果按注册顺序累积。
 */
export const EXTENSION_PARALLEL_EVENT_NAMES = Object.freeze(["SessionEnd"] as const);

/** 单个 handler 的运行记录；owner 侧据此做结果合成与审计。 */
export interface ExtensionHandlerRunRecord {
	readonly index: number;
	readonly outcome: "result" | "timeout" | "error";
	readonly durationMs: number;
	readonly result: unknown;
}

function byteLength(value: unknown): number {
	try {
		return Buffer.byteLength(JSON.stringify(value) ?? "null", "utf8");
	} catch {
		return Number.POSITIVE_INFINITY;
	}
}

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number, onTimeout: () => void): Promise<T | "timeout"> {
	let timer: NodeJS.Timeout | undefined;
	const timeout = new Promise<"timeout">((resolve) => {
		timer = setTimeout(() => { onTimeout(); resolve("timeout"); }, timeoutMs);
		timer.unref();
	});
	try {
		return await Promise.race([operation, timeout]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

/**
 * 运行一个 host generation。返回时协议已收尾：正常 shutdown 返回 0；
 * 工厂失败、协议违规或不可恢复的派发失败返回非 0，并已送出 fatal error 帧。
 */
export async function runExtensionHost(options: RunExtensionHostOptions): Promise<ExtensionHostRunResult> {
	const limits = options.bootstrap.limits;
	const diagnostics: ExtensionDiagnostic[] = [];
	const record = (diagnostic: ExtensionDiagnostic): void => {
		diagnostics.push(diagnostic);
		options.onDiagnostic?.(diagnostic);
	};
	let frameSequence = 0;
	const nextFrameId = (prefix: string): string => `${prefix}-${(frameSequence += 1)}`;
	const send = (frame: ExtensionHostFrame): void => {
		options.duplex.send(encodeExtensionHostFrame(frame, { maxFrameBytes: limits.maxRegistryBytes }));
	};
	const pendingActions = new Map<string, { resolve: (result: ExtensionActionResult) => void; timer: NodeJS.Timeout }>();
	let actionSequence = 0;
	let terminated: { readonly exitCode: number; readonly reason: "shutdown" | "fatal" } | undefined;
	let resolveTerminated: (() => void) | undefined;
	const terminatedPromise = new Promise<void>((resolve) => { resolveTerminated = resolve; });
	const terminate = (exitCode: number, reason: "shutdown" | "fatal"): void => {
		if (terminated !== undefined) return;
		terminated = { exitCode, reason };
		resolveTerminated?.();
	};

	const dispatchAction = async (request: ExtensionActionRequest): Promise<ExtensionActionResult> => {
		actionSequence += 1;
		const requestId = `action-${actionSequence}`;
		const deadlineMs = limits.handlerTimeoutMs;
		const result = new Promise<ExtensionActionResult>((resolve) => {
			const timer = setTimeout(() => {
				pendingActions.delete(requestId);
				resolve({ ok: false, code: "action_timeout", message: "owner did not answer the action within its budget" });
			}, deadlineMs);
			timer.unref();
			pendingActions.set(requestId, { resolve, timer });
		});
		send({
			protocolVersion: EXTENSION_HOST_PROTOCOL_VERSION,
			generation: options.bootstrap.generation,
			frameId: nextFrameId("frame"),
			kind: "action",
			requestId,
			action: request.action,
			payload: request.payload,
			deadlineMs,
			...(request.intent === undefined ? {} : { intent: request.intent }),
		});
		return result;
	};

	const runtime = createExtensionApi({
		limits,
		onNotInitialized: (action) => record(extensionDiagnostic({
			code: "extension.action_before_initialized",
			severity: "warning",
			message: `extension requested ${action} before the runtime was bound`,
			source: "extension-host",
		})),
	});

	try {
		await options.factory(runtime.api);
	} catch (error) {
		const message = error instanceof Error ? error.message : "extension factory failed";
		record(extensionDiagnostic({ code: "extension.factory_failed", severity: "error", message, source: "extension-host" }));
		send({
			protocolVersion: EXTENSION_HOST_PROTOCOL_VERSION,
			generation: options.bootstrap.generation,
			frameId: nextFrameId("frame"),
			kind: "error",
			error: { code: "extension_factory_failed", message },
			fatal: true,
		});
		options.duplex.close();
		return { exitCode: 1, diagnostics, reason: "fatal" };
	}

	runtime.initialize({ dispatch: dispatchAction });

	send({
		protocolVersion: EXTENSION_HOST_PROTOCOL_VERSION,
		generation: options.bootstrap.generation,
		frameId: nextFrameId("frame"),
		kind: "hello",
		hostPid: options.pid,
		packageId: options.bootstrap.packageId,
		digest: options.bootstrap.digest,
		apiVersion: options.bootstrap.apiVersion,
		limits,
	});

	const { tools, commands, flags, subscriptions } = runtime.api.registrations;
	send({
		protocolVersion: EXTENSION_HOST_PROTOCOL_VERSION,
		generation: options.bootstrap.generation,
		frameId: nextFrameId("frame"),
		kind: "registry",
		hostPid: options.pid,
		packageId: options.bootstrap.packageId,
		digest: options.bootstrap.digest,
		tools: [...tools],
		commands: [...commands],
		flags: [...flags],
		subscriptions: [...subscriptions],
		limits,
	});

	const runHandler = async (index: number, name: string, cancelable: boolean, payload: Readonly<Record<string, unknown>>, budgetMs: number): Promise<ExtensionHandlerRunRecord> => {
		const handlers = runtime.handlersFor(name);
		const handler = handlers[index];
		if (handler === undefined) return { index, outcome: "error", durationMs: 0, result: null };
		const startedAt = Date.now();
		const controller = new AbortController();
		const delivery = { name, cancelable, payload, signal: controller.signal };
		try {
			const raced = await withTimeout(Promise.resolve(handler(delivery)), budgetMs, () => controller.abort());
			const durationMs = Date.now() - startedAt;
			if (raced === "timeout") {
				record(extensionDiagnostic({
					code: "extension.handler_timeout",
					severity: "warning",
					message: `handler for ${name} exceeded ${budgetMs}ms`,
					source: "extension-host",
				}));
				return { index, outcome: "timeout", durationMs, result: null };
			}
			return { index, outcome: "result", durationMs, result: raced ?? null };
		} catch (error) {
			// 单个 handler 抛错只产生 diagnostic，不影响同事件其它 handler，
			// 也不让 host 退出（与扩展自身的裸异步错误不同）。
			record(extensionDiagnostic({
				code: "extension.handler_failed",
				severity: "warning",
				message: `handler for ${name} failed: ${error instanceof Error ? error.message : "unknown"}`,
				source: "extension-host",
			}));
			return { index, outcome: "error", durationMs: Date.now() - startedAt, result: null };
		}
	};

	const handleEventFrame = async (frame: Extract<ExtensionHostFrame, { kind: "event" }>): Promise<void> => {
		const respond = (value: Record<string, unknown> | undefined, error?: { readonly code: string; readonly message: string }): void => {
			send({
				protocolVersion: EXTENSION_HOST_PROTOCOL_VERSION,
				generation: options.bootstrap.generation,
				frameId: nextFrameId("frame"),
				kind: "result",
				requestId: frame.requestId,
				ok: error === undefined,
				...(error === undefined ? { value: value ?? {} } : { error }),
			});
		};

		// owner 侧已按投影裁剪；这里再校验一次字节上限，防止坏对端绕过投影层。
		if (byteLength(frame.payload) > limits.maxEventPayloadBytes) {
			respond(undefined, { code: "event_payload_oversize", message: `event payload exceeds ${limits.maxEventPayloadBytes} bytes` });
			return;
		}

		const handlers = runtime.handlersFor(frame.name);
		if (handlers.length === 0) {
			respond({ handlers: [] });
			return;
		}
		const parallel = (EXTENSION_PARALLEL_EVENT_NAMES as readonly string[]).includes(frame.name);
		const budgetMs = Math.max(1, Math.min(
			frame.deadlineMs,
			parallel ? limits.shutdownTimeoutMs : limits.handlerTimeoutMs,
		));
		const indexes = handlers.map((_handler, index) => index);
		const runs = parallel
			? await Promise.all(indexes.map((index) => runHandler(index, frame.name, frame.cancelable, frame.payload, budgetMs)))
			: await (async (): Promise<ExtensionHandlerRunRecord[]> => {
				const sequential: ExtensionHandlerRunRecord[] = [];
				for (const index of indexes) {
					sequential.push(await runHandler(index, frame.name, frame.cancelable, frame.payload, budgetMs));
				}
				return sequential;
			})();
		const value = { handlers: runs.map((run) => ({ index: run.index, outcome: run.outcome, durationMs: run.durationMs, result: run.result })) };
		if (byteLength(value) > MAX_HANDLER_RESULT_BYTES) {
			respond(undefined, { code: "handler_result_oversize", message: `handler result exceeds ${MAX_HANDLER_RESULT_BYTES} bytes` });
			return;
		}
		respond(value);
	};

	const onLine = (line: string): void => {
		const decoded = decodeHostInput(line, options.bootstrap.generation);
		if (!decoded.ok) {
			record(extensionDiagnostic({
				code: "extension.host_protocol_violation",
				severity: "error",
				message: decoded.message,
				source: "extension-host",
			}));
			send({
				protocolVersion: EXTENSION_HOST_PROTOCOL_VERSION,
				generation: options.bootstrap.generation,
				frameId: nextFrameId("frame"),
				kind: "error",
				error: { code: "protocol_violation", message: decoded.message },
				fatal: true,
			});
			terminate(1, "fatal");
			return;
		}
		const frame = decoded.frame;
		if (frame.kind === "shutdown") {
			terminate(0, "shutdown");
			return;
		}
		if (frame.kind === "result") {
			const pending = pendingActions.get(frame.requestId);
			if (pending === undefined) return;
			pendingActions.delete(frame.requestId);
			clearTimeout(pending.timer);
			pending.resolve(frame.ok
				? { ok: true, ...(frame.value === undefined ? {} : { value: frame.value }) }
				: { ok: false, code: frame.error?.code ?? "action_failed", message: frame.error?.message ?? "owner rejected the action" });
			return;
		}
		if (frame.kind === "event") {
			void handleEventFrame(frame);
			return;
		}
		// hello / registry / action 只应由 host 发出；owner 发来即协议违规。
		record(extensionDiagnostic({
			code: "extension.host_protocol_violation",
			severity: "error",
			message: `owner sent a host-only frame: ${frame.kind}`,
			source: "extension-host",
		}));
		send({
			protocolVersion: EXTENSION_HOST_PROTOCOL_VERSION,
			generation: options.bootstrap.generation,
			frameId: nextFrameId("frame"),
			kind: "error",
			error: { code: "protocol_violation", message: `owner sent a host-only frame: ${frame.kind}` },
			fatal: true,
		});
		terminate(1, "fatal");
	};

	const unsubscribe = options.duplex.onLine(onLine);
	// 输入 EOF 表示 owner 已经不在了：不把它当作优雅 shutdown，但也不再尝试
	// 回帧（没有对端），直接以非零码退出，避免 host 变成孤儿进程。
	const unsubscribeEnd = options.duplex.onEnd(() => { terminate(1, "fatal"); });
	try {
		await terminatedPromise;
	} finally {
		unsubscribe();
		unsubscribeEnd();
		for (const pending of pendingActions.values()) {
			clearTimeout(pending.timer);
			pending.resolve({ ok: false, code: "host_shutdown", message: "host shut down before the action completed" });
		}
		pendingActions.clear();
		options.duplex.close();
	}
	const settled = terminated ?? { exitCode: 0, reason: "shutdown" as const };
	return { exitCode: settled.exitCode, diagnostics, reason: settled.reason };
}

type HostInputDecode =
	| { readonly ok: true; readonly frame: Extract<ExtensionHostFrame, { kind: "event" | "result" | "error" | "shutdown" }> }
	| { readonly ok: false; readonly message: string };

function decodeHostInput(line: string, generation: number): HostInputDecode {
	let value: unknown;
	try {
		value = JSON.parse(line) as unknown;
	} catch {
		return { ok: false, message: "owner frame is not valid JSON" };
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) return { ok: false, message: "owner frame is not an object" };
	const record = value as Record<string, unknown>;
	if (record.protocolVersion !== EXTENSION_HOST_PROTOCOL_VERSION) return { ok: false, message: "owner frame protocolVersion mismatch" };
	if (record.generation !== generation) return { ok: false, message: "owner frame generation mismatch" };
	if (record.kind === "event" || record.kind === "result" || record.kind === "error" || record.kind === "shutdown") {
		return { ok: true, frame: value as Extract<ExtensionHostFrame, { kind: "event" | "result" | "error" | "shutdown" }> };
	}
	return { ok: false, message: `owner sent an unsupported frame kind: ${String(record.kind)}` };
}
