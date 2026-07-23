/** Runtime v3 的 ChangeProposal 公共合同；正文只存在 immutable Artifact。 */

import { Type, type TSchema } from "typebox";
import { ArtifactRefSchema, type ArtifactRef } from "./capability.ts";
import type {
	AuthorityId,
	ChangeProposalId,
	EpisodeSealId,
	PrincipalId,
	RepositoryId,
	SessionId,
	TenantId,
	WorkspaceId,
} from "./ids.ts";

export const CHANGE_PROPOSAL_SCHEMA_VERSION = 3 as const;

const runtimeId = (kind: string) =>
	Type.String({ pattern: `^${kind}_[A-Za-z0-9][A-Za-z0-9._~-]*$`, maxLength: 128 });
const digest = Type.String({ pattern: "^[a-f0-9]{64}$", maxLength: 64 });
const timestamp = Type.String({
	pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{3})?Z$",
	maxLength: 24,
});
const token = Type.String({ minLength: 1, maxLength: 512 });
const exact = <T extends Record<string, TSchema>>(properties: T) =>
	Type.Object(properties, { additionalProperties: false });

export const EpisodeSealCompletionRefSchema = Type.Unsafe<EpisodeSealCompletionRef>(exact({
	authorityId: runtimeId("authority"),
	tenantId: runtimeId("tenant"),
	sealId: runtimeId("episodeSeal"),
	sealDigest: digest,
	sealRecordDigest: digest,
	manifestBodyDigest: digest,
}));

const changeProposalBodyProperties = {
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
	verificationReceiptDigests: Type.Array(digest, {
		minItems: 1,
		maxItems: 64,
		uniqueItems: true,
	}),
	episodeSeal: EpisodeSealCompletionRefSchema,
	createdAt: timestamp,
} as const;

export const ChangeProposalBodySchema = Type.Unsafe<ChangeProposalBody>(
	exact(changeProposalBodyProperties),
);

export const ChangeProposalRefSchema = Type.Unsafe<ChangeProposalRef>(exact({
	...changeProposalBodyProperties,
	proposalDigest: digest,
}));

export interface EpisodeSealCompletionRef {
	authorityId: AuthorityId;
	tenantId: TenantId;
	sealId: EpisodeSealId;
	sealDigest: string;
	sealRecordDigest: string;
	manifestBodyDigest: string;
}

export interface ChangeProposalBody {
	schemaVersion: typeof CHANGE_PROPOSAL_SCHEMA_VERSION;
	authorityId: AuthorityId;
	tenantId: TenantId;
	proposalId: ChangeProposalId;
	sessionId: SessionId;
	createdBy: PrincipalId;
	repositoryId: RepositoryId;
	workspaceId: WorkspaceId;
	baseCommit: string;
	candidateCommit: string;
	candidateBindingDigest: string;
	proposalArtifact: ArtifactRef;
	verificationReceiptDigests: readonly string[];
	episodeSeal: EpisodeSealCompletionRef;
	createdAt: string;
}

export interface ChangeProposalRef extends ChangeProposalBody {
	proposalDigest: string;
}
