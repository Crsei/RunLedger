import { describe, expect, it } from "vitest";
import { lstat, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRunledgerLayout } from "../../../src/runtime/contracts/storage-layout.ts";
import { runtimeDigest } from "../../../src/runtime/protocol/foundation.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/ids.ts";
import {
	HostShutdownIntentStore,
	createHostShutdownIntent,
	evaluateHostReplacementAdmission,
	evaluateStoredHostReplacementAdmission,
} from "../../../src/storage/host/shutdown-intent-store.ts";

describe("durable Host shutdown intent", () => {
	it("persists an identity-bound maintenance target and rejects tampering", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-host-shutdown-intent-"));
		try {
			const layout = buildRunledgerLayout(join(root, "home"), "posix");
			const workspaceStorageKey = "ws-" + "d".repeat(64);
			const store = new HostShutdownIntentStore(layout, workspaceStorageKey);
			const intent = createHostShutdownIntent({
				workspaceStorageKey,
				hostRuntimeId: createRuntimeId("runtime", "shutdown-intent"),
				hostGeneration: 12,
				reason: "maintenance_restart",
				targetBuildDigest: runtimeDigest("replacement-build"),
				requestedAt: "2026-08-07T00:00:00.000Z",
			});
			await store.write(intent);
			expect(await store.read()).toEqual(intent);
			await expect(store.write({ ...intent, hostGeneration: 13 })).rejects.toThrow("invalid Host shutdown intent");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("prevents an old build from winning a maintenance replacement election", () => {
		const workspaceStorageKey = "ws-" + "e".repeat(64);
		const targetBuildDigest = runtimeDigest("new-build");
		const intent = createHostShutdownIntent({
			workspaceStorageKey,
			hostRuntimeId: createRuntimeId("runtime", "old-host"),
			hostGeneration: 4,
			reason: "maintenance_restart",
			targetBuildDigest,
			requestedAt: "2026-08-07T00:00:00.000Z",
		});
		expect(evaluateHostReplacementAdmission(intent, 5, runtimeDigest("old-build"))).toEqual({ ok: false, code: "host_build_mismatch" });
		expect(evaluateHostReplacementAdmission(intent, 6, targetBuildDigest)).toEqual({ ok: true });
	});

	it("rejects a symlinked Host state ancestor without writing outside canonical home", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-host-shutdown-intent-symlink-"));
		try {
			const home = join(root, "home");
			const outside = join(root, "outside");
			await mkdir(join(home, "state"), { recursive: true });
			await mkdir(outside, { recursive: true });
			await symlink(outside, join(home, "state", "hosts"), "dir");
			const workspaceStorageKey = "ws-" + "f".repeat(64);
			const store = new HostShutdownIntentStore(buildRunledgerLayout(home, "posix"), workspaceStorageKey);
			const intent = createHostShutdownIntent({
				workspaceStorageKey,
				hostRuntimeId: createRuntimeId("runtime", "shutdown-intent-symlink"),
				hostGeneration: 1,
				reason: "manual_stop",
				requestedAt: "2026-08-07T00:00:00.000Z",
			});

			await expect(store.write(intent)).rejects.toThrow(/symlink|containment/iu);
			await expect(lstat(join(outside, workspaceStorageKey))).rejects.toMatchObject({ code: "ENOENT" });
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("rejects externally tampered replacement intent instead of bypassing its build fence", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-host-shutdown-intent-tamper-"));
		try {
			const layout = buildRunledgerLayout(join(root, "home"), "posix");
			const workspaceStorageKey = "ws-" + "1".repeat(64);
			const store = new HostShutdownIntentStore(layout, workspaceStorageKey);
			const intent = createHostShutdownIntent({
				workspaceStorageKey,
				hostRuntimeId: createRuntimeId("runtime", "tampered-replacement"),
				hostGeneration: 4,
				reason: "maintenance_restart",
				targetBuildDigest: runtimeDigest("expected-build"),
				requestedAt: "2026-08-07T00:00:00.000Z",
			});
			await store.write(intent);
			await writeFile(store.path(), `${JSON.stringify({ ...intent, targetBuildDigest: runtimeDigest("attacker-build") })}\n`, "utf8");

			await expect(store.read()).rejects.toThrow("invalid Host shutdown intent");
			await expect(evaluateStoredHostReplacementAdmission(store, 5, runtimeDigest("attacker-build"))).rejects.toThrow("invalid Host shutdown intent");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
