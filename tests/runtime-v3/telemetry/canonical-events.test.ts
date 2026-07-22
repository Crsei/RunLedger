import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalDigest } from "../../../src/runtime/protocol/v3/canonical-json.ts";
import { createIdempotencyKey } from "../../../src/runtime/protocol/v3/coordination.ts";
import type { RuntimeEventV3 } from "../../../src/runtime/protocol/v3/events.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/v3/ids.ts";
import {
	BudgetGuard,
	createBudgetReservationId,
	createBudgetVector,
	type BudgetLimits,
} from "../../../src/runtime/orchestrator/budget-guard.ts";
import { SessionCanonicalBudgetJournal } from "../../../src/runtime/orchestrator/canonical-journals.ts";
import { DEFAULT_RUNTIME_FEATURES } from "../../../src/runtime/runtime-features.ts";
import { readAllRuntimeEvents } from "../../../src/runtime/session/snapshot.ts";
import {
	projectCostTraceFromCanonicalEvents,
	projectRuntimeActivityFromCanonicalEvents,
} from "../../../src/runtime/telemetry/canonical-events.ts";
import { V3SessionManager } from "../../../src/storage/v3-session-manager.ts";

const D = "d".repeat(64);
const roots: string[] = [];

const BUDGET_LIMITS: BudgetLimits = {
	inputTokens: { soft: 10_000_000, hard: 20_000_000 },
	outputTokens: { soft: 10_000_000, hard: 20_000_000 },
	usdMicros: { soft: 10_000_000, hard: 20_000_000 },
	wallTimeMs: { soft: 10_000_000, hard: 20_000_000 },
	toolCalls: { soft: 10_000_000, hard: 20_000_000 },
	retries: { soft: 10_000_000, hard: 20_000_000 },
	networkBytes: { soft: 10_000_000, hard: 20_000_000 },
	storageBytes: { soft: 10_000_000, hard: 20_000_000 },
	artifactCount: { soft: 10_000_000, hard: 20_000_000 },
	verifications: { soft: 10_000_000, hard: 20_000_000 },
	activeAgents: { soft: 10, hard: 20 },
};

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function fixture() {
	const root = mkdtempSync(join(tmpdir(), "runledger-canonical-telemetry-"));
	roots.push(root);
	const manager = await V3SessionManager.create({
		cwd: root,
		sessionDir: join(root, "sessions"),
		features: DEFAULT_RUNTIME_FEATURES,
	});
	const writer = manager.writer();
	const principalId = manager.identity().principalId;
	const traceId = createRuntimeId("trace", "canonical-telemetry");
	const lineage = manager.sessionEvents().lineage();
	const goalId = lineage.goalId;
	const turnId = createRuntimeId("turn", "canonical-telemetry");
	const requestId = createRuntimeId("modelRequest", "canonical-telemetry");
	const agentId = lineage.agentId;
	const toolCallId = createRuntimeId("toolCall", "canonical-telemetry");
	const approvalId = createRuntimeId("approval", "canonical-telemetry");
	const toolRequestId = createRuntimeId("command", "canonical-tool");
	const runtimeId = manager.runtimeId();
	const sessionId = manager.sessionId();
	const verificationId = createRuntimeId("verification", "canonical-telemetry");
	const artifactId = createRuntimeId("artifact", "canonical-telemetry");

	const append = async (draft: Parameters<typeof writer.append>[0]) => {
		const result = await writer.append(draft);
		if (!result.ok) throw new Error(result.error.message);
	};
	await append({ type: "turn.started", principalId, traceId, timestamp: "2026-07-22T00:00:00.000Z", payload: { turnId, goalId } });
	await append({ type: "model.requested", principalId, traceId, timestamp: "2026-07-22T00:00:01.000Z", payload: { turnId, requestId, modelId: "model-safe", contextDigest: D } });
	await append({ type: "model.finished", principalId, traceId, timestamp: "2026-07-22T00:00:03.000Z", payload: { turnId, requestId, responseDigest: D, inputTokens: 80, outputTokens: 20 } });
	await append({ type: "tool.requested", principalId, traceId, timestamp: "2026-07-22T00:00:04.000Z", payload: { turnId, toolCallId, agentId, toolIdentityDigest: D, argumentsDigest: D } });
	await append({
		type: "tool.authorized",
		principalId,
		traceId,
		timestamp: "2026-07-22T00:00:05.000Z",
		payload: {
			toolCallId,
			requestId: toolRequestId,
			decisionReceiptId: createRuntimeId("receipt", "canonical-tool"),
			approvalId,
			sessionId,
			runtimeId,
			runtimeGeneration: 1,
			turnId,
			capability: "workspace_write",
			requestDigest: D,
			policyDigest: D,
			workspaceEnvelopeDigest: D,
			sandboxResolutionReceiptId: createRuntimeId("receipt", "canonical-sandbox"),
		},
	});
	await append({ type: "tool.started", principalId, traceId, timestamp: "2026-07-22T00:00:06.000Z", payload: { toolCallId, invocationDigest: D, workspaceReceiptId: createRuntimeId("receipt", "canonical-workspace") } });
	await append({ type: "tool.finished", principalId, traceId, timestamp: "2026-07-22T00:00:09.000Z", payload: { toolCallId, resultDigest: D } });
	await append({
		type: "permission.requested",
		principalId,
		traceId,
		timestamp: "2026-07-22T00:00:10.000Z",
		payload: {
			approvalId,
			requestId: toolRequestId,
			sessionId,
			runtimeId,
			runtimeGeneration: 1,
			turnId,
			toolCallId,
			capability: "workspace_write",
			resourceKind: "filesystem",
			requestDigest: D,
			policyDigest: D,
			workspaceEnvelopeDigest: D,
			ticketDigest: D,
			scope: "once",
			requestedAt: "2026-07-22T00:00:10.000Z",
			attemptId: createRuntimeId("command", "canonical-permission-attempt"),
			serverScope: "tool_server",
			resourceScopeDigest: D,
			commandScopeDigest: D,
			evidenceComplete: true,
			evidenceTruncated: false,
			originalInputDigest: D,
			summary: {
				operation: "write",
				toolIdentityDigest: D,
				targetDigest: D,
				environmentKeyDigests: [],
			},
		},
	});
	await append({ type: "verification.started", principalId, traceId, timestamp: "2026-07-22T00:00:12.000Z", payload: { verificationId, gateDigest: D, candidateDigest: D, idempotencyKey: createRuntimeId("command", "canonical-verification") } });
	await append({ type: "verification.finished", principalId, traceId, timestamp: "2026-07-22T00:00:14.000Z", payload: { verificationId, outcome: "passed", resultArtifactId: artifactId, issuerReceiptId: createRuntimeId("receipt", "canonical-verification") } });
	await append({ type: "artifact.committed", principalId, traceId, timestamp: "2026-07-22T00:00:15.000Z", payload: { artifactId, operationId: createRuntimeId("command", "canonical-artifact"), storedDigest: D, storedSize: 512, metadataDigest: D, receiptId: createRuntimeId("receipt", "canonical-artifact") } });
	let budgetTime = "2026-07-22T00:00:16.000Z";
	let budgetTrace = 0;
	const budgetJournal = new SessionCanonicalBudgetJournal({
		writer,
		store: manager.eventStore(),
		principalId,
		goalId,
		limits: BUDGET_LIMITS,
		traceIdFactory: () => createRuntimeId("trace", `canonical-budget-${++budgetTrace}`),
	});
	const budget = new BudgetGuard({ goalId, limits: BUDGET_LIMITS, journal: budgetJournal, clock: () => new Date(budgetTime) });
	const reservationId = createBudgetReservationId();
	const reserved = await budget.reserve({
		reservationId,
		operationId: createRuntimeId("command", "canonical-budget-operation"),
		idempotencyKey: createIdempotencyKey("canonical-budget-reserve-key"),
		estimatedUpperBound: createBudgetVector({
			inputTokens: 100,
			outputTokens: 30,
			usdMicros: 900_000,
			wallTimeMs: 10_000,
			toolCalls: 2,
			retries: 3,
			networkBytes: 4_096,
			storageBytes: 1_024,
			artifactCount: 2,
			verifications: 2,
			activeAgents: 1,
		}),
	});
	if (!reserved.ok || reserved.value.status !== "granted") throw new Error("production budget reservation failed");
	budgetTime = "2026-07-22T00:00:17.000Z";
	const committed = await budget.commit({
		reservationId,
		idempotencyKey: createIdempotencyKey("canonical-budget-commit-key"),
		actual: createBudgetVector({
			inputTokens: 80,
			outputTokens: 20,
			usdMicros: 700_000,
			wallTimeMs: 7_000,
			toolCalls: 1,
			retries: 2,
			networkBytes: 2_048,
			storageBytes: 512,
			artifactCount: 1,
			verifications: 1,
		}),
	});
	if (!committed.ok) throw new Error(committed.error.message);
	const secret = "PRIVATE_PROMPT_AND_TOOL_OUTPUT";
	const messageJson = JSON.stringify({ role: "user", content: [{ type: "text", text: secret }] });
	await append({ type: "conversation.message_recorded", principalId, traceId, timestamp: "2026-07-22T00:00:18.000Z", payload: { role: "user", messageJson, contentDigest: canonicalDigest(messageJson) } });
	const flushed = await writer.flush();
	if (!flushed.ok) throw new Error(flushed.error.message);
	const replay = await readAllRuntimeEvents(manager.eventStore());
	if (!replay.ok) throw new Error(replay.error.message);
	return { manager, events: replay.value, ids: { goalId, turnId, toolCallId, approvalId }, secret };
}

describe("canonical Runtime telemetry adapter", () => {
	it("rebuilds RuntimeActivity and multi-dimensional cost without exposing canonical content", async () => {
		const context = await fixture();
		const activity = projectRuntimeActivityFromCanonicalEvents(context.events);
		const cost = projectCostTraceFromCanonicalEvents(context.events);
		expect(activity).toMatchObject({
			ok: true,
			value: {
				schemaVersion: 2,
				lifecycle: "active",
				status: "waiting_permission",
				activeGoalIds: [context.ids.goalId],
				activeTaskIds: [],
				activeTurnId: context.ids.turnId,
				activeToolCallIds: [],
				nestedAgentIds: [],
				waitingPermissionIds: [context.ids.approvalId],
				heartbeat: { observedAt: "2026-07-22T00:00:18.000Z" },
			},
		});
		expect(cost).toMatchObject({
			ok: true,
			value: {
				status: "partial",
				tokens: { input: 80, output: 20 },
				costUsd: 0.7,
				wallTimeMs: 7000,
				tool: { callCount: 1, wallTimeMs: 3000 },
				network: { requestCount: 1, bytesTotal: 2048 },
				storage: { operationCount: 1, bytesWritten: 512, bytesTotal: 512, artifactCount: 1 },
				verification: { runCount: 1, wallTimeMs: 2000, costUsd: 0 },
				retryCount: 2,
			},
		});
		if (!cost.ok) throw new Error(cost.error.message);
		expect(cost.value.unavailableDimensions).toEqual([
			"model_usd",
			"network_bytes_received",
			"network_bytes_sent",
			"storage_bytes_read",
			"verification_usd",
		]);
		expect(context.events.filter((event) => event.type === "budget.transaction_committed")).toHaveLength(2);
		expect(JSON.stringify({ activity, cost })).not.toContain(context.secret);
		expect(JSON.stringify({ activity, cost })).not.toMatch(/messageJson|prompt|tool.output|arguments/iu);
		await context.manager.closeAll();
	});

	it("fails closed on a cross-tenant or re-ordered event chain", async () => {
		const context = await fixture();
		const crossTenant = context.events.map((event, index) => index === 1
			? { ...event, tenantId: createRuntimeId("tenant", "canonical-other") } as RuntimeEventV3
			: event);
		expect(projectRuntimeActivityFromCanonicalEvents(crossTenant)).toMatchObject({ ok: false, error: { code: "scope_mismatch" } });
		expect(projectCostTraceFromCanonicalEvents([...context.events].reverse())).toMatchObject({ ok: false, error: { code: "out_of_order" } });
		await context.manager.closeAll();
	});
});
