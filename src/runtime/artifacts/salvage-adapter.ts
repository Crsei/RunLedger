/** 将 Phase 1 离线 salvage 报告提交为受授权、仍保持 unattested 的 Artifact。 */

import { Type, type TSchema } from "typebox";
import { Check } from "typebox/value";
import { canonicalDigest, canonicalJson } from "../protocol/v3/canonical-json.ts";
import { ArtifactRefSchema, type ArtifactRef } from "../protocol/v3/capability.ts";
import {
	isRuntimeId,
	type CommandId,
	type PrincipalId,
	type ReceiptId,
} from "../protocol/v3/ids.ts";
import {
	validateForensicSalvageReport,
	type ForensicSalvageReport,
} from "../session/salvage.ts";
import type { ArtifactRepository } from "./cas-store.ts";
import type {
	ArtifactError,
	ArtifactRetentionInput,
	ArtifactResult,
	ArtifactSource,
} from "./types.ts";

export const GOVERNED_SALVAGE_ARTIFACT_SCHEMA_VERSION = 1 as const;

const digestPattern = "^[a-f0-9]{64}$";
const timestampPattern = "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{3})?Z$";
const runtimeId = (kind: string) =>
	Type.String({ pattern: `^${kind}_[A-Za-z0-9][A-Za-z0-9._~-]*$`, maxLength: 128 });
const digest = Type.String({ pattern: digestPattern, minLength: 64, maxLength: 64 });
const timestamp = Type.String({ pattern: timestampPattern, maxLength: 24 });
const exact = <T extends Record<string, TSchema>>(properties: T) =>
	Type.Object(properties, { additionalProperties: false });

const authorizationBodyProperties = {
	schemaVersion: Type.Literal(GOVERNED_SALVAGE_ARTIFACT_SCHEMA_VERSION),
	operation: Type.Literal("store_forensic_salvage_report"),
	authorityId: runtimeId("authority"),
	tenantId: runtimeId("tenant"),
	principalId: runtimeId("principal"),
	intentId: runtimeId("command"),
	sourceSessionId: runtimeId("session"),
	reportArtifactId: runtimeId("artifact"),
	sourceDigest: digest,
	reportDigest: digest,
	retentionDigest: digest,
} as const;

export const GovernedSalvageAuthorizationRequestSchema = exact({
	...authorizationBodyProperties,
	requestDigest: digest,
});

const authorizationDecisionScope = {
	schemaVersion: Type.Literal(GOVERNED_SALVAGE_ARTIFACT_SCHEMA_VERSION),
	authorityId: runtimeId("authority"),
	tenantId: runtimeId("tenant"),
} as const;

export const GovernedSalvageAuthorizationDecisionSchema = Type.Union([
	exact({
		...authorizationDecisionScope,
		decision: Type.Literal("allow"),
		receiptId: runtimeId("receipt"),
		receiptDigest: digest,
	}),
	exact({ ...authorizationDecisionScope, decision: Type.Literal("ask") }),
	exact({ ...authorizationDecisionScope, decision: Type.Literal("deny") }),
	exact({ ...authorizationDecisionScope, decision: Type.Literal("unavailable") }),
]);

const governedReceiptBodyProperties = {
	schemaVersion: Type.Literal(GOVERNED_SALVAGE_ARTIFACT_SCHEMA_VERSION),
	authorityId: runtimeId("authority"),
	tenantId: runtimeId("tenant"),
	principalId: runtimeId("principal"),
	sourceSessionId: runtimeId("session"),
	reportArtifactId: runtimeId("artifact"),
	artifact: ArtifactRefSchema,
	sourceDigest: digest,
	reportDigest: digest,
	readOnly: Type.Literal(true),
	attestation: Type.Literal("unattested"),
	retentionDigest: digest,
	authorizationReceiptId: runtimeId("receipt"),
	authorizationReceiptDigest: digest,
	committedAt: timestamp,
} as const;

export const GovernedSalvageReceiptSchema = exact({
	...governedReceiptBodyProperties,
	receiptDigest: digest,
});

export interface GovernedSalvageAuthorizationRequest {
	schemaVersion: typeof GOVERNED_SALVAGE_ARTIFACT_SCHEMA_VERSION;
	operation: "store_forensic_salvage_report";
	authorityId: ForensicSalvageReport["authorityId"];
	tenantId: ForensicSalvageReport["tenantId"];
	principalId: PrincipalId;
	intentId: CommandId;
	sourceSessionId: ForensicSalvageReport["sourceSessionId"];
	reportArtifactId: ForensicSalvageReport["reportArtifactId"];
	sourceDigest: string;
	reportDigest: string;
	retentionDigest: string;
	requestDigest: string;
}

export type GovernedSalvageAuthorizationDecision =
	| {
			schemaVersion: typeof GOVERNED_SALVAGE_ARTIFACT_SCHEMA_VERSION;
			authorityId: ForensicSalvageReport["authorityId"];
			tenantId: ForensicSalvageReport["tenantId"];
			decision: "allow";
			receiptId: ReceiptId;
			receiptDigest: string;
	  }
	| {
			schemaVersion: typeof GOVERNED_SALVAGE_ARTIFACT_SCHEMA_VERSION;
			authorityId: ForensicSalvageReport["authorityId"];
			tenantId: ForensicSalvageReport["tenantId"];
			decision: "ask" | "deny" | "unavailable";
	  };

export interface GovernedSalvageAuthorizationPort {
	authorize(
		request: GovernedSalvageAuthorizationRequest,
		signal?: AbortSignal,
	): Promise<GovernedSalvageAuthorizationDecision>;
}

export interface GovernedSalvageReceipt {
	schemaVersion: typeof GOVERNED_SALVAGE_ARTIFACT_SCHEMA_VERSION;
	authorityId: ForensicSalvageReport["authorityId"];
	tenantId: ForensicSalvageReport["tenantId"];
	principalId: PrincipalId;
	sourceSessionId: ForensicSalvageReport["sourceSessionId"];
	reportArtifactId: ForensicSalvageReport["reportArtifactId"];
	artifact: ArtifactRef;
	sourceDigest: string;
	reportDigest: string;
	readOnly: true;
	attestation: "unattested";
	retentionDigest: string;
	authorizationReceiptId: ReceiptId;
	authorizationReceiptDigest: string;
	committedAt: string;
	receiptDigest: string;
}

export interface GovernedSalvageArtifactAdapterOptions {
	repository: ArtifactRepository;
	authorization: GovernedSalvageAuthorizationPort;
}

export interface StoreGovernedSalvageReportRequest {
	report: ForensicSalvageReport;
	principalId: PrincipalId;
	producerId: ArtifactSource["producerId"];
	intentId: CommandId;
	retention: ArtifactRetentionInput;
	signal?: AbortSignal;
}

function failure(
	code: ArtifactError["code"],
	message: string,
	retryable = false,
): ArtifactResult<never> {
	return { ok: false, error: { code, message, retryable } };
}

function retentionIsValid(retention: ArtifactRetentionInput): boolean {
	return (
		(retention.expiresAt === undefined || Number.isFinite(Date.parse(retention.expiresAt))) &&
		(retention.referenceCount === undefined ||
			(Number.isSafeInteger(retention.referenceCount) && retention.referenceCount >= 0)) &&
		(retention.pins === undefined ||
			(retention.pins.length <= 256 &&
				new Set(retention.pins).size === retention.pins.length &&
				retention.pins.every((pin) => pin.length >= 1 && pin.length <= 128))) &&
		(retention.legalHold === undefined ||
			retention.legalHold.status === "none" ||
			(retention.legalHold.status === "active" &&
				typeof retention.legalHold.reasonDigest === "string" &&
				/^[a-f0-9]{64}$/.test(retention.legalHold.reasonDigest)))
	);
}

function authorizationRequest(
	request: StoreGovernedSalvageReportRequest,
	retentionDigest: string,
): GovernedSalvageAuthorizationRequest {
	const body = {
		schemaVersion: GOVERNED_SALVAGE_ARTIFACT_SCHEMA_VERSION,
		operation: "store_forensic_salvage_report" as const,
		authorityId: request.report.authorityId,
		tenantId: request.report.tenantId,
		principalId: request.principalId,
		intentId: request.intentId,
		sourceSessionId: request.report.sourceSessionId,
		reportArtifactId: request.report.reportArtifactId,
		sourceDigest: request.report.sourceDigest,
		reportDigest: request.report.reportDigest,
		retentionDigest,
	};
	return { ...body, requestDigest: canonicalDigest(body) };
}

export function isGovernedSalvageAuthorizationRequest(
	value: unknown,
): value is GovernedSalvageAuthorizationRequest {
	if (!Check(GovernedSalvageAuthorizationRequestSchema, value)) return false;
	const request = value as GovernedSalvageAuthorizationRequest;
	const { requestDigest: _requestDigest, ...body } = request;
	return request.requestDigest === canonicalDigest(body);
}

export function isGovernedSalvageAuthorizationDecision(
	value: unknown,
): value is GovernedSalvageAuthorizationDecision {
	return Check(GovernedSalvageAuthorizationDecisionSchema, value);
}

export function isGovernedSalvageReceipt(value: unknown): value is GovernedSalvageReceipt {
	if (!Check(GovernedSalvageReceiptSchema, value)) return false;
	const receipt = value as GovernedSalvageReceipt;
	const { receiptDigest: _receiptDigest, ...body } = receipt;
	return (
		receipt.receiptDigest === canonicalDigest(body) &&
		receipt.artifact.authorityId === receipt.authorityId &&
		receipt.artifact.tenantId === receipt.tenantId &&
		receipt.artifact.artifactId === receipt.reportArtifactId
	);
}

export class GovernedSalvageArtifactAdapter {
	readonly #repository: ArtifactRepository;
	readonly #authorization: GovernedSalvageAuthorizationPort;

	public constructor(options: GovernedSalvageArtifactAdapterOptions) {
		this.#repository = options.repository;
		this.#authorization = options.authorization;
	}

	public async store(
		request: StoreGovernedSalvageReportRequest,
	): Promise<ArtifactResult<GovernedSalvageReceipt>> {
		if (
			!validateForensicSalvageReport(request.report) ||
			!isRuntimeId(request.principalId, "principal") ||
			(!isRuntimeId(request.producerId, "principal") && !isRuntimeId(request.producerId, "agent")) ||
			!isRuntimeId(request.intentId, "command") ||
			!retentionIsValid(request.retention)
		) return failure("invalid_request", "governed salvage Artifact request is invalid");

		let retentionDigest: string;
		try {
			retentionDigest = canonicalDigest(request.retention);
		} catch {
			return failure("invalid_request", "governed salvage retention is not canonical");
		}
		const authorization = authorizationRequest(request, retentionDigest);
		if (!isGovernedSalvageAuthorizationRequest(authorization)) {
			return failure("invalid_request", "governed salvage authorization request is invalid");
		}
		let decision: GovernedSalvageAuthorizationDecision;
		try {
			decision = await this.#authorization.authorize(authorization, request.signal);
		} catch {
			return failure("authorization_unavailable", "governed salvage authorization is unavailable", true);
		}
		if (!isGovernedSalvageAuthorizationDecision(decision)) {
			return failure("authorization_unavailable", "governed salvage authorization decision is invalid", true);
		}
		if (
			decision.authorityId !== request.report.authorityId ||
			decision.tenantId !== request.report.tenantId
		) return failure("authorization_denied", "governed salvage authorization scope does not match");
		if (decision.decision === "unavailable") {
			return failure("authorization_unavailable", "governed salvage authorization is unavailable", true);
		}
		if (decision.decision !== "allow") {
			return failure("authorization_denied", "governed salvage Artifact was not explicitly allowed");
		}

		const written = await this.#repository.write({
			authorityId: request.report.authorityId,
			tenantId: request.report.tenantId,
			artifactId: request.report.reportArtifactId,
			intentId: request.intentId,
			principalId: request.principalId,
			source: {
				sessionId: request.report.sourceSessionId,
				producerId: request.producerId,
			},
			kind: "session_report",
			mediaType: "application/json",
			content: canonicalJson(request.report),
			retention: request.retention,
			redaction: "default",
			createdAt: request.report.generatedAt,
		});
		if (!written.ok) return written;
		if (
			written.value.state !== "committed" ||
			!written.value.reference ||
			!written.value.metadata.committedAt
		) {
			return failure(
				"durable_write_failed",
				"governed salvage Artifact is pending reconciliation",
				true,
			);
		}
		const body = {
			schemaVersion: GOVERNED_SALVAGE_ARTIFACT_SCHEMA_VERSION,
			authorityId: request.report.authorityId,
			tenantId: request.report.tenantId,
			principalId: request.principalId,
			sourceSessionId: request.report.sourceSessionId,
			reportArtifactId: request.report.reportArtifactId,
			artifact: written.value.reference,
			sourceDigest: request.report.sourceDigest,
			reportDigest: request.report.reportDigest,
			readOnly: true as const,
			attestation: "unattested" as const,
			retentionDigest,
			authorizationReceiptId: decision.receiptId,
			authorizationReceiptDigest: decision.receiptDigest,
			committedAt: written.value.metadata.committedAt,
		};
		const receipt: GovernedSalvageReceipt = {
			...body,
			receiptDigest: canonicalDigest(body),
		};
		return isGovernedSalvageReceipt(receipt)
			? { ok: true, value: receipt }
			: failure("corrupted_metadata", "governed salvage receipt is invalid");
	}
}
