/** Verified ChangeProposal、Draft PR provider 与独立 human gate 合同。 */

import { Type, type TSchema } from "typebox";
import { Check } from "typebox/value";
import { canonicalDigest } from "../protocol/v3/canonical-json.ts";
import { ArtifactRefSchema } from "../protocol/v3/capability.ts";
import { isRuntimeId } from "../protocol/v3/ids.ts";
import {
	CHANGE_PROPOSAL_SCHEMA_VERSION,
	DRAFT_PR_RECEIPT_SCHEMA_VERSION,
	HUMAN_GATE_SCHEMA_VERSION,
	type ChangeProposalBody,
	type ChangeProposalProviderPort,
	type ChangeProposalRef,
	type DraftPrProviderReceipt,
	type DraftPrRequest,
	type EpisodeSealCompletionRef,
	type HumanGateCoordinatorPort,
	type HumanGateDecision,
	type HumanGateRequest,
	type VerificationCoreResult,
} from "./types.ts";

const digest = Type.String({ pattern: "^[a-f0-9]{64}$", maxLength: 64 });
const timestamp = Type.String({
	pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{3})?Z$",
	maxLength: 24,
});
const runtimeId = (kind: string) =>
	Type.String({ pattern: `^${kind}_[A-Za-z0-9][A-Za-z0-9._~-]*$`, maxLength: 128 });
const token = Type.String({ minLength: 1, maxLength: 512 });
const exact = <T extends Record<string, TSchema>>(properties: T) =>
	Type.Object(properties, { additionalProperties: false });

export const EpisodeSealCompletionRefSchema = exact({
	authorityId: runtimeId("authority"),
	tenantId: runtimeId("tenant"),
	sealId: runtimeId("episodeSeal"),
	sealDigest: digest,
	sealRecordDigest: digest,
	manifestBodyDigest: digest,
});

const ChangeProposalBodySchema = exact({
	schemaVersion: Type.Literal(CHANGE_PROPOSAL_SCHEMA_VERSION),
	authorityId: runtimeId("authority"),
	tenantId: runtimeId("tenant"),
	proposalId: runtimeId("changeProposal"),
	sessionId: runtimeId("session"),
	createdBy: runtimeId("principal"),
	repositoryId: runtimeId("repository"),
	workspaceId: runtimeId("workspace"),
	baseCommit: token,
	candidateCommit: token,
	candidateBindingDigest: digest,
	proposalArtifact: ArtifactRefSchema,
	verificationReceiptDigests: Type.Array(digest, { minItems: 1, maxItems: 64, uniqueItems: true }),
	episodeSeal: EpisodeSealCompletionRefSchema,
	createdAt: timestamp,
});

export const ChangeProposalRefSchema = exact({ ...ChangeProposalBodySchema.properties, proposalDigest: digest });

export const DraftPrProviderReceiptSchema = exact({
	schemaVersion: Type.Literal(DRAFT_PR_RECEIPT_SCHEMA_VERSION),
	authorityId: runtimeId("authority"),
	tenantId: runtimeId("tenant"),
	receiptId: runtimeId("receipt"),
	requestId: runtimeId("command"),
	providerId: token,
	proposalId: runtimeId("changeProposal"),
	proposalDigest: digest,
	sealId: runtimeId("episodeSeal"),
	sealDigest: digest,
	repositoryId: runtimeId("repository"),
	candidateCommit: token,
	draft: Type.Literal(true),
	externalReferenceDigest: digest,
	providerRevision: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
	createdAt: timestamp,
	receiptDigest: digest,
});

export const HumanGateRequestSchema = exact({
	schemaVersion: Type.Literal(HUMAN_GATE_SCHEMA_VERSION),
	authorityId: runtimeId("authority"),
	tenantId: runtimeId("tenant"),
	humanGateId: runtimeId("humanGate"),
	requestId: runtimeId("command"),
	requestedBy: runtimeId("principal"),
	action: Type.Union([Type.Literal("merge"), Type.Literal("deploy")]),
	proposal: ChangeProposalRefSchema,
	requestedAt: timestamp,
	requestDigest: digest,
});

export const HumanGateDecisionSchema = exact({
	schemaVersion: Type.Literal(HUMAN_GATE_SCHEMA_VERSION),
	authorityId: runtimeId("authority"),
	tenantId: runtimeId("tenant"),
	humanGateId: runtimeId("humanGate"),
	requestId: runtimeId("command"),
	proposalId: runtimeId("changeProposal"),
	proposalDigest: digest,
	action: Type.Union([Type.Literal("merge"), Type.Literal("deploy")]),
	decision: Type.Union([Type.Literal("approved"), Type.Literal("denied")]),
	decisionAuthority: Type.Union([Type.Literal("human"), Type.Literal("organization")]),
	decidedBy: runtimeId("principal"),
	receiptId: runtimeId("receipt"),
	decisionReasonDigest: digest,
	decidedAt: timestamp,
	receiptDigest: digest,
});

export interface EpisodeSealTrustPort {
	verify(reference: EpisodeSealCompletionRef): Promise<boolean>;
}

function failure(
	code: "invalid_schema" | "invalid_digest" | "scope_mismatch" | "untrusted_issuer" | "provider_unavailable" | "human_gate_required",
	message: string,
	retryable = false,
): VerificationCoreResult<never> {
	return { ok: false, error: { code, message, retryable } };
}

function proposalBody(proposal: ChangeProposalRef): ChangeProposalBody {
	const { proposalDigest: _proposalDigest, ...body } = proposal;
	return body;
}

function draftReceiptBody(receipt: DraftPrProviderReceipt): Omit<DraftPrProviderReceipt, "receiptDigest"> {
	const { receiptDigest: _receiptDigest, ...body } = receipt;
	return body;
}

function humanRequestBody(request: HumanGateRequest): Omit<HumanGateRequest, "requestDigest"> {
	const { requestDigest: _requestDigest, ...body } = request;
	return body;
}

function humanDecisionBody(decision: HumanGateDecision): Omit<HumanGateDecision, "receiptDigest"> {
	const { receiptDigest: _receiptDigest, ...body } = decision;
	return body;
}

function sortedUnique(values: readonly string[]): boolean {
	return values.every((value, index) => index === 0 || value > values[index - 1]!);
}

export function isChangeProposalRef(value: unknown): value is ChangeProposalRef {
	if (!Check(ChangeProposalRefSchema, value)) return false;
	const proposal = value as unknown as ChangeProposalRef;
	return (
		proposal.proposalArtifact.kind === "change_proposal" &&
		proposal.proposalArtifact.authorityId === proposal.authorityId &&
		proposal.proposalArtifact.tenantId === proposal.tenantId &&
		proposal.proposalArtifact.workspaceId === proposal.workspaceId &&
		proposal.episodeSeal.authorityId === proposal.authorityId &&
		proposal.episodeSeal.tenantId === proposal.tenantId &&
		sortedUnique(proposal.verificationReceiptDigests) &&
		proposal.proposalDigest === canonicalDigest(proposalBody(proposal))
	);
}

export function createChangeProposal(
	input: Omit<ChangeProposalBody, "schemaVersion">,
): VerificationCoreResult<ChangeProposalRef> {
	const body: ChangeProposalBody = { ...input, schemaVersion: CHANGE_PROPOSAL_SCHEMA_VERSION };
	const proposal: ChangeProposalRef = { ...body, proposalDigest: canonicalDigest(body) };
	return isChangeProposalRef(proposal)
		? { ok: true, value: proposal }
		: failure("invalid_schema", "ChangeProposal is invalid or not correlated with its Artifact and EpisodeSeal");
}

export function isDraftPrProviderReceipt(value: unknown): value is DraftPrProviderReceipt {
	if (!Check(DraftPrProviderReceiptSchema, value)) return false;
	const receipt = value as unknown as DraftPrProviderReceipt;
	return receipt.receiptDigest === canonicalDigest(draftReceiptBody(receipt));
}

export function draftPrProviderReceiptDigest(
	receipt: Omit<DraftPrProviderReceipt, "receiptDigest">,
): string {
	return canonicalDigest(receipt);
}

function validDraftRequest(request: DraftPrRequest): boolean {
	return (
		isRuntimeId(request.requestId, "command") &&
		isRuntimeId(request.idempotencyKey, "command") &&
		isRuntimeId(request.requestedBy, "principal") &&
		isRuntimeId(request.authorizationReceiptId, "receipt") &&
		/^[a-f0-9]{64}$/.test(request.authorizationReceiptDigest) &&
		request.providerId.length > 0 &&
		isChangeProposalRef(request.proposal) &&
		request.authorityId === request.proposal.authorityId &&
		request.tenantId === request.proposal.tenantId
	);
}

export async function requestDraftPr(
	request: DraftPrRequest,
	provider: ChangeProposalProviderPort,
	sealTrust: EpisodeSealTrustPort,
	signal?: AbortSignal,
): Promise<VerificationCoreResult<DraftPrProviderReceipt>> {
	if (!validDraftRequest(request)) return failure("invalid_schema", "Draft PR request is invalid");
	if (!(await sealTrust.verify(request.proposal.episodeSeal))) {
		return failure("untrusted_issuer", "Draft PR requires a durable trusted EpisodeSeal");
	}
	let created: Awaited<ReturnType<ChangeProposalProviderPort["createDraft"]>>;
	try {
		created = await provider.createDraft(request, signal);
	} catch {
		return failure("provider_unavailable", "Draft PR provider outcome is uncertain", false);
	}
	if (!created.ok) return created;
	const receipt = created.value;
	if (
		!isDraftPrProviderReceipt(receipt) ||
		receipt.authorityId !== request.authorityId ||
		receipt.tenantId !== request.tenantId ||
		receipt.requestId !== request.requestId ||
		receipt.providerId !== request.providerId ||
		receipt.proposalId !== request.proposal.proposalId ||
		receipt.proposalDigest !== request.proposal.proposalDigest ||
		receipt.sealId !== request.proposal.episodeSeal.sealId ||
		receipt.sealDigest !== request.proposal.episodeSeal.sealDigest ||
		receipt.repositoryId !== request.proposal.repositoryId ||
		receipt.candidateCommit !== request.proposal.candidateCommit
	) return failure("scope_mismatch", "Draft PR provider receipt is not correlated with the verified proposal");
	return created;
}

export function isHumanGateRequest(value: unknown): value is HumanGateRequest {
	if (!Check(HumanGateRequestSchema, value)) return false;
	const request = value as unknown as HumanGateRequest;
	return (
		isChangeProposalRef(request.proposal) &&
		request.authorityId === request.proposal.authorityId &&
		request.tenantId === request.proposal.tenantId &&
		request.requestDigest === canonicalDigest(humanRequestBody(request))
	);
}

export function createHumanGateRequest(
	input: Omit<HumanGateRequest, "schemaVersion" | "requestDigest">,
): VerificationCoreResult<HumanGateRequest> {
	const body: Omit<HumanGateRequest, "requestDigest"> = { ...input, schemaVersion: HUMAN_GATE_SCHEMA_VERSION };
	const request: HumanGateRequest = { ...body, requestDigest: canonicalDigest(body) };
	return isHumanGateRequest(request)
		? { ok: true, value: request }
		: failure("invalid_schema", "human gate request is invalid");
}

export function isHumanGateDecision(value: unknown): value is HumanGateDecision {
	if (!Check(HumanGateDecisionSchema, value)) return false;
	const decision = value as unknown as HumanGateDecision;
	return decision.receiptDigest === canonicalDigest(humanDecisionBody(decision));
}

export function humanGateDecisionDigest(
	decision: Omit<HumanGateDecision, "receiptDigest">,
): string {
	return canonicalDigest(decision);
}

export async function resolveHumanGate(
	request: HumanGateRequest,
	coordinator: HumanGateCoordinatorPort,
	sealTrust: EpisodeSealTrustPort,
	signal?: AbortSignal,
): Promise<VerificationCoreResult<HumanGateDecision>> {
	if (!isHumanGateRequest(request)) return failure("invalid_schema", "human gate request is invalid");
	if (!(await sealTrust.verify(request.proposal.episodeSeal))) {
		return failure("untrusted_issuer", "human gate requires a durable trusted EpisodeSeal");
	}
	try {
		const requested = await coordinator.request(request, signal);
		if (!requested.ok) return requested;
		const resolved = await coordinator.resolve(request, signal);
		if (!resolved.ok) return resolved;
		const decision = resolved.value;
		if (
			!isHumanGateDecision(decision) ||
			decision.authorityId !== request.authorityId ||
			decision.tenantId !== request.tenantId ||
			decision.humanGateId !== request.humanGateId ||
			decision.requestId !== request.requestId ||
			decision.proposalId !== request.proposal.proposalId ||
			decision.proposalDigest !== request.proposal.proposalDigest ||
			decision.action !== request.action ||
			decision.decidedBy === request.requestedBy ||
			decision.decidedBy === request.proposal.createdBy
		) return failure("human_gate_required", "human gate decision is untrusted, stale, or self-approved");
		return resolved;
	} catch {
		return failure("provider_unavailable", "human gate coordinator outcome is uncertain", false);
	}
}
