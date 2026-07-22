import { describe, expect, it } from "vitest";
import { canonicalDigest } from "../../src/runtime/protocol/v3/canonical-json.ts";
import { createRuntimeId } from "../../src/runtime/protocol/v3/ids.ts";
import type { ManagedPolicyResolveRequest } from "../../src/runtime/identity/enterprise-ports.ts";
import type { RemoteExecutorInvocation } from "../../src/runtime/executors/types.ts";
import { CredentialBroker, type CredentialMaterialHandle } from "../../src/security/enterprise/credential-broker.ts";
import { ManagedPolicyResolver, type ManagedPolicyRecord } from "../../src/security/enterprise/managed-policy.ts";
import { SecureRemoteExecutorPort, SecureSessionHandoffPort } from "../../src/security/enterprise/remote-executor.ts";
import { handoff, handoffReceipt, invocation, result } from "../runtime-v3/executors/helpers.ts";

const NOW = new Date("2026-07-22T00:00:00.000Z");

function policyRecord(source: ManagedPolicyRecord["source"], seed: string, profile: "workspace-write" | "danger-full-access", tenant = "enterprise"): ManagedPolicyRecord {
	const document = { profile } as const;
	const constraints = source === "native-managed" ? {
		allowedProfiles: ["workspace-write"] as const,
		allowedApprovalPolicies: ["on-request"] as const,
		minimumSandbox: "workspace-write" as const,
		forceNetworkDeny: true,
	} : undefined;
	const bindings = {};
	return {
		authorityId: createRuntimeId("authority", "enterprise"), tenantId: createRuntimeId("tenant", tenant),
		policyId: createRuntimeId("resource", `policy-${seed}`), source, priority: 1, revision: 1,
		document, ...(constraints ? { constraints } : {}), bindings,
		signerReceiptId: createRuntimeId("receipt", `policy-signer-${seed}`), issuedAt: NOW.toISOString(),
		snapshotDigest: canonicalDigest({ document, constraints: constraints ?? null, bindings }),
	};
}

function policyRequest(records: readonly ManagedPolicyRecord[]): ManagedPolicyResolveRequest {
	return {
		authorityId: createRuntimeId("authority", "enterprise"), tenantId: createRuntimeId("tenant", "enterprise"),
		requestId: createRuntimeId("command", "resolve-enterprise-policy"), principalId: createRuntimeId("principal", "enterprise"),
		resourceDigest: "a".repeat(64), sourceSnapshotIds: records.map((record) => record.policyId), requestedAt: NOW.toISOString(),
	};
}

describe("managed policy attacks", () => {
	it("keeps native managed constraints above a permissive user policy", async () => {
		const records = [
			policyRecord("user", "user", "danger-full-access"),
			policyRecord("native-managed", "native", "workspace-write"),
		];
		const resolver = new ManagedPolicyResolver(
			{ read: async (id) => records.find((record) => record.policyId === id) },
			{ verify: async () => true },
			() => NOW,
		);
		const resolved = await resolver.resolve(policyRequest(records));
		expect(resolved).toMatchObject({ ok: true, value: { snapshots: [{ source: "native-managed" }, { source: "user" }] } });
		const security = await resolver.resolveSecurity(policyRequest(records), {
			workspaceRoot: "/repo", tempRoot: "/tmp/session", createdAt: NOW.toISOString(),
		});
		expect(security).toMatchObject({
			ok: true,
			value: { profile: { name: "workspace-write", sandbox: "workspace-write", network: { mode: "deny" } } },
		});
	});

	it("fails closed for a cross-tenant or unsigned source", async () => {
		const crossTenant = policyRecord("organization", "cross", "workspace-write", "other");
		const scoped = new ManagedPolicyResolver({ read: async () => crossTenant }, { verify: async () => true }, () => NOW);
		expect(await scoped.resolve(policyRequest([crossTenant]))).toMatchObject({ ok: false, error: { code: "scope_mismatch" } });

		const local = policyRecord("organization", "unsigned", "workspace-write");
		const unsigned = new ManagedPolicyResolver({ read: async () => local }, { verify: async () => false }, () => NOW);
		expect(await unsigned.resolve(policyRequest([local]))).toMatchObject({ ok: false, error: { code: "denied" } });
	});
});

describe("credential isolation attacks", () => {
	it("returns only audience-bound refs and opaque handles, then rejects replay after revoke", async () => {
		const secret = "super-secret-token";
		const material: CredentialMaterialHandle = {
			handleId: createRuntimeId("resource", "credential-handle"), keyRefId: createRuntimeId("resource", "credential-key"),
			credentialKind: "github-token", audienceDigest: "b".repeat(64), providerRevision: 1,
		};
		let injectedHandle: string | undefined;
		const broker = new CredentialBroker(
			{ resolve: async () => ({ ok: true, value: material }), revoke: async () => ({ ok: true, value: undefined }) },
			{
				inject: async (request) => {
					injectedHandle = request.material.handleId;
					return { ok: true, value: {
						receiptId: createRuntimeId("receipt", "credential-injection"), grantId: request.grant.grantId,
						targetRuntimeId: request.targetRuntimeId, targetExecutorId: request.targetExecutorId,
						audienceDigest: request.executorAudienceDigest, injectedAt: NOW.toISOString(), expiresAt: request.grant.expiresAt,
					} };
				},
				revoke: async () => ({ ok: true, value: undefined }),
			},
			60_000,
			() => NOW,
		);
		const issued = await broker.issue({
			authorityId: createRuntimeId("authority", "credential"), tenantId: createRuntimeId("tenant", "credential"),
			principalId: createRuntimeId("principal", "credential"), sessionId: createRuntimeId("session", "credential"),
			credentialKind: "github-token", audienceDigest: "b".repeat(64), scopeDigest: "c".repeat(64), requestedTtlMs: 30_000,
			requestId: createRuntimeId("command", "credential"),
		});
		expect(issued.ok).toBe(true);
		if (!issued.ok) return;
		expect(JSON.stringify(issued.value)).not.toContain(secret);
		expect(await broker.inject(issued.value, {
			targetRuntimeId: createRuntimeId("runtime", "credential"), targetExecutorId: createRuntimeId("resource", "credential-executor"),
			executorAudienceDigest: "d".repeat(64),
		})).toMatchObject({ ok: false, error: { code: "policy_denied" } });
		const injected = await broker.inject(issued.value, {
			targetRuntimeId: createRuntimeId("runtime", "credential"), targetExecutorId: createRuntimeId("resource", "credential-executor"),
			executorAudienceDigest: "b".repeat(64),
		});
		expect(injected).toMatchObject({ ok: true });
		expect(injectedHandle).toBe(material.handleId);
		expect(JSON.stringify(injected)).not.toContain(secret);
		expect(await broker.revoke(issued.value.grantId)).toEqual({ ok: true, value: undefined });
		expect(await broker.inject(issued.value, {
			targetRuntimeId: createRuntimeId("runtime", "credential"), targetExecutorId: createRuntimeId("resource", "credential-executor"),
			executorAudienceDigest: "b".repeat(64),
		})).toMatchObject({ ok: false, error: { code: "policy_denied" } });
	});
});

describe("remote and CI attacks", () => {
	it("executes only after all policy/gate/workspace/credential checks and replays one terminal receipt", async () => {
		let calls = 0;
		const port = new SecureRemoteExecutorPort("ci", {
			verifyPolicy: async () => true, verifyGate: async () => true,
			verifyWorkspaceLease: async () => true, verifyCredentialAudience: async () => true,
		}, {
			execute: async (request) => { calls += 1; return { ok: true, value: result(request) }; },
		});
		const request = invocation();
		const first = await port.execute(request);
		const second = await port.execute(request);
		expect(first).toMatchObject({ ok: true, value: { status: "succeeded" } });
		expect(second).toEqual(first);
		expect(calls).toBe(1);
	});

	it.each(["policy", "gate", "workspace", "credential"] as const)("does not invoke remote or local fallback when %s trust fails", async (failed) => {
		let calls = 0;
		const port = new SecureRemoteExecutorPort("ci", {
			verifyPolicy: async () => failed !== "policy",
			verifyGate: async () => failed !== "gate",
			verifyWorkspaceLease: async () => failed !== "workspace",
			verifyCredentialAudience: async () => failed !== "credential",
		}, {
			execute: async (request) => { calls += 1; return { ok: true, value: result(request) }; },
		});
		expect(await port.execute(invocation())).toMatchObject({ ok: false, error: { code: "remote_rejected" } });
		expect(calls).toBe(0);
	});

	it("rejects candidate gate tamper and an uncorrelated remote receipt", async () => {
		let calls = 0;
		const trust = { verifyPolicy: async () => true, verifyGate: async () => true, verifyWorkspaceLease: async () => true, verifyCredentialAudience: async () => true };
		const port = new SecureRemoteExecutorPort("ci", trust, { execute: async (request) => { calls += 1; return { ok: true, value: result(request) }; } });
		const original = invocation();
		const tampered = { ...original, gate: { ...original.gate, gateDigest: "f".repeat(64) } } as RemoteExecutorInvocation;
		expect(await port.execute(tampered)).toMatchObject({ ok: false, error: { code: "invalid_invocation" } });
		expect(calls).toBe(0);

		const bad = new SecureRemoteExecutorPort("ci", trust, { execute: async (request) => ({ ok: true, value: { ...result(request), invocationDigest: "f".repeat(64) } }) });
		expect(await bad.execute(original)).toMatchObject({ ok: false, error: { code: "invalid_receipt" } });
	});

	it("requires signed handoff trust and lease transfer before broker dispatch", async () => {
		let calls = 0;
		const denied = new SecureSessionHandoffPort(
			{ verifyManifest: async () => true, transferLease: async () => false },
			{ transfer: async (manifest) => { calls += 1; return { ok: true, value: handoffReceipt(manifest) }; } },
		);
		expect(await denied.transfer(handoff())).toMatchObject({ ok: false, error: { code: "handoff_rejected" } });
		expect(calls).toBe(0);
	});
});
