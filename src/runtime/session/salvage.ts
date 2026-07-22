/** 只读 forensic salvage：报告可信前缀，修复计划只能指向新的 session。 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { canonicalDigest } from "../protocol/v3/canonical-json.ts";
import type { EventCursor, RuntimeEventV3 } from "../protocol/v3/events.ts";
import {
	isRuntimeId,
	type AgentId,
	type ArtifactId,
	type CommandId,
	type GoalId,
	type LeafId,
	type PrincipalId,
	type SessionId,
	type TraceId,
} from "../protocol/v3/ids.ts";
import { isEventCursor } from "../protocol/v3/schemas.ts";
import {
	scanJsonlV3EventLog,
	type JsonlV3EventLogScope,
	type JsonlV3ScanError,
} from "./jsonl-v3-store.ts";
import { verifyRuntimeEventChain } from "./chain-verification.ts";
import {
	createStableForkPlan,
	type StableForkGoalMode,
	type StableForkPlan,
} from "./checkpoint.ts";
import { reduceSessionEvents } from "./reducer.ts";
import { SESSION_KERNEL_ERROR_CODES } from "./types.ts";
import type { RuntimeEventDraft, SessionKernelError, SessionResult } from "./types.ts";

export const FORENSIC_SALVAGE_REPORT_VERSION = 1 as const;

export type ForensicSalvageOutcome = "no_repair_needed" | "verified_prefix_available" | "unrecoverable";

export interface ForensicSalvageFailure {
	code: JsonlV3ScanError["code"];
	line: number;
	byteOffset: number;
	tornTail: boolean;
}

export interface ForensicSalvageReportBody {
	reportVersion: typeof FORENSIC_SALVAGE_REPORT_VERSION;
	reportArtifactId: ArtifactId;
	authorityId: JsonlV3EventLogScope["authorityId"];
	tenantId: JsonlV3EventLogScope["tenantId"];
	sourceSessionId: SessionId;
	sourceDigest: string;
	sourceByteLength: number;
	generatedAt: string;
	outcome: ForensicSalvageOutcome;
	verifiedPrefixCount: number;
	verifiedPrefixCursor: EventCursor | null;
	failure: ForensicSalvageFailure | null;
	readOnly: true;
}

export interface ForensicSalvageReport extends ForensicSalvageReportBody {
	reportDigest: string;
}

export interface ForensicSalvageInspection {
	report: ForensicSalvageReport;
	verifiedPrefix: readonly RuntimeEventV3[];
}

export interface ForensicSalvageForkPlan extends StableForkPlan {
	reportArtifactId: ArtifactId;
	reportDigest: string;
	sourceDigest: string;
	sourceWasModified: false;
	repairDraft: RuntimeEventDraft<"session.repair_reported">;
}

function fail<T>(error: SessionKernelError): SessionResult<T> {
	return { ok: false, error };
}

function invalid<T>(message: string): SessionResult<T> {
	return fail({ code: "invalid_event", message, retryable: false });
}

function corrupted<T>(message: string): SessionResult<T> {
	return fail({ code: "corrupted_log", message, retryable: false });
}

function rawDigest(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function prefixCursor(events: readonly RuntimeEventV3[]): EventCursor | null {
	const event = events.at(-1);
	return event
		? {
				stream: event.stream,
				sequence: event.sequence,
				eventId: event.eventId,
				eventHash: event.currentEventHash,
			}
		: null;
}

function reportFailure(error: JsonlV3ScanError | undefined, tornTail: boolean): ForensicSalvageFailure | null {
	return error
		? {
				code: error.code,
				line: error.line,
				byteOffset: error.byteOffset,
				tornTail,
			}
		: null;
}

function hasExactKeys(value: object, keys: readonly string[]): boolean {
	const expected = [...keys].sort();
	const actual = Object.keys(value).sort();
	return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validateForensicSalvageReport(value: unknown): value is ForensicSalvageReport {
	if (!isRecord(value)) return false;
	const report = value as unknown as ForensicSalvageReport;
	if (
		!hasExactKeys(report, [
			"reportVersion",
			"reportArtifactId",
			"authorityId",
			"tenantId",
			"sourceSessionId",
			"sourceDigest",
			"sourceByteLength",
			"generatedAt",
			"outcome",
			"verifiedPrefixCount",
			"verifiedPrefixCursor",
			"failure",
			"readOnly",
			"reportDigest",
		]) ||
		report.reportVersion !== FORENSIC_SALVAGE_REPORT_VERSION ||
		!isRuntimeId(report.reportArtifactId, "artifact") ||
		!isRuntimeId(report.authorityId, "authority") ||
		!isRuntimeId(report.tenantId, "tenant") ||
		!isRuntimeId(report.sourceSessionId, "session") ||
		!/^[a-f0-9]{64}$/.test(report.sourceDigest) ||
		!Number.isSafeInteger(report.sourceByteLength) ||
		report.sourceByteLength < 0 ||
		!Number.isFinite(Date.parse(report.generatedAt)) ||
		!Number.isSafeInteger(report.verifiedPrefixCount) ||
		report.verifiedPrefixCount < 0 ||
		report.readOnly !== true ||
		!/^[a-f0-9]{64}$/.test(report.reportDigest)
	) return false;
	if (
		report.outcome !== "no_repair_needed" &&
		report.outcome !== "verified_prefix_available" &&
		report.outcome !== "unrecoverable"
	) return false;
	if (report.verifiedPrefixCursor !== null && !isEventCursor(report.verifiedPrefixCursor)) return false;
	if (
		report.verifiedPrefixCursor !== null &&
		(report.verifiedPrefixCursor.stream.scope !== "session" ||
			report.verifiedPrefixCursor.stream.sessionId !== report.sourceSessionId)
	) return false;
	if (report.verifiedPrefixCount === 0 && report.verifiedPrefixCursor !== null) return false;
	if (
		report.verifiedPrefixCount > 0 &&
		(!report.verifiedPrefixCursor || report.verifiedPrefixCursor.sequence !== report.verifiedPrefixCount - 1)
	) return false;
	if (report.failure) {
		if (
			!isRecord(report.failure) ||
			!hasExactKeys(report.failure, ["code", "line", "byteOffset", "tornTail"]) ||
			!SESSION_KERNEL_ERROR_CODES.includes(report.failure.code) ||
			typeof report.failure.tornTail !== "boolean" ||
			!Number.isSafeInteger(report.failure.line) ||
			report.failure.line < 0 ||
			!Number.isSafeInteger(report.failure.byteOffset) ||
			report.failure.byteOffset < 0
		) return false;
	} else if (report.outcome !== "no_repair_needed") return false;
	if (report.failure && report.failure.line !== report.verifiedPrefixCount) return false;
	if (report.outcome === "verified_prefix_available" && report.verifiedPrefixCount === 0) return false;
	if (report.outcome === "unrecoverable" && report.verifiedPrefixCount !== 0) return false;
	const { reportDigest, ...body } = report;
	try {
		return canonicalDigest(body) === reportDigest;
	} catch {
		return false;
	}
}

function largestReduciblePrefix(events: readonly RuntimeEventV3[]): readonly RuntimeEventV3[] {
	let validLength = 0;
	let invalidLength = events.length;
	if (events.length > 0 && reduceSessionEvents(events).ok) return events;
	while (validLength < invalidLength) {
		const candidateLength = Math.ceil((validLength + invalidLength) / 2);
		if (candidateLength > 0 && reduceSessionEvents(events.slice(0, candidateLength)).ok) {
			validLength = candidateLength;
		} else {
			invalidLength = candidateLength - 1;
		}
	}
	return events.slice(0, validLength);
}

function byteOffsetForLine(bytes: Uint8Array, line: number): number {
	if (line <= 0) return 0;
	let seen = 0;
	for (let offset = 0; offset < bytes.byteLength; offset += 1) {
		if (bytes[offset] !== 0x0a) continue;
		seen += 1;
		if (seen === line) return offset + 1;
	}
	return bytes.byteLength;
}

export async function inspectEventLogForSalvage(options: {
	filePath: string;
	scope: JsonlV3EventLogScope;
	reportArtifactId: ArtifactId;
	generatedAt: string;
}): Promise<SessionResult<ForensicSalvageInspection>> {
	if (
		!isRuntimeId(options.scope.authorityId, "authority") ||
		!isRuntimeId(options.scope.tenantId, "tenant") ||
		options.scope.stream.scope !== "session" ||
		!isRuntimeId(options.scope.stream.sessionId, "session") ||
		!isRuntimeId(options.reportArtifactId, "artifact") ||
		!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(options.generatedAt) ||
		!Number.isFinite(Date.parse(options.generatedAt))
	) {
		return invalid("forensic salvage report identity is invalid");
	}
	let bytes: Buffer;
	try {
		bytes = await readFile(options.filePath);
	} catch {
		return fail({ code: "durable_write_failed", message: "forensic source could not be read", retryable: false });
	}
	const scan = scanJsonlV3EventLog(bytes, options.scope);
	const verifiedPrefix = largestReduciblePrefix(scan.events);
	const semanticError: JsonlV3ScanError | undefined = verifiedPrefix.length < scan.events.length
		? {
				code: "invalid_event",
				message: "event prefix cannot be reduced into a valid session projection",
				line: verifiedPrefix.length,
				byteOffset: byteOffsetForLine(bytes, verifiedPrefix.length),
			}
		: scan.events.length === 0 && !scan.firstError
			? { code: "corrupted_log", message: "event log has no genesis event", line: 0, byteOffset: 0 }
			: undefined;
	const firstError = semanticError ?? scan.firstError;
	const cursor = prefixCursor(verifiedPrefix);
	const outcome: ForensicSalvageOutcome = !firstError
		? "no_repair_needed"
		: cursor
			? "verified_prefix_available"
			: "unrecoverable";
	const body: ForensicSalvageReportBody = {
		reportVersion: FORENSIC_SALVAGE_REPORT_VERSION,
		reportArtifactId: options.reportArtifactId,
		authorityId: options.scope.authorityId,
		tenantId: options.scope.tenantId,
		sourceSessionId: options.scope.stream.sessionId,
		sourceDigest: rawDigest(bytes),
		sourceByteLength: bytes.byteLength,
		generatedAt: options.generatedAt,
		outcome,
		verifiedPrefixCount: verifiedPrefix.length,
		verifiedPrefixCursor: cursor,
		failure: reportFailure(firstError, scan.tornTail),
		readOnly: true,
	};
	return {
		ok: true,
		value: {
			report: { ...body, reportDigest: canonicalDigest(body) },
			verifiedPrefix,
		},
	};
}

export function createForensicSalvageForkPlan(
	inspection: ForensicSalvageInspection,
	options: {
		newSessionId: SessionId;
		parentLeafId: LeafId;
		goalMode: StableForkGoalMode;
		initialGoalId: GoalId;
		rootAgentId: AgentId;
		idempotencyKey: CommandId;
		principalId: PrincipalId;
		forkTraceId: TraceId;
		repairTraceId: TraceId;
	},
): SessionResult<ForensicSalvageForkPlan> {
	if (!validateForensicSalvageReport(inspection.report)) return invalid("forensic salvage report is invalid");
	if (inspection.report.outcome !== "verified_prefix_available") {
		return corrupted("forensic source does not contain a repairable verified prefix");
	}
	if (
		!isRuntimeId(options.newSessionId, "session") ||
		!isRuntimeId(options.parentLeafId, "leaf") ||
		!isRuntimeId(options.initialGoalId, "goal") ||
		!isRuntimeId(options.rootAgentId, "agent") ||
		!isRuntimeId(options.idempotencyKey, "command") ||
		!isRuntimeId(options.principalId, "principal") ||
		!isRuntimeId(options.forkTraceId, "trace") ||
		!isRuntimeId(options.repairTraceId, "trace")
	) return invalid("forensic salvage fork identity is invalid");
	const cursor = prefixCursor(inspection.verifiedPrefix);
	if (
		!cursor ||
		cursor.stream.scope !== "session" ||
		cursor.stream.sessionId !== inspection.report.sourceSessionId ||
		cursor.sequence !== inspection.report.verifiedPrefixCount - 1 ||
		cursor.eventId !== inspection.report.verifiedPrefixCursor?.eventId ||
		cursor.eventHash !== inspection.report.verifiedPrefixCursor?.eventHash ||
		inspection.verifiedPrefix[0]?.authorityId !== inspection.report.authorityId ||
		inspection.verifiedPrefix[0]?.tenantId !== inspection.report.tenantId
	) return corrupted("forensic report does not match the supplied verified prefix");
	const chain = verifyRuntimeEventChain(inspection.verifiedPrefix, {
		authorityId: inspection.report.authorityId,
		tenantId: inspection.report.tenantId,
		stream: cursor.stream,
	});
	if (chain.integrity === "corrupted") {
		return fail(chain.error ?? { code: "corrupted_log", message: "forensic prefix is corrupted", retryable: false });
	}
	const projection = reduceSessionEvents(inspection.verifiedPrefix);
	if (!projection.ok) return projection;
	const fork = createStableForkPlan(projection.value, {
		newSessionId: options.newSessionId,
		parentLeafId: options.parentLeafId,
		goalMode: options.goalMode,
		initialGoalId: options.initialGoalId,
		rootAgentId: options.rootAgentId,
		idempotencyKey: options.idempotencyKey,
		principalId: options.principalId,
		traceId: options.forkTraceId,
	});
	if (!fork.ok) return fork;
	return {
		ok: true,
		value: {
			...fork.value,
			reportArtifactId: inspection.report.reportArtifactId,
			reportDigest: inspection.report.reportDigest,
			sourceDigest: inspection.report.sourceDigest,
			sourceWasModified: false,
			repairDraft: {
				type: "session.repair_reported",
				principalId: options.principalId,
				traceId: options.repairTraceId,
				payload: {
					sourceHeadHash: cursor.eventHash,
					reportArtifactId: inspection.report.reportArtifactId,
					outcome: "salvaged",
				},
			},
		},
	};
}
