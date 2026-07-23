/** Metadata-only OpenTelemetry projection 与 opaque sink adapter。 */

import { canonicalDigest } from "../protocol/v3/canonical-json.ts";
import type { CostTrace } from "./cost.ts";
import type { TelemetryExporterPort, TelemetryExporterResult } from "./sinks.ts";
import type { TelemetryAttribute, TelemetrySample } from "./types.ts";

export interface OtelSpanProjection {
	projectionKind: "otel_span";
	traceId: string;
	spanId: string;
	name: string;
	severity: TelemetrySample["severity"];
	timestamp: string;
	attributes: readonly TelemetryAttribute[];
	projectionDigest: string;
}

export interface OtelMetricProjection {
	projectionKind: "otel_metric";
	name: string;
	value: number;
	unit: "1" | "ms" | "By" | "USD" | "token";
	authorityId: string;
	tenantId: string;
	sessionId: string;
	projectionDigest: string;
}

export interface OtelProjectionSinkPort {
	export(
		spans: readonly OtelSpanProjection[],
		metrics: readonly OtelMetricProjection[],
		signal: AbortSignal,
	): Promise<void>;
}

export function toOtelSpanProjection(sample: TelemetrySample): OtelSpanProjection {
	const body = {
		projectionKind: "otel_span" as const,
		traceId: canonicalDigest({ authorityId: sample.authorityId, tenantId: sample.tenantId, traceId: sample.traceId }).slice(0, 32),
		spanId: sample.sampleDigest.slice(0, 16),
		name: sample.name,
		severity: sample.severity,
		timestamp: sample.observedAt,
		attributes: sample.attributes,
	};
	return { ...body, projectionDigest: canonicalDigest(body) };
}

export function toOtelCostMetrics(trace: CostTrace): readonly OtelMetricProjection[] {
	const values: readonly [string, number, OtelMetricProjection["unit"]][] = [
		["runledger.cost.usd", trace.costUsd, "USD"],
		["runledger.wall_time", trace.wallTimeMs, "ms"],
		["runledger.tokens.input", trace.tokens.input, "token"],
		["runledger.tokens.output", trace.tokens.output, "token"],
		["runledger.tool.calls", trace.tool.callCount, "1"],
		["runledger.network.bytes_sent", trace.network.bytesSent, "By"],
		["runledger.network.bytes_received", trace.network.bytesReceived, "By"],
		["runledger.network.bytes_total", trace.network.bytesTotal, "By"],
		["runledger.storage.bytes_read", trace.storage.bytesRead, "By"],
		["runledger.storage.bytes_written", trace.storage.bytesWritten, "By"],
		["runledger.storage.bytes_total", trace.storage.bytesTotal, "By"],
		["runledger.storage.artifacts", trace.storage.artifactCount, "1"],
		["runledger.verification.runs", trace.verification.runCount, "1"],
		["runledger.retry.count", trace.retryCount, "1"],
		["runledger.agent.count", trace.agentCount, "1"],
	];
	return values.map(([name, value, unit]) => {
		const body = {
			projectionKind: "otel_metric" as const,
			name,
			value,
			unit,
			authorityId: trace.authorityId,
			tenantId: trace.tenantId,
			sessionId: trace.sessionId,
		};
		return { ...body, projectionDigest: canonicalDigest(body) };
	});
}

export class OtelTelemetryExporter implements TelemetryExporterPort {
	public readonly id: string;
	public readonly channel = "otel" as const;
	public readonly identityDigest: string;
	readonly #sink: OtelProjectionSinkPort;

	public constructor(
		id: string,
		sink: OtelProjectionSinkPort,
		identityDigest = canonicalDigest({ adapter: "OtelTelemetryExporter", id, contractVersion: 1 }),
	) {
		this.id = id;
		this.#sink = sink;
		this.identityDigest = identityDigest;
	}

	public async export(samples: readonly TelemetrySample[], signal: AbortSignal): Promise<TelemetryExporterResult> {
		await this.#sink.export(samples.map(toOtelSpanProjection), [], signal);
		return { ok: true, accepted: samples.length };
	}
}
