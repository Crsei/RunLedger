import { describe, expect, it, vi } from "vitest";
import { canonicalDigest } from "../../../src/runtime/protocol/v3/canonical-json.ts";
import type { ArtifactRef } from "../../../src/runtime/protocol/v3/capability.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/v3/ids.ts";
import {
	TestGeneratorCoordinator,
	createTestGeneratorRequest,
	createTestProposal,
	reviewTestProposal,
	type TestGeneratorPort,
	type TestGeneratorRequest,
	type TestProposal,
	type TestProposalPromotionReceipt,
} from "../../../src/runtime/verification/test-generator.ts";
import {
	AUTHORITY_ID,
	BASE_COMMIT,
	CANDIDATE_COMMIT,
	FINISHED,
	PRINCIPAL_ID,
	REPOSITORY_ID,
	SESSION_ID,
	TENANT_ID,
	WORKSPACE_ID,
	candidate,
	candidateEnvelope,
	digest,
} from "./helpers.ts";

const PROPOSAL_WORKSPACE_ID = createRuntimeId("workspace", "test-proposal");
const GENERATOR_ID = createRuntimeId("principal", "test-generator");
const REVIEWER_ID = createRuntimeId("principal", "test-proposal-reviewer");

function artifact(kind: ArtifactRef["kind"], workspaceId = WORKSPACE_ID): ArtifactRef {
	return {
		authorityId: AUTHORITY_ID,
		tenantId: TENANT_ID,
		artifactId: createRuntimeId("artifact", kind),
		storedDigest: digest(`${kind}:stored`),
		kind,
		originalSize: 128,
		storedSize: 96,
		mediaType: "application/json",
		redaction: "redacted",
		transformReceipt: createRuntimeId("receipt", `${kind}-transform`),
		workspaceId,
	};
}

function request(): TestGeneratorRequest {
	return {
		schemaVersion: 1,
		authorityId: AUTHORITY_ID,
		tenantId: TENANT_ID,
		requestId: createRuntimeId("command", "generate-tests"),
		sessionId: SESSION_ID,
		requestedBy: PRINCIPAL_ID,
		candidate: candidate(),
		trustedBaselineReceiptDigest: digest("trusted-baseline"),
		proposalWorkspace: {
			...candidateEnvelope(),
			workspaceId: PROPOSAL_WORKSPACE_ID,
			worktreePath: "/isolated/test-proposal",
			cwd: "/isolated/test-proposal",
			branch: "agent/test-proposal",
		},
		taskArtifact: artifact("session_report"),
		publicInputArtifacts: [artifact("diff")],
		allowedTestRoots: ["tests", "test"],
		maxFiles: 8,
		maxBytes: 16_384,
	};
}

function proposal(input: TestGeneratorRequest, overrides: Partial<Parameters<typeof createTestProposal>[0]> = {}): TestProposal {
	const created = createTestProposal({
		schemaVersion: 1,
		authorityId: AUTHORITY_ID,
		tenantId: TENANT_ID,
		requestId: input.requestId,
		sessionId: input.sessionId,
		candidate: input.candidate,
		trustedBaselineReceiptDigest: input.trustedBaselineReceiptDigest,
		proposalWorkspaceId: input.proposalWorkspace.workspaceId,
		generatorId: GENERATOR_ID,
		generatorProfileDigest: digest("test-generator-profile"),
		proposalArtifact: artifact("test_report", PROPOSAL_WORKSPACE_ID),
		files: [{ path: "tests/generated.test.ts", contentDigest: digest("generated-test"), size: 512 }],
		trust: "untrusted_proposal",
		producedAt: FINISHED,
		...overrides,
	});
	if (!created.ok) throw new Error(created.error.message);
	return created.value;
}

describe("independent test generator", () => {
	it("only receives bounded public inputs and returns an immutable untrusted proposal", async () => {
		const generate = vi.fn<TestGeneratorPort["generate"]>(async (input) => {
			expect("builderPrivateReasoning" in input).toBe(false);
			return { ok: true, value: proposal(input) };
		});
		const result = await new TestGeneratorCoordinator({ generate }).generate(request());
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.trust).toBe("untrusted_proposal");
		expect(result.value).not.toHaveProperty("outcome");
		expect(Object.isFrozen(result.value)).toBe(true);
		expect(Object.isFrozen(result.value.files)).toBe(true);
		expect(generate).toHaveBeenCalledOnce();
	});

	it("rejects private reasoning and same-workspace requests before invoking the generator", async () => {
		const generate = vi.fn<TestGeneratorPort["generate"]>();
		const coordinator = new TestGeneratorCoordinator({ generate });
		expect((await coordinator.generate({ ...request(), builderPrivateReasoning: "secret" })).ok).toBe(false);
		expect(createTestGeneratorRequest({
			...request(),
			proposalWorkspace: { ...request().proposalWorkspace, workspaceId: WORKSPACE_ID },
		}).ok).toBe(false);
		expect(generate).not.toHaveBeenCalled();
	});

	it("rejects proposal paths outside the tests-only boundary and gate-shaped Artifacts", async () => {
		const input = request();
		const escaped = new TestGeneratorCoordinator({
			generate: async (value) => ({ ok: true, value: proposal(value, {
				files: [{ path: "../ci/trusted-gates/test.json", contentDigest: digest("escape"), size: 10 }],
			}) }),
		});
		expect((await escaped.generate(input)).ok).toBe(false);

		const wrongArtifact = new TestGeneratorCoordinator({
			generate: async (value) => ({ ok: true, value: proposal(value, {
				proposalArtifact: artifact("session_report", PROPOSAL_WORKSPACE_ID),
			}) }),
		});
		expect((await wrongArtifact.generate(input)).ok).toBe(false);
	});

	it("requires an independent promotion receipt before a proposal can enter a later gate", async () => {
		const input = request();
		const generated = proposal(input);
		const policyDigest = digest("test-promotion-policy");
		const nextGateManifestDigest = digest("next-gate-manifest");
		const receipt = (reviewedBy: typeof GENERATOR_ID | typeof REVIEWER_ID): TestProposalPromotionReceipt => {
			const body: Omit<TestProposalPromotionReceipt, "receiptDigest"> = {
				schemaVersion: 1,
				authorityId: AUTHORITY_ID,
				tenantId: TENANT_ID,
				receiptId: createRuntimeId("receipt", `test-promotion-${reviewedBy}`),
				proposalDigest: generated.proposalDigest,
				proposalArtifactId: generated.proposalArtifact.artifactId,
				reviewedBy,
				reviewAuthority: "independent_policy",
				policyDigest,
				nextGateManifestDigest,
				reviewedAt: FINISHED,
			};
			return { ...body, receiptDigest: canonicalDigest(body) };
		};
		const promotionRequest = {
			proposal: generated,
			requestedBy: PRINCIPAL_ID,
			policyDigest,
			nextGateManifestDigest,
		};
		expect((await reviewTestProposal(promotionRequest, {
			review: async () => ({ ok: true, value: receipt(GENERATOR_ID) }),
		})).ok).toBe(false);
		const approved = await reviewTestProposal(promotionRequest, {
			review: async () => ({ ok: true, value: receipt(REVIEWER_ID) }),
		});
		expect(approved.ok && approved.value.reviewedBy).toBe(REVIEWER_ID);
	});

	it("keeps candidate and proposal identities bound to the same repository and base", () => {
		const value = request();
		expect(value.candidate).toMatchObject({
			repositoryId: REPOSITORY_ID,
			workspaceId: WORKSPACE_ID,
			baseCommit: BASE_COMMIT,
			candidateCommit: CANDIDATE_COMMIT,
		});
	});
});
