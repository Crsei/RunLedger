/** SIEM audit projection 只含可重建 metadata 和 canonical event refs。 */

import { canonicalDigest } from "../protocol/v3/canonical-json.ts";
import type { TelemetryExporterPort, TelemetryExporterResult } from "./sinks.ts";
import type { TelemetryAttribute, TelemetrySample } from "./types.ts";

export interface SiemAuditProjection {
	projectionKind: "siem_audit";
	authorityId: string;
	tenantId: string;
	principalId: string;
	sessionId: string;
	traceId: string;
	eventName: string;
	severity: TelemetrySample["severity"];
	observedAt: string;
	eventSequence?: number;
	eventHash?: string;
	attributes: readonly TelemetryAttribute[];
	sampleDigest: string;
	projectionDigest: string;
}

export interface SiemProjectionSinkPort {
	export(records: readonly SiemAuditProjection[], signal: AbortSignal): Promise<void>;
}

export function toSiemAuditProjection(sample: TelemetrySample): SiemAuditProjection {
	const body = {
		projectionKind: "siem_audit" as const,
		authorityId: sample.authorityId,
		tenantId: sample.tenantId,
		principalId: sample.principalId,
		sessionId: sample.sessionId,
		traceId: sample.traceId,
		eventName: sample.name,
		severity: sample.severity,
		observedAt: sample.observedAt,
		...(sample.eventSequence === undefined ? {} : { eventSequence: sample.eventSequence }),
		...(sample.eventHash === undefined ? {} : { eventHash: sample.eventHash }),
		attributes: sample.attributes,
		sampleDigest: sample.sampleDigest,
	};
	return { ...body, projectionDigest: canonicalDigest(body) };
}

export class SiemTelemetryExporter implements TelemetryExporterPort {
	public readonly id: string;
	public readonly channel = "siem" as const;
	public readonly identityDigest: string;
	readonly #sink: SiemProjectionSinkPort;

	public constructor(
		id: string,
		sink: SiemProjectionSinkPort,
		identityDigest = canonicalDigest({ adapter: "SiemTelemetryExporter", id, contractVersion: 1 }),
	) {
		this.id = id;
		this.#sink = sink;
		this.identityDigest = identityDigest;
	}

	public async export(samples: readonly TelemetrySample[], signal: AbortSignal): Promise<TelemetryExporterResult> {
		await this.#sink.export(samples.map(toSiemAuditProjection), signal);
		return { ok: true, accepted: samples.length };
	}
}
