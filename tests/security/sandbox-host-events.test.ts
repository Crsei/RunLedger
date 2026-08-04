import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildRunledgerLayout } from "../../src/runtime/contracts/storage-layout.ts";
import { createRuntimeId } from "../../src/runtime/protocol/ids.ts";
import { runtimeDigest } from "../../src/runtime/protocol/foundation.ts";
import type { RuntimeHostScope } from "../../src/runtime/host/types.ts";
import { createProductionHostSecurity } from "../../src/cli/runtime-host-security.ts";
import { ProductionManagedProcessPort } from "../../src/cli/runtime-host-process.ts";

const roots: string[] = [];

afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

function scope(): RuntimeHostScope {
	const digest = (seed: string) => runtimeDigest(seed);
	return {
		authorityId: createRuntimeId("authority", "sandbox-host-events"),
		tenantId: createRuntimeId("tenant", "sandbox-host-events"),
		workspaceId: createRuntimeId("workspace", "sandbox-host-events"),
		repositoryId: createRuntimeId("repository", "sandbox-host-events"),
		workspaceStorageKey: `ws-${"f".repeat(64)}`,
		protocolVersion: 1,
		hostBuildDigest: digest("host"),
		compositionDigest: digest("composition"),
		settingsDigest: digest("settings"),
		modelCatalogDigest: digest("models"),
		tracePolicyDigest: digest("trace"),
		securityAdapterDigest: digest("security"),
		extensionProfileDigest: digest("extension"),
		sessionStorageContractVersion: 1,
		peerAttestor: { kind: "test", generation: 1, configDigest: digest("attestor") },
	};
}

describe.runIf(process.platform === "linux")("Host security event evidence", () => {
	it("records sandbox resolution and final-leaf execution before returning a process result", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-sandbox-host-events-"));
		roots.push(root);
		const layout = buildRunledgerLayout(join(root, "home"), "posix");
		const hostScope = scope();
		const principal = createRuntimeId("principal", "sandbox-host-events");
		const sessionId = createRuntimeId("session", "sandbox-host-events");
		const security = await createProductionHostSecurity({ layout, scope: hostScope, cwd: root, principalId: principal });
		const port = new ProductionManagedProcessPort({ layout, scope: hostScope, hostGeneration: 1, security });

		const created = await port.create({
			sessionId,
			sessionGeneration: 1,
			commandId: "sandbox-host-events-command",
			command: "printf governed-events",
			cwd: root,
			timeoutMs: 5_000,
			backend: "pipe",
			executionMode: "foreground",
			principalId: principal,
		});
		expect(created).toEqual(expect.objectContaining({ ok: true }));
		if (!created.ok) return;
		await port.toolClient(sessionId, 1, principal).processWait(created.handle, 5_000, "driver");

		const eventPath = join(layout.state, "hosts", hostScope.workspaceStorageKey, "runtime-events", `${sessionId}.jsonl`);
		const events = (await readFile(eventPath, "utf8"))
			.split(/\r?\n/u)
			.filter((line) => line.length > 0)
			.map((line) => JSON.parse(line) as { type: string; payload: { effect: string; refs?: readonly unknown[] } });

		expect(events.map((event) => event.type)).toEqual(expect.arrayContaining(["sandbox.resolved", "sandbox.execution_recorded"]));
		expect(events.find((event) => event.type === "sandbox.resolved")?.payload.refs?.length).toBeGreaterThan(0);
		expect(events.find((event) => event.type === "sandbox.execution_recorded")?.payload.effect).toBe("committed");
	});

	it("records an approval request and durable decision through the same Host event writer", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-permission-host-events-"));
		roots.push(root);
		const layout = buildRunledgerLayout(join(root, "home"), "posix");
		const hostScope = scope();
		const principal = createRuntimeId("principal", "permission-host-events");
		const sessionId = createRuntimeId("session", "permission-host-events");
		const security = await createProductionHostSecurity({
			layout,
			scope: hostScope,
			cwd: root,
			sessionId,
			principalId: principal,
			permissionPrompter: {
				request: async () => ({ decision: "allow-once", decidedBy: principal }),
			},
		});

		await security.createExecutionEnv({ sessionId, principalId: principal, toolCallId: createRuntimeId("toolCall", "permission-host-events"), cwd: root }).fs.writeFile(join(root, "approved.txt"), "approved");
		const eventPath = join(layout.state, "hosts", hostScope.workspaceStorageKey, "runtime-events", `${sessionId}.jsonl`);
		const events = (await readFile(eventPath, "utf8"))
			.split(/\r?\n/u)
			.filter((line) => line.length > 0)
			.map((line) => JSON.parse(line) as { type: string; payload: { effect: string; refs?: readonly unknown[] } });

		expect(events.map((event) => event.type)).toEqual(["permission.requested", "permission.decided"]);
		expect(events[1]?.payload).toMatchObject({ effect: "committed" });
		expect(events[1]?.payload.refs?.length).toBeGreaterThan(0);
	});
});
