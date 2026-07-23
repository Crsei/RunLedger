import { createIdempotencyKey, type IdempotencyKey } from "../../../src/runtime/protocol/v3/coordination.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/v3/ids.ts";
import type { ArtifactRef } from "../../../src/runtime/protocol/v3/capability.ts";
import type { BudgetLimits, BudgetThreshold } from "../../../src/runtime/orchestrator/budget-guard.ts";
import type { GoalEvidence, OperationBindings } from "../../../src/runtime/orchestrator/types.ts";

let idCounter = 0;

export function nextSeed(prefix: string): string {
	idCounter += 1;
	return `${prefix}-${idCounter}`;
}

export function idempotency(prefix: string): IdempotencyKey {
	return createIdempotencyKey(`${prefix}-${"x".repeat(24)}-${nextSeed("key")}`);
}

export function digest(character = "a"): string {
	return character.repeat(64);
}

export function artifact(seed = nextSeed("artifact")): ArtifactRef {
	return {
		authorityId: createRuntimeId("authority", "test"),
		tenantId: createRuntimeId("tenant", "test"),
		artifactId: createRuntimeId("artifact", seed),
		storedDigest: digest("a"),
		kind: "test_report",
		originalSize: 10,
		storedSize: 10,
		mediaType: "application/json",
		redaction: "redacted",
		transformReceipt: createRuntimeId("receipt", nextSeed("transform")),
	};
}

export function evidence(
	kind: GoalEvidence["kind"],
	outcome: GoalEvidence["outcome"],
): GoalEvidence {
	return {
		kind,
		outcome,
		receiptId: createRuntimeId("receipt", nextSeed(kind)),
		digest: digest("b"),
		issuerId: "runtime-test",
		issuedAt: "2026-07-22T00:00:00.000Z",
	};
}

export function bindings(modelId = "model-a"): OperationBindings {
	return {
		model: {
			modelId,
			profileId: createRuntimeId("resource", `profile-${modelId}`),
			manifestDigest: digest("a"),
			profileDigest: digest("b"),
		},
		tools: {
			snapshotId: createRuntimeId("snapshot", nextSeed("tools")),
			snapshotDigest: digest("c"),
			toolIdentityDigests: [digest("d")],
		},
		resources: {
			snapshotId: createRuntimeId("snapshot", nextSeed("resources")),
			snapshotDigest: digest("e"),
			adapterGeneration: 1,
			adapterGenerationDigest: digest("f"),
		},
		config: { revision: 1, configDigest: digest("1") },
		workspace: {
			workspaceId: createRuntimeId("workspace", "test"),
			bindingRevision: 1,
			bindingDigest: digest("2"),
		},
		capabilities: [
			{
				receiptId: createRuntimeId("receipt", "capability"),
				capability: "workspace_write",
				decisionRevision: 1,
				receiptDigest: digest("3"),
			},
		],
	};
}

export function budgetLimits(threshold: BudgetThreshold = { soft: 80, hard: 100 }): BudgetLimits {
	return {
		inputTokens: { ...threshold },
		outputTokens: { ...threshold },
		usdMicros: { ...threshold },
		wallTimeMs: { ...threshold },
		toolCalls: { ...threshold },
		retries: { ...threshold },
		networkBytes: { ...threshold },
		storageBytes: { ...threshold },
		artifactCount: { ...threshold },
		verifications: { ...threshold },
		activeAgents: { ...threshold },
	};
}
