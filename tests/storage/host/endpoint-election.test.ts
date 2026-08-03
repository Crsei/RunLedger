import { describe, expect, it } from "vitest";
import { lstat, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRunledgerLayout } from "../../../src/runtime/contracts/storage-layout.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/ids.ts";
import type { RuntimeDigest } from "../../../src/runtime/protocol/foundation.ts";
import {
	EndpointStore,
	decideEndpointAdmission,
	type HostEndpointRecord,
} from "../../../src/storage/host/endpoint-store.ts";
import { acquireStartupElection } from "../../../src/storage/host/startup-election.ts";

const digest = (seed: string): RuntimeDigest => ({
	algorithm: "sha256",
	digest: seed.repeat(64).slice(0, 64) as RuntimeDigest["digest"],
});

describe("R3 local Host endpoint and startup election", () => {
	it("publishes an atomic endpoint below canonical user home and reads it back", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-host-endpoint-"));
		try {
			const layout = buildRunledgerLayout(join(root, "home"), "posix");
			const store = new EndpointStore(layout, "ws-" + "a".repeat(64));
			const record: HostEndpointRecord = {
				protocolVersion: 1,
				workspaceStorageKey: "ws-" + "a".repeat(64),
				hostRuntimeId: createRuntimeId("runtime", "endpoint"),
				hostGeneration: 7,
				state: "ready",
				compatibilityDigest: digest("a"),
			};
			await store.publish(record);
			expect(store.endpointPath()).toContain(join(root, "home", "ipc"));
			expect(store.endpointPath()).not.toContain(`${root}/ipc`);
			expect(await store.read()).toEqual(record);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("never chooses stale cleanup when an active writer is still present", () => {
		expect(decideEndpointAdmission({
			endpoint: "ready",
			transport: "unreachable",
			writer: "active",
			compatibility: "unknown",
		})).toEqual({ decision: "conflict", code: "active_writer_unreachable" });
		expect(decideEndpointAdmission({
			endpoint: "stale",
			transport: "unreachable",
			writer: "absent",
			compatibility: "unknown",
		})).toEqual({ decision: "spawn_after_stale_cleanup" });
	});

	it("rejects a symlinked endpoint ancestor instead of escaping canonical home", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-host-endpoint-symlink-"));
		try {
			const home = join(root, "home");
			const outside = join(root, "outside");
			await mkdir(home, { recursive: true });
			await mkdir(outside, { recursive: true });
			await symlink(outside, join(home, "ipc"), "dir");
			const layout = buildRunledgerLayout(home, "posix");
			const store = new EndpointStore(layout, "ws-" + "b".repeat(64));
			const record: HostEndpointRecord = {
				protocolVersion: 1,
				workspaceStorageKey: "ws-" + "b".repeat(64),
				hostRuntimeId: createRuntimeId("runtime", "endpoint-symlink"),
				hostGeneration: 1,
				state: "ready",
				compatibilityDigest: digest("b"),
			};
			await expect(store.publish(record)).rejects.toThrow(/symlink|containment/iu);
			await expect(lstat(join(outside, "host", "ws-" + "b".repeat(64), "endpoint.json"))).rejects.toMatchObject({ code: "ENOENT" });
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("serializes launcher election and leaves the writer fence to a later Host phase", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-host-election-"));
		try {
			const target = join(root, "startup-target");
			await mkdir(root, { recursive: true });
			const first = await acquireStartupElection(target);
			expect(first.ok).toBe(true);
			const second = await acquireStartupElection(target);
			expect(second).toEqual({ ok: false, code: "startup_election_lost" });
			if (!first.ok) return;
			await first.release();
			const third = await acquireStartupElection(target);
			expect(third.ok).toBe(true);
			if (third.ok) await third.release();
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
