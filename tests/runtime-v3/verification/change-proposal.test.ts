import { describe, expect, it, vi } from "vitest";
import { canonicalDigest } from "../../../src/runtime/protocol/v3/canonical-json.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/v3/ids.ts";
import {
	createChangeProposal,
	createHumanGateRequest,
	draftPrProviderReceiptDigest,
	humanGateDecisionDigest,
	isChangeProposalRef,
	requestDraftPr,
	resolveHumanGate,
	type EpisodeSealTrustPort,
} from "../../../src/runtime/verification/change-proposal.ts";
import type {
	ChangeProposalProviderPort,
	DraftPrProviderReceipt,
	DraftPrRequest,
	EpisodeSealCompletionRef,
	HumanGateCoordinatorPort,
	HumanGateDecision,
	HumanGateRequest,
} from "../../../src/runtime/verification/types.ts";
import {
	AUTHORITY_ID,
	BASE_COMMIT,
	CANDIDATE_COMMIT,
	REPOSITORY_ID,
	SESSION_ID,
	TENANT_ID,
	WORKSPACE_ID,
	digest,
} from "./helpers.ts";

const BUILDER_ID = createRuntimeId("principal", "change-proposal-builder");
const REQUESTER_ID = createRuntimeId("principal", "change-proposal-requester");
const REVIEWER_ID = createRuntimeId("principal", "change-proposal-reviewer");
const REQUEST_ID = createRuntimeId("command", "draft-pr-request");
const PROVIDER_ID = "github-enterprise";
const NOW = "2026-07-22T08:00:05.000Z";

function sealReference(): EpisodeSealCompletionRef {
	return {
		authorityId: AUTHORITY_ID,
		tenantId: TENANT_ID,
		sealId: createRuntimeId("episodeSeal", "change-proposal"),
		sealDigest: digest("change-proposal-seal"),
		sealRecordDigest: digest("change-proposal-seal-record"),
		manifestBodyDigest: digest("change-proposal-manifest"),
	};
}

function proposal(episodeSeal: EpisodeSealCompletionRef = sealReference()) {
	const created = createChangeProposal({
		authorityId: AUTHORITY_ID,
		tenantId: TENANT_ID,
		proposalId: createRuntimeId("changeProposal", "verified-change"),
		sessionId: SESSION_ID,
		createdBy: BUILDER_ID,
		repositoryId: REPOSITORY_ID,
		workspaceId: WORKSPACE_ID,
		baseCommit: BASE_COMMIT,
		candidateCommit: CANDIDATE_COMMIT,
		candidateBindingDigest: digest("change-proposal-candidate"),
		proposalArtifact: {
			authorityId: AUTHORITY_ID,
			tenantId: TENANT_ID,
			artifactId: createRuntimeId("artifact", "change-proposal"),
			storedDigest: digest("change-proposal-artifact"),
			kind: "change_proposal",
			originalSize: 256,
			storedSize: 192,
			mediaType: "application/vnd.runledger.change-proposal+json",
			redaction: "redacted",
			transformReceipt: createRuntimeId("receipt", "change-proposal-transform"),
			workspaceId: WORKSPACE_ID,
		},
		verificationReceiptDigests: [digest("verification-a"), digest("verification-b")].sort(),
		episodeSeal,
		createdAt: NOW,
	});
	if (!created.ok) throw new Error(created.error.message);
	return created.value;
}

function draftRequest(overrides: Partial<DraftPrRequest> = {}): DraftPrRequest {
	return {
		authorityId: AUTHORITY_ID,
		tenantId: TENANT_ID,
		requestId: REQUEST_ID,
		idempotencyKey: REQUEST_ID,
		requestedBy: REQUESTER_ID,
		providerId: PROVIDER_ID,
		authorizationReceiptId: createRuntimeId("receipt", "draft-pr-authorization"),
		authorizationReceiptDigest: digest("draft-pr-authorization"),
		proposal: proposal(),
		...overrides,
	};
}

function draftReceipt(request: DraftPrRequest): DraftPrProviderReceipt {
	const body: Omit<DraftPrProviderReceipt, "receiptDigest"> = {
		schemaVersion: 1,
		authorityId: request.authorityId,
		tenantId: request.tenantId,
		receiptId: createRuntimeId("receipt", "draft-pr-provider"),
		requestId: request.requestId,
		providerId: request.providerId,
		proposalId: request.proposal.proposalId,
		proposalDigest: request.proposal.proposalDigest,
		sealId: request.proposal.episodeSeal.sealId,
		sealDigest: request.proposal.episodeSeal.sealDigest,
		repositoryId: request.proposal.repositoryId,
		candidateCommit: request.proposal.candidateCommit,
		draft: true,
		externalReferenceDigest: digest("draft-pr-external-reference"),
		providerRevision: 1,
		createdAt: NOW,
	};
	return { ...body, receiptDigest: draftPrProviderReceiptDigest(body) };
}

function sealTrust(reference = sealReference()): EpisodeSealTrustPort {
	return { verify: async (candidate) => canonicalDigest(candidate) === canonicalDigest(reference) };
}

function humanRequest(): HumanGateRequest {
	const created = createHumanGateRequest({
		authorityId: AUTHORITY_ID,
		tenantId: TENANT_ID,
		humanGateId: createRuntimeId("humanGate", "merge-review"),
		requestId: createRuntimeId("command", "human-gate-request"),
		requestedBy: REQUESTER_ID,
		action: "merge",
		proposal: proposal(),
		requestedAt: NOW,
	});
	if (!created.ok) throw new Error(created.error.message);
	return created.value;
}

function decision(
	request: HumanGateRequest,
	decidedBy = REVIEWER_ID,
	decisionAuthority: HumanGateDecision["decisionAuthority"] = "human",
): HumanGateDecision {
	const body: Omit<HumanGateDecision, "receiptDigest"> = {
		schemaVersion: 1,
		authorityId: request.authorityId,
		tenantId: request.tenantId,
		humanGateId: request.humanGateId,
		requestId: request.requestId,
		proposalId: request.proposal.proposalId,
		proposalDigest: request.proposal.proposalDigest,
		action: request.action,
		decision: "approved",
		decisionAuthority,
		decidedBy,
		receiptId: createRuntimeId("receipt", `human-gate-${decisionAuthority}-${decidedBy}`),
		decisionReasonDigest: digest("human-gate-reason"),
		decidedAt: NOW,
	};
	return { ...body, receiptDigest: humanGateDecisionDigest(body) };
}

function coordinator(resolved: HumanGateDecision): HumanGateCoordinatorPort {
	return {
		request: vi.fn(async () => ({ ok: true as const, value: undefined })),
		resolve: vi.fn(async () => ({ ok: true as const, value: resolved })),
	};
}

describe("verified change proposal boundaries", () => {
	it("creates a Draft PR only from a trusted durable seal and a fully correlated draft receipt", async () => {
		const request = draftRequest();
		const provider: ChangeProposalProviderPort = {
			createDraft: vi.fn(async () => ({ ok: true, value: draftReceipt(request) })),
		};
		const result = await requestDraftPr(request, provider, sealTrust(request.proposal.episodeSeal));
		expect(result.ok && result.value.draft).toBe(true);
		expect(provider.createDraft).toHaveBeenCalledTimes(1);
		expect(isChangeProposalRef({ ...request.proposal, future: true })).toBe(false);
	});

	it("rejects forged or stale seals before calling the provider", async () => {
		const request = draftRequest({ proposal: proposal({ ...sealReference(), sealDigest: digest("stale-seal") }) });
		const provider: ChangeProposalProviderPort = {
			createDraft: vi.fn(async () => ({ ok: true, value: draftReceipt(request) })),
		};
		expect(await requestDraftPr(request, provider, sealTrust())).toMatchObject({
			ok: false,
			error: { code: "untrusted_issuer" },
		});
		expect(provider.createDraft).not.toHaveBeenCalled();
	});

	it("rejects a provider receipt that is not a correlated Draft PR", async () => {
		const request = draftRequest();
		const valid = draftReceipt(request);
		const malformed = { ...valid, draft: false, receiptDigest: digest("forged-draft-receipt") } as unknown as DraftPrProviderReceipt;
		const provider: ChangeProposalProviderPort = {
			createDraft: async () => ({ ok: true, value: malformed }),
		};
		expect(await requestDraftPr(request, provider, sealTrust(request.proposal.episodeSeal))).toMatchObject({
			ok: false,
			error: { code: "scope_mismatch" },
		});
	});

	it("reports an uncertain provider exception without fabricating success", async () => {
		const request = draftRequest();
		const provider: ChangeProposalProviderPort = {
			createDraft: async () => { throw new Error("provider timeout"); },
		};
		expect(await requestDraftPr(request, provider, sealTrust(request.proposal.episodeSeal))).toMatchObject({
			ok: false,
			error: { code: "provider_unavailable", retryable: false },
		});
	});

	it.each(["human", "organization"] as const)("accepts an independent %s decision without executing merge", async (authority) => {
		const request = humanRequest();
		const result = await resolveHumanGate(
			request,
			coordinator(decision(request, REVIEWER_ID, authority)),
			sealTrust(request.proposal.episodeSeal),
		);
		expect(result.ok && result.value.decision).toBe("approved");
	});

	it.each([REQUESTER_ID, BUILDER_ID])("rejects requester or builder self-approval by %s", async (decidedBy) => {
		const request = humanRequest();
		expect(await resolveHumanGate(
			request,
			coordinator(decision(request, decidedBy)),
			sealTrust(request.proposal.episodeSeal),
		)).toMatchObject({ ok: false, error: { code: "human_gate_required" } });
	});
});
