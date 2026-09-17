import { describe, expect, it } from "vitest";
import { Value } from "typebox/value";
import { RUNTIME_EVENT_TYPES } from "../../src/runtime/protocol/events.ts";
import type { RuntimeEventType } from "../../src/runtime/protocol/events.ts";
import { RUNTIME_EVENT_PAYLOAD_REQUIREMENTS } from "../../src/runtime/protocol/schemas.ts";
import {
	EXTENSION_CONTRACT_BOUNDS,
	EXTENSION_DEFAULT_HOST_LIMITS,
	EXTENSION_EVENT_NAMES,
	EXTENSION_EVENT_PROJECTION_CATALOG,
	EXTENSION_HOST_ACTION_NAMES,
	EXTENSION_HOST_FRAME_DIRECTIONS,
	EXTENSION_HOST_FRAME_KINDS,
	EXTENSION_HOST_PROTOCOL_VERSION,
	EXTENSION_INTENT_MAX_BYTES,
	EXTENSION_PACKAGE_MANIFEST_KEYS,
	EXTENSION_TOOL_APPROVAL_CLASSES,
	MARKETPLACE_CATALOG_PATHS,
	MARKETPLACE_REJECTED_SOURCE_KINDS,
	MARKETPLACE_SUPPORTED_SOURCE_KINDS,
	ExtensionEventProjectionSchema,
	ExtensionHostActionFrameSchema,
	ExtensionHostEventFrameSchema,
	ExtensionHostFrameSchema,
	ExtensionHostHelloFrameSchema,
	ExtensionHostRegistryFrameSchema,
	ExtensionHostResultFrameSchema,
	ExtensionHostShutdownFrameSchema,
	ExtensionIntentSchema,
	ExtensionPackageManifestSchema,
	ExtensionRegistrySnapshotSchema,
	ExtensionToolRegistrationSchema,
	InstalledPluginsRegistrySchema,
	MarketplaceCatalogSchema,
	MarketplacesRegistrySchema,
	RunledgerPluginsRegistrySchema,
	extensionEventDescriptor,
	isExtensionEventName,
	isExtensionHostFrameKind,
} from "../../src/contracts/extensions/index.ts";

const digest = "a".repeat(64);

const manifest = {
	name: "sample-plugin",
	version: "1.2.3",
	description: "bounded description",
	capabilities: { events: ["PreToolUse"], tools: ["sample_tool"], filesystem: "read", process: false, network: false },
	extensions: ["./src/index.ts"],
	commands: ["./commands/review.md"],
	skills: ["./skills"],
	hooks: ["./hooks/hooks.json"],
};

const limits = { ...EXTENSION_DEFAULT_HOST_LIMITS };

const snapshot = {
	generation: 3,
	hostPid: 4_242,
	packageId: "sample-plugin@local",
	digest,
	tools: [{ name: "sample_tool", description: "does a thing", parameters: { type: "object" }, approvalClass: "read-only" }],
	commands: [{ name: "sample_command", description: "runs a command" }],
	flags: [{ name: "sample-flag", description: "toggles", type: "boolean" }],
	subscriptions: [{ name: "PreToolUse" }],
	limits,
};

describe("Extension package manifest contract", () => {
	it("accepts the declared shape and freezes the known key set", () => {
		expect(Value.Check(ExtensionPackageManifestSchema, manifest)).toBe(true);
		expect(ExtensionPackageManifestSchema.properties).toBeDefined();
		expect(Object.keys(ExtensionPackageManifestSchema.properties).sort()).toEqual([...EXTENSION_PACKAGE_MANIFEST_KEYS].sort());
	});

	it("rejects unknown fields, so omp/pi manifests cannot silently activate", () => {
		expect(Value.Check(ExtensionPackageManifestSchema, { ...manifest, omp: { extensions: ["./x.ts"] } })).toBe(false);
		expect(Value.Check(ExtensionPackageManifestSchema, { ...manifest, pi: {} })).toBe(false);
		expect(Value.Check(ExtensionPackageManifestSchema, { ...manifest, unknownField: 1 })).toBe(false);
	});

	it("rejects non-relative or escaped declarations and non-executable entrypoints", () => {
		expect(Value.Check(ExtensionPackageManifestSchema, { ...manifest, skills: ["../outside"] })).toBe(false);
		expect(Value.Check(ExtensionPackageManifestSchema, { ...manifest, skills: ["/abs/path"] })).toBe(false);
		expect(Value.Check(ExtensionPackageManifestSchema, { ...manifest, extensions: ["./src/index.d.ts"] })).toBe(false);
		expect(Value.Check(ExtensionPackageManifestSchema, { ...manifest, mcpServers: "mcp.json" })).toBe(false);
	});

	it("requires a bounded capability declaration and rejects unknown capability fields", () => {
		const { capabilities: _capabilities, ...withoutCapabilities } = manifest;
		expect(Value.Check(ExtensionPackageManifestSchema, withoutCapabilities)).toBe(false);
		expect(Value.Check(ExtensionPackageManifestSchema, {
			...manifest,
			capabilities: { ...manifest.capabilities, sandbox: "unbounded" },
		})).toBe(false);
		expect(Value.Check(ExtensionPackageManifestSchema, {
			...manifest,
			capabilities: { ...manifest.capabilities, network: true },
		})).toBe(false);
	});

	it("bounds entrypoint count by the frozen contract bound", () => {
		const entrypoints = Array.from({ length: EXTENSION_CONTRACT_BOUNDS.entrypointsPerPackage + 1 }, (_value, index) => `./src/mod-${index}.ts`);
		expect(Value.Check(ExtensionPackageManifestSchema, { ...manifest, extensions: entrypoints })).toBe(false);
	});

	it("accepts a bounded feature declaration set and rejects malformed entries", () => {
		expect(Value.Check(ExtensionPackageManifestSchema, {
			...manifest,
			features: [{ name: "bundle", default: true, description: "bundled commands" }, { name: "audit" }],
		})).toBe(true);
		expect(Value.Check(ExtensionPackageManifestSchema, { ...manifest, features: [{ name: "Bundle" }] })).toBe(false);
		expect(Value.Check(ExtensionPackageManifestSchema, { ...manifest, features: [{ name: "bundle", unknown: 1 }] })).toBe(false);
		expect(Value.Check(ExtensionPackageManifestSchema, { ...manifest, features: [{ default: true }] })).toBe(false);
		const tooMany = Array.from({ length: EXTENSION_CONTRACT_BOUNDS.featuresPerPackage + 1 }, (_value, index) => ({ name: `feature-${index}` }));
		expect(Value.Check(ExtensionPackageManifestSchema, { ...manifest, features: tooMany })).toBe(false);
	});
});

describe("Extension host protocol contract", () => {
	it("freezes the minimal frame set with per-frame directions", () => {
		expect(EXTENSION_HOST_PROTOCOL_VERSION).toBe(1);
		expect([...EXTENSION_HOST_FRAME_KINDS]).toEqual(["hello", "registry", "event", "action", "result", "error", "shutdown"]);
		expect(Object.keys(EXTENSION_HOST_FRAME_DIRECTIONS).sort()).toEqual([...EXTENSION_HOST_FRAME_KINDS].sort());
		for (const kind of EXTENSION_HOST_FRAME_KINDS) expect(isExtensionHostFrameKind(kind)).toBe(true);
		expect(isExtensionHostFrameKind("intent")).toBe(false);
		expect(isExtensionHostFrameKind("registry.next")).toBe(false);
	});

	it("requires protocolVersion and generation on every frame", () => {
		const hello = { protocolVersion: 1, generation: 1, frameId: "f-1", kind: "hello", hostPid: 10, packageId: "sample-plugin@local", digest, apiVersion: "1.0.0", limits };
		expect(Value.Check(ExtensionHostHelloFrameSchema, hello)).toBe(true);
		const { protocolVersion: _protocolVersion, ...withoutVersion } = hello;
		expect(Value.Check(ExtensionHostFrameSchema, withoutVersion)).toBe(false);
		const { generation: _generation, ...withoutGeneration } = hello;
		expect(Value.Check(ExtensionHostFrameSchema, withoutGeneration)).toBe(false);
		expect(Value.Check(ExtensionHostFrameSchema, { ...hello, protocolVersion: 2 })).toBe(false);
	});

	it("carries the whole registry snapshot in one registry frame", () => {
		expect(Value.Check(ExtensionHostRegistryFrameSchema, { ...snapshot, protocolVersion: 1, frameId: "f-2", kind: "registry" })).toBe(true);
		expect(Value.Check(ExtensionHostRegistryFrameSchema, { ...snapshot, protocolVersion: 1, frameId: "f-2", kind: "registry", tools: [{ name: "x", description: "y", parameters: {}, approvalClass: "unknown" }] })).toBe(false);
	});

	it("keeps event payloads bounded and out of the canonical envelope", () => {
		const event = { protocolVersion: 1, generation: 3, frameId: "f-3", kind: "event", requestId: "r-1", name: "PreToolUse", cancelable: true, payload: { toolName: "bash" }, deadlineMs: 30_000 };
		expect(Value.Check(ExtensionHostEventFrameSchema, event)).toBe(true);
		expect(Value.Check(ExtensionHostEventFrameSchema, { ...event, payload: {} })).toBe(true);
		expect(Value.Check(ExtensionHostEventFrameSchema, { ...event, deadlineMs: 0 })).toBe(false);
	});

	it("restricts host actions to the closed action list", () => {
		for (const action of EXTENSION_HOST_ACTION_NAMES) {
			const frame = { protocolVersion: 1, generation: 1, frameId: "f-4", kind: "action", requestId: "r-2", action, payload: {}, deadlineMs: 5_000 };
			expect(Value.Check(ExtensionHostActionFrameSchema, frame), action).toBe(true);
		}
		expect(Value.Check(ExtensionHostActionFrameSchema, { protocolVersion: 1, generation: 1, frameId: "f-4", kind: "action", requestId: "r-2", action: "set-service-tier", payload: {}, deadlineMs: 5_000 })).toBe(false);
		expect(Value.Check(ExtensionHostActionFrameSchema, { protocolVersion: 1, generation: 1, frameId: "f-4", kind: "action", requestId: "r-2", action: "spawn-child", payload: {}, deadlineMs: 5_000 })).toBe(false);
	});

	it("distinguishes success from failure results and rejects free-form errors", () => {
		const ok = { protocolVersion: 1, generation: 1, frameId: "f-5", kind: "result", requestId: "r-3", ok: true, value: { committed: true }, valueDigest: digest };
		expect(Value.Check(ExtensionHostResultFrameSchema, ok)).toBe(true);
		expect(Value.Check(ExtensionHostResultFrameSchema, { ...ok, error: { code: "nope", message: "x" } })).toBe(true);
		expect(Value.Check(ExtensionHostResultFrameSchema, { ...ok, error: { code: "Nope", message: "x" } })).toBe(false);
	});

	it("bounds shutdown reasons and deadlines", () => {
		expect(Value.Check(ExtensionHostShutdownFrameSchema, { protocolVersion: 1, generation: 1, frameId: "f-6", kind: "shutdown", reason: "budget-exceeded", deadlineMs: 2_000 })).toBe(true);
		expect(Value.Check(ExtensionHostShutdownFrameSchema, { protocolVersion: 1, generation: 1, frameId: "f-6", kind: "shutdown", reason: "whatever", deadlineMs: 2_000 })).toBe(false);
	});
});

describe("Extension registry snapshot contract", () => {
	it("accepts a bounded snapshot and rejects unknown registration fields", () => {
		expect(Value.Check(ExtensionRegistrySnapshotSchema, snapshot)).toBe(true);
		expect(Value.Check(ExtensionRegistrySnapshotSchema, { ...snapshot, tools: [{ ...snapshot.tools[0], runtimeName: "injected" }] })).toBe(false);
		expect(Value.Check(ExtensionRegistrySnapshotSchema, { ...snapshot, subscriptions: [{ name: "NotAProjectedEvent" }] })).toBe(false);
	});

	it("keeps approval classes closed and rejects unclassified tools", () => {
		for (const approvalClass of EXTENSION_TOOL_APPROVAL_CLASSES) {
			expect(Value.Check(ExtensionToolRegistrationSchema, { ...snapshot.tools[0], approvalClass }), approvalClass).toBe(true);
		}
		expect(Value.Check(ExtensionToolRegistrationSchema, { ...snapshot.tools[0], approvalClass: "trusted" })).toBe(false);
	});
});

describe("Extension event projection contract", () => {
	it("projects exactly the adjudicated whitelist", () => {
		expect(EXTENSION_EVENT_NAMES).toEqual([
			"SessionStart",
			"SessionEnd",
			"SessionBeforeStop",
			"SessionBeforeCompact",
			"TurnStart",
			"TurnEnd",
			"UserPromptSubmit",
			"PreToolUse",
			"PostToolUse",
			"ContextAssemble",
			"BeforeProviderRequest",
			"ResourcesDiscover",
		]);
		expect(EXTENSION_EVENT_NAMES.length).toBeLessThanOrEqual(32);
	});

	it("keeps every descriptor bounded and free of credential-shaped fields", () => {
		const forbidden = new Set(["token", "secret", "credential", "apiKey", "authorization", "installPath"]);
		for (const descriptor of EXTENSION_EVENT_PROJECTION_CATALOG) {
			expect(descriptor.payloadFields.length, descriptor.name).toBeGreaterThan(0);
			expect(descriptor.payloadBytes, descriptor.name).toBeLessThanOrEqual(EXTENSION_CONTRACT_BOUNDS.eventPayloadBytes);
			for (const field of descriptor.payloadFields) expect(forbidden.has(field), `${descriptor.name}.${field}`).toBe(false);
			expect(isExtensionEventName(descriptor.name)).toBe(true);
			expect(extensionEventDescriptor(descriptor.name)?.name).toBe(descriptor.name);
		}
		expect(extensionEventDescriptor("NotProjected")).toBeUndefined();
		expect(isExtensionEventName("NotProjected")).toBe(false);
	});

	it("rejects projection payloads outside the projected event namespace", () => {
		expect(Value.Check(ExtensionEventProjectionSchema, { name: "PreToolUse", cancelable: true, resultKind: "decision", payload: {} })).toBe(true);
		expect(Value.Check(ExtensionEventProjectionSchema, { name: "ToolCall", cancelable: true, resultKind: "decision", payload: {} })).toBe(false);
		expect(Value.Check(ExtensionEventProjectionSchema, { name: "PreToolUse", cancelable: true, resultKind: "side-effect", payload: {} })).toBe(false);
	});
});

describe("Extension intent contract", () => {
	it("bounds intent payloads and requires status keys where applicable", () => {
		expect(Value.Check(ExtensionIntentSchema, { kind: "notify", level: "info", text: "hello" })).toBe(true);
		expect(Value.Check(ExtensionIntentSchema, { kind: "status", level: "info", key: "Bad Key", text: "hello" })).toBe(false);
		expect(Value.Check(ExtensionIntentSchema, { kind: "status", level: "info", key: "phase", text: "hello" })).toBe(true);
		expect(Value.Check(ExtensionIntentSchema, { kind: "dialog", level: "info", text: "hello" })).toBe(false);
		expect(Value.Check(ExtensionIntentSchema, { kind: "notify", level: "info", text: "x".repeat(EXTENSION_CONTRACT_BOUNDS.textCharacters + 1) })).toBe(false);
		expect(EXTENSION_INTENT_MAX_BYTES).toBeLessThanOrEqual(EXTENSION_CONTRACT_BOUNDS.intentBytes);
	});
});

describe("Plugin distribution disk contracts", () => {
	it("accepts Claude-compatible registries and rejects other registry versions", () => {
		expect(Value.Check(MarketplacesRegistrySchema, { version: 1, marketplaces: [{ name: "local", sourceType: "local", sourceUri: "/tmp/marketplace", catalogPath: "cache/marketplaces/local", addedAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }] })).toBe(true);
		expect(Value.Check(MarketplacesRegistrySchema, { version: 2, marketplaces: [] })).toBe(false);
		expect(Value.Check(InstalledPluginsRegistrySchema, { version: 2, plugins: { "sample@local": [{ scope: "project", installPath: "/home/user/.runledger/plugins/x", version: "1.0.0", installedAt: "2026-01-01T00:00:00.000Z", lastUpdated: "2026-01-01T00:00:00.000Z" }] } })).toBe(true);
		expect(Value.Check(InstalledPluginsRegistrySchema, { version: 1, plugins: {} })).toBe(false);
		expect(Value.Check(InstalledPluginsRegistrySchema, { version: 2, plugins: { "sample@local": [{ scope: "session", installPath: "/x", version: "1.0.0", installedAt: "t", lastUpdated: "t" }] } })).toBe(false);
	});

	it("keeps the RunLedger install ledger bounded and feature-typed", () => {
		const record = { name: "sample-plugin", version: "1.0.0", digest, scope: "project", enabled: false, enabledFeatures: null, source: "./plugins/sample", installedAt: "t", lastUpdated: "t" };
		expect(Value.Check(RunledgerPluginsRegistrySchema, { version: 1, plugins: { "sample-plugin@local": record }, settings: {} })).toBe(true);
		expect(Value.Check(RunledgerPluginsRegistrySchema, { version: 1, plugins: { "sample-plugin@local": { ...record, enabledFeatures: "all" } }, settings: {} })).toBe(false);
		expect(Value.Check(RunledgerPluginsRegistrySchema, { version: 1, plugins: { "sample-plugin@local": { ...record, unknown: 1 } }, settings: {} })).toBe(false);
		// link 安装不是 marketplace source：source 可省略，本地目录记在 runledger 增量字段。
		const { source: _source, ...linked } = record;
		expect(Value.Check(RunledgerPluginsRegistrySchema, { version: 1, plugins: { "dev-plugin": { ...linked, runledgerLinkedPath: "/home/user/dev-plugin" } }, settings: {} })).toBe(true);
	});

	it("parses npm sources but marks them unsupported, never silently rerouted", () => {
		const catalog = {
			name: "local",
			owner: { name: "owner" },
			plugins: [
				{ name: "from-git", source: { source: "github", repo: "owner/repo", sha: "abcdef1" } },
				{ name: "from-npm", source: { source: "npm", package: "some-package" } },
				{ name: "from-path", source: "./plugins/local" },
			],
		};
		expect(Value.Check(MarketplaceCatalogSchema, catalog)).toBe(true);
		expect(Value.Check(MarketplaceCatalogSchema, { ...catalog, plugins: [{ name: "bad", source: "plugins/local" }] })).toBe(false);
		expect(Value.Check(MarketplaceCatalogSchema, { ...catalog, plugins: [{ name: "bad", source: { source: "npm" } }] })).toBe(false);
		expect([...MARKETPLACE_REJECTED_SOURCE_KINDS]).toEqual(["npm"]);
		expect([...MARKETPLACE_SUPPORTED_SOURCE_KINDS]).not.toContain("npm");
		expect([...MARKETPLACE_CATALOG_PATHS]).toEqual([".runledger-plugin/marketplace.json", ".omp-plugin/marketplace.json", ".claude-plugin/marketplace.json"]);
	});
});

describe("Canonical event catalog increment", () => {
	const added: readonly RuntimeEventType[] = [
		"extension.host.started",
		"extension.host.failed",
		"extension.host.stopped",
		"extension.registry.activated",
		"extension.action.committed",
		"extension.action.rejected",
		"plugin.installed",
		"plugin.uninstalled",
		"plugin.upgraded",
		"marketplace.added",
		"marketplace.removed",
		"marketplace.updated",
	];

	it("registers every extension/plugin/marketplace event exactly once", () => {
		for (const type of added) {
			expect(RUNTIME_EVENT_TYPES.filter((candidate) => candidate === type), type).toHaveLength(1);
		}
		expect(new Set(RUNTIME_EVENT_TYPES).size).toBe(RUNTIME_EVENT_TYPES.length);
	});

	it("derives payload requirements from the last event segment, not the first dot", () => {
		for (const type of added) {
			expect(RUNTIME_EVENT_PAYLOAD_REQUIREMENTS[type].length, type).toBeGreaterThan(0);
		}
		expect(RUNTIME_EVENT_PAYLOAD_REQUIREMENTS["extension.host.started"]).toEqual(["transition", "refs", "idempotencyKey"]);
		expect(RUNTIME_EVENT_PAYLOAD_REQUIREMENTS["extension.host.failed"]).toEqual(["transition", "refs", "expectedRevision", "reasonCode"]);
		expect(RUNTIME_EVENT_PAYLOAD_REQUIREMENTS["extension.registry.activated"]).toEqual(["transition", "refs", "expectedRevision"]);
		expect(RUNTIME_EVENT_PAYLOAD_REQUIREMENTS["plugin.installed"]).toEqual(["transition", "idempotencyKey"]);
		expect(RUNTIME_EVENT_PAYLOAD_REQUIREMENTS["plugin.uninstalled"]).toEqual(["transition", "expectedRevision"]);
		expect(RUNTIME_EVENT_PAYLOAD_REQUIREMENTS["marketplace.added"]).toEqual(["transition", "idempotencyKey"]);
	});
});
