import { describe, expect, it } from "vitest";
import { createExtensionResourceIdentity } from "../../../src/extensions/identity.ts";
import { runHookPipeline } from "../../../src/extensions/hooks/pipeline.ts";
import type { HookCommandRunner, HookDefinition, HookEvent } from "../../../src/extensions/hooks/types.ts";
import { McpConnectionManager } from "../../../src/extensions/mcp/connection-manager.ts";
import type { McpClientFactory, McpTransportClient } from "../../../src/extensions/mcp/types.ts";
import { SkillCatalog } from "../../../src/extensions/skills/catalog.ts";
import type { SkillDescriptor } from "../../../src/extensions/skills/types.ts";
import type { AdapterIdentityRef } from "../../../src/runtime/protocol/adapter.ts";
import { runtimeDigest } from "../../../src/runtime/protocol/foundation.ts";
import type { IdentityContext } from "../../../src/runtime/identity/types.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/ids.ts";
import type { RuntimeAdapterPort, RuntimeAdapterPortName } from "../../../src/runtime/contracts/ports.ts";
import { RuntimeHookAdapter } from "../../../src/extensions/integration/runtime-hook-adapter.ts";
import { RuntimeMcpAdapter } from "../../../src/extensions/integration/runtime-mcp-adapter.ts";
import { RuntimeSkillAdapter } from "../../../src/extensions/integration/runtime-skill-adapter.ts";

const identity: IdentityContext = {
	authorityId: createRuntimeId("authority", "extension-adapter"),
	tenantId: createRuntimeId("tenant", "extension-adapter"),
	principalId: createRuntimeId("principal", "extension-adapter"),
	principalKind: "local",
	issuedAt: "2026-08-04T00:00:00.000Z",
};

const adapter: AdapterIdentityRef = {
	adapterId: "extension-adapter",
	generation: 1,
	configDigest: runtimeDigest("extension-adapter-config"),
};

const snapshotId = createRuntimeId("snapshot", "extension-adapter");
const receiptRef = { subjectKind: "receipt" as const, digest: runtimeDigest("decision") };

function resource(kind: "hook" | "mcp-tool" | "skill", qualifiedId: string) {
	return createExtensionResourceIdentity({
		kind,
		qualifiedId,
		version: "1",
		source: "project",
		digest: runtimeDigest({ kind, qualifiedId }).digest,
	});
}

function invocation(resourceIdentity: ReturnType<typeof resource>, input: unknown, seed: string) {
	return {
		requestId: createRuntimeId("command", seed),
		tool: resourceIdentity,
		inputDigest: runtimeDigest(input),
		requestedClaims: [],
		decisionReceiptRef: receiptRef,
		snapshotId,
		correlationId: createRuntimeId("trace", seed),
	} as const;
}

function okPort<P extends RuntimeAdapterPortName>(port: P): RuntimeAdapterPort<P> {
	return {
		async execute(request) {
			return {
				port: request.port,
				action: request.action,
				requestId: request.requestId,
				outcome: "ok",
				effect: "terminal",
				adapter,
				outputDigest: runtimeDigest({ port, requestId: request.requestId }),
				outputRef: { subjectKind: "content", digest: runtimeDigest({ port, requestId: request.requestId }) },
				receiptRef,
				completedAt: "2026-08-04T00:00:01.000Z",
			};
		},
	};
}

function hookDefinition(resourceId: ReturnType<typeof resource>["resourceId"]): HookDefinition {
	return {
		id: "hook:project:fixture:pre-tool",
		event: "PreToolUse",
		handlers: [{ type: "command", command: "fixture-hook", args: [], timeoutMs: 100, env: {} }],
		sourceLayer: "project",
		sourcePath: "/fixture/hooks.json",
		declarationIndex: 0,
		resourceId,
	};
}

function hookEvent(input: unknown): HookEvent {
	return {
		event: "PreToolUse",
		eventId: createRuntimeId("event", "extension-hook"),
		timestamp: "2026-08-04T00:00:00.000Z",
		sessionId: createRuntimeId("session", "extension-adapter"),
		snapshotId,
		source: "test",
		input,
	};
}

describe("Host-facing extension adapters", () => {
	it("invokes the existing hook pipeline and returns revalidation plus digest-only audit", async () => {
		const hookIdentity = resource("hook", "hook:project:fixture:pre-tool");
		const runner: HookCommandRunner = {
			async run() {
				return {
					exitCode: 0,
					stdout: JSON.stringify({ decision: "allow", updatedInput: { safe: true }, additionalContext: "context" }),
					stderr: "",
				};
			},
		};
		const hook = new RuntimeHookAdapter({
			pipeline: runHookPipeline,
			runner,
			resources: { invocation: okPort("resource_invocation") },
			adapter,
		});
		const rawInput = { token: "raw-secret", command: "inspect" };
		const result = await hook.invoke({
			identity,
			deadline: "2026-08-04T00:01:00.000Z",
			invocation: invocation(hookIdentity, rawInput, "hook-invoke"),
			event: hookEvent(rawInput),
			hooks: [hookDefinition(hookIdentity.resourceId)],
		});

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value).toMatchObject({ decision: "allow", requiresRevalidation: true, finalInput: { safe: true } });
		expect(result.audit.kind).toBe("hook.run");
		expect(JSON.stringify(result.audit)).not.toContain("raw-secret");
		expect(result.auditDigest.digest).toHaveLength(64);
	});

	it("fails closed before a hook runner when the resource port denies or returns an unknown effect", async () => {
		let runs = 0;
		const runner: HookCommandRunner = {
			async run() {
				runs += 1;
				return { exitCode: 0, stdout: JSON.stringify({ decision: "allow" }), stderr: "" };
			},
		};
		const hookIdentity = resource("hook", "hook:project:fixture:deny");
		const deniedPort: RuntimeAdapterPort<"resource_invocation"> = {
			async execute(request) {
				return {
					port: request.port,
					action: request.action,
					requestId: request.requestId,
					outcome: "denied",
					effect: "none",
					adapter,
					outputDigest: runtimeDigest("denied"),
					error: { code: "capability_denied", message: "denied", retryable: false, correlationId: request.traceId },
					completedAt: "2026-08-04T00:00:01.000Z",
				};
			},
		};
		const denied = await new RuntimeHookAdapter({ pipeline: runHookPipeline, runner, resources: { invocation: deniedPort }, adapter }).invoke({
			identity,
			deadline: "2026-08-04T00:01:00.000Z",
			invocation: invocation(hookIdentity, { token: "secret" }, "hook-denied"),
			event: hookEvent({ token: "secret" }),
			hooks: [hookDefinition(hookIdentity.resourceId)],
		});
		expect(denied).toMatchObject({ ok: false, error: { code: "authorization_denied" } });
		expect(runs).toBe(0);

		const unknownPort: RuntimeAdapterPort<"resource_invocation"> = {
			async execute(request) {
				return {
					port: request.port,
					action: request.action,
					requestId: request.requestId,
					outcome: "ok",
					effect: "future-effect",
					adapter,
					outputDigest: runtimeDigest("unknown"),
					completedAt: "2026-08-04T00:00:01.000Z",
				} as never;
			},
		};
		const unknown = await new RuntimeHookAdapter({ pipeline: runHookPipeline, runner, resources: { invocation: unknownPort }, adapter }).invoke({
			identity,
			deadline: "2026-08-04T00:01:00.000Z",
			invocation: invocation(hookIdentity, { command: "inspect" }, "hook-unknown-effect"),
			event: hookEvent({ command: "inspect" }),
			hooks: [hookDefinition(hookIdentity.resourceId)],
		});
		expect(unknown).toMatchObject({ ok: false, error: { code: "unknown_effect" } });
		expect(runs).toBe(0);
	});

	it("maps an MCP manager call to a bounded RuntimeToolResult without putting content in audit", async () => {
		const client: McpTransportClient = {
			async listTools() {
				return [{ name: "search", description: "search", inputSchema: { type: "object" }, annotations: { readOnly: true, destructive: false, concurrencySafe: true } }];
			},
			async callTool() {
				return { isError: false, content: [{ type: "text", text: "private-body" }] };
			},
			async close() {},
		};
		const factory: McpClientFactory = { async connect() { return client; } };
		const manager = new McpConnectionManager({ factory, authorize: async () => ({ decision: "allow" }) });
		const started = await manager.start({
			serverId: "mcp-server:project:fixture",
			displayName: "fixture",
			transport: "stdio",
			enabled: true,
			trusted: true,
			required: false,
			startupTimeoutMs: 100,
			toolTimeoutMs: 100,
			enabledTools: ["search"],
			maxResultBytes: 128,
		});
		expect(started.ok).toBe(true);
		const mcpIdentity = resource("mcp-tool", "mcp-tool:project:fixture:search");
		const mcp = new RuntimeMcpAdapter({ manager, resources: { invocation: okPort("resource_invocation") }, adapter });
		const result = await mcp.invoke({
			identity,
			deadline: "2026-08-04T00:01:00.000Z",
			invocation: invocation(mcpIdentity, { query: "private" }, "mcp-invoke"),
			serverId: "mcp-server:project:fixture",
			toolName: "search",
			runtimeName: "mcp__fixture__search",
			input: { query: "private" },
		});

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.runtimeResult).toMatchObject({ outcome: "ok", content: [{ type: "text", text: "private-body" }] });
		expect(JSON.stringify(result.audit)).not.toContain("private-body");
		expect(result.auditDigest.digest).toHaveLength(64);
	});

	it("resolves a qualified Skill through the existing catalog and fails closed when the catalog port is unavailable", async () => {
		const skillIdentity = resource("skill", "skill:project:fixture:review");
		const descriptor: SkillDescriptor = {
			descriptor: {
				kind: "skill",
				identity: { kind: "skill", qualifiedId: skillIdentity.qualifiedId, version: "1", source: "project", digest: skillIdentity.digest.digest },
				resource: skillIdentity,
				provenance: { source: "project", sourceLocatorDigest: runtimeDigest("/fixture/SKILL.md") },
				displayName: "review",
				description: "Review releases",
				enabled: true,
				trusted: true,
				ready: true,
				trust: "trusted",
				activation: "ready",
			},
			frontmatter: { name: "review", description: "Review releases", userInvocable: true, disableModelInvocation: false, metadata: {} },
			rootPath: "/fixture/review",
			skillFile: "/fixture/review/SKILL.md",
			bodyDigest: runtimeDigest("private skill body").digest,
			resourceSet: {
				qualifiedId: skillIdentity.qualifiedId,
				metadata: { role: "metadata", identity: skillIdentity, contentDigest: runtimeDigest("metadata").digest, byteLength: 8, entryCount: 1, capabilities: [] },
				body: { role: "body", identity: skillIdentity, contentDigest: runtimeDigest("private skill body").digest, byteLength: 17, entryCount: 1, capabilities: ["filesystem:read"] },
				budget: { maxBytes: 1024, maxEntries: 16 },
			},
			sourceRoot: { source: "project", sourceKey: "project:fixture", rootPath: "/fixture", priority: 1 },
			priority: 1,
			trustBinding: { identity: skillIdentity, canonicalPath: "/fixture/review", binding: { rootDigest: runtimeDigest("root").digest, manifestDigest: runtimeDigest("manifest").digest, configDigest: runtimeDigest("config").digest, assetsDigest: runtimeDigest("assets").digest, capabilityDigest: runtimeDigest("capabilities").digest, combinedDigest: skillIdentity.digest.digest }, principalId: identity.principalId },
		};
		const catalog = new SkillCatalog([descriptor]);
		const skill = new RuntimeSkillAdapter({ catalog, resources: { catalog: okPort("resource_catalog") }, adapter });
		const skillInvocationValue = "$skill:project:fixture:review";
		const result = await skill.resolve({
			identity,
			deadline: "2026-08-04T00:01:00.000Z",
			invocation: invocation(skillIdentity, skillInvocationValue, "skill-resolve"),
			value: skillInvocationValue,
		});

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value).toMatchObject({ skillId: skillIdentity.qualifiedId, trigger: "dollar" });
		expect(JSON.stringify(result.audit)).not.toContain("private skill body");

		const unavailable = new RuntimeSkillAdapter({
			catalog,
			resources: {},
			adapter,
		}).resolve({
			identity,
			deadline: "2026-08-04T00:01:00.000Z",
			invocation: invocation(skillIdentity, skillIdentity.qualifiedId, "skill-unavailable"),
			value: skillIdentity.qualifiedId,
		});
		expect(await unavailable).toMatchObject({ ok: false, error: { code: "unavailable" } });
	});
});
