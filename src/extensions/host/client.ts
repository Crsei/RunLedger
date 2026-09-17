/**
 * owner 侧的 extension host 客户端：握手校验、注册表校验、事件请求/回执与
 * 动作帧应答。
 *
 * 客户端是 owner 唯一读取 host 输出的地方。它遵循 fail-closed：
 * 任何协议违规（非法 JSON、未知帧、版本/generation 不匹配、谎报 package
 * 绑定、注册表超限或重复名）都让该 host 进入 `failed`，并关闭进程；不存在
 * “忽略坏帧继续跑”的降级路径。
 */

import type { ExtensionHostFrame, ExtensionHostHelloFrame, ExtensionHostShutdownReason } from "../../contracts/extensions/host-protocol.ts";
import { EXTENSION_HOST_PROTOCOL_VERSION } from "../../contracts/extensions/host-protocol.ts";
import type { ExtensionHostLimits, ExtensionRegistrySnapshot } from "../../contracts/extensions/registry.ts";
import type { ExtensionIntent } from "../../contracts/extensions/intent.ts";
import { runtimeDigest } from "../../runtime/protocol/foundation.ts";
import { createExtensionHostFrameDecoder, encodeExtensionHostFrame } from "./protocol.ts";
import type { ExtensionHostBootstrap } from "./bootstrap.ts";
import { validateExtensionRegistry } from "./registration.ts";
import type { ExtensionActionResult } from "./runtime-api.ts";
import type { ExtensionHostChannel } from "./channel.ts";

export interface ExtensionHostActionRequest {
	readonly action: string;
	readonly payload: Readonly<Record<string, unknown>>;
	readonly intent?: ExtensionIntent;
}

export type ExtensionHostActionHandler = (request: ExtensionHostActionRequest) => Promise<ExtensionActionResult>;

export type ExtensionHostClientState =
	| { readonly status: "connecting" }
	| { readonly status: "ready"; readonly hello: ExtensionHostHelloFrame; readonly registry: ExtensionRegistrySnapshot; readonly registryDigest: string }
	| { readonly status: "failed"; readonly code: string; readonly message: string }
	| { readonly status: "stopped"; readonly reason: ExtensionHostShutdownReason };

export type ExtensionEventOutcome =
	| { readonly ok: true; readonly value: unknown }
	| { readonly ok: false; readonly code: string; readonly message: string };

export interface ExtensionHostClient {
	state(): ExtensionHostClientState;
	requestEvent(input: { readonly name: string; readonly cancelable: boolean; readonly payload: Readonly<Record<string, unknown>>; readonly deadlineMs: number }): Promise<ExtensionEventOutcome>;
	close(reason: ExtensionHostShutdownReason): Promise<void>;
}

export interface ExtensionHostClientOptions {
	readonly channel: ExtensionHostChannel;
	readonly bootstrap: ExtensionHostBootstrap;
	readonly onAction: ExtensionHostActionHandler;
	readonly onDiagnostic?: (diagnostic: { readonly code: string; readonly message: string }) => void;
	/** 握手（hello + registry）预算。 */
	readonly handshakeTimeoutMs?: number;
}

const DEFAULT_HANDSHAKE_TIMEOUT_MS = 5_000;
const READ_TIMEOUT_MS = 250;

interface PendingEvent {
	readonly resolve: (outcome: ExtensionEventOutcome) => void;
	readonly timer: NodeJS.Timeout;
}

/**
 * 启动读循环、完成握手并返回就绪客户端。任何一步失败都返回 `ok:false`
 * 且已释放进程；调用方据此把 generation 记为 failed（D2）。
 */
export async function connectExtensionHost(options: ExtensionHostClientOptions): Promise<{ readonly ok: true; readonly client: ExtensionHostClient } | { readonly ok: false; readonly code: string; readonly message: string }> {
	const handshakeTimeoutMs = options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
	const decoder = createExtensionHostFrameDecoder({ generation: options.bootstrap.generation });
	const pending = new Map<string, PendingEvent>();
	let eventSequence = 0;
	let state: ExtensionHostClientState = { status: "connecting" };
	// TS 的控制流分析看不到闭包里的赋值；所有读取都经访问器，避免把 state
	// 窄化成初始字面量类型。
	const readState = (): ExtensionHostClientState => state;
	let failure: { readonly code: string; readonly message: string } | undefined;
	let closed = false;
	let readyResolve: (() => void) | undefined;
	let readyReject: ((error: Error) => void) | undefined;
	let hello: ExtensionHostHelloFrame | undefined;
	const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });

	const report = (code: string, message: string): void => {
		options.onDiagnostic?.({ code, message });
	};

	const fail = (code: string, message: string): void => {
		if (failure !== undefined || closed) return;
		failure = { code, message };
		state = { status: "failed", code, message };
		report(code, message);
		readyReject?.(new Error(`${code}: ${message}`));
		void options.channel.close();
	};

	const send = async (frame: ExtensionHostFrame): Promise<boolean> => {
		const written = await options.channel.write(encodeExtensionHostFrame(frame));
		if (!written.ok) {
			fail("host_write_failed", `owner could not write to the host channel: ${written.code}`);
			return false;
		}
		return true;
	};

	const handleActionFrame = async (frame: Extract<ExtensionHostFrame, { kind: "action" }>): Promise<void> => {
		if (frame.action === "intent" && frame.intent === undefined) {
			await send({
				protocolVersion: EXTENSION_HOST_PROTOCOL_VERSION,
				generation: options.bootstrap.generation,
				frameId: `owner-${frame.requestId}`,
				kind: "result",
				requestId: frame.requestId,
				ok: false,
				error: { code: "intent_missing", message: "intent action requires an intent payload" },
			});
			return;
		}
		let result: ExtensionActionResult;
		try {
			result = await options.onAction({
				action: frame.action,
				payload: frame.payload,
				...(frame.intent === undefined ? {} : { intent: frame.intent }),
			});
		} catch (error) {
			result = { ok: false, code: "action_handler_failed", message: error instanceof Error ? error.message : "owner action handler failed" };
		}
		await send({
			protocolVersion: EXTENSION_HOST_PROTOCOL_VERSION,
			generation: options.bootstrap.generation,
			frameId: `owner-${frame.requestId}`,
			kind: "result",
			requestId: frame.requestId,
			ok: result.ok,
			...(result.ok ? { ...(result.value === undefined ? {} : { value: { ...result.value } }), valueDigest: runtimeDigest(result.value ?? null).digest } : {}),
			...(result.ok ? {} : { error: { code: result.code, message: result.message } }),
		});
	};

	const handleFrame = (frame: ExtensionHostFrame): void => {
		switch (frame.kind) {
			case "hello": {
				if (readState().status !== "connecting") {
					fail("protocol_violation", "host sent a second hello frame");
					return;
				}
				if (frame.packageId !== options.bootstrap.packageId || frame.digest !== options.bootstrap.digest) {
					fail("host_identity_mismatch", "host hello does not match the trusted package binding");
					return;
				}
				if (frame.apiVersion !== options.bootstrap.apiVersion) {
					fail("host_api_version_mismatch", `host api version ${frame.apiVersion} is not the expected ${options.bootstrap.apiVersion}`);
					return;
				}
				if (!sameLimits(frame.limits, options.bootstrap.limits)) {
					fail("host_limits_mismatch", "host declared different limits than the owner requested");
					return;
				}
				state = { status: "connecting" };
				hello = frame;
				return;
			}
			case "registry": {
				if (readState().status !== "connecting" || hello === undefined) {
					fail("protocol_violation", "host sent a registry frame before hello");
					return;
				}
				const validated = validateExtensionRegistry({
					generation: frame.generation,
					hostPid: frame.hostPid,
					packageId: frame.packageId,
					digest: frame.digest,
					tools: frame.tools,
					commands: frame.commands,
					flags: frame.flags,
					subscriptions: frame.subscriptions,
					limits: frame.limits,
				}, {
					packageId: options.bootstrap.packageId,
					digest: options.bootstrap.digest,
					hostPid: frame.hostPid,
					generation: options.bootstrap.generation,
					limits: options.bootstrap.limits,
				});
				if (!validated.ok) {
					fail(validated.error.code, validated.error.message);
					return;
				}
				state = { status: "ready", hello, registry: validated.snapshot, registryDigest: validated.identityDigest };
				readyResolve?.();
				return;
			}
			case "result": {
				const entry = pending.get(frame.requestId);
				if (entry === undefined) return;
				pending.delete(frame.requestId);
				clearTimeout(entry.timer);
				entry.resolve(frame.ok
					? { ok: true, value: frame.value?.result ?? null }
					: { ok: false, code: frame.error?.code ?? "host_result_failed", message: frame.error?.message ?? "host rejected the event" });
				return;
			}
			case "action": {
				void handleActionFrame(frame);
				return;
			}
			case "error": {
				if (frame.fatal) fail(frame.error.code, frame.error.message);
				else report(frame.error.code, frame.error.message);
				return;
			}
			case "shutdown": {
				if (readState().status === "ready") state = { status: "stopped", reason: frame.reason };
				readyResolve?.();
				return;
			}
		}
	};

	const pump = async (): Promise<void> => {
		try {
			while (!closed) {
				const read = await options.channel.read(READ_TIMEOUT_MS);
				if (!read.ok) {
					fail("host_read_failed", `owner could not read the host channel: ${read.code}`);
					return;
				}
				for (const line of read.lines) {
					const decoded = decoder.push(`${line}\n`);
					for (const error of decoded.errors) fail(`protocol_${error.code}`, error.message);
					for (const frame of decoded.frames) handleFrame(frame);
					if (failure !== undefined) return;
				}
				if (read.closed) {
					if (readState().status === "connecting") {
						fail("host_exited_before_handshake", "host exited before completing the handshake");
						return;
					}
					if (readState().status === "ready") {
						state = { status: "stopped", reason: "host-exit" };
						report("host_exited", `host process exited with code ${read.exitCode ?? "unknown"} (${read.state})`);
					}
					return;
				}
			}
		} catch (error) {
			fail("host_channel_failed", error instanceof Error ? error.message : "host channel failed");
		}
	};

	const pumpPromise = pump();
	const handshakeTimer = setTimeout(() => { readyReject?.(new Error("extension host handshake timed out")); }, handshakeTimeoutMs);
	try {
		await ready;
	} catch (error) {
		closed = true;
		await options.channel.close();
		await pumpPromise.catch(() => undefined);
		return failure !== undefined
			? { ok: false, code: failure.code, message: failure.message }
			: { ok: false, code: "handshake_failed", message: error instanceof Error ? error.message : "extension host handshake failed" };
	} finally {
		clearTimeout(handshakeTimer);
	}
	if (readState().status !== "ready") {
		closed = true;
		await options.channel.close();
		await pumpPromise.catch(() => undefined);
		return failure !== undefined
			? { ok: false, code: failure.code, message: failure.message }
			: { ok: false, code: "handshake_failed", message: "extension host did not become ready" };
	}

	const client: ExtensionHostClient = {
		state: () => readState(),
		requestEvent: async (input) => {
			if (readState().status !== "ready") return { ok: false, code: "host_not_ready", message: "extension host is not accepting events" };
			if (closed) return { ok: false, code: "host_closed", message: "extension host channel is closed" };
			eventSequence += 1;
			const requestId = `event-${eventSequence}`;
			const outcome = new Promise<ExtensionEventOutcome>((resolve) => {
				const timer = setTimeout(() => {
					pending.delete(requestId);
					resolve({ ok: false, code: "host_event_timeout", message: `host did not answer ${input.name} within ${input.deadlineMs}ms` });
				}, input.deadlineMs);
				timer.unref();
				pending.set(requestId, { resolve, timer });
			});
			const delivered = await send({
				protocolVersion: EXTENSION_HOST_PROTOCOL_VERSION,
				generation: options.bootstrap.generation,
				frameId: `owner-${requestId}`,
				kind: "event",
				requestId,
				name: input.name,
				cancelable: input.cancelable,
				payload: { ...input.payload },
				deadlineMs: input.deadlineMs,
			});
			if (!delivered) return { ok: false, code: "host_write_failed", message: "owner could not deliver the event frame" };
			return outcome;
		},
		close: async (reason) => {
			if (closed) return;
			closed = true;
			if (readState().status === "ready" || readState().status === "connecting") {
				await send({
					protocolVersion: EXTENSION_HOST_PROTOCOL_VERSION,
					generation: options.bootstrap.generation,
					frameId: "owner-shutdown",
					kind: "shutdown",
					reason,
					deadlineMs: options.bootstrap.limits.shutdownTimeoutMs,
				}).catch(() => undefined);
			}
			await options.channel.close();
			await pumpPromise.catch(() => undefined);
			for (const entry of pending.values()) {
				clearTimeout(entry.timer);
				entry.resolve({ ok: false, code: "host_closed", message: "extension host closed before the event completed" });
			}
			pending.clear();
		},
	};
	return { ok: true, client };
}

function sameLimits(left: ExtensionHostLimits, right: ExtensionHostLimits): boolean {
	return left.maxRegistrationsPerKind === right.maxRegistrationsPerKind
		&& left.maxEventPayloadBytes === right.maxEventPayloadBytes
		&& left.handlerTimeoutMs === right.handlerTimeoutMs
		&& left.shutdownTimeoutMs === right.shutdownTimeoutMs
		&& left.eventBudgetMs === right.eventBudgetMs
		&& left.maxInFlightEvents === right.maxInFlightEvents
		&& left.maxRegistryBytes === right.maxRegistryBytes;
}
