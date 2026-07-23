import { describe, expect, it } from "vitest";
import { canonicalDigest } from "../../../src/runtime/protocol/v3/canonical-json.ts";
import { createSessionEventStreamRef } from "../../../src/runtime/protocol/v3/events.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/v3/ids.ts";
import {
	aggregateCostTraceV2,
	createCostSettlementV2,
	reconcileLateProviderCost,
	type CostSettlementV2,
	type CostSettlementV2Body,
	type CostUsageV2,
} from "../../../src/runtime/telemetry/cost-v2.ts";

const authorityId = createRuntimeId("authority", "cost-v2");
const tenantId = createRuntimeId("tenant", "cost-v2");
const sessionId = createRuntimeId("session", "cost-v2");
const rootAgentId = createRuntimeId("agent", "cost-v2-root");
const childAgentId = createRuntimeId("agent", "cost-v2-child");
const stream = createSessionEventStreamRef({ authorityId, tenantId }, sessionId);

function usage(usdMicros: number, inputTokens = 0): CostUsageV2 {
	return {
		inputTokens,
		outputTokens: 0,
		usdMicros,
		wallTimeMs: 10,
		toolCalls: 0,
		networkBytes: 0,
		storageBytes: 0,
		artifactCount: 0,
		verifications: 0,
	};
}

function entry(
	seed: string,
	phase: CostSettlementV2Body["phase"],
	value: CostUsageV2,
	agentId = rootAgentId,
	operationId = createRuntimeId("command", `cost-v2-operation-${agentId}`),
	sequence = 4,
): CostSettlementV2 {
	const body: CostSettlementV2Body = {
		schemaVersion: 2,
		authorityId,
		tenantId,
		sessionId,
		rootAgentId,
		agentId,
		operationId,
		entryId: createRuntimeId("receipt", `cost-v2-${seed}`),
		phase,
		usage: value,
		eventHead: {
			stream,
			sequence,
			eventId: createRuntimeId("event", `cost-v2-${sequence}`),
			eventHash: canonicalDigest({ sequence }),
		},
		episodeManifest: {
			artifactId: createRuntimeId("artifact", "cost-v2-manifest"),
			manifestBodyDigest: canonicalDigest("cost-v2-manifest"),
			evidenceHead: {
				stream,
				sequence: 3,
				eventId: createRuntimeId("event", "cost-v2-manifest"),
				eventHash: canonicalDigest("cost-v2-manifest-head"),
			},
		},
		sourceReceiptId: createRuntimeId("receipt", `cost-v2-source-${seed}`),
		sourceReceiptDigest: canonicalDigest({ seed }),
		recordedAt: "2026-07-24T00:00:00.000Z",
	};
	const created = createCostSettlementV2(body);
	if (!created.ok) throw new Error(created.error.message);
	return created.value;
}

describe("CostTraceV2", () => {
	it("binds root/child settlements to canonical head and Episode Manifest", () => {
		const rootOperation = createRuntimeId("command", "cost-v2-root-operation");
		const childOperation = createRuntimeId("command", "cost-v2-child-operation");
		const entries = [
			entry("root-reserve", "reserve", usage(1_000, 100), rootAgentId, rootOperation),
			entry("root-commit", "commit", usage(700, 80), rootAgentId, rootOperation, 5),
			entry("root-refund", "refund", usage(100, 10), rootAgentId, rootOperation, 6),
			entry("child-reserve", "reserve", usage(500, 50), childAgentId, childOperation, 7),
			entry("child-late", "late_provider_commit", usage(400, 40), childAgentId, childOperation, 8),
		];
		const trace = aggregateCostTraceV2(entries);
		expect(trace).toMatchObject({
			ok: true,
			value: {
				rootAgentId,
				eventHead: { sequence: 8 },
				totals: {
					reserved: { usdMicros: 1500 },
					committed: { usdMicros: 1100 },
					refunded: { usdMicros: 100 },
					net: { usdMicros: 1000 },
				},
			},
		});
		if (!trace.ok) return;
		expect(trace.value.byAgent.map((projection) => projection.agentId))
			.toEqual([childAgentId, rootAgentId]);
		expect(trace.value.operations.find((operation) => operation.agentId === childAgentId))
			.toMatchObject({ lateProviderReconciled: true });
	});

	it("rejects over-commit, changed duplicate and incomplete settlement", () => {
		const operationId = createRuntimeId("command", "cost-v2-invalid");
		expect(aggregateCostTraceV2([
			entry("reserve", "reserve", usage(100), rootAgentId, operationId),
			entry("commit", "commit", usage(101), rootAgentId, operationId),
		])).toMatchObject({ ok: false, error: { code: "conflict" } });
		expect(aggregateCostTraceV2([
			entry("reserve-only", "reserve", usage(100), rootAgentId, operationId),
		])).toMatchObject({ ok: false, error: { code: "reconciliation_required" } });
		const duplicate = entry("duplicate", "reserve", usage(100), rootAgentId, operationId);
		expect(aggregateCostTraceV2([
			duplicate,
			{ ...duplicate, entryDigest: canonicalDigest("changed") },
		])).toMatchObject({ ok: false });
	});

	it("routes unattributed late provider charges to the finding port without mutating another trace", async () => {
		const operationId = createRuntimeId("command", "cost-v2-attributed");
		const trace = aggregateCostTraceV2([
			entry("reserve", "reserve", usage(100), rootAgentId, operationId),
			entry("commit", "commit", usage(80), rootAgentId, operationId),
		]);
		if (!trace.ok) throw new Error(trace.error.message);
		let findings = 0;
		const reconciled = await reconcileLateProviderCost(trace.value, {
			authorityId,
			tenantId,
			sessionId: createRuntimeId("session", "foreign"),
			rootAgentId,
			operationId,
			providerReceiptId: createRuntimeId("receipt", "late-provider"),
			providerReceiptDigest: canonicalDigest("late-provider"),
			usage: usage(50),
			observedAt: "2026-07-24T01:00:00.000Z",
		}, {
			recordUnattributedCost: async () => {
				findings += 1;
				return {
					ok: true,
					value: {
						findingId: createRuntimeId("finding", "late-cost"),
						receiptId: createRuntimeId("receipt", "late-cost"),
						receiptDigest: canonicalDigest("late-cost-finding"),
						recordedAt: "2026-07-24T01:00:00.000Z",
					},
				};
			},
		});
		expect(reconciled).toMatchObject({
			ok: true,
			value: { status: "finding_recorded", trace: { traceDigest: trace.value.traceDigest } },
		});
		expect(findings).toBe(1);
	});
});
