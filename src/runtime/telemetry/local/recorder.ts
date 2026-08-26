import { AsyncLocalStorage } from "node:async_hooks";
import { canonicalJson } from "../../protocol/canonical-json.ts";
import type { TraceId } from "../../protocol/ids.ts";
import { isRuntimeId, type SessionId } from "../../protocol/ids.ts";
import { RuntimeMemorySampler } from "./memory.ts";
import type { RecordingFailurePolicy, RecordingMode } from "../../../storage/settings-manager.ts";
import type { JsonlTraceEventStore } from "../../trace/event-store.ts";
import type { TraceEventInput } from "../../trace/types.ts";
import { isTelemetryObservation } from "./schemas.ts";
import type { LocalTelemetryPort, LocalTelemetryResult } from "./port.ts";
import type { TelemetryCorrelationContext, TelemetryObservation } from "./types.ts";

export interface LocalTelemetryRecorderOptions {
	readonly eventStore: Pick<JsonlTraceEventStore, "append" | "events">;
	readonly traceId: TraceId;
	readonly sessionId?: SessionId;
	readonly ownerGeneration?: number;
	readonly mode: RecordingMode;
	readonly failurePolicy: RecordingFailurePolicy;
	readonly parentNodeId?: string;
	readonly onDiagnostic?: (diagnostic: LocalTelemetryDiagnostic) => void;
}

export interface LocalTelemetryDiagnostic {
	readonly code: "event_store_write_failed";
	readonly message: string;
}

export class LocalTelemetryRecordingError extends Error {
	public readonly code = "event_store_write_failed" as const;

	public constructor(cause: unknown) {
		super("local telemetry recording failed: event_store_write_failed", { cause });
		this.name = "LocalTelemetryRecordingError";
	}
}

export class LocalTelemetryRecorder implements LocalTelemetryPort {
	readonly #eventStore: Pick<JsonlTraceEventStore, "append" | "events">;
	readonly #traceId: TraceId;
	readonly #failurePolicy: RecordingFailurePolicy;
	readonly #parentNodeId: string;
	readonly #onDiagnostic: ((diagnostic: LocalTelemetryDiagnostic) => void) | undefined;
	readonly #correlations = new AsyncLocalStorage<TelemetryCorrelationContext>();
	readonly #reportedDiagnostics = new Set<string>();
	readonly #memorySampler: RuntimeMemorySampler | undefined;
	#eventStoreDisabled = false;
	#closed = false;

	public constructor(options: Omit<LocalTelemetryRecorderOptions, "mode"> & { readonly mode: Exclude<RecordingMode, "off"> }) {
		this.#eventStore = options.eventStore;
		this.#traceId = options.traceId;
		this.#failurePolicy = options.failurePolicy;
		this.#parentNodeId = options.parentNodeId ?? options.traceId;
		this.#onDiagnostic = options.onDiagnostic;
		const sessionId = options.sessionId;
		if (sessionId !== undefined && isRuntimeId(sessionId, "session")) {
			this.#memorySampler = new RuntimeMemorySampler({
				correlation: {
					sessionId,
					traceId: options.traceId,
					ownerGeneration: options.ownerGeneration ?? 0,
				},
					observe: (observation) => this.observe(observation),
				});
			}
	}

	public async observe(observation: TelemetryObservation): Promise<LocalTelemetryResult> {
		if (this.#closed) return { ok: false, code: "closed" };
		if (!isTelemetryObservation(observation)) return { ok: false, code: "invalid_observation" };
		if (observation.correlation.traceId !== this.#traceId) return { ok: false, code: "trace_id_mismatch" };
		if (this.#eventStoreDisabled) return { ok: false, code: "event_store_unavailable" };

		const eventId = `event:telemetry:${observation.observationId}`;
		try {
			const existing = await this.#eventStore.events();
			const prior = existing.find((event) => event.eventId === eventId);
			if (prior !== undefined) {
				if (prior.observation === undefined || canonicalJson(prior.observation) !== canonicalJson(observation)) return { ok: false, code: "observation_conflict" };
				return { ok: true };
			}
			const input: TraceEventInput = {
				eventId,
				traceId: this.#traceId,
				nodeId: `observation:${this.#traceId}:${observation.observationId}`,
				parentNodeId: this.#parentNodeId,
				kind: "observation",
				name: `observation:${observation.kind}`,
				phase: "finished",
				timestamp: observation.observedAt,
				observation,
			};
			await this.#eventStore.append(input);
			return { ok: true };
		} catch (error) {
			return this.#handleWriteFailure(error);
		}
	}

	public bind<T>(correlation: TelemetryCorrelationContext, operation: () => Promise<T>): Promise<T> {
		return this.#correlations.run(correlation, operation);
	}

	public currentCorrelation(): TelemetryCorrelationContext | undefined {
		return this.#correlations.getStore();
	}

	/** M0 只冻结边界；实际 runtime/process sampler 在 M2 接入。 */
	public async forceSample(reason: "run" | "turn" | "process" | "checkpoint" | "progress"): Promise<void> {
		if (this.#closed) return;
		await this.#memorySampler?.forceSample(reason);
	}

	public async close(): Promise<void> {
		await this.#memorySampler?.close();
		this.#closed = true;
	}

	#handleWriteFailure(error: unknown): LocalTelemetryResult {
		if (this.#failurePolicy === "fail_closed") throw new LocalTelemetryRecordingError(error);
		this.#eventStoreDisabled = true;
		if (!this.#reportedDiagnostics.has("event_store_write_failed")) {
			this.#reportedDiagnostics.add("event_store_write_failed");
			this.#onDiagnostic?.({ code: "event_store_write_failed", message: "local telemetry recording degraded: event_store_write_failed" });
		}
		return { ok: false, code: "event_store_write_failed" };
	}
}

export function createLocalTelemetryPort(options: LocalTelemetryRecorderOptions): LocalTelemetryPort | undefined {
	if (options.mode === "off") return undefined;
	return new LocalTelemetryRecorder(options as Omit<LocalTelemetryRecorderOptions, "mode"> & { readonly mode: Exclude<RecordingMode, "off"> });
}
