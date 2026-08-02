import { describe, expect, it } from "vitest";
import {
	CONTRACT_DIRECTORY_ALLOWLIST,
	CONTRACT_HANDOFFS,
	CONTRACT_INVENTORY,
	PASSIVE_PERSISTENCE_POLICIES,
	PERSISTENCE_CLASSES,
} from "../../src/runtime/contracts/inventory.ts";

describe("Runtime public contract inventory", () => {
	it("lists every contract package with ownership and persistence metadata", () => {
		expect(CONTRACT_INVENTORY.map((entry) => entry.id)).toEqual([
			"foundation",
			"identity",
			"events",
			"passive-state",
			"workspace-security",
			"resources",
			"model-routing",
			"plan-mode",
			"context",
			"compaction",
			"memory",
			"artifact-evidence",
			"adapter-ports",
			"user-home-layout",
			"control-telemetry",
			"host-process",
			"public-surface",
		]);

		for (const entry of CONTRACT_INVENTORY) {
			expect(entry.owner.length).toBeGreaterThan(0);
			expect(entry.modules).toBeInstanceOf(Array);
			expect(entry.types).toBeInstanceOf(Array);
			expect(entry.schemas).toBeInstanceOf(Array);
			expect(entry.events).toBeInstanceOf(Array);
			expect(entry.ports).toBeInstanceOf(Array);
			expect(entry.fixtures).toBeInstanceOf(Array);
			expect(entry.persistence.length).toBeGreaterThan(0);
			expect(entry.gaps).toBeInstanceOf(Array);
		}
	});

	it("freezes the five persistence classes and contract directory allowlist", () => {
		expect(PERSISTENCE_CLASSES).toEqual([
			"canonical_durable",
			"external_authority_ref",
			"reconstructible_passive",
			"ephemeral",
			"forbidden",
		]);
		expect(CONTRACT_DIRECTORY_ALLOWLIST).toEqual([
			"src/runtime/contracts",
			"src/runtime/protocol",
			"src/runtime/identity",
			"src/runtime/resources",
			"src/runtime/model-routing",
			"src/runtime/modes",
			"src/runtime/context",
			"src/runtime/host",
			"src/runtime/process",
		]);
	});

	it("routes every behavior owner without silently enabling an unowned implementation", () => {
		expect(CONTRACT_HANDOFFS.length).toBeGreaterThanOrEqual(10);
		for (const handoff of CONTRACT_HANDOFFS) {
			expect(handoff.behavior.length).toBeGreaterThan(0);
			expect(handoff.owner.length).toBeGreaterThan(0);
			expect(handoff.contracts.length).toBeGreaterThan(0);
		}
		expect(CONTRACT_HANDOFFS.filter((handoff) => handoff.availability === "unavailable").length).toBeGreaterThan(0);
	});

	it("tracks closed foundation and event contracts without classifying executable helpers as contracts", () => {
		const foundation = CONTRACT_INVENTORY.find((entry) => entry.id === "foundation");
		const events = CONTRACT_INVENTORY.find((entry) => entry.id === "events");
		const identity = CONTRACT_INVENTORY.find((entry) => entry.id === "identity");
		const userHome = CONTRACT_INVENTORY.find((entry) => entry.id === "user-home-layout");

		expect(foundation?.modules).toContain("src/runtime/protocol/foundation-schemas.ts");
		expect(foundation?.gaps).toEqual([]);
		expect(events?.schemas).toContain("RUNTIME_EVENT_PAYLOAD_SCHEMAS");
		expect(events?.gaps).toEqual([]);
		expect(identity?.modules).not.toContain("src/runtime/identity/local-principal.ts");
		expect(identity?.gaps).not.toContain("local-principal.ts is an executable local identity helper");
		expect(userHome?.modules).toContain("src/runtime/contracts/storage-layout.ts");
		expect(userHome?.gaps).toEqual([]);
		for (const id of [
			"workspace-security",
			"resources",
			"model-routing",
			"plan-mode",
			"context",
			"compaction",
			"memory",
			"artifact-evidence",
			"control-telemetry",
			"adapter-ports",
		]) {
			expect(CONTRACT_INVENTORY.find((entry) => entry.id === id)?.gaps).toEqual([]);
		}
		const adapterPorts = CONTRACT_INVENTORY.find((entry) => entry.id === "adapter-ports");
		expect(adapterPorts?.ports).toHaveLength(18);
		expect(adapterPorts?.fixtures).toContain("tests/runtime-contracts/adapter-port-contracts.test.ts");
		expect(CONTRACT_INVENTORY.find((entry) => entry.id === "resources")?.fixtures).toContain(
			"tests/runtime-contracts/consumers/plugin-resource.consumer.ts",
		);
		expect(CONTRACT_INVENTORY.find((entry) => entry.id === "workspace-security")?.fixtures).toContain(
			"tests/runtime-contracts/consumers/security-worktree.consumer.ts",
		);
		for (const id of ["model-routing", "plan-mode", "context", "compaction", "memory"]) {
			expect(CONTRACT_INVENTORY.find((entry) => entry.id === id)?.fixtures).toContain(
				"tests/runtime-contracts/consumers/plan-context-memory.consumer.ts",
			);
		}
		for (const entry of CONTRACT_INVENTORY) {
			expect(entry.gaps, entry.id).toEqual([]);
		}
	});

	it("routes user-home migration behavior to the dedicated handoff", () => {
		expect(CONTRACT_HANDOFFS).toContainEqual({
			behavior: "User home creation, legacy import, and CLI option deprecation",
			owner: "development-doc/storage-cli/02-user-home-migration-handoff.md",
			contracts: ["user-home-layout"],
			availability: "external_plan",
		});
	});

	it("classifies every passive structure with retention, redaction, and forbidden-field policy", () => {
		expect(PASSIVE_PERSISTENCE_POLICIES.length).toBeGreaterThanOrEqual(45);
		expect(new Set(PASSIVE_PERSISTENCE_POLICIES.map((policy) => policy.contract)).size).toBe(
			PASSIVE_PERSISTENCE_POLICIES.length,
		);
		for (const policy of PASSIVE_PERSISTENCE_POLICIES) {
			expect(PERSISTENCE_CLASSES).toContain(policy.classification);
			expect(policy.retention.length).toBeGreaterThan(0);
			expect(policy.redaction.length).toBeGreaterThan(0);
			expect(policy.forbiddenFields.length).toBeGreaterThan(0);
		}
		expect(PASSIVE_PERSISTENCE_POLICIES).toContainEqual(expect.objectContaining({
			contract: "CredentialGrantRef",
			classification: "external_authority_ref",
			forbiddenFields: expect.arrayContaining(["credential", "token", "secret"]),
		}));
		expect(PASSIVE_PERSISTENCE_POLICIES).toContainEqual(expect.objectContaining({
			contract: "RuntimeResourceSnapshot",
			classification: "reconstructible_passive",
		}));
		expect(PASSIVE_PERSISTENCE_POLICIES).toContainEqual(expect.objectContaining({
			contract: "RuntimeToolInvocation",
			classification: "ephemeral",
		}));
	});
});
