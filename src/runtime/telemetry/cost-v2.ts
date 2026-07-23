/** CostTraceV2：绑定 Agent、event head、Episode Manifest 与预算结算。 */

import { canonicalDigest } from "../protocol/v3/canonical-json.ts";
import { sameRuntimeEventStream, type EventCursor } from "../protocol/v3/events.ts";
import type {
	AgentId,
	ArtifactId,
	AuthorityId,
	CommandId,
	FindingId,
	ReceiptId,
	SessionId,
	TenantId,
} from "../protocol/v3/ids.ts";
import type { TelemetryResult } from "./types.ts";

export const COST_TRACE_V2_SCHEMA_VERSION = 2 as const;

export interface CostTraceV2EpisodeRef {
	artifactId: ArtifactId;
	manifestBodyDigest: string;
	evidenceHead: EventCursor;
}

export interface CostUsageV2 {
	inputTokens: number;
	outputTokens: number;
	usdMicros: number;
	wallTimeMs: number;
	toolCalls: number;
	networkBytes: number;
	storageBytes: number;
	artifactCount: number;
	verifications: number;
}

export interface CostSettlementV2Body {
	schemaVersion: typeof COST_TRACE_V2_SCHEMA_VERSION;
	authorityId: AuthorityId;
	tenantId: TenantId;
	sessionId: SessionId;
	rootAgentId: AgentId;
	agentId: AgentId;
	operationId: CommandId;
	entryId: ReceiptId;
	phase: "reserve" | "commit" | "refund" | "late_provider_commit";
	usage: CostUsageV2;
	eventHead: EventCursor;
	episodeManifest: CostTraceV2EpisodeRef;
	sourceReceiptId: ReceiptId;
	sourceReceiptDigest: string;
	recordedAt: string;
}

export interface CostSettlementV2 extends CostSettlementV2Body {
	entryDigest: string;
}

export interface CostOperationProjectionV2 {
	operationId: CommandId;
	agentId: AgentId;
	reserved: CostUsageV2;
	committed: CostUsageV2;
	refunded: CostUsageV2;
	net: CostUsageV2;
	lateProviderReconciled: boolean;
}

export interface CostAgentProjectionV2 {
	agentId: AgentId;
	net: CostUsageV2;
	operationCount: number;
}

export interface CostTraceV2 {
	schemaVersion: typeof COST_TRACE_V2_SCHEMA_VERSION;
	projectionKind: "cost_trace_v2";
	authorityId: AuthorityId;
	tenantId: TenantId;
	sessionId: SessionId;
	rootAgentId: AgentId;
	eventHead: EventCursor;
	episodeManifests: readonly CostTraceV2EpisodeRef[];
	operations: readonly CostOperationProjectionV2[];
	byAgent: readonly CostAgentProjectionV2[];
	totals: {
		reserved: CostUsageV2;
		committed: CostUsageV2;
		refunded: CostUsageV2;
		net: CostUsageV2;
	};
	traceDigest: string;
}

export interface UnattributedLateCost {
	authorityId: AuthorityId;
	tenantId: TenantId;
	sessionId: SessionId;
	rootAgentId: AgentId;
	operationId: CommandId;
	providerReceiptId: ReceiptId;
	providerReceiptDigest: string;
	usage: CostUsageV2;
	observedAt: string;
}

export interface UnattributedCostFindingReceipt {
	findingId: FindingId;
	receiptId: ReceiptId;
	receiptDigest: string;
	recordedAt: string;
}

/** 实现必须写既有 finding repository 并提交 canonical finding.transitioned event。 */
export interface UnattributedCostFindingPort {
	recordUnattributedCost(
		lateCost: UnattributedLateCost,
		reasonDigest: string,
	): Promise<TelemetryResult<UnattributedCostFindingReceipt>>;
}

export type LateCostReconciliationResult =
	| { status: "attributed"; trace: CostTraceV2 }
	| { status: "finding_recorded"; trace: CostTraceV2; finding: UnattributedCostFindingReceipt };

const usageKeys = [
	"inputTokens",
	"outputTokens",
	"usdMicros",
	"wallTimeMs",
	"toolCalls",
	"networkBytes",
	"storageBytes",
	"artifactCount",
	"verifications",
] as const satisfies readonly (keyof CostUsageV2)[];

function zeroUsage(): CostUsageV2 {
	return {
		inputTokens: 0,
		outputTokens: 0,
		usdMicros: 0,
		wallTimeMs: 0,
		toolCalls: 0,
		networkBytes: 0,
		storageBytes: 0,
		artifactCount: 0,
		verifications: 0,
	};
}

function validUsage(usage: CostUsageV2): boolean {
	return usageKeys.every((key) => Number.isSafeInteger(usage[key]) && usage[key] >= 0);
}

function addUsage(left: CostUsageV2, right: CostUsageV2): CostUsageV2 | undefined {
	const value = zeroUsage();
	for (const key of usageKeys) {
		const sum = left[key] + right[key];
		if (!Number.isSafeInteger(sum)) return undefined;
		value[key] = sum;
	}
	return value;
}

function subtractUsage(left: CostUsageV2, right: CostUsageV2): CostUsageV2 | undefined {
	const value = zeroUsage();
	for (const key of usageKeys) {
		const difference = left[key] - right[key];
		if (!Number.isSafeInteger(difference) || difference < 0) return undefined;
		value[key] = difference;
	}
	return value;
}

function settlementBody(entry: CostSettlementV2): CostSettlementV2Body {
	const { entryDigest: _entryDigest, ...body } = entry;
	return body;
}

export function costSettlementV2Digest(body: CostSettlementV2Body): string {
	return canonicalDigest(body);
}

export function createCostSettlementV2(body: CostSettlementV2Body): TelemetryResult<CostSettlementV2> {
	if (!validUsage(body.usage) || !Number.isFinite(Date.parse(body.recordedAt))) {
		return { ok: false, error: { code: "invalid_schema", message: "cost settlement is invalid", retryable: false } };
	}
	return { ok: true, value: { ...body, entryDigest: costSettlementV2Digest(body) } };
}

function validSettlement(entry: CostSettlementV2): boolean {
	return entry.schemaVersion === COST_TRACE_V2_SCHEMA_VERSION &&
		validUsage(entry.usage) &&
		/^[a-f0-9]{64}$/.test(entry.sourceReceiptDigest) &&
		/^[a-f0-9]{64}$/.test(entry.episodeManifest.manifestBodyDigest) &&
		entry.entryDigest === canonicalDigest(settlementBody(entry)) &&
		Number.isFinite(Date.parse(entry.recordedAt));
}

export function aggregateCostTraceV2(
	entries: readonly CostSettlementV2[],
): TelemetryResult<CostTraceV2> {
	const first = entries[0];
	if (!first) {
		return { ok: false, error: { code: "invalid_schema", message: "CostTraceV2 requires entries", retryable: false } };
	}
	const seenEntries = new Map<ReceiptId, string>();
	const operations = new Map<CommandId, {
		agentId: AgentId;
		reserved?: CostUsageV2;
		committed?: CostUsageV2;
		refunded?: CostUsageV2;
		lateProviderReconciled: boolean;
	}>();
	const manifests = new Map<string, CostTraceV2EpisodeRef>();
	let eventHead = first.eventHead;
	for (const entry of entries) {
		if (!validSettlement(entry)) {
			return { ok: false, error: { code: "invalid_schema", message: "CostTraceV2 entry is invalid", retryable: false } };
		}
		if (entry.authorityId !== first.authorityId || entry.tenantId !== first.tenantId ||
			entry.sessionId !== first.sessionId || entry.rootAgentId !== first.rootAgentId) {
			return { ok: false, error: { code: "scope_mismatch", message: "CostTraceV2 entry scope mismatch", retryable: false } };
		}
		const seen = seenEntries.get(entry.entryId);
		if (seen) {
			if (seen !== entry.entryDigest) {
				return { ok: false, error: { code: "conflict", message: "cost entry id was reused", retryable: false } };
			}
			continue;
		}
		seenEntries.set(entry.entryId, entry.entryDigest);
		if (!sameRuntimeEventStream(entry.eventHead.stream, first.eventHead.stream)) {
			return { ok: false, error: { code: "scope_mismatch", message: "CostTraceV2 event stream mismatch", retryable: false } };
		}
		if (entry.eventHead.sequence > eventHead.sequence) eventHead = entry.eventHead;
		const manifestKey = `${entry.episodeManifest.artifactId}:${entry.episodeManifest.manifestBodyDigest}`;
		manifests.set(manifestKey, entry.episodeManifest);
		const operation = operations.get(entry.operationId) ?? {
			agentId: entry.agentId,
			lateProviderReconciled: false,
		};
		if (operation.agentId !== entry.agentId) {
			return { ok: false, error: { code: "scope_mismatch", message: "cost operation changed Agent", retryable: false } };
		}
		if (entry.phase === "reserve") {
			if (operation.reserved) return { ok: false, error: { code: "conflict", message: "cost operation has multiple reserves", retryable: false } };
			operation.reserved = entry.usage;
		} else if (entry.phase === "refund") {
			if (operation.refunded) return { ok: false, error: { code: "conflict", message: "cost operation has multiple refunds", retryable: false } };
			operation.refunded = entry.usage;
		} else {
			if (operation.committed) return { ok: false, error: { code: "conflict", message: "cost operation has multiple commits", retryable: false } };
			operation.committed = entry.usage;
			operation.lateProviderReconciled = entry.phase === "late_provider_commit";
		}
		operations.set(entry.operationId, operation);
	}
	const operationProjections: CostOperationProjectionV2[] = [];
	let totalReserved = zeroUsage();
	let totalCommitted = zeroUsage();
	let totalRefunded = zeroUsage();
	for (const [operationId, operation] of [...operations.entries()].sort(([left], [right]) => left.localeCompare(right))) {
		if (!operation.reserved || !operation.committed) {
			return { ok: false, error: { code: "reconciliation_required", message: "cost operation is missing reserve or commit", retryable: false } };
		}
		const refunded = operation.refunded ?? zeroUsage();
		const net = subtractUsage(operation.committed, refunded);
		if (!net || !subtractUsage(operation.reserved, operation.committed)) {
			return { ok: false, error: { code: "conflict", message: "cost settlement exceeds reserve or refund", retryable: false } };
		}
		const nextReserved = addUsage(totalReserved, operation.reserved);
		const nextCommitted = addUsage(totalCommitted, operation.committed);
		const nextRefunded = addUsage(totalRefunded, refunded);
		if (!nextReserved || !nextCommitted || !nextRefunded) {
			return { ok: false, error: { code: "invalid_schema", message: "CostTraceV2 totals overflow", retryable: false } };
		}
		totalReserved = nextReserved;
		totalCommitted = nextCommitted;
		totalRefunded = nextRefunded;
		operationProjections.push({
			operationId,
			agentId: operation.agentId,
			reserved: operation.reserved,
			committed: operation.committed,
			refunded,
			net,
			lateProviderReconciled: operation.lateProviderReconciled,
		});
	}
	const totalNet = subtractUsage(totalCommitted, totalRefunded);
	if (!totalNet) {
		return { ok: false, error: { code: "conflict", message: "CostTraceV2 totals underflow", retryable: false } };
	}
	const byAgentMap = new Map<AgentId, { net: CostUsageV2; operationCount: number }>();
	for (const operation of operationProjections) {
		const current = byAgentMap.get(operation.agentId) ?? { net: zeroUsage(), operationCount: 0 };
		const net = addUsage(current.net, operation.net);
		if (!net) return { ok: false, error: { code: "invalid_schema", message: "CostTraceV2 totals overflow", retryable: false } };
		byAgentMap.set(operation.agentId, { net, operationCount: current.operationCount + 1 });
	}
	const byAgent = [...byAgentMap.entries()]
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([agentId, projection]) => ({ agentId, ...projection }));
	const body = {
		schemaVersion: COST_TRACE_V2_SCHEMA_VERSION,
		projectionKind: "cost_trace_v2" as const,
		authorityId: first.authorityId,
		tenantId: first.tenantId,
		sessionId: first.sessionId,
		rootAgentId: first.rootAgentId,
		eventHead,
		episodeManifests: [...manifests.values()].sort((left, right) =>
			left.artifactId.localeCompare(right.artifactId)),
		operations: operationProjections,
		byAgent,
		totals: {
			reserved: totalReserved,
			committed: totalCommitted,
			refunded: totalRefunded,
			net: totalNet,
		},
	};
	return { ok: true, value: { ...body, traceDigest: canonicalDigest(body) } };
}

export async function reconcileLateProviderCost(
	trace: CostTraceV2,
	lateCost: UnattributedLateCost,
	findingPort: UnattributedCostFindingPort,
): Promise<TelemetryResult<LateCostReconciliationResult>> {
	const operation = trace.operations.find((candidate) => candidate.operationId === lateCost.operationId);
	const attributable = lateCost.authorityId === trace.authorityId &&
		lateCost.tenantId === trace.tenantId &&
		lateCost.sessionId === trace.sessionId &&
		lateCost.rootAgentId === trace.rootAgentId &&
		operation !== undefined;
	if (attributable) return { ok: true, value: { status: "attributed", trace } };
	const reasonDigest = canonicalDigest({
		code: "unattributed_late_provider_cost",
		traceDigest: trace.traceDigest,
		operationId: lateCost.operationId,
		providerReceiptDigest: lateCost.providerReceiptDigest,
	});
	const finding = await findingPort.recordUnattributedCost(lateCost, reasonDigest);
	return finding.ok
		? { ok: true, value: { status: "finding_recorded", trace, finding: finding.value } }
		: finding;
}
