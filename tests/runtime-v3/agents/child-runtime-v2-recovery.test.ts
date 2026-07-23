import { describe, expect, it } from "vitest";
import {
	assessChildRuntimeColdRecovery,
	childRuntimeDescriptorV2Digest,
	childRuntimeExecutionRecordV2Digest,
	isChildRuntimeExecutionRecordV2,
	type ChildRuntimeDescriptorV2,
	type ChildRuntimeExecutionRecordV2,
} from "../../../src/runtime/agents/child-runtime-contracts.ts";
import {
	ChildGovernedOperationAdmission,
	type ChildOperationAdmissionEvidence,
} from "../../../src/runtime/agents/governed-operation-admission.ts";
import {
	ChildRuntimeGenerationCoordinator,
	MemoryChildRuntimeGenerationStore,
	childRuntimeGenerationHandle,
	createInitialChildRuntimeGenerationAuthority,
} from "../../../src/runtime/agents/child-runtime-generation.ts";
import { canonicalDigest } from "../../../src/runtime/protocol/v3/canonical-json.ts";
import { createSessionEventStreamRef } from "../../../src/runtime/protocol/v3/events.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/v3/ids.ts";
import type { ArtifactRef } from "../../../src/runtime/protocol/v3/capability.ts";

const AUTHORITY_ID = createRuntimeId("authority", "child-v2");
const TENANT_ID = createRuntimeId("tenant", "child-v2");
const PRINCIPAL_ID = createRuntimeId("principal", "child-v2");
const PARENT_SESSION_ID = createRuntimeId("session", "child-v2-parent");
const SESSION_ID = createRuntimeId("session", "child-v2");
const PARENT_AGENT_ID = createRuntimeId("agent", "child-v2-parent");
const AGENT_ID = createRuntimeId("agent", "child-v2");
const WORKSPACE_ID = createRuntimeId("workspace", "child-v2");
const DIGEST = canonicalDigest("child runtime v2 fixture");
const NOW = "2026-07-24T00:00:00.000Z";

function artifact(seed: string): ArtifactRef {
	return {
		authorityId: AUTHORITY_ID,
		tenantId: TENANT_ID,
		artifactId: createRuntimeId("artifact", seed),
		storedDigest: DIGEST,
		kind: "session_report",
		originalSize: 32,
		storedSize: 32,
		mediaType: "application/json",
		redaction: "redacted",
		transformReceipt: createRuntimeId("receipt", `${seed}-transform`),
		workspaceId: WORKSPACE_ID,
	};
}

function descriptor(): ChildRuntimeDescriptorV2 {
	const body = {
		schemaVersion: 2 as const,
		descriptorId: createRuntimeId("resource", "child-v2-runtime"),
		runtimeId: createRuntimeId("runtime", "child-v2-runtime"),
		providerId: "deepseek",
		modelId: "deepseek-v4-pro",
		profileDigest: DIGEST,
		resourceGeneration: 4,
		resourceManifestDigest: DIGEST,
		toolGeneration: 7,
		toolManifestDigest: DIGEST,
		factoryGeneration: 2,
	};
	return { ...body, descriptorDigest: childRuntimeDescriptorV2Digest(body) };
}

function cursor(sequence = 3) {
	return {
		stream: createSessionEventStreamRef(
			{ authorityId: AUTHORITY_ID, tenantId: TENANT_ID },
			SESSION_ID,
		),
		sequence,
		eventId: createRuntimeId("event", `child-v2-${sequence}`),
		eventHash: DIGEST,
	};
}

function record(
	state: ChildRuntimeExecutionRecordV2["state"],
	options: { activation?: boolean; completion?: boolean } = {},
): ChildRuntimeExecutionRecordV2 {
	const runtimeDescriptor = descriptor();
	const activationRequestId = createRuntimeId("command", "child-v2-activate");
	const activationRequestDigest = canonicalDigest("child-v2 activation");
	const body: Omit<ChildRuntimeExecutionRecordV2, "recordDigest"> = {
		schemaVersion: 2,
		kind: "child_runtime_execution",
		state,
		revision: 4,
		authorityId: AUTHORITY_ID,
		tenantId: TENANT_ID,
		principalId: PRINCIPAL_ID,
		parentSessionId: PARENT_SESSION_ID,
		parentAgentId: PARENT_AGENT_ID,
		agentId: AGENT_ID,
		sessionId: SESSION_ID,
		workspaceId: WORKSPACE_ID,
		role: "build",
		objectiveDigest: DIGEST,
		promptArtifact: artifact("child-v2-prompt"),
		promptDigest: DIGEST,
		runtimeDescriptor,
		activationRequestId,
		activationRequestDigest,
		...(options.activation
			? {
					activationReceipt: {
						receiptId: createRuntimeId("receipt", "child-v2-activation"),
						requestId: activationRequestId,
						requestDigest: activationRequestDigest,
						runtimeDescriptorDigest: runtimeDescriptor.descriptorDigest,
						activatedAt: NOW,
						receiptDigest: DIGEST,
					},
				}
			: {}),
		...(options.completion
			? {
					completionReceipt: {
						receiptId: createRuntimeId("receipt", "child-v2-completion"),
						requestId: createRuntimeId("command", "child-v2-completion"),
						requestDigest: canonicalDigest("child-v2 completion"),
						outcome: "completed" as const,
						finalCursor: cursor(),
						artifactRefs: [artifact("child-v2-result")],
						completedAt: NOW,
						receiptDigest: DIGEST,
					},
				}
			: {}),
		updatedAt: NOW,
	};
	return { ...body, recordDigest: childRuntimeExecutionRecordV2Digest(body) };
}

const COMPLETE_EVIDENCE = {
	outcomeKnown: true,
	writerEvidenceComplete: true,
	stopEvidenceComplete: true,
	finalCursorComplete: true,
};

describe("child runtime authority v2 cold recovery", () => {
	it("restores only an exactly described active runtime", () => {
		const active = record("active", { activation: true });
		expect(isChildRuntimeExecutionRecordV2(active)).toBe(true);
		expect(assessChildRuntimeColdRecovery(active, COMPLETE_EVIDENCE)).toMatchObject({
			ok: true,
			value: {
				kind: "restore_exact",
				descriptor: { providerId: "deepseek", modelId: "deepseek-v4-pro" },
			},
		});
		expect(assessChildRuntimeColdRecovery({
			...active,
			runtimeDescriptor: { ...active.runtimeDescriptor, modelId: "changed" },
		}, COMPLETE_EVIDENCE)).toMatchObject({
			ok: false,
			error: { code: "invalid_request" },
		});
	});

	it("never retries an unknown provider/tool outcome and quarantines incomplete terminal evidence", () => {
		const active = record("completion_pending", { activation: true });
		expect(assessChildRuntimeColdRecovery(active, {
			...COMPLETE_EVIDENCE,
			outcomeKnown: false,
		})).toMatchObject({ ok: true, value: { kind: "stop_uncertain" } });

		const completed = record("completed", { activation: true, completion: true });
		expect(assessChildRuntimeColdRecovery(completed, COMPLETE_EVIDENCE)).toMatchObject({
			ok: true,
			value: { kind: "replay_terminal", completion: { outcome: "completed" } },
		});
		expect(assessChildRuntimeColdRecovery(completed, {
			...COMPLETE_EVIDENCE,
			finalCursorComplete: false,
		})).toMatchObject({
			ok: true,
			value: { kind: "quarantine", operatorResolution: "supply_evidence" },
		});
	});
});

describe("unified child governed operation admission", () => {
	it("admits every operation kind through one exact scope/generation check and rejects drift", async () => {
		const evidence: ChildOperationAdmissionEvidence = {
			agentId: AGENT_ID,
			sessionId: SESSION_ID,
			workspaceId: WORKSPACE_ID,
			capabilityReceiptDigest: DIGEST,
			workspaceReceiptDigest: DIGEST,
			resourceGeneration: 4,
			resourceManifestDigest: DIGEST,
			evidenceDigest: DIGEST,
		};
		const admission = new ChildGovernedOperationAdmission({
			resolver: { resolve: async () => ({ ok: true, value: evidence }) },
			clock: () => new Date(NOW),
		});
		for (const operation of ["provider", "tool", "isolated_command", "resume", "cancel"] as const) {
			const result = await admission.admit({
				requestId: createRuntimeId("command", `child-v2-${operation}`),
				agentId: AGENT_ID,
				sessionId: SESSION_ID,
				workspaceId: WORKSPACE_ID,
				operation,
				capabilityReceiptDigest: DIGEST,
				workspaceReceiptDigest: DIGEST,
				resourceGeneration: 4,
				resourceManifestDigest: DIGEST,
				operationDigest: DIGEST,
			});
			expect(result).toMatchObject({ ok: true, value: { decision: "allowed", operation } });
		}
		const drifted = await admission.admit({
			requestId: createRuntimeId("command", "child-v2-drift"),
			agentId: AGENT_ID,
			sessionId: SESSION_ID,
			workspaceId: WORKSPACE_ID,
			operation: "tool",
			capabilityReceiptDigest: DIGEST,
			workspaceReceiptDigest: DIGEST,
			resourceGeneration: 5,
			resourceManifestDigest: DIGEST,
			operationDigest: DIGEST,
		});
		expect(drifted).toMatchObject({
			ok: false,
			error: { code: "delegation_invalid", retryable: false },
		});
	});
});

describe("child runtime generation replacement", () => {
	it("commits replacement authority before drain and permanently fences old handles", async () => {
		const store = new MemoryChildRuntimeGenerationStore();
		const first = childRuntimeGenerationHandle({
			handleId: "child-handle-generation-1",
			agentId: AGENT_ID,
			sessionId: SESSION_ID,
			descriptor: descriptor(),
			generation: 1,
		});
		store.seed(createInitialChildRuntimeGenerationAuthority({ handle: first }));
		const coordinator = new ChildRuntimeGenerationCoordinator({
			store,
			clock: () => new Date(NOW),
		});
		const replacementDescriptor = {
			...descriptor(),
			runtimeId: createRuntimeId("runtime", "child-v2-runtime-2"),
			factoryGeneration: 3,
		};
		const replacementDescriptorBody = {
			schemaVersion: replacementDescriptor.schemaVersion,
			descriptorId: replacementDescriptor.descriptorId,
			runtimeId: replacementDescriptor.runtimeId,
			providerId: replacementDescriptor.providerId,
			modelId: replacementDescriptor.modelId,
			profileDigest: replacementDescriptor.profileDigest,
			resourceGeneration: replacementDescriptor.resourceGeneration,
			resourceManifestDigest: replacementDescriptor.resourceManifestDigest,
			toolGeneration: replacementDescriptor.toolGeneration,
			toolManifestDigest: replacementDescriptor.toolManifestDigest,
			factoryGeneration: replacementDescriptor.factoryGeneration,
		};
		replacementDescriptor.descriptorDigest =
			childRuntimeDescriptorV2Digest(replacementDescriptorBody);
		const second = childRuntimeGenerationHandle({
			handleId: "child-handle-generation-2",
			agentId: AGENT_ID,
			sessionId: SESSION_ID,
			descriptor: replacementDescriptor,
			generation: 2,
		});
		const replaced = await coordinator.replace({
			previous: first,
			replacement: second,
			authorityCommitCursor: cursor(5),
			drainPrevious: async () => {
				expect(await coordinator.validateHandle(first)).toMatchObject({
					ok: false,
					error: { code: "reference_unavailable" },
				});
				expect(await coordinator.validateHandle(second)).toMatchObject({ ok: true });
			},
		});
		expect(replaced).toMatchObject({
			ok: true,
			value: {
				previousGeneration: 1,
				replacementGeneration: 2,
				drainStatus: "completed",
			},
		});
		expect(await coordinator.validateHandle(first)).toMatchObject({ ok: false });
		expect(await coordinator.validateHandle(second)).toMatchObject({ ok: true });
	});
});
