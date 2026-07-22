import { describe, expect, it } from "vitest";
import { canonicalDigest } from "../../src/runtime/protocol/v3/canonical-json.ts";
import {
	capabilityGatewayRequestDigest,
	type CapabilityClaim,
	type CapabilityGatewayRequest,
	type CapabilityGatewayRequestBody,
	type CapabilityName,
} from "../../src/runtime/protocol/v3/capability.ts";
import { createRuntimeId } from "../../src/runtime/protocol/v3/ids.ts";
import type { InputSourceRef } from "../../src/runtime/protocol/v3/taint.ts";
import { workspaceExecutionEnvelopeDigest, type WorkspaceExecutionEnvelope } from "../../src/runtime/protocol/v3/workspace.ts";
import { CapabilityAuthenticationAdapter } from "../../src/security/integration/capability-authentication.ts";
import { MemoryCapabilityRateLimiter } from "../../src/security/integration/capability-rate-limiter.ts";
import { PendingApprovalRegistry } from "../../src/security/integration/pending-approval-registry.ts";
import { RuntimeApprovalCoordinatorAdapter } from "../../src/security/integration/runtime-approval-adapter.ts";
import {
	RuntimeCapabilityGatewayAdapter,
	type SecurityToolManifest,
} from "../../src/security/integration/runtime-gateway-adapter.ts";
import { ApprovalCoordinator } from "../../src/security/permission/approval-coordinator.ts";
import { PermissionEngine } from "../../src/security/permission/engine.ts";
import type { SecuritySnapshot } from "../../src/security/types.ts";

const NOW = new Date("2026-07-22T00:00:00.000Z");
const AUTH_BINDING = "a".repeat(64);
const READ_MANIFEST = "b".repeat(64);
const BROWSER_MANIFEST = "c".repeat(64);
const rateLimitId = (capability: CapabilityName) => createRuntimeId("rateLimit", `gateway-${capability}`);

function envelope(): WorkspaceExecutionEnvelope {
	return {
		authorityId: createRuntimeId("authority", "gateway"), tenantId: createRuntimeId("tenant", "gateway"),
		principalId: createRuntimeId("principal", "gateway"), sessionId: createRuntimeId("session", "gateway"),
		workspaceId: createRuntimeId("workspace", "gateway"), repositoryId: createRuntimeId("repository", "gateway"),
		worktreePath: "/repo", branch: "runledger/test", baseCommit: "d".repeat(40), agentId: createRuntimeId("agent", "gateway"),
		toolCallId: createRuntimeId("toolCall", "gateway"), traceId: createRuntimeId("trace", "gateway"), cwd: "/repo",
		ownerRuntimeId: createRuntimeId("runtime", "gateway"), leaseRevision: 1, fencingToken: "gateway-fence",
	};
}

function snapshot(): SecuritySnapshot {
	return {
		profile: { name: "workspace-write", approvalPolicy: "on-request", filesystemMode: "workspace-write", network: { mode: "deny", allowedHosts: [] }, sandbox: "workspace-write" },
		filesystem: { readRoots: ["/repo"], writeRoots: ["/repo"], denyRead: [], denyWrite: [], protectedPaths: ["/repo/.git", "/repo/.runledger"] },
		rules: [], sources: ["builtin"], workspaceRoot: "/repo", tempRoot: "/tmp/session", policyDigest: "e".repeat(64), createdAt: NOW.toISOString(),
	};
}

function gatewayRequest(input: {
	idempotency: string;
	nonce: string;
	manifestDigest?: string;
	rawArguments?: unknown;
	capability?: CapabilityName;
	claims?: readonly CapabilityName[];
	inputSources?: readonly InputSourceRef[];
	targetSink?: CapabilityGatewayRequestBody["targetSink"];
}): CapabilityGatewayRequest {
	const workspace = envelope();
	const rawArguments = input.rawArguments ?? { path: "README.md" };
	const capability = input.capability ?? "repository_read";
	const claims = input.claims ?? [capability];
	const manifestDigest = input.manifestDigest ?? READ_MANIFEST;
	const requestId = createRuntimeId("command", `gateway-${input.idempotency}`);
	const requestedClaims: CapabilityClaim[] = claims.map((name, index) => {
		const base = {
			authorityId: workspace.authorityId,
			tenantId: workspace.tenantId,
			name,
			resourceDigest: canonicalDigest({ name, index }),
			constraintsDigest: canonicalDigest({ constraint: name }),
		};
		if (name === "browser") {
			return {
				...base,
				resourceKind: "browser_tool",
				browserConstraints: {
					navigateOriginDigest: canonicalDigest("https://example.com"),
					domReadScopeDigest: canonicalDigest("dom-read"),
					scriptPolicyDigest: canonicalDigest("script-denied"),
					downloadScopeDigest: canonicalDigest("download-denied"),
					uploadScopeDigest: canonicalDigest("upload-denied"),
					cookieCredentialScopeDigest: canonicalDigest("cookie-session"),
					networkEgressScopeDigest: canonicalDigest("network-denied"),
				},
			};
		}
		return {
			...base,
			resourceKind: name === "credential" ? "credential" : "filesystem",
		};
	});
	const body: CapabilityGatewayRequestBody = {
		request: {
			authorityId: workspace.authorityId, tenantId: workspace.tenantId, principalId: workspace.principalId,
			requestId,
			approvalId: createRuntimeId("approval", `gateway-${input.idempotency}`),
			sessionId: workspace.sessionId,
			runtimeId: workspace.ownerRuntimeId,
			runtimeGeneration: workspace.leaseRevision,
			turnId: createRuntimeId("turn", `gateway-${input.idempotency}`),
			toolCallId: workspace.toolCallId,
			capability,
			argumentsDigest: canonicalDigest(rawArguments), workspaceEnvelopeDigest: workspaceExecutionEnvelopeDigest(workspace),
			policyDigest: snapshot().policyDigest,
			serverScope: "tool_server",
			resourceScopeDigest: canonicalDigest(requestedClaims.map((claim) => ({
				resourceKind: claim.resourceKind,
				resourceDigest: claim.resourceDigest,
				constraintsDigest: claim.constraintsDigest,
			}))),
			commandScopeDigest: canonicalDigest({ manifestDigest, rawArguments }),
		},
		invocation: {
			requestId, toolManifestDigest: manifestDigest,
			rawArguments, envelope: workspace,
			requestedClaims,
		},
		idempotencyKey: createRuntimeId("command", input.idempotency),
		inputSources: input.inputSources ?? [], targetSink: input.targetSink ?? "filesystem", declassificationReceipts: [],
	};
	return {
		...body,
		authentication: {
			channel: "local_process", channelBindingDigest: AUTH_BINDING,
			requestDigest: capabilityGatewayRequestDigest(body), nonce: input.nonce,
			issuedAt: NOW.toISOString(), expiresAt: new Date(NOW.getTime() + 60_000).toISOString(), keyRevision: 1,
		},
	};
}

function harness(maxUnits = 20): {
	gateway: RuntimeCapabilityGatewayAdapter;
	approval: RuntimeApprovalCoordinatorAdapter;
	registry: PendingApprovalRegistry;
} {
	const workspace = envelope();
	const registry = new PendingApprovalRegistry();
	const manifests: readonly SecurityToolManifest[] = [
		{ manifestDigest: READ_MANIFEST, toolName: "read", kind: "native", requiredCapabilities: ["repository_read"] },
		{ manifestDigest: BROWSER_MANIFEST, toolName: "browser_cookie", kind: "browser", browserOperation: "cookie", requiredCapabilities: ["browser", "credential"] },
	];
	const authentication = new CapabilityAuthenticationAdapter({
		clock: () => NOW,
		peerBindings: [{
			authorityId: workspace.authorityId, tenantId: workspace.tenantId, principalId: workspace.principalId,
			channel: "local_process", channelBindingDigest: AUTH_BINDING, keyRevision: 1, issuedAt: NOW.toISOString(),
		}],
	});
	const limiter = new MemoryCapabilityRateLimiter([
		...(["repository_read", "browser", "credential"] as const).map((capability) => ({ rateLimitId: rateLimitId(capability), capability, maxUnits, maxWindowMs: 60_000 })),
	], () => NOW);
	const security = snapshot();
	const gateway = new RuntimeCapabilityGatewayAdapter({
		authentication, rateLimiter: limiter,
		rateLimitPolicy: (capability) => ({ rateLimitId: rateLimitId(capability), windowMs: 60_000, units: 1 }),
		manifestResolver: { resolve: async (digest) => {
			const manifest = manifests.find((candidate) => candidate.manifestDigest === digest);
			return manifest ? { ok: true, value: manifest } : { ok: false, error: { code: "invalid_request", message: "missing", retryable: false } };
		} },
		snapshotResolver: {
			resolve: async (digest) => digest === security.policyDigest ? { ok: true, value: security } : { ok: false, error: { code: "invalid_config", message: "stale", retryable: false } },
			currentPolicyDigest: async () => security.policyDigest,
		},
		permissionEngine: new PermissionEngine(), approvals: registry, clock: () => NOW,
	});
	const coordinator = new ApprovalCoordinator({
		prompter: { request: async () => ({ decision: "allow-once", decidedBy: createRuntimeId("principal", "approver") }) },
		clock: () => NOW, timeoutMs: 60_000, fallbackPrincipalId: createRuntimeId("principal", "fallback"),
	});
	return {
		gateway,
		registry,
		approval: new RuntimeApprovalCoordinatorAdapter({ coordinator, registry, fallbackPrincipalId: createRuntimeId("principal", "fallback"), clock: () => NOW }),
	};
}

describe("authenticated Runtime capability gateway", () => {
	it("allows a correlated read and idempotently replays the result", async () => {
		const { gateway } = harness();
		const request = gatewayRequest({ idempotency: "read-one", nonce: "nonce-read-one-0001" });
		const first = await gateway.authorize(request);
		const second = await gateway.authorize(request);
		expect(first).toMatchObject({ decision: "allow", sandboxProfile: { requested: "workspace-write" } });
		expect(second).toEqual(first);
	});

	it("rejects the same authenticated nonce under a different command", async () => {
		const { gateway } = harness();
		const first = gatewayRequest({ idempotency: "nonce-first", nonce: "nonce-replay-shared" });
		const replay = gatewayRequest({ idempotency: "nonce-second", nonce: "nonce-replay-shared" });
		expect((await gateway.authorize(first)).decision).toBe("allow");
		expect(await gateway.authorize(replay)).toMatchObject({ decision: "deny", approvalReceipt: { decision: "denied" } });
	});

	it("enforces the independent gateway rate limit", async () => {
		const { gateway } = harness(1);
		expect((await gateway.authorize(gatewayRequest({ idempotency: "rate-first", nonce: "nonce-rate-first-01" }))).decision).toBe("allow");
		expect((await gateway.authorize(gatewayRequest({ idempotency: "rate-second", nonce: "nonce-rate-second-1" }))).decision).toBe("deny");
	});

	it("blocks tainted repository input at a shell sink without exact declassification", async () => {
		const workspace = envelope();
		const source: InputSourceRef = {
			schemaVersion: 1, authorityId: workspace.authorityId, tenantId: workspace.tenantId,
			sourceId: createRuntimeId("inputSource", "repo-instruction"), kind: "repository", sourceDigest: "f".repeat(64),
			trust: "tainted", taintLabels: ["repository_controlled"], observedAt: NOW.toISOString(),
		};
		const { gateway } = harness();
		const result = await gateway.authorize(gatewayRequest({
			idempotency: "taint-shell", nonce: "nonce-taint-shell-01", inputSources: [source], targetSink: "shell",
		}));
		expect(result).toMatchObject({ decision: "deny", approvalReceipt: { decision: "denied" } });
	});

	it("requires the browser-cookie capability set, then resumes exact approval", async () => {
		const { gateway, approval } = harness();
		const incomplete = gatewayRequest({
			idempotency: "browser-incomplete", nonce: "nonce-browser-bad-1", manifestDigest: BROWSER_MANIFEST,
			rawArguments: { origin: "https://example.com" }, capability: "browser", claims: ["browser"], targetSink: "credential",
		});
		expect((await gateway.authorize(incomplete)).decision).toBe("deny");

		const complete = gatewayRequest({
			idempotency: "browser-complete", nonce: "nonce-browser-good1", manifestDigest: BROWSER_MANIFEST,
			rawArguments: { origin: "https://example.com" }, capability: "browser", claims: ["browser", "credential"], targetSink: "context",
		});
		const asked = await gateway.authorize(complete);
		expect(asked.decision).toBe("ask");
		if (asked.decision !== "ask") return;
		const decided = await approval.request({ ticket: asked.approvalTicket, expectedDecisionRevision: 0, idempotencyKey: createRuntimeId("command", "approve-browser") });
		expect(decided.receipt.decision).toBe("allowed");
		expect(await gateway.authorize(complete)).toMatchObject({ decision: "allow", approvalReceipt: { decision: "allowed" } });
	});
});
