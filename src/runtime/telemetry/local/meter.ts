import { createRuntimeId, type EventId, type ExecutionId } from "../../protocol/ids.ts";
import type { LocalTelemetryPort, LocalTelemetryResult } from "./port.ts";
import type { TelemetryCorrelationContext, TelemetryObservation } from "./types.ts";

type FetchInput = Parameters<typeof globalThis.fetch>[0];
type FetchInit = Parameters<typeof globalThis.fetch>[1];
type FetchBody = NonNullable<NonNullable<FetchInit>["body"]>;

export type MeteredFetch = (input: FetchInput, init?: FetchInit) => Promise<Response>;

export interface TelemetryObservationSink {
	observe(observation: TelemetryObservation): Promise<LocalTelemetryResult>;
	currentCorrelation?(): TelemetryCorrelationContext | undefined;
}

export interface MeterOptions {
	readonly port?: TelemetryObservationSink;
	readonly correlation?: TelemetryCorrelationContext;
	readonly channel: Extract<TelemetryObservation, { kind: "traffic" }>["channel"];
	readonly transportAttempt?: number;
	readonly now?: () => Date;
	readonly monotonicNow?: () => number;
	readonly createObservationId?: () => EventId;
	/** Provider fetch 根据实际 response Content-Type 区分普通 HTTP 与 SSE。 */
	readonly classifyProviderTransport?: boolean;
}

export interface MeteredFetchOptions extends MeterOptions {
	readonly maxAttempts?: number;
	readonly shouldRetry?: (input: { readonly error?: unknown; readonly response?: Response; readonly attempt: number }) => boolean;
	readonly retryDelayMs?: number | ((attempt: number) => number);
}

export interface MeteredWebSocketLike {
	send(data: string | ArrayBufferLike | ArrayBufferView | Blob): void;
	close(code?: number, reason?: string): void;
	addEventListener(type: string, listener: (event: unknown) => void): void;
	removeEventListener(type: string, listener: (event: unknown) => void): void;
	/** Meter wrapper 的 request-scoped listener 清理；原生 socket 可不实现。 */
	disposeTelemetry?(): void;
}

export interface MeteredWebSocketOptions extends MeterOptions {}

interface MeterClock {
	now: () => Date;
	monotonicNow: () => number;
	createObservationId: () => EventId;
}

interface BodyCounter {
	readonly bytes: () => number;
	readonly done: Promise<void>;
	readonly body: ReadableStream<Uint8Array>;
}

const DEFAULT_RETRY_DELAY_MS = 0;
const activeWebSocketTelemetry = new WeakMap<object, () => void>();

function clockFor(options: MeterOptions): MeterClock {
	return {
		now: options.now ?? (() => new Date()),
		monotonicNow: options.monotonicNow ?? (() => performance.now()),
		createObservationId: options.createObservationId ?? (() => createRuntimeId("event") as EventId),
	};
}

function validBytes(value: number): boolean {
	return Number.isSafeInteger(value) && value >= 0;
}

function payloadByteLength(value: unknown): number | undefined {
	if (typeof value === "string") return Buffer.byteLength(value, "utf8");
	if (value instanceof ArrayBuffer) return value.byteLength;
	if (ArrayBuffer.isView(value)) return value.byteLength;
	if (typeof Blob !== "undefined" && value instanceof Blob) return value.size;
	if (typeof URLSearchParams !== "undefined" && value instanceof URLSearchParams) return Buffer.byteLength(value.toString(), "utf8");
	return undefined;
}

function resolveCorrelation(options: MeterOptions): TelemetryCorrelationContext | undefined {
	return options.correlation ?? options.port?.currentCorrelation?.();
}

function quantity(value: number) {
	return validBytes(value)
		? { availability: "available" as const, unit: "bytes" as const, value, accuracy: "exact" as const, source: "runtime_meter" as const }
		: { availability: "unavailable" as const, unit: "bytes" as const, reason: "sample_failed" as const };
}

function observationBase(options: MeterOptions, clock: MeterClock, startedAt: number): Pick<TelemetryObservation, "format" | "observationId" | "observedAt" | "monotonicOffsetMs" | "correlation"> | undefined {
	const correlation = resolveCorrelation(options);
	if (correlation === undefined) return undefined;
	const offset = Math.max(0, Math.floor(clock.monotonicNow() - startedAt));
	return {
		format: "runledger.telemetry.observation",
		observationId: clock.createObservationId(),
		observedAt: clock.now().toISOString(),
		monotonicOffsetMs: offset,
		correlation,
	};
}

async function observeTraffic(
	options: MeterOptions,
	clock: MeterClock,
	startedAt: number,
	direction: "tx" | "rx",
	boundary: "request_body" | "response_body" | "message_payload",
	bytes: number,
	terminal: "completed" | "aborted" | "failed",
): Promise<void> {
	if (options.port === undefined) return;
	const base = observationBase(options, clock, startedAt);
	if (base === undefined) return;
	const observation: TelemetryObservation = {
		...base,
		kind: "traffic",
		channel: options.channel,
		direction,
		boundary,
		bytes: quantity(bytes),
		transportAttempt: options.transportAttempt ?? 1,
		terminal,
	};
	await options.port.observe(observation);
}

function optionsForResponse(options: MeterOptions, response: Response): MeterOptions {
	if (options.classifyProviderTransport !== true) return options;
	const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
	return { ...options, channel: contentType.includes("text/event-stream") ? "llm_sse" : "llm_http" };
}

function isReadableStream(value: unknown): value is ReadableStream<Uint8Array> {
	return typeof value === "object" && value !== null && typeof (value as { getReader?: unknown }).getReader === "function";
}

function wrapReadableStream(
	source: ReadableStream<Uint8Array>,
	onChunk: (chunk: Uint8Array) => void,
	onDone: (terminal: "completed" | "aborted" | "failed") => Promise<void> | void,
): BodyCounter {
	const reader = source.getReader();
	let count = 0;
	let settled = false;
	let resolveDone: () => void = () => undefined;
	const done = new Promise<void>((resolve) => { resolveDone = resolve; });
	const settle = async (terminal: "completed" | "aborted" | "failed"): Promise<void> => {
		if (settled) return;
		settled = true;
		try {
			await onDone(terminal);
		} finally {
			resolveDone();
		}
	};
	const body = new ReadableStream<Uint8Array>({
		async pull(controller) {
			try {
				const result = await reader.read();
				if (result.done) {
					await settle("completed");
					controller.close();
					return;
				}
				const chunk = result.value;
				count += chunk.byteLength;
				onChunk(chunk);
				controller.enqueue(chunk);
			} catch (error) {
				try {
					await settle("failed");
				} catch (telemetryError) {
					controller.error(telemetryError);
					return;
				}
				controller.error(error);
			}
		},
		async cancel(reason) {
			try {
				await reader.cancel(reason);
			} finally {
				await settle("aborted");
			}
		},
	});
	return { bytes: () => count, done, body };
}

function requestBody(input: FetchInput, init: FetchInit | undefined): FetchBody | null | undefined {
	if (init?.body !== undefined) return init.body;
	if (typeof Request !== "undefined" && input instanceof Request) return input.body;
	return null;
}

function withRequestMeter(body: FetchBody | null | undefined): {
	readonly body: FetchBody | null | undefined;
	readonly counter?: BodyCounter;
	readonly terminal?: () => "completed" | "aborted" | "failed" | undefined;
} {
	if (!isReadableStream(body)) return { body };
	let terminal: "completed" | "aborted" | "failed" | undefined;
	const counter = wrapReadableStream(body, () => undefined, (value) => { terminal = value; });
	return { body: counter.body, counter, terminal: () => terminal };
}

export async function meteredFetch(
	fetchImpl: MeteredFetch,
	input: FetchInput,
	init: FetchInit | undefined,
	options: MeterOptions,
): Promise<Response> {
	const clock = clockFor(options);
	const startedAt = clock.monotonicNow();
	const body = requestBody(input, init);
	const knownRequestBytes = body === null || body === undefined ? 0 : payloadByteLength(body);
	const request = withRequestMeter(body);
	const requestInit = request.counter === undefined ? init : { ...init, body: request.body, duplex: "half" as const };
	let response: Response;
	try {
		response = await fetchImpl(input, requestInit);
	} catch (error) {
		const sentBytes = request.counter?.bytes() ?? knownRequestBytes ?? 0;
		await observeTraffic(options, clock, startedAt, "tx", "request_body", sentBytes, "failed");
		throw error;
	}
	const responseOptions = optionsForResponse(options, response);
	if (request.counter !== undefined) {
		await request.counter.done;
		await observeTraffic(responseOptions, clock, startedAt, "tx", "request_body", request.counter.bytes(), request.terminal?.() ?? "completed");
	} else {
		await observeTraffic(responseOptions, clock, startedAt, "tx", "request_body", knownRequestBytes ?? 0, "completed");
	}
	if (response.body === null) {
		await observeTraffic(responseOptions, clock, startedAt, "rx", "response_body", 0, "completed");
		return response;
	}
	let responseCounter: BodyCounter | undefined;
	responseCounter = wrapReadableStream(response.body, () => undefined, (terminal) => {
		return observeTraffic(responseOptions, clock, startedAt, "rx", "response_body", responseCounter?.bytes() ?? 0, terminal);
	});
	return new Response(responseCounter.body, {
		status: response.status,
		statusText: response.statusText,
		headers: response.headers,
	});
}

export async function meteredFetchWithRetry(
	fetchImpl: MeteredFetch,
	input: FetchInput,
	init: FetchInit | undefined,
	options: MeteredFetchOptions,
): Promise<Response> {
	const maxAttempts = options.maxAttempts ?? 1;
	if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) throw new Error("maxAttempts must be a positive safe integer");
	let lastError: unknown;
	for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
		try {
			const response = await meteredFetch(fetchImpl, input, init, { ...options, transportAttempt: attempt });
			if (attempt < maxAttempts && options.shouldRetry?.({ response, attempt }) === true) {
				await response.body?.cancel();
				await retryDelay(options.retryDelayMs, attempt);
				continue;
			}
			return response;
		} catch (error) {
			lastError = error;
			if (attempt >= maxAttempts || options.shouldRetry?.({ error, attempt }) === false) throw error;
			await retryDelay(options.retryDelayMs, attempt);
		}
	}
	throw lastError instanceof Error ? lastError : new Error("metered fetch retry failed");
}

async function retryDelay(value: MeteredFetchOptions["retryDelayMs"], attempt: number): Promise<void> {
	const requested = typeof value === "function" ? value(attempt) : value ?? DEFAULT_RETRY_DELAY_MS;
	if (!Number.isFinite(requested) || requested < 0) throw new Error("retryDelayMs must be non-negative");
	if (requested === 0) return;
	await new Promise<void>((resolve) => setTimeout(resolve, Math.floor(requested)));
}

export function createMeteredWebSocket(socket: MeteredWebSocketLike, options: MeteredWebSocketOptions): MeteredWebSocketLike {
	activeWebSocketTelemetry.get(socket)?.();
	const clock = clockFor(options);
	const startedAt = clock.monotonicNow();
	const onMessage = (event: unknown): void => {
		const data = typeof event === "object" && event !== null && "data" in event ? (event as { data?: unknown }).data : undefined;
		const bytes = payloadByteLength(data) ?? 0;
		void observeTraffic(options, clock, startedAt, "rx", "message_payload", bytes, "completed").catch(() => {
			socket.close(1011, "telemetry_failure");
		});
	};
	socket.addEventListener("message", onMessage);
	let disposed = false;
	const disposeTelemetry = (): void => {
		if (disposed) return;
		disposed = true;
		socket.removeEventListener("message", onMessage);
		if (activeWebSocketTelemetry.get(socket) === disposeTelemetry) activeWebSocketTelemetry.delete(socket);
	};
	activeWebSocketTelemetry.set(socket, disposeTelemetry);
	return {
		send(data) {
		const bytes = payloadByteLength(data) ?? 0;
		try {
			socket.send(data);
			void observeTraffic(options, clock, startedAt, "tx", "message_payload", bytes, "completed");
		} catch (error) {
			void observeTraffic(options, clock, startedAt, "tx", "message_payload", bytes, "failed");
			throw error;
		}
		},
		close(code, reason) { disposeTelemetry(); socket.close(code, reason); },
		addEventListener(type, listener) { socket.addEventListener(type, listener); },
		removeEventListener(type, listener) { socket.removeEventListener(type, listener); },
		disposeTelemetry,
	};
}

export interface ProcessIoMeterInput {
	readonly stream: Extract<TelemetryObservation, { kind: "process_io" }>["stream"];
	readonly observedBytes: number;
	readonly retainedBytes: number;
	readonly executionId?: ExecutionId;
	readonly correlation?: TelemetryCorrelationContext;
	readonly port?: TelemetryObservationSink;
}

export async function recordProcessIo(
	port: Pick<LocalTelemetryPort, "observe" | "currentCorrelation"> | TelemetryObservationSink,
	input: Omit<ProcessIoMeterInput, "port">,
): Promise<LocalTelemetryResult> {
	const options: MeterOptions = {
		port,
		correlation: input.correlation,
		channel: "governed_http",
	};
	const correlation = resolveCorrelation(options);
	if (correlation === undefined) return { ok: false, code: "correlation_missing" };
	const clock = clockFor(options);
	const base = observationBase(options, clock, clock.monotonicNow());
	if (base === undefined) return { ok: false, code: "correlation_missing" };
	const withExecution = input.executionId === undefined ? correlation : { ...correlation, executionId: input.executionId };
	const observation: TelemetryObservation = {
		...base,
		correlation: withExecution,
		kind: "process_io",
		stream: input.stream,
		observedBytes: quantity(input.observedBytes),
		retainedBytes: quantity(input.retainedBytes),
	};
	try {
		return await port.observe(observation);
	} catch {
		return { ok: false, code: "observation_failed" };
	}
}

export function payloadBytes(value: unknown): number | undefined {
	return payloadByteLength(value);
}
