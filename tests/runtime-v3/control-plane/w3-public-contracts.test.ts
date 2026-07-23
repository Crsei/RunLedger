import { describe, expect, it } from "vitest";
import { DEFAULT_RUNTIME_FEATURES, validateRuntimeFeatureFlags } from "../../../src/runtime/runtime-features.ts";
import {
	type AgentSpawnCommandV2,
	validateControlPlaneV2AgentCommand,
} from "../../../src/runtime/control-plane/multi-agent-contracts.ts";
import { createIdempotencyKey } from "../../../src/runtime/protocol/v3/coordination.ts";
import { createSessionEventStreamRef } from "../../../src/runtime/protocol/v3/events.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/v3/ids.ts";
import type { ArtifactRef } from "../../../src/runtime/protocol/v3/capability.ts";
import type {
	ChildGovernedOperationAdmissionPort,
	ChildRuntimeRecoveryDecision,
	ProductionHeadlessChildRuntimeFactoryPort,
} from "../../../src/runtime/agents/index.ts";

const AUTHORITY_ID = createRuntimeId("authority", "w3-contract");
const TENANT_ID = createRuntimeId("tenant", "w3-contract");
const SESSION_ID = createRuntimeId("session", "w3-contract");
const CHILD_SESSION_ID = createRuntimeId("session", "w3-child-contract");
const PARENT_AGENT_ID = createRuntimeId("agent", "w3-parent");
const CHILD_AGENT_ID = createRuntimeId("agent", "w3-child");
const DIGEST = "a".repeat(64);

function artifact(seed: string): ArtifactRef {
	return {
		authorityId: AUTHORITY_ID,
		tenantId: TENANT_ID,
		artifactId: createRuntimeId("artifact", seed),
		storedDigest: DIGEST,
		kind: "session_report",
		originalSize: 64,
		storedSize: 64,
		mediaType: "application/json",
		redaction: "redacted",
		transformReceipt: createRuntimeId("receipt", `${seed}-transform`),
	};
}

function command(): AgentSpawnCommandV2 {
	return {
		kind: "command",
		type: "agent:spawn",
		commandId: createRuntimeId("command", "w3-spawn"),
		idempotencyKey: createIdempotencyKey("w3-spawn-contract-key"),
		authorityId: AUTHORITY_ID,
		tenantId: TENANT_ID,
		principalId: createRuntimeId("principal", "w3-contract"),
		expectedSessionRevision: {
			stream: createSessionEventStreamRef(
				{ authorityId: AUTHORITY_ID, tenantId: TENANT_ID },
				SESSION_ID,
			),
			sequence: 1,
			eventHash: DIGEST,
		},
		expectedAgentGraphRevision: 3,
		sessionHandle: {
			handleId: "handle_0123456789abcdef",
			sessionId: SESSION_ID,
			generation: 2,
		},
		payload: {
			sessionId: SESSION_ID,
			spec: {
				launchSpecArtifact: artifact("launch"),
				launchSpecDigest: DIGEST,
				promptArtifact: artifact("prompt"),
				promptDigest: DIGEST,
				parentAgentId: PARENT_AGENT_ID,
				childAgentId: CHILD_AGENT_ID,
				childSessionId: CHILD_SESSION_ID,
				role: "build",
			},
		},
	};
}

describe("W3 public contracts", () => {
	it("keeps multiAgent off by default and independent from daemon rollout", () => {
		expect(DEFAULT_RUNTIME_FEATURES.multiAgent).toBe(false);
		expect(validateRuntimeFeatureFlags({
			...DEFAULT_RUNTIME_FEATURES,
			daemon: true,
		})).not.toContain("daemon requires multiAgent");
		expect(validateRuntimeFeatureFlags({
			...DEFAULT_RUNTIME_FEATURES,
			multiAgent: true,
		})).toContain("multiAgent requires sessionV3");
	});

	it("validates exact schema v2 Agent mutations and their generation/revision correlation", () => {
		const valid = command();
		expect(validateControlPlaneV2AgentCommand(valid)).toMatchObject({ ok: true });
		expect(validateControlPlaneV2AgentCommand({
			...valid,
			expectedAgentGraphRevision: -1,
		})).toMatchObject({ ok: false, error: { code: "invalid_request" } });
		expect(validateControlPlaneV2AgentCommand({
			...valid,
			payload: { ...valid.payload, sessionId: CHILD_SESSION_ID },
		})).toMatchObject({ ok: false, error: { code: "invalid_request" } });
	});

	it("exports the production child factory, recovery decision, and governed admission ports", () => {
		const compileOnly: [
			ProductionHeadlessChildRuntimeFactoryPort?,
			ChildRuntimeRecoveryDecision?,
			ChildGovernedOperationAdmissionPort?,
		] = [];
		expect(compileOnly).toEqual([]);
	});
});
