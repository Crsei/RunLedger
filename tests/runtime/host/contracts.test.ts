import { describe, expect, it } from "vitest";
import { Value } from "typebox/value";
import { createRuntimeId } from "../../../src/runtime/protocol/ids.ts";
import type { RuntimeDigest } from "../../../src/runtime/protocol/foundation.ts";
import {
	HOST_PROTOCOL_VERSION,
	RUNTIME_HOST_BOUNDS,
	RuntimeHostScopeSchema,
	type RuntimeHostScope,
	createHostCompatibilityEnvelope,
	validateHostCompatibility,
} from "../../../src/runtime/host/contracts.ts";
import {
	authorizeDriverMutation,
	claimDriver,
	createDriverState,
	releaseDriver,
} from "../../../src/runtime/host/driver.ts";

const digest = (seed: string): RuntimeDigest => ({
	algorithm: "sha256",
	digest: seed.repeat(64).slice(0, 64) as RuntimeDigest["digest"],
});

function scope(): RuntimeHostScope {
	return {
		authorityId: createRuntimeId("authority", "r1"),
		tenantId: createRuntimeId("tenant", "r1"),
		workspaceId: createRuntimeId("workspace", "r1"),
		repositoryId: createRuntimeId("repository", "r1"),
		workspaceStorageKey: "ws-" + "a".repeat(64),
		protocolVersion: HOST_PROTOCOL_VERSION,
		hostBuildDigest: digest("b"),
		compositionDigest: digest("c"),
		settingsDigest: digest("d"),
		modelCatalogDigest: digest("e"),
		tracePolicyDigest: digest("f"),
		securityAdapterDigest: digest("1"),
		extensionProfileDigest: digest("2"),
		sessionStorageContractVersion: 1,
		peerAttestor: {
			kind: "linux-so-peercred",
			generation: 1,
			configDigest: digest("3"),
		},
	};
}

describe("R1 Runtime Host exact contracts", () => {
	it("freezes bounded protocol values and rejects public private fields", () => {
		expect(RUNTIME_HOST_BOUNDS.maxFrameBytes).toBeGreaterThan(0);
		expect(RUNTIME_HOST_BOUNDS.maxWaitMs).toBeGreaterThan(0);
		expect(Value.Check(RuntimeHostScopeSchema, scope())).toBe(true);
		expect(Value.Check(RuntimeHostScopeSchema, {
			...scope(),
			authorityId: createRuntimeId("workspace", "wrong-scope"),
		})).toBe(false);
		expect(Value.Check(RuntimeHostScopeSchema, { ...scope(), pid: 42 })).toBe(false);
		expect(Value.Check(RuntimeHostScopeSchema, { ...scope(), endpointPath: "/private/socket" })).toBe(false);
	});

	it("compares the complete compatibility envelope instead of silently accepting drift", () => {
		const current = createHostCompatibilityEnvelope(scope());
		const same = createHostCompatibilityEnvelope(scope());
		expect(current.compatibilityDigest).toEqual(same.compatibilityDigest);
		expect(validateHostCompatibility(current, same)).toEqual({ ok: true });

		const changed = createHostCompatibilityEnvelope({ ...scope(), hostBuildDigest: digest("9") });
		expect(validateHostCompatibility(current, changed)).toMatchObject({
			ok: false,
			code: "host_configuration_conflict",
		});
	});
});

describe("R1 explicit driver fencing", () => {
	const principalA = createRuntimeId("principal", "a");
	const principalB = createRuntimeId("principal", "b");
	const connectionA = createRuntimeId("connection", "a");
	const connectionB = createRuntimeId("connection", "b");

	it("claims with generation and revision, then rejects observer mutation and stale claims", () => {
		const initial = createDriverState({ hostGeneration: 4, sessionGeneration: 2 });
		const claimed = claimDriver(initial, {
			mode: "claim",
			principalId: principalA,
			connectionId: connectionA,
			expectedHostGeneration: 4,
			expectedSessionGeneration: 2,
			expectedDriverRevision: 0,
		});
		expect(claimed.ok).toBe(true);
		if (!claimed.ok) return;
		expect(claimed.state.driver?.principalId).toBe(principalA);
		expect(claimed.state.driverRevision).toBe(1);

		expect(authorizeDriverMutation(claimed.state, {
			principalId: principalB,
			connectionId: connectionB,
			expectedHostGeneration: 4,
			expectedSessionGeneration: 2,
			expectedDriverRevision: 1,
		})).toMatchObject({ ok: false, code: "observer_mutation_forbidden" });
		expect(claimDriver(claimed.state, {
			mode: "claim",
			principalId: principalB,
			connectionId: connectionB,
			expectedHostGeneration: 4,
			expectedSessionGeneration: 2,
			expectedDriverRevision: 0,
		})).toMatchObject({ ok: false, code: "driver_revision_conflict" });
	});

	it("allows an explicit transfer and release only with the current fence", () => {
		const initial = createDriverState({ hostGeneration: 4, sessionGeneration: 2 });
		const first = claimDriver(initial, {
			mode: "claim",
			principalId: principalA,
			connectionId: connectionA,
			expectedHostGeneration: 4,
			expectedSessionGeneration: 2,
			expectedDriverRevision: 0,
		});
		if (!first.ok) throw new Error("first claim failed");
		const transferred = claimDriver(first.state, {
			mode: "transfer",
			principalId: principalA,
			connectionId: connectionA,
			nextDriver: { principalId: principalB, connectionId: connectionB },
			expectedHostGeneration: 4,
			expectedSessionGeneration: 2,
			expectedDriverRevision: 1,
		});
		if (!transferred.ok) throw new Error("transfer failed");
		expect(transferred.state.driver?.connectionId).toBe(connectionB);
		const released = releaseDriver(transferred.state, {
			principalId: principalB,
			connectionId: connectionB,
			expectedHostGeneration: 4,
			expectedSessionGeneration: 2,
			expectedDriverRevision: 2,
		});
		expect(released).toMatchObject({ ok: true, state: { driver: undefined, driverRevision: 3 } });
	});
});
