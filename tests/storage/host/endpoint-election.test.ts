import { describe, expect, it } from "vitest";
import { lstat, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canCreateSymlink } from "../../helpers/platform.ts";
import { buildRunledgerLayout } from "../../../src/runtime/contracts/storage-layout.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/ids.ts";
import { runtimeDigest, type RuntimeDigest } from "../../../src/runtime/protocol/foundation.ts";
import {
	EndpointStore,
	createHostEndpointRecord,
	decideEndpointAdmission,
	type HostEndpointRecord,
} from "../../../src/storage/host/endpoint-store.ts";
import { acquireStartupElection } from "../../../src/storage/host/startup-election.ts";

const CAN_SYMLINK = canCreateSymlink();

const digest = (seed: string): RuntimeDigest => runtimeDigest(seed);

describe("R3 local Host endpoint and startup election", () => {
	it("publishes an atomic endpoint below canonical user home and reads it back", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-host-endpoint-"));
		try {
			const layout = buildRunledgerLayout(join(root, "home"), "posix");
			const store = new EndpointStore(layout, "ws-" + "a".repeat(64));
			const record: HostEndpointRecord = createHostEndpointRecord({
				protocolVersion: 1,
				managementProtocolVersion: 1,
				workspaceStorageKey: "ws-" + "a".repeat(64),
				hostRuntimeId: createRuntimeId("runtime", "endpoint"),
				hostGeneration: 7,
				hostProcessId: 123,
				hostProcessStartIdentityDigest: digest("s"),
				hostBuildDigest: digest("h"),
				state: "ready",
				compatibilityDigest: digest("a"),
				publishedAt: "2026-08-07T00:00:00.000Z",
			});
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

	it("rejects endpoint metadata whose process identity was tampered", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-host-endpoint-tamper-"));
		try {
			const layout = buildRunledgerLayout(join(root, "home"), "posix");
			const key = "ws-" + "c".repeat(64);
			const store = new EndpointStore(layout, key);
			const record = createHostEndpointRecord({
				protocolVersion: 1,
				managementProtocolVersion: 1,
				workspaceStorageKey: key,
				hostRuntimeId: createRuntimeId("runtime", "endpoint-tamper"),
				hostGeneration: 2,
				hostProcessId: 125,
				hostProcessStartIdentityDigest: digest("s"),
				hostBuildDigest: digest("h"),
				state: "ready",
				compatibilityDigest: digest("c"),
				publishedAt: "2026-08-07T00:00:00.000Z",
			});
			await expect(store.publish({ ...record, hostProcessId: 999 })).rejects.toThrow("invalid Host endpoint record");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("rejects a symlinked endpoint ancestor instead of escaping canonical home", { skip: !CAN_SYMLINK }, async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-host-endpoint-symlink-"));
		try {
			const home = join(root, "home");
			const outside = join(root, "outside");
			await mkdir(home, { recursive: true });
			await mkdir(outside, { recursive: true });
			await symlink(outside, join(home, "ipc"), "dir");
			const layout = buildRunledgerLayout(home, "posix");
			const store = new EndpointStore(layout, "ws-" + "b".repeat(64));
			const record: HostEndpointRecord = createHostEndpointRecord({
				protocolVersion: 1,
				managementProtocolVersion: 1,
				workspaceStorageKey: "ws-" + "b".repeat(64),
				hostRuntimeId: createRuntimeId("runtime", "endpoint-symlink"),
				hostGeneration: 1,
				hostProcessId: 124,
				hostProcessStartIdentityDigest: digest("s"),
				hostBuildDigest: digest("h"),
				state: "ready",
				compatibilityDigest: digest("b"),
				publishedAt: "2026-08-07T00:00:00.000Z",
			});
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
