import { describe, expect, it } from "vitest";
import { canonicalDigest } from "../../../src/runtime/protocol/v3/canonical-json.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/v3/ids.ts";
import { createWorktreeId, type WorkspaceServicePort, type WorkspaceServiceRequest } from "../../../src/runtime/protocol/v3/workspace.ts";
import { TrustedBaselineCoordinator, isTrustedBaselineReceipt } from "../../../src/runtime/verification/baseline.ts";
import { createGateManifest, isGateManifest, loadTrustedGate } from "../../../src/runtime/verification/gate-loader.ts";
import type { TrustedGateSourcePort, TrustedVerificationPolicyPort } from "../../../src/runtime/verification/types.ts";
import {
	AGENT_ID,
	AUTHORITY_ID,
	BASE_COMMIT,
	BASE_WORKSPACE_ID,
	NOW,
	PRINCIPAL_ID,
	REPOSITORY_ID,
	RUNTIME_ID,
	SESSION_ID,
	TENANT_ID,
	TRACE_ID,
	dependencyPolicy,
	gateManifest,
	policy,
} from "./helpers.ts";

class FakeWorkspace implements WorkspaceServicePort {
	readonly requests: WorkspaceServiceRequest[] = [];

	public async request(request: WorkspaceServiceRequest) {
		this.requests.push(request);
		if (request.kind !== "bind") throw new Error("unexpected request");
		return {
			schemaVersion: 1 as const,
			requestId: request.requestId,
			kind: "bound" as const,
			receiptId: createRuntimeId("receipt", "baseline-bind"),
			binding: {
				authorityId: request.authorityId,
				tenantId: request.tenantId,
				workspaceId: BASE_WORKSPACE_ID,
				repositoryId: request.repositoryId,
				bindingKind: "readonly_checkout" as const,
				canonicalCwd: "/trusted/base",
				effectiveCwd: "/trusted/base",
				branch: request.branch,
				baseCommit: request.baseCommit,
				headCommit: request.baseCommit,
				worktreeId: createWorktreeId("trusted-base"),
			},
			lease: {
				authorityId: request.authorityId,
				tenantId: request.tenantId,
				principalId: request.principalId,
				leaseId: createRuntimeId("lease", "trusted-base"),
				workspaceId: BASE_WORKSPACE_ID,
				ownerRuntimeId: request.ownerRuntimeId,
				leaseRevision: 7,
				fencingTokenDigest: canonicalDigest("trusted-fence"),
				state: "active" as const,
			},
		};
	}
}

function request() {
	return {
		requestId: createRuntimeId("command", "baseline-request"),
		authorityId: AUTHORITY_ID,
		tenantId: TENANT_ID,
		principalId: PRINCIPAL_ID,
		sessionId: SESSION_ID,
		agentId: AGENT_ID,
		traceId: TRACE_ID,
		repositoryId: REPOSITORY_ID,
		gateKey: "test",
		ownerRuntimeId: RUNTIME_ID,
	};
}

describe("trusted baseline and exact GateManifest", () => {
	it("materializes an immutable readonly base through the injected Workspace port", async () => {
		const trustedPolicy = policy();
		const policyPort: TrustedVerificationPolicyPort = {
			resolve: async () => ({ ok: true, value: trustedPolicy }),
		};
		const workspace = new FakeWorkspace();
		const coordinator = new TrustedBaselineCoordinator({ policy: policyPort, workspace, clock: () => new Date(NOW) });
		const result = await coordinator.materialize(request());
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(isTrustedBaselineReceipt(result.value.receipt)).toBe(true);
		expect(workspace.requests).toHaveLength(1);
		expect(workspace.requests[0]).toMatchObject({
			kind: "bind",
			bindingKind: "readonly_checkout",
			baseCommit: BASE_COMMIT,
			requestedCwd: "/trusted/base",
		});
		expect(result.value.receipt.materializedCommit).toBe(BASE_COMMIT);
	});

	it("rejects unknown fields, unsafe paths, and internally inconsistent lockfile policy", () => {
		const valid = gateManifest();
		expect(isGateManifest(valid)).toBe(true);
		expect(isGateManifest({ ...valid, candidateOverride: "npm test" })).toBe(false);
		const unsafe = createGateManifest({
			...valid,
			executable: { ...valid.executable, path: "../candidate/test.sh" },
		});
		expect(unsafe.ok).toBe(false);
		const inconsistent = createGateManifest({
			...valid,
			dependencyPolicy: dependencyPolicy({ installMode: "frozen", lockfileSource: "none" }),
		});
		expect(inconsistent.ok).toBe(false);
	});

	it("loads gate schema, policy, and document only when all trusted-base digests correlate", async () => {
		const manifest = gateManifest();
		const trustedPolicy = policy(manifest);
		const baseline = {
			...request(),
		};
		const workspace = new FakeWorkspace();
		const coordinator = new TrustedBaselineCoordinator({
			policy: { resolve: async () => ({ ok: true, value: trustedPolicy }) },
			workspace,
			clock: () => new Date(NOW),
		});
		const materialized = await coordinator.materialize(baseline);
		if (!materialized.ok) throw new Error(materialized.error.message);
		const source: TrustedGateSourcePort = {
			read: async ({ baseline: receipt, protectedPath }) => ({
				ok: true,
				value: {
					baselineReceiptDigest: receipt.receiptDigest,
					sourceCommit: BASE_COMMIT,
					protectedPath,
					document: manifest,
					documentDigest: canonicalDigest(manifest),
				},
			}),
		};
		const loaded = await loadTrustedGate(trustedPolicy, materialized.value.receipt, source);
		expect(loaded.ok && loaded.value.manifest.manifestDigest).toBe(manifest.manifestDigest);

		const candidateSchemaSource: TrustedGateSourcePort = {
			read: async ({ baseline: receipt, protectedPath }) => {
				const forged = { ...manifest, executable: { ...manifest.executable, path: "candidate/test.sh" } };
				return {
					ok: true,
					value: {
						baselineReceiptDigest: receipt.receiptDigest,
						sourceCommit: "candidate-commit",
						protectedPath,
						document: forged,
						documentDigest: canonicalDigest(forged),
					},
				};
			},
		};
		expect((await loadTrustedGate(trustedPolicy, materialized.value.receipt, candidateSchemaSource)).ok).toBe(false);
	});
});
