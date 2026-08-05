import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRuntimeId } from "../../../src/runtime/protocol/ids.ts";
import { runtimeDigest } from "../../../src/runtime/protocol/foundation.ts";
import { buildRunledgerLayout } from "../../../src/runtime/contracts/storage-layout.ts";
import { JsonlRuntimeEventStore } from "../../../src/storage/host/runtime-event-store.ts";
import type { ExtensionPublicSnapshot, ExtensionReloadResult } from "../../../src/extensions/host-manager.ts";
import type { SecuritySnapshot } from "../../../src/security/types.ts";
import type { HostRuntimeDomainContext } from "../../../src/cli/runtime-host-service.ts";
import { createHostDomainPorts } from "../../../src/cli/runtime-host-domains.ts";

function securitySnapshot(): SecuritySnapshot {
	return {
		profile: { name: "workspace-write", approvalPolicy: "on-request", filesystemMode: "workspace-write", network: { mode: "deny", allowedHosts: [] }, sandbox: "off" },
		filesystem: { mode: "workspace-write", workspaceRoot: "/private/workspace", protectedPaths: [] },
		rules: [],
		sources: ["user"],
		workspaceRoot: "/private/workspace",
		tempRoot: "/private/tmp",
		policyDigest: runtimeDigest("policy"),
		createdAt: "2026-08-05T00:00:00.000Z",
	};
}

function snapshot(): ExtensionPublicSnapshot {
	return {
		snapshotId: "snapshot_extension-domain",
		generation: 1,
		createdAt: "2026-08-05T00:00:00.000Z",
		digest: "d".repeat(64),
		counts: { plugins: 1, skills: 0, hooks: 0, mcpServers: 0, mcpTools: 0, ready: 0, blocked: 1, disabled: 0, error: 0 },
		descriptors: [{
			kind: "plugin",
			identity: { kind: "plugin", qualifiedId: "plugin:fixture", version: "1.0.0", source: "project", digest: "plugin-digest" },
			displayName: "fixture",
			enabled: true,
			trusted: false,
			ready: false,
			trust: "untrusted",
			activation: "blocked",
		}],
		diagnostics: [],
	};
}

function context(operation: string, mutation = false): HostRuntimeDomainContext {
	const sessionId = createRuntimeId("session", "extension-domain");
	return {
		principal: { principalId: createRuntimeId("principal", "extension-domain"), connectionId: createRuntimeId("connection", "extension-domain"), attestationDigest: runtimeDigest("attestation") },
		frame: { frameId: "extension-domain-frame", kind: "command_request", protocolVersion: 1, body: { operation, sessionId, expectedDomainRevision: 0 } },
		operation,
		mutation,
		sessionId,
		controller: {} as HostRuntimeDomainContext["controller"],
		hostGeneration: 1,
		sessionGeneration: 1,
		driverRevision: 1,
		domainRevision: 0,
	};
}

describe("Host extension domain adapter", () => {
	it("projects bounded extension state and returns snapshot events through the Host port", async () => {
		const current = snapshot();
		const reloadResult: ExtensionReloadResult = { status: "ready", snapshot: current };
		const calls: string[] = [];
		const manager = {
			publicSnapshot: () => current,
			reload: async () => { calls.push("reload"); return reloadResult; },
			setEnabled: async () => reloadResult,
			trust: async () => reloadResult,
			untrust: async () => reloadResult,
		};
		const ports = createHostDomainPorts({
			security: { snapshot: securitySnapshot() },
			workspace: { workspaceId: createRuntimeId("workspace", "extension-domain"), defaultCwd: "/private/workspace" },
			extensions: { manager, authorityId: createRuntimeId("authority", "extension-domain"), tenantId: createRuntimeId("tenant", "extension-domain") },
		});
		expect(ports.map((port) => port.name)).toEqual(["security", "workspace", "extensions"]);
		const inspected = await ports[2]!.execute(context("extension.inspect"));
		expect(inspected).toMatchObject({ ok: true, body: { snapshot: { digest: current.digest, descriptors: [{ identity: { qualifiedId: "plugin:fixture" } }] } } });
		const reloaded = await ports[2]!.execute(context("extension.reload", true));
		expect(reloaded).toMatchObject({ ok: true, body: { status: "ready", snapshot: { snapshotId: current.snapshotId } } });
		expect(calls).toEqual(["reload"]);
		expect(reloaded.events).toHaveLength(1);
		expect(reloaded.events?.[0]?.type).toBe("resource.snapshot_acquired");
		const root = await mkdtemp(join(tmpdir(), "runledger-extension-domain-event-"));
		try {
			const event = reloaded.events?.[0];
			expect(event).toBeDefined();
			if (event === undefined) return;
			const writer = new JsonlRuntimeEventStore({
				layout: buildRunledgerLayout(join(root, "home"), "posix"),
				workspaceStorageKey: "ws-" + "e".repeat(64),
			});
			await expect(writer.append(event)).resolves.toBeDefined();
		} finally {
			await rm(root, { recursive: true, force: true });
		}
		expect(JSON.stringify(reloaded)).not.toContain("/private");
	});
});
