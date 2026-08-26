import { Type } from "typebox";
import { Value } from "typebox/value";
import { canonicalDigest } from "../../protocol/canonical-json.ts";
import { CanonicalUtcTimestampSchema, RuntimeIdSchema } from "../../protocol/foundation-schemas.ts";
import { isRuntimeId, type SessionId, type TraceId } from "../../protocol/ids.ts";
import type { TraceEvent } from "../../trace/types.ts";
import { isTelemetryObservation } from "./schemas.ts";
import type {
	ObservedQuantity,
	ObservationAccuracy,
	ObservationSource,
	ObservationUnavailableReason,
	ObservationUnit,
	TelemetryObservation,
} from "./types.ts";

export type TelemetryCoverageState = "measured" | "sampled" | "partial" | "unavailable" | "recording_off";

export type TelemetryCoverageReason = ObservationUnavailableReason | "trace_missing" | "trace_tampered";

export type TelemetrySourceState = "available" | "missing" | "tampered" | "recording_off" | "partial";

export interface TelemetryCoverageEntry {
	readonly key: string;
	readonly state: TelemetryCoverageState;
	readonly reason?: TelemetryCoverageReason;
}

export interface TelemetryMetric<TUnit extends ObservationUnit> {
	readonly sum: ObservedQuantity<TUnit>;
	readonly peak: ObservedQuantity<TUnit>;
	readonly sampleCount: number;
	readonly firstObservedAt: string | null;
	readonly lastObservedAt: string | null;
}

export interface TelemetryTrafficMetric {
	readonly tx: TelemetryMetric<"bytes">;
	readonly rx: TelemetryMetric<"bytes">;
}

export interface TelemetryProcessIoMetric {
	readonly observed: TelemetryMetric<"bytes">;
	readonly retained: TelemetryMetric<"bytes">;
}

export interface SessionTelemetryReport {
	readonly format: "runledger.telemetry.report";
	readonly sessionId: SessionId;
	readonly traceId: TraceId | null;
	readonly traceIds: readonly TraceId[];
	readonly generatedAt: string;
	readonly source: {
		readonly trace: {
			readonly state: TelemetrySourceState;
			readonly traceCount: number;
			readonly traceIds: readonly TraceId[];
		};
	};
	readonly summary: {
		readonly durationMs: number | null;
		readonly traceCount: number;
		readonly observationCount: number;
		readonly turnCount: number;
		readonly modelCallCount: number;
	};
	readonly coverage: readonly TelemetryCoverageEntry[];
	readonly traffic: {
		readonly llmHttp: TelemetryTrafficMetric;
		readonly llmSse: TelemetryTrafficMetric;
		readonly llmWebsocket: TelemetryTrafficMetric;
		readonly mcpHttp: TelemetryTrafficMetric;
		readonly governedHttp: TelemetryTrafficMetric;
		readonly gateway: TelemetryTrafficMetric;
		readonly processIo: {
			readonly stdin: TelemetryProcessIoMetric;
			readonly stdout: TelemetryProcessIoMetric;
			readonly stderr: TelemetryProcessIoMetric;
			readonly ptyOutput: TelemetryProcessIoMetric;
		};
	};
	readonly memory: {
		readonly runtimeRssBytes: TelemetryMetric<"bytes">;
		readonly runtimeHeapTotalBytes: TelemetryMetric<"bytes">;
		readonly runtimeHeapUsedBytes: TelemetryMetric<"bytes">;
		readonly runtimeExternalBytes: TelemetryMetric<"bytes">;
		readonly runtimeArrayBuffersBytes: TelemetryMetric<"bytes">;
		readonly logicalStateBytes: TelemetryMetric<"bytes">;
		readonly contextCurrentTokens: TelemetryMetric<"tokens">;
		readonly managedProcessRssBytes: TelemetryMetric<"bytes">;
		readonly managedProcessPssBytes: TelemetryMetric<"bytes">;
		readonly managedProcessUssBytes: TelemetryMetric<"bytes">;
		readonly managedProcessCount: TelemetryMetric<"count">;
	};
}

const NonNegativeSafeIntegerSchema = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const ObservationAccuracySchema = Type.Union([
	Type.Literal("exact"),
	Type.Literal("sampled"),
	Type.Literal("estimated"),
	Type.Literal("upper_bound"),
]);
const ObservationSourceSchema = Type.Union([
	Type.Literal("runtime_meter"),
	Type.Literal("provider_reported"),
	Type.Literal("canonical_serialization"),
	Type.Literal("linux_proc"),
	Type.Literal("derived"),
]);
const ObservationUnavailableReasonSchema = Type.Union([
	Type.Literal("recording_disabled"),
	Type.Literal("transport_not_instrumented"),
	Type.Literal("platform_unsupported"),
	Type.Literal("permission_denied"),
	Type.Literal("correlation_missing"),
	Type.Literal("provider_usage_missing"),
	Type.Literal("sample_failed"),
	Type.Literal("not_applicable"),
]);

function quantitySchema<TUnit extends ObservationUnit>(unit: TUnit) {
	return Type.Union([
		Type.Object(
			{
				availability: Type.Literal("available"),
				unit: Type.Literal(unit),
				value: NonNegativeSafeIntegerSchema,
				accuracy: ObservationAccuracySchema,
				source: ObservationSourceSchema,
			},
			{ additionalProperties: false },
		),
		Type.Object(
			{
				availability: Type.Literal("unavailable"),
				unit: Type.Literal(unit),
				reason: ObservationUnavailableReasonSchema,
			},
			{ additionalProperties: false },
		),
	]);
}

function metricSchema<TUnit extends ObservationUnit>(unit: TUnit) {
	return Type.Object(
		{
			sum: quantitySchema(unit),
			peak: quantitySchema(unit),
			sampleCount: NonNegativeSafeIntegerSchema,
			firstObservedAt: Type.Union([CanonicalUtcTimestampSchema, Type.Null()]),
			lastObservedAt: Type.Union([CanonicalUtcTimestampSchema, Type.Null()]),
		},
		{ additionalProperties: false },
	);
}

const trafficMetricSchema = Type.Object(
	{ tx: metricSchema("bytes"), rx: metricSchema("bytes") },
	{ additionalProperties: false },
);
const processIoMetricSchema = Type.Object(
	{ observed: metricSchema("bytes"), retained: metricSchema("bytes") },
	{ additionalProperties: false },
);

const coverageSchema = Type.Object(
	{
		key: Type.String({ minLength: 1, maxLength: 128 }),
		state: Type.Union([
			Type.Literal("measured"),
			Type.Literal("sampled"),
			Type.Literal("partial"),
			Type.Literal("unavailable"),
			Type.Literal("recording_off"),
		]),
		reason: Type.Optional(Type.Union([
			ObservationUnavailableReasonSchema,
			Type.Literal("trace_missing"),
			Type.Literal("trace_tampered"),
		])),
	},
	{ additionalProperties: false },
);

export const SessionTelemetryReportSchema = Type.Object(
	{
		format: Type.Literal("runledger.telemetry.report"),
		sessionId: RuntimeIdSchema,
		traceId: Type.Union([RuntimeIdSchema, Type.Null()]),
		traceIds: Type.Array(RuntimeIdSchema, { maxItems: 1024 }),
		generatedAt: CanonicalUtcTimestampSchema,
		source: Type.Object(
			{
				trace: Type.Object(
					{
						state: Type.Union([
							Type.Literal("available"),
							Type.Literal("missing"),
							Type.Literal("tampered"),
							Type.Literal("recording_off"),
							Type.Literal("partial"),
						]),
						traceCount: NonNegativeSafeIntegerSchema,
						traceIds: Type.Array(RuntimeIdSchema, { maxItems: 1024 }),
					},
					{ additionalProperties: false },
				),
			},
			{ additionalProperties: false },
		),
		summary: Type.Object(
			{
				durationMs: Type.Union([NonNegativeSafeIntegerSchema, Type.Null()]),
				traceCount: NonNegativeSafeIntegerSchema,
				observationCount: NonNegativeSafeIntegerSchema,
				turnCount: NonNegativeSafeIntegerSchema,
				modelCallCount: NonNegativeSafeIntegerSchema,
			},
			{ additionalProperties: false },
		),
		coverage: Type.Array(coverageSchema, { maxItems: 128 }),
		traffic: Type.Object(
			{
				llmHttp: trafficMetricSchema,
				llmSse: trafficMetricSchema,
				llmWebsocket: trafficMetricSchema,
				mcpHttp: trafficMetricSchema,
				governedHttp: trafficMetricSchema,
				gateway: trafficMetricSchema,
				processIo: Type.Object(
					{
						stdin: processIoMetricSchema,
						stdout: processIoMetricSchema,
						stderr: processIoMetricSchema,
						ptyOutput: processIoMetricSchema,
					},
					{ additionalProperties: false },
				),
			},
			{ additionalProperties: false },
		),
		memory: Type.Object(
			{
				runtimeRssBytes: metricSchema("bytes"),
				runtimeHeapTotalBytes: metricSchema("bytes"),
				runtimeHeapUsedBytes: metricSchema("bytes"),
				runtimeExternalBytes: metricSchema("bytes"),
				runtimeArrayBuffersBytes: metricSchema("bytes"),
				logicalStateBytes: metricSchema("bytes"),
				contextCurrentTokens: metricSchema("tokens"),
				managedProcessRssBytes: metricSchema("bytes"),
				managedProcessPssBytes: metricSchema("bytes"),
				managedProcessUssBytes: metricSchema("bytes"),
				managedProcessCount: metricSchema("count"),
			},
			{ additionalProperties: false },
		),
	},
	{ additionalProperties: false },
);

export function isSessionTelemetryReport(value: unknown): value is SessionTelemetryReport {
	if (!Value.Check(SessionTelemetryReportSchema, value)) return false;
	const report = value as SessionTelemetryReport;
	return isRuntimeId(report.sessionId, "session")
		&& (report.traceId === null || isRuntimeId(report.traceId, "trace"))
		&& report.traceIds.every((traceId) => isRuntimeId(traceId, "trace"));
}

export class TelemetryProjectionError extends Error {
	public readonly code: "trace_tampered" | "trace_sequence_invalid" | "trace_correlation_mismatch" | "invalid_observation";

	public constructor(code: TelemetryProjectionError["code"]) {
		super(`telemetry projection failed: ${code}`);
		this.name = "TelemetryProjectionError";
		this.code = code;
	}
}

export interface SessionTelemetryProjectorInput {
	readonly sessionId: SessionId;
	readonly traceId: TraceId;
	readonly events: readonly TraceEvent[];
	readonly generatedAt?: string;
}

export type SessionTelemetryProjectorResult =
	| { readonly ok: true; readonly report: SessionTelemetryReport }
	| { readonly ok: false; readonly code: TelemetryProjectionError["code"] };

interface MetricAccumulator<TUnit extends ObservationUnit = ObservationUnit> {
	readonly unit: TUnit;
	values: Array<Extract<ObservedQuantity<TUnit>, { readonly availability: "available" }>>;
	firstObservedAt: string | null;
	lastObservedAt: string | null;
	readonly defaultUnavailableReason: ObservationUnavailableReason;
	unavailableReason: ObservationUnavailableReason | undefined;
}

function accumulator<TUnit extends ObservationUnit>(unit: TUnit, unavailableReason: ObservationUnavailableReason): MetricAccumulator<TUnit> {
	return { unit, values: [], firstObservedAt: null, lastObservedAt: null, defaultUnavailableReason: unavailableReason, unavailableReason: undefined };
}

function addQuantity<TUnit extends ObservationUnit>(target: MetricAccumulator<TUnit>, quantity: ObservedQuantity<TUnit>, observedAt: string): void {
	if (quantity.availability === "unavailable") {
		target.unavailableReason ??= quantity.reason;
		return;
	}
	target.values.push(quantity);
	if (target.firstObservedAt === null || observedAt < target.firstObservedAt) target.firstObservedAt = observedAt;
	if (target.lastObservedAt === null || observedAt > target.lastObservedAt) target.lastObservedAt = observedAt;
}

function metric<TUnit extends ObservationUnit>(target: MetricAccumulator<TUnit>): TelemetryMetric<TUnit> {
	const values = target.values;
	if (values.length === 0) {
		const unavailable: ObservedQuantity<TUnit> = {
			availability: "unavailable",
			unit: target.unit as TUnit,
			reason: target.unavailableReason ?? target.defaultUnavailableReason,
		};
		return {
			sum: unavailable,
			peak: unavailable,
			sampleCount: 0,
			firstObservedAt: null,
			lastObservedAt: null,
		};
	}
	const source: ObservationSource = values.every((quantity) => quantity.source === values[0]!.source)
		? values[0]!.source
		: "derived";
	const accuracy = combinedAccuracy(values.map((quantity) => quantity.accuracy));
	const sum = values.reduce((total, quantity) => total + quantity.value, 0);
	const peak = Math.max(...values.map((quantity) => quantity.value));
	if (!Number.isSafeInteger(sum)) {
		const unavailable: ObservedQuantity<TUnit> = { availability: "unavailable", unit: target.unit as TUnit, reason: "sample_failed" };
		return { sum: unavailable, peak: unavailable, sampleCount: values.length, firstObservedAt: target.firstObservedAt, lastObservedAt: target.lastObservedAt };
	}
	const make = (value: number): ObservedQuantity<TUnit> => ({
		availability: "available",
		unit: target.unit as TUnit,
		value,
		accuracy,
		source,
	});
	return { sum: make(sum), peak: make(peak), sampleCount: values.length, firstObservedAt: target.firstObservedAt, lastObservedAt: target.lastObservedAt };
}

function combinedAccuracy(values: readonly ObservationAccuracy[]): ObservationAccuracy {
	if (values.every((value) => value === "exact")) return "exact";
	if (values.includes("upper_bound")) return "upper_bound";
	if (values.includes("estimated")) return "estimated";
	return "sampled";
}

function makeCoverage(key: string, state: TelemetryCoverageState, reason?: TelemetryCoverageReason): TelemetryCoverageEntry {
	return reason === undefined ? { key, state } : { key, state, reason };
}

function verifyTrace(events: readonly TraceEvent[], traceId: TraceId): SessionTelemetryProjectorResult | undefined {
	let previousHash: string | null = null;
	for (const [index, event] of events.entries()) {
		if (event.traceId !== traceId || event.sequence !== index + 1 || event.previousEventHash !== previousHash) {
			return { ok: false, code: "trace_sequence_invalid" };
		}
		const body: Record<string, unknown> = { ...event };
		delete body.eventHash;
		if (canonicalDigest(body) !== event.eventHash) return { ok: false, code: "trace_tampered" };
		if (event.kind === "observation" && !isTelemetryObservation(event.observation)) return { ok: false, code: "invalid_observation" };
		if (event.kind !== "observation" && event.observation !== undefined) return { ok: false, code: "invalid_observation" };
		previousHash = event.eventHash;
	}
	return undefined;
}

function emptyMetric<TUnit extends ObservationUnit>(unit: TUnit, reason: ObservationUnavailableReason): TelemetryMetric<TUnit> {
	const unavailable: ObservedQuantity<TUnit> = { availability: "unavailable", unit, reason };
	return { sum: unavailable, peak: unavailable, sampleCount: 0, firstObservedAt: null, lastObservedAt: null };
}

function summaryForEvents(events: readonly TraceEvent[]): SessionTelemetryReport["summary"] {
	const timestamps = events.map((event) => Date.parse(event.timestamp)).filter((value) => Number.isFinite(value));
	const durationMs = timestamps.length < 2 ? null : Math.max(0, Math.max(...timestamps) - Math.min(...timestamps));
	return {
		durationMs,
		traceCount: 1,
		observationCount: events.filter((event) => event.kind === "observation").length,
		turnCount: new Set(events.filter((event) => event.kind === "turn").map((event) => event.nodeId)).size,
		modelCallCount: new Set(events.filter((event) => event.kind === "model").map((event) => event.nodeId)).size,
	};
}

function mergeQuantity<TUnit extends ObservationUnit>(
	left: ObservedQuantity<TUnit>,
	right: ObservedQuantity<TUnit>,
	mode: "sum" | "peak",
): ObservedQuantity<TUnit> {
	if (left.availability === "unavailable") return right;
	if (right.availability === "unavailable") return left;
	const value = mode === "sum" ? left.value + right.value : Math.max(left.value, right.value);
	if (!Number.isSafeInteger(value)) return { availability: "unavailable", unit: left.unit, reason: "sample_failed" };
	return {
		availability: "available",
		unit: left.unit,
		value,
		accuracy: combinedAccuracy([left.accuracy, right.accuracy]),
		source: left.source === right.source ? left.source : "derived",
	};
}

function mergeMetric<TUnit extends ObservationUnit>(left: TelemetryMetric<TUnit>, right: TelemetryMetric<TUnit>): TelemetryMetric<TUnit> {
	return {
		sum: mergeQuantity(left.sum, right.sum, "sum"),
		peak: mergeQuantity(left.peak, right.peak, "peak"),
		sampleCount: left.sampleCount + right.sampleCount,
		firstObservedAt: left.firstObservedAt === null ? right.firstObservedAt : right.firstObservedAt === null ? left.firstObservedAt : left.firstObservedAt < right.firstObservedAt ? left.firstObservedAt : right.firstObservedAt,
		lastObservedAt: left.lastObservedAt === null ? right.lastObservedAt : right.lastObservedAt === null ? left.lastObservedAt : left.lastObservedAt > right.lastObservedAt ? left.lastObservedAt : right.lastObservedAt,
	};
}

function mergeReports(left: SessionTelemetryReport, right: SessionTelemetryReport): SessionTelemetryReport {
	const coverage = new Map<string, TelemetryCoverageEntry>();
	for (const entry of [...left.coverage, ...right.coverage]) {
		const previous = coverage.get(entry.key);
		if (previous === undefined) {
			coverage.set(entry.key, entry);
			continue;
		}
		if (previous.state === entry.state && previous.reason === entry.reason) continue;
		const available = previous.state === "measured" || previous.state === "sampled";
		const nextAvailable = entry.state === "measured" || entry.state === "sampled";
		coverage.set(entry.key, available || nextAvailable ? makeCoverage(entry.key, "partial", entry.reason ?? previous.reason) : entry);
	}
	const traceIds = [...left.traceIds, ...right.traceIds];
	const traceState: TelemetrySourceState = left.source.trace.state === right.source.trace.state
		? left.source.trace.state
		: left.source.trace.state === "available" && right.source.trace.state === "available" ? "available" : "partial";
	return {
		...left,
		traceId: left.traceId ?? right.traceId,
		traceIds,
		source: { trace: { state: traceState, traceCount: traceIds.length, traceIds } },
		summary: {
			durationMs: left.summary.durationMs === null ? right.summary.durationMs : right.summary.durationMs === null ? left.summary.durationMs : Math.max(left.summary.durationMs, right.summary.durationMs),
			traceCount: left.summary.traceCount + right.summary.traceCount,
			observationCount: left.summary.observationCount + right.summary.observationCount,
			turnCount: left.summary.turnCount + right.summary.turnCount,
			modelCallCount: left.summary.modelCallCount + right.summary.modelCallCount,
		},
		coverage: [...coverage.values()],
		traffic: {
			llmHttp: { tx: mergeMetric(left.traffic.llmHttp.tx, right.traffic.llmHttp.tx), rx: mergeMetric(left.traffic.llmHttp.rx, right.traffic.llmHttp.rx) },
			llmSse: { tx: mergeMetric(left.traffic.llmSse.tx, right.traffic.llmSse.tx), rx: mergeMetric(left.traffic.llmSse.rx, right.traffic.llmSse.rx) },
			llmWebsocket: { tx: mergeMetric(left.traffic.llmWebsocket.tx, right.traffic.llmWebsocket.tx), rx: mergeMetric(left.traffic.llmWebsocket.rx, right.traffic.llmWebsocket.rx) },
			mcpHttp: { tx: mergeMetric(left.traffic.mcpHttp.tx, right.traffic.mcpHttp.tx), rx: mergeMetric(left.traffic.mcpHttp.rx, right.traffic.mcpHttp.rx) },
			governedHttp: { tx: mergeMetric(left.traffic.governedHttp.tx, right.traffic.governedHttp.tx), rx: mergeMetric(left.traffic.governedHttp.rx, right.traffic.governedHttp.rx) },
			gateway: { tx: mergeMetric(left.traffic.gateway.tx, right.traffic.gateway.tx), rx: mergeMetric(left.traffic.gateway.rx, right.traffic.gateway.rx) },
			processIo: {
				stdin: { observed: mergeMetric(left.traffic.processIo.stdin.observed, right.traffic.processIo.stdin.observed), retained: mergeMetric(left.traffic.processIo.stdin.retained, right.traffic.processIo.stdin.retained) },
				stdout: { observed: mergeMetric(left.traffic.processIo.stdout.observed, right.traffic.processIo.stdout.observed), retained: mergeMetric(left.traffic.processIo.stdout.retained, right.traffic.processIo.stdout.retained) },
				stderr: { observed: mergeMetric(left.traffic.processIo.stderr.observed, right.traffic.processIo.stderr.observed), retained: mergeMetric(left.traffic.processIo.stderr.retained, right.traffic.processIo.stderr.retained) },
				ptyOutput: { observed: mergeMetric(left.traffic.processIo.ptyOutput.observed, right.traffic.processIo.ptyOutput.observed), retained: mergeMetric(left.traffic.processIo.ptyOutput.retained, right.traffic.processIo.ptyOutput.retained) },
			},
		},
		memory: {
			runtimeRssBytes: mergeMetric(left.memory.runtimeRssBytes, right.memory.runtimeRssBytes),
			runtimeHeapTotalBytes: mergeMetric(left.memory.runtimeHeapTotalBytes, right.memory.runtimeHeapTotalBytes),
			runtimeHeapUsedBytes: mergeMetric(left.memory.runtimeHeapUsedBytes, right.memory.runtimeHeapUsedBytes),
			runtimeExternalBytes: mergeMetric(left.memory.runtimeExternalBytes, right.memory.runtimeExternalBytes),
			runtimeArrayBuffersBytes: mergeMetric(left.memory.runtimeArrayBuffersBytes, right.memory.runtimeArrayBuffersBytes),
			logicalStateBytes: mergeMetric(left.memory.logicalStateBytes, right.memory.logicalStateBytes),
			contextCurrentTokens: mergeMetric(left.memory.contextCurrentTokens, right.memory.contextCurrentTokens),
			managedProcessRssBytes: mergeMetric(left.memory.managedProcessRssBytes, right.memory.managedProcessRssBytes),
			managedProcessPssBytes: mergeMetric(left.memory.managedProcessPssBytes, right.memory.managedProcessPssBytes),
			managedProcessUssBytes: mergeMetric(left.memory.managedProcessUssBytes, right.memory.managedProcessUssBytes),
			managedProcessCount: mergeMetric(left.memory.managedProcessCount, right.memory.managedProcessCount),
		},
	};
}

export interface SessionTelemetryAggregateInput {
	readonly sessionId: SessionId;
	readonly traces: readonly { readonly traceId: TraceId; readonly events?: readonly TraceEvent[]; readonly state?: "available" | "missing" | "tampered" }[];
	readonly recordingMode?: "off" | "events" | "events_and_artifacts";
	readonly generatedAt?: string;
}

export function emptySessionTelemetryReport(
	sessionId: SessionId,
	input: { readonly state: TelemetrySourceState; readonly reason: TelemetryCoverageReason; readonly recordingMode?: SessionTelemetryAggregateInput["recordingMode"]; readonly generatedAt?: string; readonly traceIds?: readonly TraceId[] },
): SessionTelemetryReport {
	const observationReason: ObservationUnavailableReason = input.recordingMode === "off" || input.reason === "recording_disabled" ? "recording_disabled" : "sample_failed";
	const report = projectEmptyReport(sessionId, observationReason, input.generatedAt);
	const traceIds = [...(input.traceIds ?? [])];
	return {
		...report,
		traceIds,
		source: { trace: { state: input.state, traceCount: traceIds.length, traceIds } },
		coverage: report.coverage.map((entry) => entry.key === "trace" ? makeCoverage("trace", input.state === "recording_off" ? "recording_off" : "unavailable", input.reason) : entry),
	};
}

function projectEmptyReport(sessionId: SessionId, reason: ObservationUnavailableReason, generatedAt?: string): SessionTelemetryReport {
	const bytes = (key: string): TelemetryMetric<"bytes"> => {
		void key;
		return { sum: { availability: "unavailable", unit: "bytes", reason }, peak: { availability: "unavailable", unit: "bytes", reason }, sampleCount: 0, firstObservedAt: null, lastObservedAt: null };
	};
	const tokens: TelemetryMetric<"tokens"> = { sum: { availability: "unavailable", unit: "tokens", reason: reason === "recording_disabled" ? "recording_disabled" : "provider_usage_missing" }, peak: { availability: "unavailable", unit: "tokens", reason: reason === "recording_disabled" ? "recording_disabled" : "provider_usage_missing" }, sampleCount: 0, firstObservedAt: null, lastObservedAt: null };
	const process = (): TelemetryProcessIoMetric => ({ observed: bytes("process"), retained: bytes("process") });
	return {
		format: "runledger.telemetry.report",
		sessionId,
		traceId: null,
		traceIds: [],
		generatedAt: generatedAt ?? new Date().toISOString(),
		source: { trace: { state: "missing", traceCount: 0, traceIds: [] } },
		summary: { durationMs: null, traceCount: 0, observationCount: 0, turnCount: 0, modelCallCount: 0 },
		coverage: [
			makeCoverage("trace", "unavailable", reason),
			...(["llm_http", "llm_sse", "llm_websocket", "mcp_http", "governed_http", "gateway"] as const).map((channel) => makeCoverage(`traffic.${channel}`, "unavailable", reason)),
			makeCoverage("memory.runtime", "unavailable", reason),
			makeCoverage("memory.logical_state", "unavailable", reason),
			makeCoverage("memory.process_pss", "unavailable", reason),
		],
		traffic: {
			llmHttp: { tx: bytes("llm_http"), rx: bytes("llm_http") },
			llmSse: { tx: bytes("llm_sse"), rx: bytes("llm_sse") },
			llmWebsocket: { tx: bytes("llm_websocket"), rx: bytes("llm_websocket") },
			mcpHttp: { tx: bytes("mcp_http"), rx: bytes("mcp_http") },
			governedHttp: { tx: bytes("governed_http"), rx: bytes("governed_http") },
			gateway: { tx: bytes("gateway"), rx: bytes("gateway") },
			processIo: { stdin: process(), stdout: process(), stderr: process(), ptyOutput: process() },
		},
		memory: {
			runtimeRssBytes: bytes("runtime_rss"), runtimeHeapTotalBytes: bytes("heap_total"), runtimeHeapUsedBytes: bytes("heap_used"), runtimeExternalBytes: bytes("external"), runtimeArrayBuffersBytes: bytes("array_buffers"), logicalStateBytes: bytes("logical_state"), contextCurrentTokens: tokens, managedProcessRssBytes: bytes("process_rss"), managedProcessPssBytes: bytes("process_pss"), managedProcessUssBytes: bytes("process_uss"), managedProcessCount: { ...bytes("process_count"), sum: { availability: "unavailable", unit: "count", reason }, peak: { availability: "unavailable", unit: "count", reason } },
		},
	};
}

export function projectSessionTelemetryAggregate(input: SessionTelemetryAggregateInput): SessionTelemetryProjectorResult {
	if (input.traces.some((trace) => trace.state === "tampered")) {
		return {
			ok: true,
			report: emptySessionTelemetryReport(input.sessionId, {
				state: "tampered",
				reason: "trace_tampered",
				recordingMode: input.recordingMode,
				generatedAt: input.generatedAt,
				traceIds: input.traces.map((trace) => trace.traceId),
			}),
		};
	}
	const available = input.traces.flatMap((trace) => {
		if (trace.state === "missing" || trace.events === undefined) return [];
		const result = projectSessionTelemetryReport({ sessionId: input.sessionId, traceId: trace.traceId, events: trace.events, generatedAt: input.generatedAt });
		return result.ok ? [result.report] : [];
	});
	if (available.length === 0) {
		return { ok: true, report: emptySessionTelemetryReport(input.sessionId, { state: input.recordingMode === "off" ? "recording_off" : "missing", reason: input.recordingMode === "off" ? "recording_disabled" : "trace_missing", recordingMode: input.recordingMode, generatedAt: input.generatedAt }) };
	}
	let report = available[0]!;
	for (const next of available.slice(1)) report = mergeReports(report, next);
	const traceIds = input.traces.map((trace) => trace.traceId);
	const sourceState: TelemetrySourceState = available.length === input.traces.length ? "available" : "partial";
	const timestamps = input.traces
		.flatMap((trace) => trace.events ?? [])
		.map((event) => Date.parse(event.timestamp))
		.filter((timestamp) => Number.isFinite(timestamp));
	const durationMs = timestamps.length < 2 ? null : Math.max(0, Math.max(...timestamps) - Math.min(...timestamps));
	return {
		ok: true,
		report: {
			...report,
			traceIds,
			source: { trace: { state: sourceState, traceCount: traceIds.length, traceIds } },
			coverage: [makeCoverage("trace", sourceState === "available" ? "measured" : "partial", sourceState === "available" ? undefined : "trace_missing"), ...report.coverage.filter((entry) => entry.key !== "trace")],
			summary: { ...report.summary, traceCount: traceIds.length, durationMs },
		},
	};
}

export function projectSessionTelemetryReport(input: SessionTelemetryProjectorInput): SessionTelemetryProjectorResult {
	const verified = verifyTrace(input.events, input.traceId);
	if (verified !== undefined) return verified;
	const trafficKeys = ["llmHttp", "llmSse", "llmWebsocket", "mcpHttp", "governedHttp", "gateway"] as const;
	const trafficAccumulators = Object.fromEntries(trafficKeys.map((key) => [key, { tx: accumulator("bytes", "transport_not_instrumented"), rx: accumulator("bytes", "transport_not_instrumented") }])) as Record<(typeof trafficKeys)[number], { tx: MetricAccumulator<"bytes">; rx: MetricAccumulator<"bytes"> }>;
	const processAccumulators = {
		stdin: { observed: accumulator("bytes", "not_applicable"), retained: accumulator("bytes", "not_applicable") },
		stdout: { observed: accumulator("bytes", "not_applicable"), retained: accumulator("bytes", "not_applicable") },
		stderr: { observed: accumulator("bytes", "not_applicable"), retained: accumulator("bytes", "not_applicable") },
		ptyOutput: { observed: accumulator("bytes", "not_applicable"), retained: accumulator("bytes", "not_applicable") },
	};
	const memoryAccumulators = {
		runtimeRssBytes: accumulator("bytes", "sample_failed"),
		runtimeHeapTotalBytes: accumulator("bytes", "sample_failed"),
		runtimeHeapUsedBytes: accumulator("bytes", "sample_failed"),
		runtimeExternalBytes: accumulator("bytes", "sample_failed"),
		runtimeArrayBuffersBytes: accumulator("bytes", "sample_failed"),
		logicalStateBytes: accumulator("bytes", "sample_failed"),
		contextCurrentTokens: accumulator("tokens", "provider_usage_missing"),
		managedProcessRssBytes: accumulator("bytes", "platform_unsupported"),
		managedProcessPssBytes: accumulator("bytes", "platform_unsupported"),
		managedProcessUssBytes: accumulator("bytes", "platform_unsupported"),
		managedProcessCount: accumulator("count", "platform_unsupported"),
	};
	const observedChannels = new Set<string>();
	const observedMemory = new Set<string>();

	for (const event of input.events) {
		const observation = event.observation;
		if (observation === undefined) continue;
		if (observation.correlation.sessionId !== input.sessionId || observation.correlation.traceId !== input.traceId) {
			return { ok: false, code: "trace_correlation_mismatch" };
		}
		if (observation.kind === "traffic") {
			const key = {
				llm_http: "llmHttp",
				llm_sse: "llmSse",
				llm_websocket: "llmWebsocket",
				mcp_http: "mcpHttp",
				governed_http: "governedHttp",
				gateway: "gateway",
			}[observation.channel] as (typeof trafficKeys)[number];
			addQuantity(trafficAccumulators[key][observation.direction], observation.bytes, observation.observedAt);
			observedChannels.add(`traffic.${observation.channel}`);
		} else if (observation.kind === "process_io") {
			const key = observation.stream === "pty_output" ? "ptyOutput" : observation.stream;
			addQuantity(processAccumulators[key].observed, observation.observedBytes, observation.observedAt);
			observedChannels.add(`process.${observation.stream}`);
			addQuantity(processAccumulators[key].retained, observation.retainedBytes, observation.observedAt);
		} else if (observation.kind === "runtime_memory") {
			addQuantity(memoryAccumulators.runtimeRssBytes, observation.rssBytes, observation.observedAt);
			addQuantity(memoryAccumulators.runtimeHeapTotalBytes, observation.heapTotalBytes, observation.observedAt);
			addQuantity(memoryAccumulators.runtimeHeapUsedBytes, observation.heapUsedBytes, observation.observedAt);
			addQuantity(memoryAccumulators.runtimeExternalBytes, observation.externalBytes, observation.observedAt);
			addQuantity(memoryAccumulators.runtimeArrayBuffersBytes, observation.arrayBuffersBytes, observation.observedAt);
			observedMemory.add("memory.runtime");
		} else if (observation.kind === "logical_session_state") {
			addQuantity(memoryAccumulators.logicalStateBytes, observation.totalBytes, observation.observedAt);
			addQuantity(memoryAccumulators.contextCurrentTokens, observation.contextCurrentTokens, observation.observedAt);
			observedMemory.add("memory.logical_state");
		} else {
			addQuantity(memoryAccumulators.managedProcessRssBytes, observation.rssBytes, observation.observedAt);
			addQuantity(memoryAccumulators.managedProcessPssBytes, observation.pssBytes, observation.observedAt);
			addQuantity(memoryAccumulators.managedProcessUssBytes, observation.ussBytes, observation.observedAt);
			addQuantity(memoryAccumulators.managedProcessCount, observation.observedProcessCount, observation.observedAt);
			observedMemory.add("memory.process");
		}
	}

	const traffic = {
		llmHttp: { tx: metric(trafficAccumulators.llmHttp.tx), rx: metric(trafficAccumulators.llmHttp.rx) },
		llmSse: { tx: metric(trafficAccumulators.llmSse.tx), rx: metric(trafficAccumulators.llmSse.rx) },
		llmWebsocket: { tx: metric(trafficAccumulators.llmWebsocket.tx), rx: metric(trafficAccumulators.llmWebsocket.rx) },
		mcpHttp: { tx: metric(trafficAccumulators.mcpHttp.tx), rx: metric(trafficAccumulators.mcpHttp.rx) },
		governedHttp: { tx: metric(trafficAccumulators.governedHttp.tx), rx: metric(trafficAccumulators.governedHttp.rx) },
		gateway: { tx: metric(trafficAccumulators.gateway.tx), rx: metric(trafficAccumulators.gateway.rx) },
		processIo: {
			stdin: { observed: metric(processAccumulators.stdin.observed), retained: metric(processAccumulators.stdin.retained) },
			stdout: { observed: metric(processAccumulators.stdout.observed), retained: metric(processAccumulators.stdout.retained) },
			stderr: { observed: metric(processAccumulators.stderr.observed), retained: metric(processAccumulators.stderr.retained) },
			ptyOutput: { observed: metric(processAccumulators.ptyOutput.observed), retained: metric(processAccumulators.ptyOutput.retained) },
		},
	};
	const memory = {
		runtimeRssBytes: metric(memoryAccumulators.runtimeRssBytes),
		runtimeHeapTotalBytes: metric(memoryAccumulators.runtimeHeapTotalBytes),
		runtimeHeapUsedBytes: metric(memoryAccumulators.runtimeHeapUsedBytes),
		runtimeExternalBytes: metric(memoryAccumulators.runtimeExternalBytes),
		runtimeArrayBuffersBytes: metric(memoryAccumulators.runtimeArrayBuffersBytes),
		logicalStateBytes: metric(memoryAccumulators.logicalStateBytes),
		contextCurrentTokens: metric(memoryAccumulators.contextCurrentTokens),
		managedProcessRssBytes: metric(memoryAccumulators.managedProcessRssBytes),
		managedProcessPssBytes: metric(memoryAccumulators.managedProcessPssBytes),
		managedProcessUssBytes: metric(memoryAccumulators.managedProcessUssBytes),
		managedProcessCount: metric(memoryAccumulators.managedProcessCount),
	};
	const trafficChannelByKey: Readonly<Record<(typeof trafficKeys)[number], string>> = {
		llmHttp: "llm_http",
		llmSse: "llm_sse",
		llmWebsocket: "llm_websocket",
		mcpHttp: "mcp_http",
		governedHttp: "governed_http",
		gateway: "gateway",
	};
	const coverageEntries: TelemetryCoverageEntry[] = [
		makeCoverage("trace", "measured"),
		...trafficKeys.map((key) => {
			const channel = trafficChannelByKey[key];
			const observed = observedChannels.has(`traffic.${channel}`);
			return makeCoverage(`traffic.${channel}`, observed ? "measured" : "unavailable", observed ? undefined : "transport_not_instrumented");
		}),
		makeCoverage("memory.runtime", observedMemory.has("memory.runtime") ? "sampled" : "unavailable", observedMemory.has("memory.runtime") ? undefined : "sample_failed"),
		makeCoverage("memory.logical_state", observedMemory.has("memory.logical_state") ? "measured" : "unavailable", observedMemory.has("memory.logical_state") ? undefined : "sample_failed"),
		makeCoverage("memory.process_pss", observedMemory.has("memory.process") ? "sampled" : "unavailable", observedMemory.has("memory.process") ? undefined : "platform_unsupported"),
	];
	return {
		ok: true,
			report: {
				format: "runledger.telemetry.report",
				sessionId: input.sessionId,
				traceId: input.traceId,
				traceIds: [input.traceId],
				generatedAt: input.generatedAt ?? new Date().toISOString(),
				source: { trace: { state: "available", traceCount: 1, traceIds: [input.traceId] } },
				summary: summaryForEvents(input.events),
				coverage: coverageEntries,
			traffic,
			memory,
		},
	};
}
