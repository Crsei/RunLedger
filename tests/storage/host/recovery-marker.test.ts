import { describe, expect, it } from "vitest";
import { canCreateSymlink } from "../../helpers/platform.ts";
import { lstat, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRunledgerLayout } from "../../../src/runtime/contracts/storage-layout.ts";
import { runtimeDigest } from "../../../src/runtime/protocol/foundation.ts";
import type { RuntimeHostRecoveryMarker } from "../../../src/runtime/host/lifecycle.ts";
import { HostRecoveryMarkerStore } from "../../../src/storage/host/recovery-marker.ts";

const CAN_SYMLINK = canCreateSymlink();

function marker(phase: RuntimeHostRecoveryMarker["phase"], generation = 3): RuntimeHostRecoveryMarker {
	const body = {
		hostGeneration: generation,
		phase,
		artifactMode: "events_and_artifacts" as const,
		processIds: ["execution_recovery"],
		processEvidence: [],
		failures: [],
	};
	return { ...body, markerDigest: runtimeDigest(body) };
}

describe("R10 durable Host recovery marker", () => {
	it("persists and reloads the latest current-format marker below canonical Host state", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-host-recovery-marker-"));
		try {
			const layout = buildRunledgerLayout(join(root, "home"), "posix");
			const store = new HostRecoveryMarkerStore(layout, "ws-" + "a".repeat(64));
			await store.append(marker("shutdown_started"));
			await store.append(marker("shutdown_incomplete", 4));
			expect(await store.latest()).toEqual(marker("shutdown_incomplete", 4));
			expect(store.path()).toContain(join(root, "home", "state", "hosts"));
			expect(store.path()).not.toContain(`${root}/state`);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("rejects a tampered marker instead of treating it as recovery truth", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-host-recovery-marker-tamper-"));
		try {
			const layout = buildRunledgerLayout(join(root, "home"), "posix");
			const store = new HostRecoveryMarkerStore(layout, "ws-" + "b".repeat(64));
			await expect(store.append({ ...marker("shutdown_started"), hostGeneration: 99 })).rejects.toThrow(/digest|marker/iu);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("rejects a symlinked Host state ancestor", { skip: !CAN_SYMLINK }, async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-host-recovery-marker-symlink-"));
		try {
			const home = join(root, "home");
			const outside = join(root, "outside");
			await mkdir(home, { recursive: true });
			await mkdir(outside, { recursive: true });
			await mkdir(join(home, "state"), { recursive: true });
			await symlink(outside, join(home, "state", "hosts"), "dir");
			const layout = buildRunledgerLayout(home, "posix");
			const store = new HostRecoveryMarkerStore(layout, "ws-" + "c".repeat(64));
			await expect(store.append(marker("shutdown_started"))).rejects.toThrow(/symlink|containment/iu);
			await expect(lstat(join(outside, "ws-" + "c".repeat(64)))).rejects.toMatchObject({ code: "ENOENT" });
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
