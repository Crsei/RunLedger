/** 受信 base policy 解析与 readonly checkout receipt 编排。 */

import { Type, type TSchema } from "typebox";
import { Check } from "typebox/value";
import { canonicalDigest } from "../protocol/v3/canonical-json.ts";
import type { WorkspaceServicePort } from "../protocol/v3/workspace.ts";
import { workspaceBindingDigest } from "../protocol/v3/workspace.ts";
import {
	TRUSTED_BASELINE_SCHEMA_VERSION,
	VERIFICATION_SCHEMA_VERSION,
	type TrustedBaselineReceipt,
	type TrustedBaselineRequestContext,
	type TrustedVerificationPolicy,
	type TrustedVerificationPolicyPort,
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
const pathText = Type.String({ minLength: 1, maxLength: 4096 });
const exact = <T extends Record<string, TSchema>>(properties: T) =>
	Type.Object(properties, { additionalProperties: false });

export const TrustedVerificationPolicySchema = exact({
	schemaVersion: Type.Literal(VERIFICATION_SCHEMA_VERSION),
	authorityId: runtimeId("authority"),
	tenantId: runtimeId("tenant"),
	policyId: token,
	policyRevision: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
	repositoryId: runtimeId("repository"),
	baseCommit: token,
	baseBranch: token,
	protectedRoot: pathText,
	gateManifestPath: pathText,
	expectedGateManifestDigest: digest,
	gateSchemaDigest: digest,
	policyDigest: digest,
});

export const TrustedBaselineReceiptSchema = exact({
	schemaVersion: Type.Literal(TRUSTED_BASELINE_SCHEMA_VERSION),
	authorityId: runtimeId("authority"),
	tenantId: runtimeId("tenant"),
	receiptId: runtimeId("receipt"),
	policyId: token,
	policyRevision: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
	policyDigest: digest,
	repositoryId: runtimeId("repository"),
	workspaceId: runtimeId("workspace"),
	bindingDigest: digest,
	leaseRevision: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
	baseCommit: token,
	materializedCommit: token,
	protectedRoot: pathText,
	gateManifestPath: pathText,
	gateSchemaDigest: digest,
	issuedAt: timestamp,
	receiptDigest: digest,
});

function failure(
	code: "invalid_schema" | "invalid_digest" | "scope_mismatch" | "baseline_unavailable",
	message: string,
	retryable = false,
): VerificationCoreResult<never> {
	return { ok: false, error: { code, message, retryable } };
}

function withoutPolicyDigest(policy: TrustedVerificationPolicy): Omit<TrustedVerificationPolicy, "policyDigest"> {
	const { policyDigest: _policyDigest, ...body } = policy;
	return body;
}

function withoutReceiptDigest(receipt: TrustedBaselineReceipt): Omit<TrustedBaselineReceipt, "receiptDigest"> {
	const { receiptDigest: _receiptDigest, ...body } = receipt;
	return body;
}

export function isTrustedVerificationPolicy(value: unknown): value is TrustedVerificationPolicy {
	if (!Check(TrustedVerificationPolicySchema, value)) return false;
	const policy = value as TrustedVerificationPolicy;
	return policy.policyDigest === canonicalDigest(withoutPolicyDigest(policy));
}

export function isTrustedBaselineReceipt(value: unknown): value is TrustedBaselineReceipt {
	if (!Check(TrustedBaselineReceiptSchema, value)) return false;
	const receipt = value as TrustedBaselineReceipt;
	return receipt.receiptDigest === canonicalDigest(withoutReceiptDigest(receipt));
}

export interface TrustedBaselineCoordinatorOptions {
	policy: TrustedVerificationPolicyPort;
	workspace: WorkspaceServicePort;
	clock?: () => Date;
}

/**
 * Runtime 只申请 readonly_checkout；路径规范化、materialization、lease 与 fencing
 * 都由 Workspace adapter 负责。
 */
export class TrustedBaselineCoordinator {
	readonly #policy: TrustedVerificationPolicyPort;
	readonly #workspace: WorkspaceServicePort;
	readonly #clock: () => Date;

	public constructor(options: TrustedBaselineCoordinatorOptions) {
		this.#policy = options.policy;
		this.#workspace = options.workspace;
		this.#clock = options.clock ?? (() => new Date());
	}

	public async materialize(
		request: TrustedBaselineRequestContext,
		signal?: AbortSignal,
	): Promise<VerificationCoreResult<{ policy: TrustedVerificationPolicy; receipt: TrustedBaselineReceipt }>> {
		let resolved: Awaited<ReturnType<TrustedVerificationPolicyPort["resolve"]>>;
		try {
			resolved = await this.#policy.resolve({
				authorityId: request.authorityId,
				tenantId: request.tenantId,
				repositoryId: request.repositoryId,
				gateKey: request.gateKey,
			});
		} catch {
			return failure("baseline_unavailable", "trusted verification policy is unavailable", true);
		}
		if (!resolved.ok) return resolved;
		const policy = resolved.value;
		if (!isTrustedVerificationPolicy(policy)) {
			return failure("invalid_digest", "trusted verification policy failed schema or digest validation");
		}
		if (
			policy.authorityId !== request.authorityId ||
			policy.tenantId !== request.tenantId ||
			policy.repositoryId !== request.repositoryId
		) {
			return failure("scope_mismatch", "trusted verification policy scope does not match request");
		}

		let result: Awaited<ReturnType<WorkspaceServicePort["request"]>>;
		try {
			result = await this.#workspace.request(
				{
					schemaVersion: 1,
					requestId: request.requestId,
					authorityId: request.authorityId,
					tenantId: request.tenantId,
					principalId: request.principalId,
					sessionId: request.sessionId,
					agentId: request.agentId,
					traceId: request.traceId,
					kind: "bind",
					repositoryId: request.repositoryId,
					bindingKind: "readonly_checkout",
					requestedCwd: policy.protectedRoot,
					branch: policy.baseBranch,
					baseCommit: policy.baseCommit,
					ownerRuntimeId: request.ownerRuntimeId,
				},
				signal,
			);
		} catch {
			return failure("baseline_unavailable", "trusted baseline workspace service is unavailable", true);
		}
		if (result.kind !== "bound") {
			return failure("baseline_unavailable", "trusted baseline readonly checkout was rejected", result.kind === "rejected" && result.retryable);
		}
		const binding = result.binding;
		const lease = result.lease;
		if (
			result.requestId !== request.requestId ||
			binding.authorityId !== request.authorityId ||
			binding.tenantId !== request.tenantId ||
			binding.repositoryId !== request.repositoryId ||
			binding.bindingKind !== "readonly_checkout" ||
			binding.baseCommit !== policy.baseCommit ||
			binding.headCommit !== policy.baseCommit ||
			lease.workspaceId !== binding.workspaceId ||
			lease.state !== "active" ||
			lease.authorityId !== request.authorityId ||
			lease.tenantId !== request.tenantId ||
			lease.principalId !== request.principalId
		) {
			return failure("baseline_unavailable", "workspace adapter returned an uncorrelated trusted baseline receipt");
		}
		const body: Omit<TrustedBaselineReceipt, "receiptDigest"> = {
			schemaVersion: TRUSTED_BASELINE_SCHEMA_VERSION,
			authorityId: request.authorityId,
			tenantId: request.tenantId,
			receiptId: result.receiptId,
			policyId: policy.policyId,
			policyRevision: policy.policyRevision,
			policyDigest: policy.policyDigest,
			repositoryId: request.repositoryId,
			workspaceId: binding.workspaceId,
			bindingDigest: workspaceBindingDigest(binding),
			leaseRevision: lease.leaseRevision,
			baseCommit: policy.baseCommit,
			materializedCommit: binding.headCommit,
			protectedRoot: policy.protectedRoot,
			gateManifestPath: policy.gateManifestPath,
			gateSchemaDigest: policy.gateSchemaDigest,
			issuedAt: this.#clock().toISOString(),
		};
		const receipt: TrustedBaselineReceipt = { ...body, receiptDigest: canonicalDigest(body) };
		return isTrustedBaselineReceipt(receipt)
			? { ok: true, value: { policy, receipt } }
			: failure("invalid_schema", "trusted baseline receipt construction failed");
	}
}
