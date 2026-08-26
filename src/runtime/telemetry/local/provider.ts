import { AsyncLocalStorage } from "node:async_hooks";
import { createRuntimeId } from "../../protocol/ids.ts";
import type { NetworkRequest, NetworkResponse } from "../../execution-env.ts";
import {
	createMeteredWebSocket,
	meteredFetch,
	type MeteredFetch,
	type MeteredWebSocketLike,
	type TelemetryObservationSink,
	payloadBytes,
} from "./meter.ts";
import { assertDeclaredLocalTelemetryTransport, type LocalTelemetryTransport } from "./coverage.ts";
import type { LocalTelemetryPort } from "./port.ts";
import type { TelemetryCorrelationContext } from "./types.ts";

export interface LocalTelemetryContext {
	readonly port: Pick<LocalTelemetryPort, "observe" | "bind" | "currentCorrelation">;
	readonly correlation: TelemetryCorrelationContext;
	readonly providerChannel: Extract<LocalTelemetryTransport, "llm_http" | "llm_sse">;
	readonly kind: "provider" | "tool";
}

const localTelemetryContexts = new AsyncLocalStorage<LocalTelemetryContext>();
let networkObservationSequence = 0;

export function createLocalTelemetryContext(
	port: Pick<LocalTelemetryPort, "observe" | "bind" | "currentCorrelation">,
	correlation: TelemetryCorrelationContext,
	providerChannel: LocalTelemetryContext["providerChannel"] = "llm_http",
	kind: LocalTelemetryContext["kind"] = "provider",
): LocalTelemetryContext {
	return { port, correlation, providerChannel, kind };
}

/** 在 provider/tool lazy callback 的整个生命周期内保持 correlation。 */
export function runWithLocalTelemetry<T>(context: LocalTelemetryContext, operation: () => Promise<T>): Promise<T> {
	return context.port.currentCorrelation === undefined
		? localTelemetryContexts.run(context, operation)
		: context.port.bind(context.correlation, () => localTelemetryContexts.run(context, operation));
}

export function currentLocalTelemetryContext(): LocalTelemetryContext | undefined {
	return localTelemetryContexts.getStore();
}

/** 对 SDK 捕获的 fetch 实现做一次 application payload 计量。 */
export function meteredProviderFetch(
	fetchImpl: MeteredFetch,
	input: Parameters<typeof globalThis.fetch>[0],
	init?: Parameters<typeof globalThis.fetch>[1],
	channel?: LocalTelemetryContext["providerChannel"],
): Promise<Response> {
	const context = currentLocalTelemetryContext();
	if (context === undefined || context.kind !== "provider") return fetchImpl(input, init);
	return meteredFetch(fetchImpl, input, init, {
		port: context.port,
		correlation: context.correlation,
		channel: channel ?? context.providerChannel,
		classifyProviderTransport: channel === undefined,
	});
}

/** 包住 Codex WebSocket 的 send/message 边界，不读取 URL、header 或正文。 */
export function meterCurrentWebSocket(socket: MeteredWebSocketLike): MeteredWebSocketLike {
	const context = currentLocalTelemetryContext();
	return context === undefined
		? socket
		: createMeteredWebSocket(socket, {
			port: context.port,
			correlation: context.correlation,
			channel: "llm_websocket",
		});
}

/**
 * Network 是已授权且已物化 response body 的边界，因此可以精确计量实际
 * request/response body，而不预读 stream，也不把 request metadata 写入 observation。
 */
export async function withMeteredNetworkRequest(
	request: NetworkRequest,
	signal: AbortSignal | undefined,
	execute: (request: NetworkRequest, signal?: AbortSignal) => Promise<NetworkResponse>,
	port?: TelemetryObservationSink,
): Promise<NetworkResponse> {
	const context = currentLocalTelemetryContext();
	const activePort = port ?? context?.port;
	const correlation = context?.correlation ?? activePort?.currentCorrelation?.();
	if (activePort === undefined || correlation === undefined) return execute(request, signal);

	const channel = request.telemetryChannel ?? "governed_http";
	const requestBytes = payloadBytes(request.body) ?? 0;
	const startedAt = new Date();
	const monotonicStart = performance.now();
	const observe = async (
		direction: "tx" | "rx",
		boundary: "request_body" | "response_body",
		bytes: number,
		terminal: "completed" | "failed" | "aborted",
	): Promise<void> => {
		const observation = {
			format: "runledger.telemetry.observation" as const,
			observationId: createRuntimeId("event", `network-${networkObservationSequence += 1}`),
			observedAt: startedAt.toISOString(),
			monotonicOffsetMs: Math.max(0, Math.floor(performance.now() - monotonicStart)),
			correlation,
			kind: "traffic" as const,
			channel,
			direction,
			boundary,
			bytes: Number.isSafeInteger(bytes) && bytes >= 0
				? { availability: "available" as const, unit: "bytes" as const, value: bytes, accuracy: "exact" as const, source: "runtime_meter" as const }
				: { availability: "unavailable" as const, unit: "bytes" as const, reason: "sample_failed" as const },
			transportAttempt: 1,
			terminal,
		};
		await activePort.observe(observation);
	};

	try {
		const response = await execute(request, signal);
		await observe("tx", "request_body", requestBytes, "completed");
		await observe("rx", "response_body", response.body.byteLength, "completed");
		return response;
	} catch (error) {
		await observe("tx", "request_body", requestBytes, signal?.aborted === true ? "aborted" : "failed");
		throw error;
	}
}

export { assertDeclaredLocalTelemetryTransport } from "./coverage.ts";
