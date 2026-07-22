import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type {
	CredentialAudienceValidationRequest,
	CredentialGrantIssueRequest,
	EnterprisePortResult,
} from "../../../src/runtime/identity/enterprise-types.ts";
import { canonicalDigest } from "../../../src/runtime/protocol/v3/canonical-json.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/v3/ids.ts";
import type { InputSourceRef } from "../../../src/runtime/protocol/v3/taint.ts";
import {
	workspaceExecutionEnvelopeDigest,
	type WorkspaceExecutionEnvelope,
	type WorkspaceServicePort,
	type WorkspaceServiceRequest,
	type WorkspaceServiceResult,
} from "../../../src/runtime/protocol/v3/workspace.ts";
import type {
	AgentTool,
	AgentToolResult,
	ToolExecutionGatewayRequest,
} from "../../../src/runtime/types.ts";
import { MemoryCapabilityRateLimiter } from "../../../src/security/integration/capability-rate-limiter.ts";
import type {
	CredentialAudienceBindingRef,
	CredentialAudienceBindingRequest,
	CredentialAudienceBindingResolverPort,
} from "../../../src/security/integration/credential-broker-adapter.ts";
import {
	createProductionToolManifest,
	type ToolInvocationInputClassificationPort,
} from "../../../src/security/integration/production-tool-components.ts";
import type { ToolExecutionWorkspaceResolverPort } from "../../../src/security/integration/tool-execution-gateway.ts";
import type {
	SandboxBackend,
	SandboxBackendCapability,
	SandboxLaunchPlan,
	SandboxPrepareRequest,
	SandboxProcessResult,
} from "../../../src/security/sandbox/types.ts";
import type { SecurityResult, SecuritySnapshot } from "../../../src/security/types.ts";
import {
	createProductionToolGatewayComposition,
	type ProductionToolGatewayComposition,
} from "../../../src/storage/production-tool-gateway.ts";

const NOW = new Date("2026-07-22T00:00:00.000Z");
const SECRET = "credential-value-must-never-escape";
const FENCING_TOKEN = "workspace-fencing-token-must-remain-adapter-owned";
const AUDIENCE = "a".repeat(64);
const SCOPE_DIGEST = "b".repeat(64);
const authorityId = createRuntimeId("authority", "production-tool-gateway");
const tenantId = createRuntimeId("tenant", "production-tool-gateway");
const principalId = createRuntimeId("principal", "production-tool-gateway");
const sessionId = createRuntimeId("session", "production-tool-gateway");
const workspaceId = createRuntimeId("workspace", "production-tool-gateway");
const repositoryId = createRuntimeId("repository", "production-tool-gateway");
const runtimeId = createRuntimeId("runtime", "production-tool-gateway");
const agentId = createRuntimeId("agent", "production-tool-gateway");
const traceId = createRuntimeId("trace", "production-tool-gateway");
const validatorId = createRuntimeId("principal", "production-workspace-validator");
const executorId = createRuntimeId("resource", "production-tool-executor");
const rateLimitId = createRuntimeId("rateLimit", "production-tool-gateway");
const toolSchema = Type.Object({ path: Type.String(), content: Type.String() });

const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

class StrictWorkspaceService implements WorkspaceServicePort {
	public async request(request: WorkspaceServiceRequest): Promise<WorkspaceServiceResult> {
		if (
			request.kind !== "validate" || request.envelope.fencingToken !== FENCING_TOKEN ||
			request.envelopeDigest !== workspaceExecutionEnvelopeDigest(request.envelope)
		) {
			return {
				schemaVersion: 1,
				requestId: request.requestId,
				kind: "rejected",
				code: "lease_conflict",
				messageDigest: canonicalDigest("workspace validation rejected"),
				retryable: false,
			};
		}
		return {
			schemaVersion: 1,
			requestId: request.requestId,
			kind: "validated",
			validation: {
				authorityId,
				tenantId,
				principalId,
				receiptId: createRuntimeId("receipt", `workspace-${request.envelope.toolCallId}`),
				workspaceId,
				envelopeDigest: request.envelopeDigest,
				validatorId,
				validatedAt: NOW.toISOString(),
				outcome: "valid",
			},
		};
	}
}

class AvailableSandbox implements SandboxBackend {
	public async probe(): Promise<SandboxBackendCapability> {
		return {
			backendId: "integration-enforced-sandbox",
			platform: "external",
			status: "available",
			supportsFilesystemIsolation: true,
			supportsNetworkDeny: true,
			supportsChildIsolation: true,
		};
	}

	public async prepare(_request: SandboxPrepareRequest): Promise<SecurityResult<SandboxLaunchPlan>> {
		return { ok: false, error: { code: "sandbox_unavailable", message: "process execution is outside this filesystem test", retryable: false } };
	}

	public async spawn(_plan: SandboxLaunchPlan): Promise<SecurityResult<SandboxProcessResult>> {
		return { ok: false, error: { code: "sandbox_unavailable", message: "process execution is outside this filesystem test", retryable: false } };
	}
}

class UnavailableSandbox extends AvailableSandbox {
	public override async probe(): Promise<SandboxBackendCapability> {
		return {
			backendId: "integration-unavailable-sandbox",
			platform: "unknown",
			status: "unavailable",
			supportsFilesystemIsolation: false,
			supportsNetworkDeny: false,
			supportsChildIsolation: false,
			reason: "sandbox unavailable by construction",
		};
	}
}

class FixedSnapshotResolver {
	readonly #snapshot: SecuritySnapshot;

	public constructor(snapshot: SecuritySnapshot) {
		this.#snapshot = snapshot;
	}

	public async resolve(policyDigest: string, requestedWorkspaceId: typeof workspaceId): Promise<SecurityResult<SecuritySnapshot>> {
		return policyDigest === this.#snapshot.policyDigest && requestedWorkspaceId === workspaceId
			? { ok: true, value: structuredClone(this.#snapshot) }
			: { ok: false, error: { code: "invalid_config", message: "snapshot is not current", retryable: false } };
	}

	public async currentPolicyDigest(requestedWorkspaceId: typeof workspaceId): Promise<string> {
		if (requestedWorkspaceId !== workspaceId) throw new Error("workspace snapshot is unavailable");
		return this.#snapshot.policyDigest;
	}
}

class AudienceResolver implements CredentialAudienceBindingResolverPort {
	public async resolve(
		request: CredentialAudienceBindingRequest,
	): Promise<EnterprisePortResult<CredentialAudienceBindingRef>> {
		const body = {
			...request,
			audienceDigest: AUDIENCE,
			issuedAt: NOW.toISOString(),
			expiresAt: new Date(NOW.getTime() + 60_000).toISOString(),
		};
		return { ok: true, value: { ...body, bindingDigest: canonicalDigest(body) } };
	}
}

function snapshot(workspaceRoot: string, stateRoot: string): SecuritySnapshot {
	const body = {
		profile: {
			name: "workspace-write" as const,
			approvalPolicy: "on-request" as const,
			filesystemMode: "workspace-write" as const,
			network: { mode: "deny" as const, allowedHosts: [] },
			sandbox: "workspace-write" as const,
		},
		filesystem: {
			readRoots: [workspaceRoot],
			writeRoots: [workspaceRoot],
			denyRead: [stateRoot],
			denyWrite: [stateRoot],
			protectedPaths: [join(workspaceRoot, ".git"), join(workspaceRoot, ".runledger"), stateRoot],
		},
		rules: [],
		sources: ["builtin" as const],
		workspaceRoot,
		tempRoot: join(workspaceRoot, "tmp"),
		createdAt: NOW.toISOString(),
	};
	return { ...body, policyDigest: canonicalDigest(body) };
}

function envelope(request: ToolExecutionGatewayRequest, workspaceRoot: string, fencingToken = FENCING_TOKEN): WorkspaceExecutionEnvelope {
	return {
		authorityId,
		tenantId,
		principalId,
		sessionId,
		workspaceId,
		repositoryId,
		worktreePath: workspaceRoot,
		branch: "worktree/production-tool-gateway",
		baseCommit: "0123456789abcdef",
		agentId,
		toolCallId: request.toolCallId,
		traceId,
		cwd: request.cwd,
		ownerRuntimeId: runtimeId,
		leaseRevision: 1,
		fencingToken,
	};
}

function trustedClassification(): ToolInvocationInputClassificationPort {
	return {
		classify: async (request, value) => {
			const source: InputSourceRef = {
				schemaVersion: 1,
				authorityId: value.authorityId,
				tenantId: value.tenantId,
				sourceId: createRuntimeId("inputSource", `tool-${request.toolCallId}`),
				kind: "user",
				sourceDigest: canonicalDigest(request.arguments),
				trust: "trusted",
				taintLabels: [],
				observedAt: NOW.toISOString(),
			};
			return { ok: true, value: { inputSources: [source], declassificationReceipts: [] } };
		},
	};
}

function createTool(counter: { value: number }): AgentTool<typeof toolSchema> {
	return {
		name: "write",
		label: "write",
		description: "production governed write fixture",
		parameters: toolSchema,
		governedExecution: "tool-context",
		isDestructive: () => true,
		async execute(_toolCallId, params, _signal, _update, context): Promise<AgentToolResult> {
			counter.value += 1;
			if (!context?.authorizationGrant) throw new Error("authorization grant is required");
			if (context.sessionId !== sessionId) throw new Error("ToolContext session identity is uncorrelated");
			await context.env.fs.writeFile(params.path, params.content);
			return {
				content: [{ type: "text", text: `token=${SECRET}` }],
				details: { authorization: SECRET, written: params.path },
			};
		},
	};
}

interface Harness {
	root: string;
	workspaceRoot: string;
	stateRoot: string;
	resolver: ToolExecutionWorkspaceResolverPort;
	snapshots: FixedSnapshotResolver;
	composition(backend?: SandboxBackend): Promise<ProductionToolGatewayComposition>;
}

async function createHarness(): Promise<Harness> {
	const root = await mkdtemp(join(tmpdir(), "runledger-production-tool-gateway-"));
	roots.push(root);
	const workspaceRoot = join(root, "workspace");
	const stateRoot = join(root, "security-state");
	await mkdir(workspaceRoot, { recursive: true });
	const snapshots = new FixedSnapshotResolver(snapshot(workspaceRoot, stateRoot));
	const resolver: ToolExecutionWorkspaceResolverPort = {
		resolve: async (request) => envelope(request, workspaceRoot),
	};
	const manifest = createProductionToolManifest({
		toolName: "write",
		kind: "native",
		primaryCapability: "workspace_write",
		requiredCapabilities: ["workspace_write"],
		targetSink: "filesystem",
		idempotent: false,
		retrySafe: false,
	});
	return {
		root,
		workspaceRoot,
		stateRoot,
		resolver,
		snapshots,
		composition: async (backend = new AvailableSandbox()) => createProductionToolGatewayComposition({
			stateRoot,
			workspace: new StrictWorkspaceService(),
			workspaceResolver: resolver,
			snapshots,
			manifests: [manifest],
			classification: trustedClassification(),
			peerBinding: {
				authorityId,
				tenantId,
				principalId,
				channel: "local_process",
				channelBindingDigest: canonicalDigest("production-local-peer"),
				keyRevision: 1,
				issuedAt: NOW.toISOString(),
				expiresAt: new Date(NOW.getTime() + 3_600_000).toISOString(),
			},
			rateLimiter: new MemoryCapabilityRateLimiter([{
				rateLimitId,
				capability: "workspace_write",
				maxUnits: 100,
				maxWindowMs: 60_000,
			}], () => NOW),
			rateLimitPolicy: () => ({ rateLimitId, windowMs: 60_000, units: 1 }),
			prompter: {
				request: async () => ({ decision: "allow-once", decidedBy: principalId }),
			},
			fallbackPrincipalId: principalId,
			credentials: {
				materials: {
					resolve: async () => {
						const material = {
							handleId: createRuntimeId("resource", "production-material-handle"),
							keyRefId: createRuntimeId("resource", "production-material-key"),
							credentialKind: "ci-oidc",
							audienceDigest: AUDIENCE,
							providerRevision: 1,
							credentialValue: SECRET,
						};
						return { ok: true as const, value: material };
					},
					revoke: async () => ({ ok: true, value: undefined }),
				},
				injection: {
					inject: async (request) => ({
						ok: true,
						value: {
							receiptId: createRuntimeId("receipt", "production-credential-injection"),
							grantId: request.grant.grantId,
							targetRuntimeId: request.targetRuntimeId,
							targetExecutorId: request.targetExecutorId,
							audienceDigest: request.executorAudienceDigest,
							injectedAt: NOW.toISOString(),
							expiresAt: request.grant.expiresAt,
						},
					}),
					revoke: async () => ({ ok: true, value: undefined }),
				},
				audienceResolver: new AudienceResolver(),
				maxBrokerTtlMs: 60_000,
				maxRuntimeGrantTtlMs: 30_000,
				maxRequestAgeMs: 60_000,
				allowedClockSkewMs: 0,
			},
			sandboxBackend: backend,
			baseEnvironment: { PATH: "/usr/bin:/bin" },
			allowedEnvironmentKeys: ["PATH", "LANG"],
			clock: () => NOW,
			approvalTimeoutMs: 30_000,
			authenticationTtlMs: 30_000,
		}),
	};
}

function invocation(tool: AgentTool<typeof toolSchema>, workspaceRoot: string, seed: string, envVars: Readonly<Record<string, string>> = {}): ToolExecutionGatewayRequest {
	return {
		turnId: createRuntimeId("turn", seed),
		toolCallId: createRuntimeId("toolCall", seed),
		providerToolCallId: `provider-${seed}`,
		tool,
		arguments: { path: join(workspaceRoot, `${seed}.txt`), content: seed },
		cwd: workspaceRoot,
		envVars,
	};
}

async function allAttemptText(path: string): Promise<string> {
	const files = await readdir(path);
	return (await Promise.all(files.filter((file) => file.endsWith(".json")).map((file) => readFile(join(path, file), "utf8")))).join("\n");
}

describe("production Tool Gateway composition", () => {
	it("persists a redacted terminal attempt and replays it after reconstruction without repeating the side effect", async () => {
		const harness = await createHarness();
		const counter = { value: 0 };
		const tool = createTool(counter);
		const first = await harness.composition();
		const request = invocation(tool, harness.workspaceRoot, "restart");
		const authorization = await first.toolExecutionGateway.authorize(request);
		if (authorization.status !== "authorized") throw new Error(authorization.reason);
		expect(JSON.stringify(authorization.grant)).not.toContain(FENCING_TOKEN);
		expect(JSON.stringify(authorization.grant)).not.toContain("fencingToken");
		const executed = await first.toolExecutionGateway.execute({ invocation: request, grant: authorization.grant }, () => undefined);
		expect(executed.status).toBe("completed");
		expect(counter.value).toBe(1);
		expect(await readFile(join(harness.workspaceRoot, "restart.txt"), "utf8")).toBe("restart");

		const persisted = await allAttemptText(first.paths.attemptsRoot);
		expect(persisted).not.toContain(SECRET);
		expect(persisted).not.toContain(FENCING_TOKEN);
		expect(persisted).toContain("[REDACTED");
		const attemptFiles = (await readdir(first.paths.attemptsRoot)).filter((file) => file.endsWith(".json"));
		expect((await stat(join(first.paths.attemptsRoot, attemptFiles[0]!))).mode & 0o777).toBe(0o600);

		const restarted = await harness.composition();
		const replay = await restarted.toolExecutionGateway.execute({ invocation: request, grant: authorization.grant }, () => undefined);
		expect(replay).toEqual(executed);
		expect(counter.value).toBe(1);
	});

	it("fails closed before invoking the tool when durable attempt state or restrictive sandbox is unavailable", async () => {
		const harness = await createHarness();
		const counter = { value: 0 };
		const tool = createTool(counter);
		const composition = await harness.composition();
		const request = invocation(tool, harness.workspaceRoot, "corrupt-attempt");
		const authorization = await composition.toolExecutionGateway.authorize(request);
		if (authorization.status !== "authorized") throw new Error(authorization.reason);
		const corruptPath = join(composition.paths.attemptsRoot, `${canonicalDigest(authorization.grant.grantDigest)}.json`);
		await writeFile(corruptPath, "not-json", { mode: 0o600 });
		expect(await composition.toolExecutionGateway.execute({ invocation: request, grant: authorization.grant }, () => undefined)).toMatchObject({
			status: "unavailable",
			outcomeCertain: true,
		});
		expect(counter.value).toBe(0);

		const unavailable = await createProductionToolGatewayComposition({
			stateRoot: join(harness.root, "unavailable-state"),
			workspace: new StrictWorkspaceService(),
			workspaceResolver: harness.resolver,
			snapshots: harness.snapshots,
			manifests: [createProductionToolManifest({ toolName: "write", kind: "native", primaryCapability: "workspace_write", requiredCapabilities: ["workspace_write"], targetSink: "filesystem", idempotent: false, retrySafe: false })],
			classification: trustedClassification(),
			peerBinding: {
				authorityId, tenantId, principalId, channel: "local_process",
				channelBindingDigest: canonicalDigest("unavailable-peer"), keyRevision: 1,
				issuedAt: NOW.toISOString(), expiresAt: new Date(NOW.getTime() + 60_000).toISOString(),
			},
			rateLimiter: new MemoryCapabilityRateLimiter([{ rateLimitId, capability: "workspace_write", maxUnits: 10, maxWindowMs: 60_000 }], () => NOW),
			rateLimitPolicy: () => ({ rateLimitId, windowMs: 60_000, units: 1 }),
			prompter: { request: async () => ({ decision: "allow-once", decidedBy: principalId }) },
			fallbackPrincipalId: principalId,
			credentials: {
				materials: { resolve: async () => ({ ok: false, error: { code: "credential_unavailable", message: "unavailable", retryable: false } }), revoke: async () => ({ ok: true, value: undefined }) },
				injection: { inject: async () => ({ ok: false, error: { code: "credential_unavailable", message: "unavailable", retryable: false } }), revoke: async () => ({ ok: true, value: undefined }) },
				audienceResolver: new AudienceResolver(), maxBrokerTtlMs: 60_000, maxRuntimeGrantTtlMs: 30_000,
			},
			sandboxBackend: new UnavailableSandbox(),
			baseEnvironment: { PATH: "/usr/bin:/bin" },
			clock: () => NOW,
		});
		const unavailableRequest = invocation(tool, harness.workspaceRoot, "sandbox-unavailable");
		expect(await unavailable.toolExecutionGateway.authorize(unavailableRequest)).toMatchObject({ status: "unavailable" });
		expect(counter.value).toBe(0);
	});

	it("keeps credential material opaque and refuses secret-bearing ToolContext environment keys", async () => {
		const harness = await createHarness();
		const counter = { value: 0 };
		const composition = await harness.composition();
		const issueRequest: CredentialGrantIssueRequest = {
			schemaVersion: 1,
			authorityId,
			tenantId,
			requestId: createRuntimeId("command", "production-credential-issue"),
			principalId,
			sessionId,
			credentialKind: "ci-oidc",
			audienceDigest: AUDIENCE,
			scopeDigest: SCOPE_DIGEST,
			requestedTtlMs: 20_000,
			requestedAt: NOW.toISOString(),
		};
		const issued = await composition.credentialBroker.issue(issueRequest);
		expect(issued.ok).toBe(true);
		expect(JSON.stringify(issued)).not.toContain(SECRET);
		if (issued.ok) {
			const validation: CredentialAudienceValidationRequest = {
				schemaVersion: 1,
				authorityId,
				tenantId,
				requestId: createRuntimeId("command", "production-credential-audience"),
				principalId,
				sessionId,
				grant: issued.value,
				targetKind: "local",
				targetExecutorId: executorId,
				invocationDigest: canonicalDigest("credential invocation"),
				requestedAt: NOW.toISOString(),
			};
			expect(JSON.stringify(await composition.credentialBroker.validateAudience(validation))).not.toContain(SECRET);
		}

		const tool = createTool(counter);
		const request = invocation(tool, harness.workspaceRoot, "secret-env", { API_KEY: SECRET });
		expect(await composition.toolExecutionGateway.authorize(request)).toMatchObject({ status: "unavailable" });
		expect(counter.value).toBe(0);
		expect(JSON.stringify(composition)).not.toContain(SECRET);
	});

	it("rejects an uncorrelated fencing token without exposing it in a grant", async () => {
		const harness = await createHarness();
		const tool = createTool({ value: 0 });
		const composition = await createProductionToolGatewayComposition({
			stateRoot: join(harness.root, "wrong-fence-state"),
			workspace: new StrictWorkspaceService(),
			workspaceResolver: { resolve: async (request) => envelope(request, harness.workspaceRoot, "wrong-fencing-token") },
			snapshots: harness.snapshots,
			manifests: [createProductionToolManifest({ toolName: "write", kind: "native", primaryCapability: "workspace_write", requiredCapabilities: ["workspace_write"], targetSink: "filesystem", idempotent: false, retrySafe: false })],
			classification: trustedClassification(),
			peerBinding: {
				authorityId, tenantId, principalId, channel: "local_process",
				channelBindingDigest: canonicalDigest("wrong-fence-peer"), keyRevision: 1,
				issuedAt: NOW.toISOString(), expiresAt: new Date(NOW.getTime() + 60_000).toISOString(),
			},
			rateLimiter: new MemoryCapabilityRateLimiter([{ rateLimitId, capability: "workspace_write", maxUnits: 10, maxWindowMs: 60_000 }], () => NOW),
			rateLimitPolicy: () => ({ rateLimitId, windowMs: 60_000, units: 1 }),
			prompter: { request: async () => ({ decision: "deny", decidedBy: principalId }) },
			fallbackPrincipalId: principalId,
			credentials: {
				materials: { resolve: async () => ({ ok: false, error: { code: "credential_unavailable", message: "unavailable", retryable: false } }), revoke: async () => ({ ok: true, value: undefined }) },
				injection: { inject: async () => ({ ok: false, error: { code: "credential_unavailable", message: "unavailable", retryable: false } }), revoke: async () => ({ ok: true, value: undefined }) },
				audienceResolver: new AudienceResolver(), maxBrokerTtlMs: 60_000, maxRuntimeGrantTtlMs: 30_000,
			},
			sandboxBackend: new AvailableSandbox(),
			baseEnvironment: { PATH: "/usr/bin:/bin" },
			clock: () => NOW,
		});
		const result = await composition.toolExecutionGateway.authorize(invocation(tool, harness.workspaceRoot, "wrong-fence"));
		expect(result.status).toBe("denied");
		expect(JSON.stringify(result)).not.toContain("wrong-fencing-token");
	});
});
