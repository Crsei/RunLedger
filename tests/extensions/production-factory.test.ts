import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { RuntimeEventDraft } from "../../src/runtime/session/types.ts";
import { canonicalDigest } from "../../src/runtime/protocol/v3/canonical-json.ts";
import { createSessionEventStreamRef, type EventCursor } from "../../src/runtime/protocol/v3/events.ts";
import { computeRuntimeEventPayloadDigest } from "../../src/runtime/protocol/v3/event-hash.ts";
import { createRuntimeId } from "../../src/runtime/protocol/v3/ids.ts";
import { ToolRegistry } from "../../src/runtime/tool-registry.ts";
import type { ToolContext } from "../../src/runtime/tool-context.ts";
import type {
	AgentTool,
	AgentToolHookContext,
	ToolExecutionAuthorizationGrant,
	ToolExecutionAuthorizationResult,
	ToolExecutionGatewayExecuteResult,
	ToolExecutionGatewayPort,
	ToolExecutionGatewayRequest,
} from "../../src/runtime/types.ts";
import type { SecuritySnapshot } from "../../src/security/types.ts";
import { NodePolicyExtensionStorage } from "../../src/storage/extension-node-storage.ts";
import type { ProductionInteractiveExtensionFactoryPort } from "../../src/storage/production-interactive-runtime.ts";
import { discoverExtensionRoots } from "../../src/extensions/paths.ts";
import { discoverHooks } from "../../src/extensions/hooks/discovery.ts";
import { discoverSkills } from "../../src/extensions/skills/discovery.ts";
import { loadMcpConfig } from "../../src/extensions/mcp/config.ts";
import type { McpOperationAuthorizationPort } from "../../src/extensions/mcp/connection-manager.ts";
import type { McpClientFactoryPort, McpClientPort, McpServerDescriptor, McpToolDefinition } from "../../src/extensions/mcp/types.ts";
import {
	createProductionExtensionFactory,
	DurableExtensionSpill,
	GatewayHookCommandExecutor,
	type ProductionExtensionCanonicalWriterPort,
	type ProductionExtensionPersistencePaths,
} from "../../src/extensions/integration/production-factory.ts";
import { TrustStore } from "../../src/extensions/trust/trust-store.ts";
import { TEST_SCOPE } from "./helpers.ts";

type CanonicalDraft = RuntimeEventDraft<"resource.snapshot"> | RuntimeEventDraft<"resource.lifecycle_recorded">;

const temporaryRoots: string[] = [];
const SESSION_ID = createRuntimeId("session", "production-extension-factory");
const SESSION_STREAM = createSessionEventStreamRef(TEST_SCOPE, SESSION_ID);

async function temporary(label: string): Promise<string> {
	const path = await mkdtemp(join(tmpdir(), `runledger-production-extension-${label}-`));
	temporaryRoots.push(path);
	return path;
}

afterEach(async () => {
	await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function securitySnapshot(root: string): SecuritySnapshot {
	return Object.freeze({
		profile: Object.freeze({
			name: "workspace-write" as const,
			approvalPolicy: "never" as const,
			filesystemMode: "workspace-write" as const,
			network: Object.freeze({ mode: "deny" as const, allowedHosts: Object.freeze([]) }),
			sandbox: "workspace-write" as const,
		}),
		filesystem: Object.freeze({
			readRoots: Object.freeze([root]),
			writeRoots: Object.freeze([root]),
			denyRead: Object.freeze([]),
			denyWrite: Object.freeze([]),
			protectedPaths: Object.freeze([]),
		}),
		rules: Object.freeze([]),
		sources: Object.freeze(["builtin" as const]),
		workspaceRoot: root,
		tempRoot: join(root, ".tmp"),
		policyDigest: "e".repeat(64),
		createdAt: "2026-07-22T00:00:00.000Z",
	});
}

function persistence(root: string): ProductionExtensionPersistencePaths {
	return {
		stateFile: join(root, "metadata", "extensions-state.json"),
		trustFile: join(root, "metadata", "trust.json"),
		pluginDataRoot: join(root, "metadata", "plugin-data"),
		spillRoot: join(root, "metadata", "spill"),
	};
}

class RecordingWriter implements ProductionExtensionCanonicalWriterPort {
	public durable = true;
	public flushMode: "exact" | "failed" | "mismatched" = "exact";
	public readonly drafts: CanonicalDraft[] = [];
	#cursor: EventCursor | undefined;

	public async append<TType extends "resource.snapshot" | "resource.lifecycle_recorded">(draft: RuntimeEventDraft<TType>): ReturnType<ProductionExtensionCanonicalWriterPort["append"]> {
		this.drafts.push(draft as CanonicalDraft);
		if (!this.durable) return { ok: false };
		const eventId = createRuntimeId("event", `extension-writer-${this.drafts.length}`);
		const eventHash = canonicalDigest({ draft, eventId, sequence: this.drafts.length - 1 });
		this.#cursor = { stream: SESSION_STREAM, sequence: this.drafts.length - 1, eventId, eventHash };
		return {
			ok: true,
			value: {
				event: {
					stream: SESSION_STREAM,
					eventId,
					type: draft.type,
					payload: draft.payload,
					payloadDigest: computeRuntimeEventPayloadDigest(draft.payload),
					currentEventHash: eventHash,
				},
				cursor: this.#cursor,
			},
		};
	}

	public async flush(): ReturnType<ProductionExtensionCanonicalWriterPort["flush"]> {
		if (this.flushMode === "failed") return { ok: false };
		if (!this.#cursor) return { ok: true, value: undefined };
		return this.flushMode === "mismatched"
			? { ok: true, value: { ...this.#cursor, eventHash: "f".repeat(64) } }
			: { ok: true, value: this.#cursor };
	}
}

function bashTool(): AgentTool {
	return {
		name: "bash",
		label: "bash",
		description: "production bash fixture",
		parameters: Type.Object({ command: Type.String(), timeout: Type.Optional(Type.Number()), stdin: Type.Optional(Type.String()) }, { additionalProperties: false }),
		governedExecution: "tool-context",
		async execute() {
			return { content: [{ type: "text", text: "unused" }], details: {}, terminate: false };
		},
	};
}

function processGrant(request: ToolExecutionGatewayRequest, policyDigest = "e".repeat(64)): ToolExecutionAuthorizationGrant {
	return {
		schemaVersion: 1,
		toolCallId: request.toolCallId,
		providerToolCallDigest: "1".repeat(64),
		toolIdentityDigest: "2".repeat(64),
		argumentsDigest: "3".repeat(64),
		invocationDigest: "4".repeat(64),
		workspaceEnvelopeDigest: "5".repeat(64),
		workspaceValidation: {
			authorityId: TEST_SCOPE.authorityId,
			tenantId: TEST_SCOPE.tenantId,
			principalId: TEST_SCOPE.principalId,
			receiptId: createRuntimeId("receipt", "hook-workspace"),
			workspaceId: createRuntimeId("workspace", "hook-workspace"),
			bindingRevision: 1,
			bindingDigest: "6".repeat(64),
			outcome: "valid",
			validatedAt: "2026-07-22T00:00:00.000Z",
		},
		authorization: {
			receiptId: createRuntimeId("receipt", "hook-authorization"),
			requestId: createRuntimeId("command", "hook-authorization"),
			requestDigest: "7".repeat(64),
			decisionDigest: "8".repeat(64),
			receiptDigest: "9".repeat(64),
		},
		capability: "process",
		policyDigest,
		sandbox: {
			receiptId: createRuntimeId("receipt", "hook-sandbox-resolution"),
			profileId: createRuntimeId("resource", "hook-sandbox-profile"),
			requested: "workspace-write",
			resolved: "workspace-write",
			policyDigest,
			backendId: "fixture-sandbox",
			effectiveEnforcement: "enforced",
			resolutionDigest: "a".repeat(64),
		},
		grantDigest: "b".repeat(64),
	};
}

class RecordingGateway implements ToolExecutionGatewayPort {
	public authorizeMode: "allow" | "deny" = "allow";
	public authorizeError?: Error;
	public policyDigest = "e".repeat(64);
	public sandboxEnforcement: "enforced" | "degraded" | "unavailable" | "off" = "enforced";
	public hookResponse: unknown = { decision: "allow", updatedInput: { path: "README.md" }, additionalContext: "checked" };
	public readonly requests: ToolExecutionGatewayRequest[] = [];
	public executions = 0;

	public async authorize(request: ToolExecutionGatewayRequest): Promise<ToolExecutionAuthorizationResult> {
		this.requests.push(request);
		if (this.authorizeError) throw this.authorizeError;
		return this.authorizeMode === "allow"
			? { status: "authorized", grant: processGrant(request, this.policyDigest) }
			: { status: "unavailable", requestId: createRuntimeId("command", "hook-unavailable"), reason: "gateway unavailable" };
	}

	public async execute(request: Parameters<ToolExecutionGatewayPort["execute"]>[0]): Promise<ToolExecutionGatewayExecuteResult> {
		this.executions += 1;
		return {
			status: "completed",
			grantDigest: request.grant.grantDigest,
			result: {
				content: [{ type: "text", text: "hook completed" }],
				details: {
					stdout: JSON.stringify(this.hookResponse),
					stderr: "",
					exitCode: 0,
				},
				terminate: false,
			},
			sandboxReceipt: {
				authorityId: TEST_SCOPE.authorityId,
				tenantId: TEST_SCOPE.tenantId,
				principalId: TEST_SCOPE.principalId,
				receiptId: createRuntimeId("receipt", "hook-sandbox-execution"),
				requestId: request.grant.authorization.requestId,
				profileId: request.grant.sandbox.profileId,
				requested: "workspace-write",
				resolved: "workspace-write",
				policyDigest: request.grant.policyDigest,
				backendId: "fixture-sandbox",
				effectiveEnforcement: this.sandboxEnforcement,
				invocationDigest: request.grant.invocationDigest,
			},
		};
	}
}

async function writeSkill(root: string): Promise<void> {
	const directory = join(root, "skills", "review");
	await mkdir(directory, { recursive: true });
	await writeFile(join(directory, "SKILL.md"), [
		"---",
		"name: review",
		"description: Review the current change.",
		"user-invocable: true",
		"disable-model-invocation: false",
		"---",
		"",
		"# Review",
	].join("\n"));
}

async function writeHook(root: string): Promise<string> {
	const directory = join(root, "hooks");
	await mkdir(directory, { recursive: true });
	const path = join(directory, "guard.json");
	await writeFile(path, JSON.stringify({
		schemaVersion: 1,
		hooks: {
			PreToolUse: [{
				id: "gateway-guard",
				matcher: "^read$",
				failureMode: "closed",
				handlers: [{ type: "command", command: "node", args: ["guard.mjs"], timeoutMs: 2_000, env: {} }],
			}],
		},
	}, null, 2));
	return path;
}

async function writeMcp(root: string): Promise<string> {
	const path = join(root, "mcp.json");
	await writeFile(path, JSON.stringify({
		schemaVersion: 1,
		mcpServers: {
			fixture: {
				transport: "stdio",
				command: "node",
				required: false,
				pinnedTools: ["inspect"],
			},
		},
	}, null, 2));
	return path;
}

class ReadOnlyHintMcpClient implements McpClientPort {
	public calls = 0;

	public async listTools(): Promise<readonly Omit<McpToolDefinition, "serverId" | "serverName" | "qualifiedName" | "runtimeName" | "pinned">[]> {
		return [{
			rawName: "inspect",
			description: "read-only-hint fixture",
			inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false },
			annotations: { readOnly: true, destructive: false, concurrencySafe: true },
		}];
	}

	public async callTool(): Promise<{ content: readonly unknown[]; isError: boolean }> {
		this.calls += 1;
		return { content: [{ type: "text", text: "inspected" }], isError: false };
	}

	public async ping(): Promise<void> {}
	public async listResources(): Promise<readonly unknown[]> { return []; }
	public async listResourceTemplates(): Promise<readonly unknown[]> { return []; }
	public async readResource(): Promise<readonly unknown[]> { return []; }
	public async listPrompts(): Promise<readonly unknown[]> { return []; }
	public async getPrompt(): Promise<unknown> { return {}; }
	public async close(): Promise<void> {}
	public onClose(): void {}
}

class RecordingMcpClientFactory implements McpClientFactoryPort {
	public readonly client = new ReadOnlyHintMcpClient();
	public connections = 0;

	public async connect(): Promise<McpClientPort> {
		this.connections += 1;
		return this.client;
	}
}

class CurrentPolicyMcpAuthorization implements McpOperationAuthorizationPort {
	public allowed = true;
	public readonly calls: Array<{ server: McpServerDescriptor; tool: McpToolDefinition; rawInput: unknown }> = [];

	public async authorize(input: { server: McpServerDescriptor; tool: McpToolDefinition; rawInput: unknown }) {
		this.calls.push(input);
		if (!this.allowed) return undefined;
		return {
			receiptId: `current-policy-${this.calls.length}`,
			serverId: input.server.descriptor.identity.qualifiedId,
			toolName: input.tool.rawName,
			inputDigest: canonicalDigest(input.rawInput),
			configDigest: input.server.descriptor.manifest.combinedDigest,
			expiresAt: "2999-01-01T00:00:00.000Z",
		};
	}
}

async function trustProjectMcp(root: string, storage: NodePolicyExtensionStorage, trust: TrustStore, configPath: string): Promise<void> {
	const roots = await discoverExtensionRoots({ storage, cwd: root });
	const project = roots.find((candidate) => candidate.rootPath === join(root, ".runledger"));
	if (!project) throw new Error("project Extension root was not discovered");
	const initial = await loadMcpConfig({ configPath, root: project, scope: TEST_SCOPE, trustStore: trust, storage });
	const server = initial.servers[0];
	if (!server) throw new Error("MCP fixture was not discovered");
	await trust.grant({
		identity: server.descriptor.identity,
		canonicalPath: configPath,
		binding: server.descriptor.manifest,
		principalId: TEST_SCOPE.principalId,
		scope: "project",
	});
}

describe("ProductionExtensionFactory", () => {
	it("discovers user and project roots, preserves exact resource identities, and writes the canonical snapshot", async () => {
		const root = await temporary("roots");
		const projectRoot = join(root, ".runledger");
		const userRoot = join(root, "user-extensions");
		await mkdir(projectRoot, { recursive: true });
		await mkdir(userRoot, { recursive: true });
		await writeSkill(userRoot);
		await writeHook(projectRoot);
		const writer = new RecordingWriter();
		const registry = new ToolRegistry();
		registry.register(bashTool(), { namespace: "production" });
		const factory = createProductionExtensionFactory({
			scope: TEST_SCOPE,
			securitySnapshot: securitySnapshot(root),
			writer,
			userRoot,
			resolvePaths: () => persistence(root),
		});
		const productionFactoryPort: ProductionInteractiveExtensionFactoryPort = factory;
		expect(productionFactoryPort).toBe(factory);
		const adapter = await factory.create({ registry, gateway: new RecordingGateway(), sessionId: SESSION_ID, cwd: root });
		try {
			expect(await adapter.runtime.start()).toMatchObject({ status: "ready", generation: 1 });
			expect(JSON.parse(await readFile(persistence(root).stateFile, "utf8"))).toEqual({ schemaVersion: 1, revision: 0, resources: {} });
			expect(JSON.parse(await readFile(persistence(root).trustFile, "utf8"))).toEqual({ schemaVersion: 1, revision: 0, records: [] });
			if (process.platform !== "win32") {
				expect((await stat(persistence(root).stateFile)).mode & 0o777).toBe(0o600);
				expect((await stat(persistence(root).trustFile)).mode & 0o777).toBe(0o600);
			}
			const catalog = adapter.runtime.catalog();
			expect(catalog?.resources.map((resource) => resource.identity.source).sort()).toEqual(["project", "user"]);
			expect(catalog?.resources.every((resource) => resource.identity.qualifiedId.length > 0 && resource.identity.digest === resource.manifest.combinedDigest)).toBe(true);
			expect(writer.drafts).toMatchObject([{ type: "resource.snapshot", payload: { generation: 1, resourceCount: 2 } }]);
			expect(registry.list("extensions")).toEqual([]);
		} finally {
			await adapter.runtime.close();
		}
	});

	it("runs a trusted PreToolUse command only through the governed bash/Gateway path and fails closed when enforcement disappears", async () => {
		const root = await temporary("hook-gateway");
		const projectRoot = join(root, ".runledger");
		await mkdir(projectRoot, { recursive: true });
		await writeHook(projectRoot);
		const snapshot = securitySnapshot(root);
		const storage = new NodePolicyExtensionStorage({ cwd: root, securitySnapshot: snapshot });
		const paths = persistence(root);
		const trust = new TrustStore(paths.trustFile, storage);
		const roots = await discoverExtensionRoots({ storage, cwd: root });
		const initial = await discoverHooks({ roots, scope: TEST_SCOPE, trustStore: trust, storage });
		const hook = initial.hooks[0];
		if (!hook) throw new Error("hook fixture was not discovered");
		await trust.grant({ identity: hook.descriptor.identity, canonicalPath: hook.configPath, binding: hook.descriptor.manifest, principalId: TEST_SCOPE.principalId, scope: "project" });

		const writer = new RecordingWriter();
		const gateway = new RecordingGateway();
		const registry = new ToolRegistry();
		registry.register(bashTool(), { namespace: "production" });
		const adapter = await createProductionExtensionFactory({ scope: TEST_SCOPE, securitySnapshot: snapshot, writer, userRoot: null, resolvePaths: () => paths }).create({ registry, gateway, sessionId: SESSION_ID, cwd: root });
		try {
			expect((await adapter.runtime.start()).status).toBe("ready");
			expect(adapter.runtime.beginTurn().status).toBe("ready");
			const readTool: AgentTool = { name: "read", label: "read", description: "fixture read", parameters: Type.Object({ path: Type.String() }, { additionalProperties: false }), governedExecution: "tool-context", async execute() { return { content: [], details: {}, terminate: false }; } };
			const hookContext = { tool: readTool, args: { path: "unsafe" }, toolCall: { id: "provider-read", name: "read", arguments: { path: "unsafe" } } } as unknown as AgentToolHookContext;
			expect(await adapter.beforeToolCall(hookContext)).toEqual({ updatedInput: { path: "README.md" } });
			expect(gateway.requests).toHaveLength(1);
			expect(gateway.requests[0]).toMatchObject({ tool: { name: "bash" }, cwd: root, arguments: { stdin: expect.any(String), timeout: 2_000 } });
			expect((gateway.requests[0]?.arguments as { command: string }).command).toContain("cd --");
			expect(gateway.executions).toBe(1);
			expect(writer.drafts.map((draft) => draft.type)).toEqual(["resource.snapshot", "resource.lifecycle_recorded"]);

			gateway.hookResponse = { decision: "allow", updatedInput: { path: "README.md", injected: true } };
			expect(await adapter.beforeToolCall(hookContext)).toMatchObject({
				block: true,
				reason: expect.stringContaining("PreToolUse updatedInput failed schema validation"),
			});
			expect(gateway.executions).toBe(2);

			gateway.authorizeMode = "deny";
			expect(await adapter.beforeToolCall(hookContext)).toMatchObject({ block: true, reason: expect.stringContaining("reasonDigest=") });
			expect(gateway.executions).toBe(2);
			await adapter.runtime.endTurn();
		} finally {
			await adapter.runtime.close();
		}
	});

	it("fails startup when the v3 writer cannot durably accept the snapshot", async () => {
		const root = await temporary("audit-failure");
		await mkdir(join(root, ".runledger"), { recursive: true });
		const writer = new RecordingWriter();
		writer.durable = false;
		const registry = new ToolRegistry();
		registry.register(bashTool(), { namespace: "production" });
		const adapter = await createProductionExtensionFactory({ scope: TEST_SCOPE, securitySnapshot: securitySnapshot(root), writer, userRoot: null, resolvePaths: () => persistence(root) }).create({ registry, gateway: new RecordingGateway(), sessionId: SESSION_ID, cwd: root });
		expect(await adapter.runtime.start()).toEqual({ status: "failed", reason: "durable extension snapshot audit failed" });
		expect(registry.list("extensions")).toEqual([]);
		await adapter.runtime.close();

		const flushWriter = new RecordingWriter();
		flushWriter.flushMode = "mismatched";
		const flushAdapter = await createProductionExtensionFactory({ scope: TEST_SCOPE, securitySnapshot: securitySnapshot(root), writer: flushWriter, userRoot: null, resolvePaths: () => persistence(root) }).create({ registry, gateway: new RecordingGateway(), sessionId: SESSION_ID, cwd: root });
		expect(await flushAdapter.runtime.start()).toEqual({ status: "failed", reason: "durable extension snapshot audit failed" });
		await flushAdapter.runtime.close();
	});

	it("fails closed when durable state or trust metadata is corrupt", async () => {
		const root = await temporary("metadata-corrupt");
		await mkdir(join(root, ".runledger"), { recursive: true });
		const paths = persistence(root);
		await mkdir(join(root, "metadata"), { recursive: true });
		await writeFile(paths.stateFile, "{not-json\n");
		await writeFile(paths.trustFile, JSON.stringify({ schemaVersion: 1, revision: 0, records: [] }));
		const registry = new ToolRegistry();
		registry.register(bashTool(), { namespace: "production" });
		const adapter = await createProductionExtensionFactory({
			scope: TEST_SCOPE,
			securitySnapshot: securitySnapshot(root),
			writer: new RecordingWriter(),
			userRoot: null,
			resolvePaths: () => paths,
		}).create({ registry, gateway: new RecordingGateway(), sessionId: SESSION_ID, cwd: root });
		expect(await adapter.runtime.start()).toMatchObject({
			status: "failed",
			reason: expect.stringContaining("durable extension state/trust persistence is unavailable"),
		});
		expect(registry.list("extensions")).toEqual([]);
		await adapter.runtime.close();
	});

	it("requires an explicit secure MCP factory and rechecks current policy even for a read-only hint", async () => {
		const root = await temporary("secure-mcp");
		const projectRoot = join(root, ".runledger");
		await mkdir(projectRoot, { recursive: true });
		const configPath = await writeMcp(projectRoot);
		const snapshot = securitySnapshot(root);
		const paths = persistence(root);
		const storage = new NodePolicyExtensionStorage({ cwd: root, securitySnapshot: snapshot });
		const trust = new TrustStore(paths.trustFile, storage);
		await trustProjectMcp(root, storage, trust, configPath);

		const unsafeRegistry = new ToolRegistry();
		unsafeRegistry.register(bashTool(), { namespace: "production" });
		const unsafeAdapter = await createProductionExtensionFactory({
			scope: TEST_SCOPE,
			securitySnapshot: snapshot,
			writer: new RecordingWriter(),
			userRoot: null,
			resolvePaths: () => paths,
		}).create({ registry: unsafeRegistry, gateway: new RecordingGateway(), sessionId: SESSION_ID, cwd: root });
		expect(await unsafeAdapter.runtime.start()).toEqual({
			status: "failed",
			reason: "enabled trusted MCP requires an explicit secure client factory and per-operation authorization",
		});
		expect(unsafeRegistry.list("extensions")).toEqual([]);
		await unsafeAdapter.runtime.close();

		const clientFactory = new RecordingMcpClientFactory();
		const authorization = new CurrentPolicyMcpAuthorization();
		const registry = new ToolRegistry();
		registry.register(bashTool(), { namespace: "production" });
		const adapter = await createProductionExtensionFactory({
			scope: TEST_SCOPE,
			securitySnapshot: snapshot,
			writer: new RecordingWriter(),
			userRoot: null,
			resolvePaths: () => paths,
			secureMcp: { clientFactory, authorization },
		}).create({ registry, gateway: new RecordingGateway(), sessionId: SESSION_ID, cwd: root });
		try {
			expect(await adapter.runtime.start()).toMatchObject({ status: "ready", generation: 1 });
			expect(clientFactory.connections).toBe(1);
			expect(adapter.runtime.beginTurn()).toMatchObject({ status: "ready", generation: 1 });
			const pinnedName = adapter.runtime.catalog()?.pinnedTools[0]?.runtimeName;
			if (!pinnedName) throw new Error("pinned MCP fixture tool was not exposed");
			const pinned = registry.get(pinnedName, "extensions");
			if (!pinned) throw new Error("pinned MCP fixture tool was not registered");
			const context = {} as unknown as ToolContext;
			const first = await pinned.execute("mcp-first", { path: "README.md" }, undefined, undefined, context);
			expect(first.isError).not.toBe(true);
			expect(authorization.calls).toHaveLength(1);
			expect(authorization.calls[0]?.tool.annotations.readOnly).toBe(true);
			expect(clientFactory.client.calls).toBe(1);

			authorization.allowed = false;
			const denied = await pinned.execute("mcp-second", { path: "README.md" }, undefined, undefined, context);
			expect(denied).toMatchObject({ isError: true, content: [{ text: "MCP operation authorization is missing or stale" }] });
			expect(authorization.calls).toHaveLength(2);
			expect(clientFactory.client.calls).toBe(1);
			await adapter.runtime.endTurn();
		} finally {
			await adapter.runtime.close();
		}
	});

	it("keeps Skill fragment receipts stable and redacts thrown Gateway errors", async () => {
		const root = await temporary("stable-redacted");
		const projectRoot = join(root, ".runledger");
		await mkdir(projectRoot, { recursive: true });
		await writeSkill(projectRoot);
		const snapshot = securitySnapshot(root);
		const storage = new NodePolicyExtensionStorage({ cwd: root, securitySnapshot: snapshot });
		const paths = persistence(root);
		const trust = new TrustStore(paths.trustFile, storage);
		const roots = await discoverExtensionRoots({ storage, cwd: root });
		const initial = await discoverSkills({ roots, scope: TEST_SCOPE, trustStore: trust, storage });
		const skill = initial.skills[0];
		if (!skill) throw new Error("Skill fixture was not discovered");
		await trust.grant({
			identity: skill.descriptor.identity,
			canonicalPath: skill.rootPath,
			binding: skill.descriptor.manifest,
			principalId: TEST_SCOPE.principalId,
			scope: "project",
		});
		const registry = new ToolRegistry();
		registry.register(bashTool(), { namespace: "production" });
		const gateway = new RecordingGateway();
		const adapter = await createProductionExtensionFactory({ scope: TEST_SCOPE, securitySnapshot: snapshot, writer: new RecordingWriter(), userRoot: null, resolvePaths: () => paths }).create({ registry, gateway, sessionId: SESSION_ID, cwd: root });
		try {
			expect((await adapter.runtime.start()).status).toBe("ready");
			const provider = adapter.fragmentProviders[0];
			if (!provider) throw new Error("Skill fragment provider missing");
			const request = {
				input: { turn: 7 },
				route: { authorityId: TEST_SCOPE.authorityId, tenantId: TEST_SCOPE.tenantId },
				sessionId: SESSION_ID,
			} as unknown as Parameters<typeof provider.load>[0];
			const first = await provider.load(request);
			const second = await provider.load(request);
			expect(first).toEqual(second);
			expect(first.fragments).toHaveLength(1);
			expect(first.fragments[0]).toMatchObject({
				provenance: { observedAt: adapter.runtime.catalog()?.createdAt, toSequence: 7 },
			});

			gateway.authorizeError = new Error("Bearer super-secret-token");
			const executor = new GatewayHookCommandExecutor({ registry, gateway, cwd: root, policyDigest: snapshot.policyDigest });
			const failed = await executor.execute({ command: "node", args: [], cwd: root, environment: {}, stdin: "{}", timeoutMs: 1_000, maxStdoutBytes: 1_024, maxStderrBytes: 1_024, hookId: "hook:fixture", commandDigest: "a".repeat(64) });
			expect(failed).toMatchObject({ status: "failed", stderr: expect.stringContaining("errorDigest=") });
			expect(failed.stderr).toContain("Error");
			expect(failed.stderr).not.toContain("super-secret-token");

			gateway.authorizeError = undefined;
			gateway.policyDigest = "f".repeat(64);
			const stalePolicy = await executor.execute({ command: "node", args: [], cwd: root, environment: {}, stdin: "{}", timeoutMs: 1_000, maxStdoutBytes: 1_024, maxStderrBytes: 1_024, hookId: "hook:stale-policy", commandDigest: "b".repeat(64) });
			expect(stalePolicy).toMatchObject({ status: "failed", stderr: "hook did not receive a process grant" });
			expect(gateway.executions).toBe(0);

			gateway.policyDigest = snapshot.policyDigest;
			gateway.sandboxEnforcement = "degraded";
			const degraded = await executor.execute({ command: "node", args: [], cwd: root, environment: {}, stdin: "{}", timeoutMs: 1_000, maxStdoutBytes: 1_024, maxStderrBytes: 1_024, hookId: "hook:degraded", commandDigest: "c".repeat(64) });
			expect(degraded).toMatchObject({ status: "failed", stderr: "hook execution lacks a current enforced sandbox receipt" });
			expect(gateway.executions).toBe(1);
		} finally {
			await adapter.runtime.close();
		}
	});

	it("stores spill bytes durably with a verified digest and private modes", async () => {
		const root = await temporary("spill");
		const storage = new NodePolicyExtensionStorage({ cwd: root, securitySnapshot: securitySnapshot(root) });
		const spillRoot = join(root, "spill");
		const spill = new DurableExtensionSpill(spillRoot, storage);
		const ref = await spill.write("hook-output", Buffer.from("bounded spill"));
		expect(await readFile(join(spillRoot, ref.relativePath), "utf8")).toBe("bounded spill");
		expect(ref).toMatchObject({ bytes: 13, digest: expect.stringMatching(/^[a-f0-9]{64}$/u) });
		if (process.platform !== "win32") {
			expect((await stat(join(spillRoot, ref.relativePath))).mode & 0o777).toBe(0o600);
			expect((await stat(spillRoot)).mode & 0o777).toBe(0o700);
		}
	});
});
