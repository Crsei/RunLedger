/** 本地 stdio JSONL host：串行 dispatch、stdout 背压与 bounded shutdown。 */

import type { Readable, Writable } from "node:stream";
import { canonicalJson } from "../runtime/protocol/v3/canonical-json.ts";
import { JsonlControlPlaneAdapter } from "../runtime/control-plane/jsonl-transport.ts";
import { ControlPlaneError } from "../runtime/control-plane/errors.ts";
import type { ShutdownCoordinator, ShutdownReport } from "../runtime/control-plane/shutdown.ts";
import type { PeerConnectionEvidence } from "../runtime/control-plane/local-peer.ts";
import { errorResponse, type StableEventDelivery } from "../runtime/control-plane/types.ts";
import {
	createRuntimeTerminalErrorTrigger,
	isRuntimeShutdownTrigger,
	type RuntimeShutdownTrigger,
} from "../runtime/lifecycle/shutdown.ts";
import type { HeadlessDaemonServer } from "./server.ts";
import type { BoundedEventSubscription } from "../runtime/control-plane/subscriptions.ts";

export type StdioHostExitReason =
	| "stdin_eof"
	| "sigint"
	| "sigterm"
	| "shutdown_command"
	| "framing_error"
	| "terminal_error"
	| "input_error"
	| "output_error"
	| "uncaught_exception"
	| "unhandled_rejection"
	| "daemon_upgrade"
	| "transport_error";

export interface StdioHostOptions {
	server: HeadlessDaemonServer;
	shutdown: ShutdownCoordinator;
	input: Readable;
	output: Writable;
	connectionId?: string;
	/** inherited stdio 必须由进程 host 显式绑定到 parent peer。 */
	evidence: PeerConnectionEvidence;
	maxFrameBytes?: number;
	shutdownTimeoutMs?: number;
	signal?: AbortSignal;
}

export interface StdioHostResult {
	reason: StdioHostExitReason;
	responsesWritten: number;
	shutdown: ShutdownReport;
	trigger?: RuntimeShutdownTrigger;
}

export interface StdioEventDeliveryFrame extends StableEventDelivery {
	kind: "event_delivery";
}

interface ActiveDeliveryPump {
	subscription: BoundedEventSubscription;
	promise: Promise<void>;
}

export function createStdioParentPeerEvidence(): PeerConnectionEvidence {
	return {
		transport: "jsonl",
		pid: process.ppid,
		...(typeof process.getuid === "function" ? { uid: process.getuid() } : {}),
		peerCredentialsVerified: true,
	};
}

type DrainResult = "drained" | "aborted" | "closed";

function triggerFromAbort(signal: AbortSignal | undefined): RuntimeShutdownTrigger {
	if (isRuntimeShutdownTrigger(signal?.reason)) return signal.reason;
	if (signal?.reason === "SIGINT" || signal?.reason === "SIGTERM") {
		return { kind: "signal", signal: signal.reason };
	}
	return createRuntimeTerminalErrorTrigger(signal?.reason, "terminal");
}

function exitReasonForTrigger(trigger: RuntimeShutdownTrigger): StdioHostExitReason {
	switch (trigger.kind) {
		case "signal":
			return trigger.signal === "SIGINT" ? "sigint" : trigger.signal === "SIGTERM" ? "sigterm" : "daemon_upgrade";
		case "stdin_eof":
			return "stdin_eof";
		case "terminal_error":
			return trigger.source === "input" ? "input_error" : trigger.source === "output" ? "output_error" : "terminal_error";
		case "uncaught_exception":
			return "uncaught_exception";
		case "unhandled_rejection":
			return "unhandled_rejection";
		case "daemon_upgrade":
			return "daemon_upgrade";
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasTerminalFramingError(lines: readonly string[]): boolean {
	for (const line of lines) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(line) as unknown;
		} catch {
			// adapter 只生成 canonical JSON；若此处失败，按 transport 终止处理。
			return true;
		}
		if (!isRecord(parsed) || parsed.kind !== "error" || !isRecord(parsed.error)) continue;
		if (parsed.error.code === "malformed_frame" || parsed.error.code === "frame_too_large") return true;
	}
	return false;
}

function waitForDrain(output: Writable, signal: AbortSignal | undefined): Promise<DrainResult> {
	if (signal?.aborted) return Promise.resolve("aborted");
	if (output.destroyed || output.writableEnded) return Promise.resolve("closed");
	return new Promise((resolve) => {
		const finish = (result: DrainResult): void => {
			output.off("drain", onDrain);
			output.off("error", onClosed);
			output.off("close", onClosed);
			signal?.removeEventListener("abort", onAbort);
			resolve(result);
		};
		const onDrain = (): void => finish("drained");
		const onClosed = (): void => finish("closed");
		const onAbort = (): void => finish("aborted");
		output.once("drain", onDrain);
		output.once("error", onClosed);
		output.once("close", onClosed);
		signal?.addEventListener("abort", onAbort, { once: true });
		// 关闭/abort 可能发生在初始检查与 listener 注册之间。
		if (signal?.aborted) onAbort();
		else if (output.destroyed || output.writableEnded) onClosed();
		else if (output.writableNeedDrain === false) onDrain();
	});
}

async function writeResponses(
	output: Writable,
	responses: readonly string[],
	signal: AbortSignal | undefined,
): Promise<{ ok: boolean; written: number }> {
	let written = 0;
	for (const response of responses) {
		if (output.destroyed || output.writableEnded || signal?.aborted) return { ok: false, written };
		let accepted: boolean;
		try {
			accepted = output.write(response, "utf8");
		} catch {
			return { ok: false, written };
		}
		written += 1;
		if (!accepted && await waitForDrain(output, signal) !== "drained") return { ok: false, written };
	}
	return { ok: true, written };
}

/**
 * 一个 stdio 连接对应一个 handshake scope。输入按到达顺序串行执行；输出只有 JSONL
 * protocol frame，生命周期诊断必须写 stderr，由调用方负责。
 */
export async function runStdioControlPlaneHost(options: StdioHostOptions): Promise<StdioHostResult> {
	const connectionId = options.connectionId ?? `stdio-${process.pid}`;
	const evidence = options.evidence;
	const dispatcher = options.server.createDispatcher(connectionId, evidence);
	const adapter = new JsonlControlPlaneAdapter(dispatcher, options.maxFrameBytes);
	const timeoutMs = Math.max(1, Math.min(300_000, Math.trunc(options.shutdownTimeoutMs ?? 30_000)));
	let reason: StdioHostExitReason = "stdin_eof";
	let responsesWritten = 0;
	let trigger: RuntimeShutdownTrigger | undefined;
	let shutdownPromise: Promise<ShutdownReport> | undefined;
	let outputSerial: Promise<void> = Promise.resolve();
	const deliveryPumps = new Map<string, ActiveDeliveryPump>();
	const beginShutdown = (candidate: RuntimeShutdownTrigger): Promise<ShutdownReport> => {
		trigger ??= candidate;
		// begin() 在返回 Promise 前同步关闭 mutation gate；所有 host source 只走这一入口。
		shutdownPromise ??= options.shutdown.begin(timeoutMs);
		return shutdownPromise;
	};
	const abortInput = (): void => {
		if (!options.input.destroyed) options.input.destroy();
	};
	const onAbort = (): void => {
		const candidate = triggerFromAbort(options.signal);
		beginShutdown(candidate);
		reason = exitReasonForTrigger(candidate);
		abortInput();
	};
	const onInputError = (error: Error): void => {
		const candidate = createRuntimeTerminalErrorTrigger(error, "input");
		beginShutdown(candidate);
		reason = exitReasonForTrigger(candidate);
		abortInput();
	};
	const onOutputError = (error: Error): void => {
		const candidate = createRuntimeTerminalErrorTrigger(error, "output");
		beginShutdown(candidate);
		reason = exitReasonForTrigger(candidate);
		abortInput();
	};
	const enqueueResponses = (responses: readonly string[]): Promise<{ ok: boolean; written: number }> => {
		const pending = outputSerial.then(() => writeResponses(options.output, responses, options.signal));
		outputSerial = pending.then(
			() => undefined,
			() => undefined,
		);
		return pending;
	};
	const startDeliveryPumps = (responses: readonly string[]): void => {
		for (const response of responses) {
			let parsed: unknown;
			try {
				parsed = JSON.parse(response) as unknown;
			} catch {
				continue;
			}
				if (!isRecord(parsed) || parsed.kind !== "subscription_result" ||
					typeof parsed.subscriptionId !== "string") continue;
				const subscription = options.server.subscription(connectionId, parsed.subscriptionId);
				if (!subscription) continue;
				const subscriptionId = parsed.subscriptionId;
				const previous = deliveryPumps.get(subscriptionId);
				if (previous?.subscription === subscription) continue;
				const active: ActiveDeliveryPump = { subscription, promise: Promise.resolve() };
				active.promise = (async () => {
					try {
					for await (const delivery of subscription) {
						const frame: StdioEventDeliveryFrame = { kind: "event_delivery", ...delivery };
						const written = await enqueueResponses([`${canonicalJson(frame)}\n`]);
						responsesWritten += written.written;
						if (!written.ok) {
							onOutputError(new Error("stdio event delivery write failed"));
							return;
						}
					}
				} catch (error) {
					const shape = error instanceof ControlPlaneError
						? {
								code: error.code,
								message: error.message,
								retryable: error.retryable,
								...(error.details ? { details: error.details } : {}),
							}
						: {
								code: "adapter_unavailable" as const,
								message: "event delivery pump failed",
								retryable: true,
								details: { errorName: error instanceof Error ? error.name : "UnknownError" },
							};
					const written = await enqueueResponses([`${canonicalJson(errorResponse(subscriptionId, shape))}\n`]);
					responsesWritten += written.written;
					if (!written.ok) onOutputError(new Error("stdio event delivery error write failed"));
				}
				})().finally(async () => {
					await options.server.releaseSubscription(connectionId, subscriptionId, subscription);
					if (deliveryPumps.get(subscriptionId) === active) deliveryPumps.delete(subscriptionId);
				});
				deliveryPumps.set(subscriptionId, active);
		}
	};
	options.signal?.addEventListener("abort", onAbort, { once: true });
	options.input.on("error", onInputError);
	options.output.on("error", onOutputError);

	try {
		if (options.signal?.aborted) {
			onAbort();
		} else {
			try {
				for await (const chunk of options.input) {
					if (options.signal?.aborted) {
						const candidate = triggerFromAbort(options.signal);
						beginShutdown(candidate);
						reason = exitReasonForTrigger(candidate);
						break;
					}
					const responses = await adapter.receive(typeof chunk === "string" ? chunk : new Uint8Array(chunk));
					const written = await enqueueResponses(responses);
					responsesWritten += written.written;
					if (!written.ok) {
						const candidate = options.signal?.aborted
							? triggerFromAbort(options.signal)
							: createRuntimeTerminalErrorTrigger(new Error("stdio output write failed"), "output");
						beginShutdown(candidate);
						reason = exitReasonForTrigger(candidate);
						break;
					}
					if (hasTerminalFramingError(responses)) {
						beginShutdown(createRuntimeTerminalErrorTrigger(new Error("terminal protocol framing error"), "input"));
						reason = "framing_error";
						break;
					}
					startDeliveryPumps(responses);
					if (options.shutdown.state() !== "open") {
						shutdownPromise ??= options.shutdown.begin(timeoutMs);
						reason = "shutdown_command";
						break;
					}
				}
			} catch (error) {
				const candidate = options.signal?.aborted
					? triggerFromAbort(options.signal)
					: trigger ?? createRuntimeTerminalErrorTrigger(error, "input");
				beginShutdown(candidate);
				reason = exitReasonForTrigger(candidate);
			}

			if (reason === "stdin_eof" && options.signal?.aborted) {
				const candidate = triggerFromAbort(options.signal);
				beginShutdown(candidate);
				reason = exitReasonForTrigger(candidate);
			}
			if (reason === "stdin_eof") {
				const shutdownAlreadyStarted = options.shutdown.state() !== "open";
				// EOF 是 terminal source；先关 mutation gate，再处理可能残留的非 mutation 尾帧。
				if (shutdownAlreadyStarted) shutdownPromise ??= options.shutdown.begin(timeoutMs);
				else beginShutdown({ kind: "stdin_eof" });
				const responses = await adapter.finish();
				const written = await enqueueResponses(responses);
				responsesWritten += written.written;
				if (!written.ok) {
					const candidate = options.signal?.aborted
						? triggerFromAbort(options.signal)
						: createRuntimeTerminalErrorTrigger(new Error("stdio output write failed"), "output");
					reason = exitReasonForTrigger(candidate);
				}
				else if (hasTerminalFramingError(responses)) reason = "framing_error";
				else if (shutdownAlreadyStarted) reason = "shutdown_command";
				else startDeliveryPumps(responses);
			}
		}
	} finally {
		options.signal?.removeEventListener("abort", onAbort);
		options.input.off("error", onInputError);
		options.output.off("error", onOutputError);
			await options.server.closeConnection(connectionId);
			await Promise.allSettled([...deliveryPumps.values()].map((pump) => pump.promise));
		await outputSerial;
		if (reason !== "stdin_eof" && !options.input.destroyed) options.input.destroy();
	}

	const shutdown = await (shutdownPromise ?? beginShutdown(trigger ?? { kind: "stdin_eof" }));
	return { reason, responsesWritten, shutdown, ...(trigger ? { trigger } : {}) };
}
