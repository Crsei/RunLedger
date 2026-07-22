import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalDigest, canonicalJson } from "../../src/runtime/protocol/v3/canonical-json.ts";
import { createRuntimeId } from "../../src/runtime/protocol/v3/ids.ts";
import { parseExtensionCommand } from "../../src/extensions/control-plane/commands.ts";
import { ExtensionControlPlane, renderExtensionControlPlane } from "../../src/extensions/control-plane/control-plane.ts";
import { extensionViewModels } from "../../src/extensions/control-plane/view-model.ts";
import { ExtensionManager } from "../../src/extensions/extension-manager.ts";
import { createExtensionResourceIdentity } from "../../src/extensions/identity.ts";
import { boundedAuditPayload, ExtensionRuntimeEventSinkAdapter, lifecycleEvent, resourceAudit } from "../../src/extensions/integration/runtime-audit-adapter.ts";
import { ExtensionRuntimeCatalogAdapter, ExtensionRuntimeInvocationAdapter, projectRuntimeSnapshot } from "../../src/extensions/integration/runtime-resource-adapter.ts";
import { buildExtensionSnapshot } from "../../src/extensions/snapshot.ts";
import { ExtensionStateStore } from "../../src/extensions/state-store.ts";
import { buildResourceManifestDigest } from "../../src/extensions/trust/digest.ts";
import { TrustStore } from "../../src/extensions/trust/trust-store.ts";
import type { ExtensionResourceDescriptor, ExtensionSourceRoot } from "../../src/extensions/types.ts";
import type { RuntimeToolInvocation } from "../../src/runtime/resources/types.ts";
import { createResourceProtocolHandshake } from "../../src/runtime/resources/schemas.ts";
import { consumeResourceInvocation } from "../../src/runtime/resources/invocation-stream.ts";
import { makeExtensionTempDir, NodeTestExtensionStorage, removeExtensionTempDir, TEST_SCOPE } from "./helpers.ts";

const storage = new NodeTestExtensionStorage();
const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map(removeExtensionTempDir));
});

async function temporary(label: string): Promise<string> {
	const path = await makeExtensionTempDir(label);
	temporaryDirectories.push(path);
	return path;
}

function root(path: string): ExtensionSourceRoot {
	return { source: "project", sourceKey: "project:adapters", rootPath: path, priority: 200 };
}

function toolDescriptor(): ExtensionResourceDescriptor {
	const manifest = buildResourceManifestDigest({ rootDigest: canonicalDigest("tool-root"), capabilityDigest: canonicalDigest("tool-capability") });
	const identity = createExtensionResourceIdentity({ scope: TEST_SCOPE, kind: "mcp-tool", qualifiedId: "mcp-tool:project:fixture:echo", version: "1", source: "project", digest: manifest.combinedDigest });
	return {
		schemaVersion: 1,
		kind: "mcp-tool",
		identity,
		provenance: { schemaVersion: 1, authorityId: TEST_SCOPE.authorityId, tenantId: TEST_SCOPE.tenantId, source: "project", canonicalLocator: "/fixture/mcp.json" },
		manifest,
		displayName: "echo",
		description: "Echo a value",
		runtimeName: "mcp__fixture__echo",
		sourcePath: "/fixture/mcp.json",
		enabled: true,
		trust: "trusted",
		activation: "ready",
		approvalReceiptId: createRuntimeId("receipt", "extension-tool-approval"),
		capabilities: [],
		risk: { level: "low", sideEffect: "read", rationaleDigest: canonicalDigest("read-only") },
		exposure: "direct",
		diagnostics: [],
		tool: { inputSchemaJson: canonicalJson({ type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false }), maxInputBytes: 4_096, resultContentKinds: ["text"], execution: { readOnly: true, destructive: false, concurrencySafe: true } },
	};
}

describe("Extension control plane and Runtime adapters", () => {
	it("parses discriminated extension commands without consuming legacy flags", () => {
		expect(parseExtensionCommand(["inspect", "--json"])).toMatchObject({ ok: true, command: { kind: "inspect", json: true } });
		expect(parseExtensionCommand(["trust", "grant", "skill:project:fixture"])).toMatchObject({ ok: true, command: { kind: "trust-grant", resourceId: "skill:project:fixture" } });
		expect(parseExtensionCommand(["mcp", "doctor"])).toMatchObject({ ok: true, command: { kind: "mcp-doctor" } });
		expect(parseExtensionCommand(["--continue"])).toEqual({ ok: false, passthrough: true });
		expect(parseExtensionCommand(["plugin", "unknown"])).toMatchObject({ ok: false, message: expect.stringContaining("unknown") });
	});

	it("grants standalone Skill trust against its canonical root and exposes one snapshot fact through list/view models", async () => {
		const parent = await temporary("control-plane");
		const extensionRoot = join(parent, ".runledger");
		const skillRoot = join(extensionRoot, "skills", "fixture");
		await mkdir(skillRoot, { recursive: true });
		await writeFile(join(skillRoot, "SKILL.md"), "---\nname: fixture\ndescription: Fixture skill\n---\nFixture body\n");
		const trust = new TrustStore(join(parent, "trust.json"), storage);
		const state = new ExtensionStateStore(join(parent, "extensions-state.json"), storage);
		const manager = new ExtensionManager({ scope: TEST_SCOPE, roots: [root(extensionRoot)], storage, trustStore: trust, stateStore: state, pluginDataRoot: join(parent, "plugin-data") });
		try {
			expect((await manager.reload()).status).toBe("applied");
			const skill = manager.current()?.skills[0];
			if (!skill) throw new Error("standalone skill missing");
			expect(skill.descriptor.activation).toBe("blocked");
			const control = new ExtensionControlPlane({ manager, state, trust, scope: TEST_SCOPE });
			const granted = await control.execute({ kind: "trust-grant", resourceId: skill.descriptor.identity.qualifiedId, json: true });
			expect(granted).toMatchObject({ schemaVersion: 1, ok: true, exitCode: 0, data: { reload: "pending" } });
			expect((await trust.load()).records[0]?.canonicalPath).toBe(skillRoot);
			expect((await manager.reload()).status).toBe("applied");
			const listed = await control.execute({ kind: "skill-list", json: true });
			expect(listed).toMatchObject({ ok: true, data: [{ kind: "skill", trust: "trusted", activation: "ready" }] });
			const current = manager.current();
			if (!current) throw new Error("extension snapshot missing");
			expect(extensionViewModels(current)).toMatchObject([{ kind: "skill", status: "ready", componentCount: 0 }]);
			expect(JSON.parse(renderExtensionControlPlane(listed, true))).toMatchObject({ schemaVersion: 1, ok: true });
		} finally {
			await manager.close();
		}
	});

	it("projects an immutable extension tool into exact Runtime catalog/snapshot contracts", async () => {
		const descriptor = toolDescriptor();
		const snapshot = buildExtensionSnapshot({ generation: 7, createdAt: "2026-07-22T00:00:00.000Z", descriptors: [descriptor], diagnostics: [] });
		const projected = projectRuntimeSnapshot(snapshot, TEST_SCOPE);
		expect(projected).toMatchObject({ schemaVersion: 1, adapterGeneration: 7, resources: [{ descriptorType: "tool", runtimeName: "mcp__fixture__echo", identity: descriptor.identity }] });
		expect(projected.digest).toHaveLength(64);
		const catalog = new ExtensionRuntimeCatalogAdapter(snapshot, TEST_SCOPE);
		const resolveRequest = { schemaVersion: 1 as const, ...TEST_SCOPE, requestId: createRuntimeId("command", "extension-resolve"), snapshotId: snapshot.snapshotId, identity: descriptor.identity };
		const resolved = await catalog.resolveExact(resolveRequest);
		expect(resolved).toMatchObject({ status: "found", descriptor: { descriptorType: "tool" } });
		const searched = await catalog.search({ schemaVersion: 1, ...TEST_SCOPE, requestId: createRuntimeId("command", "extension-search"), snapshotId: snapshot.snapshotId, query: "echo", limit: 10 });
		expect(searched.items).toHaveLength(1);
		const acquired = await catalog.acquire({ schemaVersion: 1, ...TEST_SCOPE, requestId: createRuntimeId("command", "extension-acquire"), minimumGeneration: 7 });
		expect(acquired.snapshot.snapshotId).toBe(snapshot.snapshotId);
		const releaseRequest = { schemaVersion: 1 as const, ...TEST_SCOPE, requestId: createRuntimeId("command", "extension-release"), snapshotId: snapshot.snapshotId, expectedGeneration: 7 };
		expect(await catalog.release(releaseRequest)).toMatchObject({ status: "released" });
		expect(await catalog.release(releaseRequest)).toMatchObject({ status: "already_released" });
	});

	it("canonicalizes, derives, invokes idempotently, and cancels extension tools through Runtime ports", async () => {
		const descriptor = toolDescriptor();
		const snapshot = buildExtensionSnapshot({ generation: 1, createdAt: "2026-07-22T00:00:00.000Z", descriptors: [descriptor], diagnostics: [] });
		let calls = 0;
		const handlers = new Map([[descriptor.identity.qualifiedId, async (input: unknown) => {
			calls += 1;
			return { content: [{ type: "text" as const, text: canonicalJson(input) }], isError: false, originalBytes: canonicalJson(input).length, truncated: false };
		}]]);
		const adapter = new ExtensionRuntimeInvocationAdapter({ snapshot, scope: TEST_SCOPE, deriver: { derive: async () => [] }, handlers });
		const requestId = createRuntimeId("command", "extension-invoke");
		const correlationId = createRuntimeId("trace", "extension-invoke");
		const projected = projectRuntimeSnapshot(snapshot, TEST_SCOPE);
		const handshake = createResourceProtocolHandshake({ schemaVersion: 1, ...TEST_SCOPE, protocol: "runledger.resource", protocolVersion: 1, sessionId: createRuntimeId("session", "extension-invoke"), adapterId: projected.adapterId, adapterGeneration: projected.adapterGeneration, snapshotId: snapshot.snapshotId, snapshotSequence: 0, catalogDigest: projected.digest, peerFeatures: [] });
		const derived = await adapter.canonicalizeAndDerive({ schemaVersion: 1, ...TEST_SCOPE, requestId, handshake, tool: descriptor.identity, snapshotId: snapshot.snapshotId, rawInput: { text: "hello" }, requestedClaims: [], correlationId });
		expect(derived.status).toBe("derived");
		if (derived.status !== "derived") return;
		const invocation: RuntimeToolInvocation = { schemaVersion: 1, ...TEST_SCOPE, requestId, handshake, invocationSequence: 0, tool: descriptor.identity, snapshotId: snapshot.snapshotId, correlationId, derivationReceipt: derived.receipt, decision: "allow", authorizationReceiptId: createRuntimeId("receipt", "extension-invoke-approval"), authorizationDecisionDigest: canonicalDigest("allow") };
		const first = await consumeResourceInvocation(invocation, adapter.invoke(invocation));
		const second = await consumeResourceInvocation(invocation, adapter.invoke(invocation));
		expect(first).toEqual(second);
		expect(first).toMatchObject({ ok: true, result: { isError: false, content: [{ type: "text", text: '{"text":"hello"}' }] } });
		expect(calls).toBe(1);
		expect(await adapter.cancel({ schemaVersion: 1, ...TEST_SCOPE, requestId, reasonDigest: canonicalDigest("late") })).toMatchObject({ status: "already_terminal" });
	});

	it("redacts and bounds audit payloads and fails closed when the durable event sink is unavailable", async () => {
		const descriptor = toolDescriptor();
		const snapshot = buildExtensionSnapshot({ generation: 1, createdAt: "2026-07-22T00:00:00.000Z", descriptors: [descriptor], diagnostics: [] });
		expect(boundedAuditPayload({ apiKey: "raw-secret", nested: { authorization: "Bearer raw" } })).toEqual({ apiKey: "[redacted]", nested: { authorization: "[redacted]" } });
		const audit = resourceAudit({ kind: "mcp.tool/v1", sessionId: "session", snapshotId: snapshot.snapshotId, descriptor, occurredAt: snapshot.createdAt, payload: { token: "raw", resultSize: 12 } });
		expect(audit.payload).toMatchObject({ token: "[redacted]", resultSize: 12 });
		expect(() => lifecycleEvent({ scope: TEST_SCOPE, descriptor, snapshot, state: "approved", correlationSeed: "approved", occurredAt: snapshot.createdAt })).toThrow(/requires receipt/u);
		expect(lifecycleEvent({ scope: TEST_SCOPE, descriptor, snapshot, state: "approved", correlationSeed: "approved", occurredAt: snapshot.createdAt, receiptId: descriptor.approvalReceiptId })).toMatchObject({ state: "approved", receiptId: descriptor.approvalReceiptId });
		const sink = new ExtensionRuntimeEventSinkAdapter(TEST_SCOPE);
		const event = lifecycleEvent({ scope: TEST_SCOPE, descriptor, snapshot, state: "discovered", correlationSeed: "discovered", occurredAt: snapshot.createdAt });
		const emitted = await sink.emit({ schemaVersion: 1, ...TEST_SCOPE, idempotencyKey: createRuntimeId("command", "extension-event"), event });
		expect(emitted).toMatchObject({ status: "rejected", error: { code: "unavailable" } });
	});
});
