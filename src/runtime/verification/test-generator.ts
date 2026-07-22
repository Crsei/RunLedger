/** 独立 Test Generator：只产生未受信 test proposal Artifact，不修改 gate 或签发 pass。 */

import { posix } from "node:path";
import { Type, type TSchema } from "typebox";
import { Check } from "typebox/value";
import { canonicalDigest } from "../protocol/v3/canonical-json.ts";
import { ArtifactRefSchema, type ArtifactRef } from "../protocol/v3/capability.ts";
import { WorkspaceExecutionEnvelopeSchema, type WorkspaceExecutionEnvelope } from "../protocol/v3/workspace.ts";
import { CandidateIdentitySchema } from "./evidence.ts";
import {
	TEST_PROPOSAL_SCHEMA_VERSION,
	type CandidateIdentity,
	type VerificationCoreResult,
	type VerificationScope,
} from "./types.ts";
import type { CommandId, PrincipalId, ReceiptId, SessionId } from "../protocol/v3/ids.ts";

const digest = Type.String({ pattern: "^[a-f0-9]{64}$", maxLength: 64 });
const timestamp = Type.String({
	pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{3})?Z$",
	maxLength: 24,
});
const runtimeId = (kind: string) =>
	Type.String({ pattern: `^${kind}_[A-Za-z0-9][A-Za-z0-9._~-]*$`, maxLength: 128 });
const boundedPath = Type.String({ minLength: 1, maxLength: 1_024 });
const exact = <T extends Record<string, TSchema>>(properties: T) =>
	Type.Object(properties, { additionalProperties: false });

export interface TestGeneratorRequest extends VerificationScope {
	readonly schemaVersion: typeof TEST_PROPOSAL_SCHEMA_VERSION;
	readonly requestId: CommandId;
	readonly sessionId: SessionId;
	readonly requestedBy: PrincipalId;
	readonly candidate: CandidateIdentity;
	readonly trustedBaselineReceiptDigest: string;
	readonly proposalWorkspace: WorkspaceExecutionEnvelope;
	readonly taskArtifact: ArtifactRef;
	readonly publicInputArtifacts: readonly ArtifactRef[];
	readonly allowedTestRoots: readonly string[];
	readonly maxFiles: number;
	readonly maxBytes: number;
}

export interface TestProposalFile {
	readonly path: string;
	readonly contentDigest: string;
	readonly size: number;
}

export interface TestProposalBody extends VerificationScope {
	readonly schemaVersion: typeof TEST_PROPOSAL_SCHEMA_VERSION;
	readonly requestId: CommandId;
	readonly sessionId: SessionId;
	readonly candidate: CandidateIdentity;
	readonly trustedBaselineReceiptDigest: string;
	readonly proposalWorkspaceId: WorkspaceExecutionEnvelope["workspaceId"];
	readonly generatorId: PrincipalId;
	readonly generatorProfileDigest: string;
	readonly proposalArtifact: ArtifactRef;
	readonly files: readonly TestProposalFile[];
	readonly trust: "untrusted_proposal";
	readonly producedAt: string;
}

export interface TestProposal extends TestProposalBody {
	readonly proposalDigest: string;
}

export interface TestGeneratorPort {
	generate(request: TestGeneratorRequest, signal?: AbortSignal): Promise<VerificationCoreResult<TestProposal>>;
}

export interface TestProposalPromotionRequest {
	readonly proposal: TestProposal;
	readonly requestedBy: PrincipalId;
	readonly policyDigest: string;
	readonly nextGateManifestDigest: string;
}

export interface TestProposalPromotionReceipt extends VerificationScope {
	readonly schemaVersion: typeof TEST_PROPOSAL_SCHEMA_VERSION;
	readonly receiptId: ReceiptId;
	readonly proposalDigest: string;
	readonly proposalArtifactId: ArtifactRef["artifactId"];
	readonly reviewedBy: PrincipalId;
	readonly reviewAuthority: "human" | "organization" | "independent_policy";
	readonly policyDigest: string;
	readonly nextGateManifestDigest: string;
	readonly reviewedAt: string;
	readonly receiptDigest: string;
}

/** 此端口由受保护 gate/policy 域实现；Runtime 不改写 GateManifest。 */
export interface TestProposalPromotionPort {
	review(
		request: TestProposalPromotionRequest,
		signal?: AbortSignal,
	): Promise<VerificationCoreResult<TestProposalPromotionReceipt>>;
}

export const TestGeneratorRequestSchema = exact({
	schemaVersion: Type.Literal(TEST_PROPOSAL_SCHEMA_VERSION),
	authorityId: runtimeId("authority"),
	tenantId: runtimeId("tenant"),
	requestId: runtimeId("command"),
	sessionId: runtimeId("session"),
	requestedBy: runtimeId("principal"),
	candidate: CandidateIdentitySchema,
	trustedBaselineReceiptDigest: digest,
	proposalWorkspace: WorkspaceExecutionEnvelopeSchema,
	taskArtifact: ArtifactRefSchema,
	publicInputArtifacts: Type.Array(ArtifactRefSchema, { maxItems: 256 }),
	allowedTestRoots: Type.Array(boundedPath, { minItems: 1, maxItems: 64 }),
	maxFiles: Type.Integer({ minimum: 1, maximum: 4_096 }),
	maxBytes: Type.Integer({ minimum: 1, maximum: 64 * 1024 * 1024 }),
});

const TestProposalBodySchema = exact({
	schemaVersion: Type.Literal(TEST_PROPOSAL_SCHEMA_VERSION),
	authorityId: runtimeId("authority"),
	tenantId: runtimeId("tenant"),
	requestId: runtimeId("command"),
	sessionId: runtimeId("session"),
	candidate: CandidateIdentitySchema,
	trustedBaselineReceiptDigest: digest,
	proposalWorkspaceId: runtimeId("workspace"),
	generatorId: runtimeId("principal"),
	generatorProfileDigest: digest,
	proposalArtifact: ArtifactRefSchema,
	files: Type.Array(exact({
		path: boundedPath,
		contentDigest: digest,
		size: Type.Integer({ minimum: 0, maximum: 64 * 1024 * 1024 }),
	}), { maxItems: 4_096 }),
	trust: Type.Literal("untrusted_proposal"),
	producedAt: timestamp,
});

export const TestProposalSchema = exact({
	...TestProposalBodySchema.properties,
	proposalDigest: digest,
});

export const TestProposalPromotionReceiptSchema = exact({
	schemaVersion: Type.Literal(TEST_PROPOSAL_SCHEMA_VERSION),
	authorityId: runtimeId("authority"),
	tenantId: runtimeId("tenant"),
	receiptId: runtimeId("receipt"),
	proposalDigest: digest,
	proposalArtifactId: runtimeId("artifact"),
	reviewedBy: runtimeId("principal"),
	reviewAuthority: Type.Union([
		Type.Literal("human"),
		Type.Literal("organization"),
		Type.Literal("independent_policy"),
	]),
	policyDigest: digest,
	nextGateManifestDigest: digest,
	reviewedAt: timestamp,
	receiptDigest: digest,
});

function failure(
	code: "invalid_schema" | "scope_mismatch" | "artifact_invalid" | "provider_unavailable" | "human_gate_required",
	message: string,
	retryable = false,
): VerificationCoreResult<never> {
	return { ok: false, error: { code, message, retryable } };
}

function deepFreeze<T>(value: T): T {
	if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
		for (const nested of Object.values(value)) deepFreeze(nested);
		Object.freeze(value);
	}
	return value;
}

function artifactInScope(artifact: ArtifactRef, request: TestGeneratorRequest): boolean {
	return (
		Check(ArtifactRefSchema, artifact) &&
		artifact.authorityId === request.authorityId &&
		artifact.tenantId === request.tenantId
	);
}

function normalizedRelativePath(value: string): string | undefined {
	if (value.includes("\\") || value.includes("\0") || value.startsWith("/")) return undefined;
	const normalized = posix.normalize(value);
	return normalized === "." || normalized === ".." || normalized.startsWith("../") ? undefined : normalized;
}

function pathIsWithinRoots(value: string, roots: readonly string[]): boolean {
	const normalized = normalizedRelativePath(value);
	if (!normalized) return false;
	return roots.some((root) => {
		const normalizedRoot = normalizedRelativePath(root)?.replace(/\/$/, "");
		return normalizedRoot !== undefined && (normalized === normalizedRoot || normalized.startsWith(`${normalizedRoot}/`));
	});
}

function proposalBody(proposal: TestProposal): TestProposalBody {
	const { proposalDigest: _proposalDigest, ...body } = proposal;
	return body;
}

export function createTestProposal(input: TestProposalBody): VerificationCoreResult<TestProposal> {
	if (!Check(TestProposalBodySchema, input)) {
		return failure("invalid_schema", "test proposal body is not exact or bounded");
	}
	const proposal: TestProposal = { ...input, proposalDigest: canonicalDigest(input) };
	return Check(TestProposalSchema, proposal)
		? { ok: true, value: deepFreeze(structuredClone(proposal)) }
		: failure("invalid_schema", "test proposal is invalid");
}

function promotionReceiptBody(
	receipt: TestProposalPromotionReceipt,
): Omit<TestProposalPromotionReceipt, "receiptDigest"> {
	const { receiptDigest: _receiptDigest, ...body } = receipt;
	return body;
}

export function createTestGeneratorRequest(value: unknown): VerificationCoreResult<TestGeneratorRequest> {
	if (!Check(TestGeneratorRequestSchema, value)) {
		return failure("invalid_schema", "test generator request is not exact or bounded");
	}
	const request = value as unknown as TestGeneratorRequest;
	if (
		request.authorityId !== request.candidate.authorityId ||
		request.tenantId !== request.candidate.tenantId ||
		request.proposalWorkspace.authorityId !== request.authorityId ||
		request.proposalWorkspace.tenantId !== request.tenantId ||
		request.proposalWorkspace.repositoryId !== request.candidate.repositoryId ||
		request.proposalWorkspace.workspaceId === request.candidate.workspaceId ||
		request.proposalWorkspace.baseCommit !== request.candidate.baseCommit
	) return failure("scope_mismatch", "test generator must use a distinct, correlated proposal workspace");
	if (
		!artifactInScope(request.taskArtifact, request) ||
		!request.publicInputArtifacts.every((artifact) => artifactInScope(artifact, request))
	) return failure("artifact_invalid", "test generator input Artifact is outside the request scope");
	if (!request.allowedTestRoots.every((root) => normalizedRelativePath(root) !== undefined)) {
		return failure("invalid_schema", "test generator allowed root is not a safe relative path");
	}
	return { ok: true, value: deepFreeze(structuredClone(request)) };
}

export function isTestProposal(value: unknown): value is TestProposal {
	if (!Check(TestProposalSchema, value)) return false;
	const proposal = value as unknown as TestProposal;
	return proposal.proposalDigest === canonicalDigest(proposalBody(proposal));
}

function validateProposal(request: TestGeneratorRequest, proposal: TestProposal): VerificationCoreResult<TestProposal> {
	if (!isTestProposal(proposal)) return failure("invalid_schema", "test generator returned a non-canonical proposal");
	if (
		proposal.authorityId !== request.authorityId ||
		proposal.tenantId !== request.tenantId ||
		proposal.requestId !== request.requestId ||
		proposal.sessionId !== request.sessionId ||
		proposal.candidate.candidateCommit !== request.candidate.candidateCommit ||
		proposal.candidate.workspaceId !== request.candidate.workspaceId ||
		proposal.trustedBaselineReceiptDigest !== request.trustedBaselineReceiptDigest ||
		proposal.proposalWorkspaceId !== request.proposalWorkspace.workspaceId
	) return failure("scope_mismatch", "test proposal does not bind the requested candidate and isolated workspace");
	if (
		proposal.proposalArtifact.kind !== "test_report" ||
		proposal.proposalArtifact.workspaceId !== request.proposalWorkspace.workspaceId ||
		!artifactInScope(proposal.proposalArtifact, request)
	) return failure("artifact_invalid", "test proposal Artifact is not scoped to the proposal workspace");
	const totalBytes = proposal.files.reduce((total, file) => total + file.size, 0);
	if (
		proposal.files.length === 0 ||
		proposal.files.length > request.maxFiles ||
		totalBytes > request.maxBytes ||
		!proposal.files.every((file) => pathIsWithinRoots(file.path, request.allowedTestRoots))
	) return failure("invalid_schema", "test proposal exceeds its file, byte, or path boundary");
	return { ok: true, value: deepFreeze(structuredClone(proposal)) };
}

export class TestGeneratorCoordinator {
	readonly #generator: TestGeneratorPort;

	public constructor(generator: TestGeneratorPort) {
		this.#generator = generator;
	}

	public async generate(value: unknown, signal?: AbortSignal): Promise<VerificationCoreResult<TestProposal>> {
		const request = createTestGeneratorRequest(value);
		if (!request.ok) return request;
		let generated: Awaited<ReturnType<TestGeneratorPort["generate"]>>;
		try {
			generated = await this.#generator.generate(request.value, signal);
		} catch {
			return failure("provider_unavailable", "test generator is unavailable", true);
		}
		return generated.ok ? validateProposal(request.value, generated.value) : generated;
	}
}

export async function reviewTestProposal(
	request: TestProposalPromotionRequest,
	port: TestProposalPromotionPort,
	signal?: AbortSignal,
): Promise<VerificationCoreResult<TestProposalPromotionReceipt>> {
	if (
		!isTestProposal(request.proposal) ||
		!Check(runtimeId("principal"), request.requestedBy) ||
		!Check(digest, request.policyDigest) ||
		!Check(digest, request.nextGateManifestDigest)
	) return failure("invalid_schema", "test proposal promotion request is invalid");
	let reviewed: Awaited<ReturnType<TestProposalPromotionPort["review"]>>;
	try {
		reviewed = await port.review(request, signal);
	} catch {
		return failure("provider_unavailable", "test proposal review authority is unavailable", true);
	}
	if (!reviewed.ok) return reviewed;
	const receipt = reviewed.value;
	if (
		!Check(TestProposalPromotionReceiptSchema, receipt) ||
		receipt.receiptDigest !== canonicalDigest(promotionReceiptBody(receipt)) ||
		receipt.authorityId !== request.proposal.authorityId ||
		receipt.tenantId !== request.proposal.tenantId ||
		receipt.proposalDigest !== request.proposal.proposalDigest ||
		receipt.proposalArtifactId !== request.proposal.proposalArtifact.artifactId ||
		receipt.policyDigest !== request.policyDigest ||
		receipt.nextGateManifestDigest !== request.nextGateManifestDigest ||
		receipt.reviewedBy === request.proposal.generatorId
	) return failure("human_gate_required", "test proposal lacks an independent, correlated promotion receipt");
	return { ok: true, value: deepFreeze(structuredClone(receipt)) };
}
