/** Native/organization/project/user policy 的 fail-closed 分层与 Runtime receipt adapter。 */

import { canonicalDigest } from "../../runtime/protocol/v3/canonical-json.ts";
import { createRuntimeId, type ResourceId } from "../../runtime/protocol/v3/ids.ts";
import type {
	ManagedPolicyProviderPort,
	ManagedPolicyResolveRequest,
	ManagedPolicyResolveResult,
} from "../../runtime/identity/enterprise-ports.ts";
import type {
	EnterprisePortResult,
	ManagedPolicySnapshotRef,
	ManagedPolicySource,
	PolicyBindingRefs,
} from "../../runtime/identity/enterprise-types.ts";
import { resolveSecuritySnapshot, type ResolveSecuritySnapshotOptions } from "../config/resolver.ts";
import type {
	ManagedSecurityConstraints,
	SecurityConfigDocument,
	SecurityConfigLayer,
	SecurityPolicySource,
	SecurityResult,
	SecuritySnapshot,
} from "../types.ts";

const SOURCE_STRENGTH: Readonly<Record<SecurityPolicySource, number>> = {
	"native-managed": 700,
	organization: 600,
	managed: 500,
	project: 400,
	user: 300,
	session: 200,
	builtin: 100,
	fallback: 0,
};

const SANDBOX_STRENGTH = { off: 0, external: 1, "workspace-write": 2, "read-only": 3, strict: 4 } as const;

export interface ManagedPolicyRecord {
	authorityId: ManagedPolicyResolveRequest["authorityId"];
	tenantId: ManagedPolicyResolveRequest["tenantId"];
	policyId: ResourceId;
	source: Exclude<SecurityPolicySource, "builtin" | "fallback">;
	priority: number;
	revision: number;
	document: SecurityConfigDocument;
	constraints?: ManagedSecurityConstraints;
	bindings: PolicyBindingRefs;
	signerReceiptId: ManagedPolicySnapshotRef["signerReceiptId"];
	issuedAt: string;
	expiresAt?: string;
	snapshotDigest: string;
}

export interface ManagedPolicyStorePort {
	read(policyId: ResourceId): Promise<ManagedPolicyRecord | undefined>;
}

export interface ManagedPolicyTrustPort {
	verify(record: ManagedPolicyRecord, signal?: AbortSignal): Promise<boolean>;
}

function portFailure(code: "invalid_request" | "not_found" | "denied" | "unavailable" | "stale_receipt" | "scope_mismatch", reason: string, retryable = false): EnterprisePortResult<never> {
	return { ok: false, error: { code, retryable, reasonDigest: canonicalDigest(reason) } };
}

function runtimeSource(source: ManagedPolicyRecord["source"]): ManagedPolicySource {
	switch (source) {
		case "native-managed": return "native-managed";
		case "organization": return "organization";
		case "managed": return "tenant";
		case "project": return "project";
		case "user": return "user";
		case "session": return "session";
	}
}

function snapshotRef(record: ManagedPolicyRecord): ManagedPolicySnapshotRef {
	return {
		schemaVersion: 1,
		authorityId: record.authorityId,
		tenantId: record.tenantId,
		policyId: record.policyId,
		source: runtimeSource(record.source),
		priority: SOURCE_STRENGTH[record.source] + record.priority,
		revision: record.revision,
		snapshotDigest: record.snapshotDigest,
		bindings: record.bindings,
		signerReceiptId: record.signerReceiptId,
		issuedAt: record.issuedAt,
		...(record.expiresAt ? { expiresAt: record.expiresAt } : {}),
	};
}

function sortRecords(records: readonly ManagedPolicyRecord[]): readonly ManagedPolicyRecord[] {
	return [...records].sort((left, right) =>
		SOURCE_STRENGTH[right.source] - SOURCE_STRENGTH[left.source] ||
		right.priority - left.priority || right.revision - left.revision || left.policyId.localeCompare(right.policyId),
	);
}

function combineConstraints(records: readonly ManagedPolicyRecord[]): ManagedSecurityConstraints | undefined {
	const constrained = records.flatMap((record) => record.constraints ? [record.constraints] : []);
	if (constrained.length === 0) return undefined;
	const profiles = constrained.reduce<readonly ManagedSecurityConstraints["allowedProfiles"][number][]>(
		(current, value) => current.filter((profile) => value.allowedProfiles.includes(profile)),
		["read-only", "workspace-write", "headless-workspace", "danger-full-access", "custom"],
	);
	const approvals = constrained.reduce<readonly ManagedSecurityConstraints["allowedApprovalPolicies"][number][]>(
		(current, value) => current.filter((policy) => value.allowedApprovalPolicies.includes(policy)),
		["on-request", "never"],
	);
	const minimumSandbox = constrained.reduce<ManagedSecurityConstraints["minimumSandbox"]>(
		(current, value) => SANDBOX_STRENGTH[value.minimumSandbox] > SANDBOX_STRENGTH[current] ? value.minimumSandbox : current,
		"off",
	);
	return {
		allowedProfiles: profiles,
		allowedApprovalPolicies: approvals,
		minimumSandbox,
		forceNetworkDeny: constrained.some((value) => value.forceNetworkDeny),
	};
}

export class ManagedPolicyResolver implements ManagedPolicyProviderPort {
	readonly #store: ManagedPolicyStorePort;
	readonly #trust: ManagedPolicyTrustPort;
	readonly #clock: () => Date;

	public constructor(store: ManagedPolicyStorePort, trust: ManagedPolicyTrustPort, clock: () => Date = () => new Date()) {
		this.#store = store;
		this.#trust = trust;
		this.#clock = clock;
	}

	async #records(request: ManagedPolicyResolveRequest, signal?: AbortSignal): Promise<EnterprisePortResult<readonly ManagedPolicyRecord[]>> {
		if (new Set(request.sourceSnapshotIds).size !== request.sourceSnapshotIds.length) return portFailure("invalid_request", "managed policy source ids contain duplicates");
		const records: ManagedPolicyRecord[] = [];
		for (const policyId of request.sourceSnapshotIds) {
			let record: ManagedPolicyRecord | undefined;
			try {
				record = await this.#store.read(policyId);
			} catch {
				return portFailure("unavailable", "managed policy store is unavailable", true);
			}
			if (!record) return portFailure("not_found", "managed policy source is missing");
			if (record.authorityId !== request.authorityId || record.tenantId !== request.tenantId) return portFailure("scope_mismatch", "managed policy source crossed authority or tenant");
			if (record.expiresAt && Date.parse(record.expiresAt) <= this.#clock().getTime()) return portFailure("stale_receipt", "managed policy source expired");
			if (record.snapshotDigest !== canonicalDigest({ document: record.document, constraints: record.constraints ?? null, bindings: record.bindings })) {
				return portFailure("stale_receipt", "managed policy source digest is invalid");
			}
			try {
				if (!await this.#trust.verify(record, signal)) return portFailure("denied", "managed policy signature was rejected");
			} catch {
				return portFailure("unavailable", "managed policy trust verifier is unavailable", true);
			}
			records.push(record);
		}
		return { ok: true, value: sortRecords(records) };
	}

	public async resolve(request: ManagedPolicyResolveRequest, signal?: AbortSignal): Promise<EnterprisePortResult<ManagedPolicyResolveResult>> {
		const records = await this.#records(request, signal);
		if (!records.ok) return records;
		const snapshots = records.value.map(snapshotRef);
		const sources = snapshots.map((snapshot) => ({
			policyId: snapshot.policyId,
			source: snapshot.source,
			priority: snapshot.priority,
			revision: snapshot.revision,
			snapshotDigest: snapshot.snapshotDigest,
		}));
		const body = {
			schemaVersion: 1 as const,
			authorityId: request.authorityId,
			tenantId: request.tenantId,
			receiptId: createRuntimeId("receipt", canonicalDigest({ requestId: request.requestId, sources }).slice(0, 48)),
			sources,
			effectivePolicyDigest: canonicalDigest(records.value.map((record) => ({ source: record.source, document: record.document, constraints: record.constraints ?? null }))),
			decisionDigest: canonicalDigest({ resourceDigest: request.resourceDigest, bindings: records.value.map((record) => record.bindings) }),
			evaluatorId: "runledger-security-managed-policy-v1",
			evaluatedAt: this.#clock().toISOString(),
		};
		return { ok: true, value: { snapshots, effective: { ...body, receiptDigest: canonicalDigest(body) } } };
	}

	public async resolveSecurity(
		request: ManagedPolicyResolveRequest,
		options: Omit<ResolveSecuritySnapshotOptions, "layers" | "constraints">,
		signal?: AbortSignal,
	): Promise<SecurityResult<SecuritySnapshot>> {
		const records = await this.#records(request, signal);
		if (!records.ok) return { ok: false, error: { code: "invalid_config", message: records.error.reasonDigest, retryable: records.error.retryable } };
		const layers: SecurityConfigLayer[] = records.value.map((record) => ({ source: record.source, document: record.document, documentDigest: record.snapshotDigest }));
		return resolveSecuritySnapshot({ ...options, layers, constraints: combineConstraints(records.value) });
	}
}
