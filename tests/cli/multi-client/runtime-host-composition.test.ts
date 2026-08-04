import { describe, expect, it } from "vitest";
import {
	connectOrSpawnHost,
	type HostConnectionAttempt,
	type HostSpawnResult,
		type RuntimeHostLauncherOptions,
} from "../../../src/cli/runtime-host-composition.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/ids.ts";
import { runtimeDigest, type RuntimeDigest } from "../../../src/runtime/protocol/foundation.ts";
import type { HostEndpointRecord } from "../../../src/storage/host/endpoint-store.ts";

const digest = (seed: string): RuntimeDigest => runtimeDigest(seed);
const workspaceStorageKey = "ws-" + "a".repeat(64);

function endpoint(state: HostEndpointRecord["state"] = "ready", generation = 1): HostEndpointRecord {
	return {
		protocolVersion: 1,
		workspaceStorageKey,
		hostRuntimeId: createRuntimeId("runtime", `host-${generation}`),
		hostGeneration: generation,
		state,
		compatibilityDigest: digest("scope"),
	};
}

function options(overrides: Partial<RuntimeHostLauncherOptions> = {}): RuntimeHostLauncherOptions {
	let current: HostEndpointRecord | undefined;
	let removed = 0;
	let spawnCount = 0;
	const base: RuntimeHostLauncherOptions = {
		endpoint: {
			read: async () => current,
			remove: async () => { current = undefined; removed += 1; },
		},
		writer: { state: async () => "absent" },
		election: {
			acquire: async () => ({ ok: true, release: async () => {} }),
		},
		connector: {
			connect: async () => ({ ok: false, code: "unreachable", retryable: true }),
		},
		spawner: {
			spawn: async ({ hostGeneration }) => {
				spawnCount += 1;
				const value: HostSpawnResult = {
					endpoint: endpoint("ready", hostGeneration),
					connection: { kind: "fake", id: `connection-${hostGeneration}` },
					close: async () => {},
				};
				current = value.endpoint;
				return value;
			},
		},
		expectedCompatibilityDigest: digest("scope"),
		wait: { timeoutMs: 50, intervalMs: 1 },
		clock: () => Date.now(),
		delay: async (durationMs) => new Promise((resolve) => setTimeout(resolve, durationMs)),
	};
	const endpointOverride = overrides.endpoint;
	const result = {
		...base,
		...overrides,
		endpoint: {
			...base.endpoint,
			...endpointOverride,
			remove: async () => {
				removed += 1;
				await endpointOverride?.remove?.();
			},
		},
	};
	Object.defineProperties(result, {
		spawnCount: { get: () => spawnCount },
		removed: { get: () => removed },
	});
	return result;
}

describe("R3/R4 connect-or-spawn Host composition", () => {
	it("connects to a compatible ready Host without acquiring startup or spawning", async () => {
		const connection: HostConnectionAttempt = { kind: "fake", id: "existing" };
		const value = options({
			endpoint: { read: async () => endpoint(), remove: async () => {} },
			connector: { connect: async () => ({ ok: true, connection }) },
		});

		await expect(connectOrSpawnHost(value)).resolves.toMatchObject({ startedHost: false, connection });
		expect((value as RuntimeHostLauncherOptions & { readonly spawnCount: number }).spawnCount).toBe(0);
	});

	it("never removes an unreachable endpoint while the writer is active", async () => {
		const value = options({
			endpoint: { read: async () => endpoint(), remove: async () => {} },
			writer: { state: async () => "active" },
		});

		await expect(connectOrSpawnHost(value)).resolves.toMatchObject({ ok: false, code: "active_writer_unreachable" });
		expect((value as RuntimeHostLauncherOptions & { readonly removed: number }).removed).toBe(0);
	});

	it("cleans a stale endpoint only after the writer is absent, then starts one Host", async () => {
		const value = options({
			// The persisted format has no `stale` state. It is derived from a ready
			// endpoint that is unreachable while the writer fence is absent.
			endpoint: { read: async () => endpoint("ready"), remove: async () => {} },
			connector: { connect: async () => ({ ok: false, code: "unreachable", retryable: true }) },
		});

		const result = await connectOrSpawnHost(value);
		expect(result).toMatchObject({ ok: true, startedHost: true, connection: { id: "connection-2" } });
		expect((value as RuntimeHostLauncherOptions & { readonly removed: number }).removed).toBe(1);
		expect((value as RuntimeHostLauncherOptions & { readonly spawnCount: number }).spawnCount).toBe(1);
	});

	it("waits for an election winner instead of starting a second Host", async () => {
		let reads = 0;
		const value = options({
			endpoint: {
				read: async () => {
					reads += 1;
					return reads < 3 ? endpoint("starting") : endpoint("ready", 4);
				},
				remove: async () => {},
			},
			election: { acquire: async () => ({ ok: false, code: "startup_election_lost" }) },
			connector: { connect: async () => ({ ok: true, connection: { kind: "fake", id: "winner" } }) },
		});

		await expect(connectOrSpawnHost(value)).resolves.toMatchObject({ ok: true, startedHost: false, connection: { id: "winner" } });
		expect((value as RuntimeHostLauncherOptions & { readonly spawnCount: number }).spawnCount).toBe(0);
	});

	it("fails closed when compatibility conflicts or attestation is unavailable", async () => {
		const conflict = options({ endpoint: { read: async () => endpoint(), remove: async () => {} } });
		(conflict.endpoint.read as () => Promise<HostEndpointRecord | undefined>) = async () => ({ ...endpoint(), compatibilityDigest: digest("other") });
		await expect(connectOrSpawnHost(conflict)).resolves.toMatchObject({ ok: false, code: "host_configuration_conflict" });

		const unsupported = options({
			endpoint: { read: async () => undefined, remove: async () => {} },
			spawner: { spawn: async () => ({ ok: false, code: "peer_attestation_required" }) },
		});
		await expect(connectOrSpawnHost(unsupported)).resolves.toMatchObject({ ok: false, code: "peer_attestation_required" });
	});
});
