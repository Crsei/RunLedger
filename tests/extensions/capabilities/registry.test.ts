/**
 * P1 RED→GREEN：被动 CapabilityRegistry 的构造与 load 编排合同。
 *
 * 冻结语义（development-doc/plugin-mcp-skill-hooks/02 计划 D1/D8）：
 * - registry 是显式构造、注册、冻结的被动实例；运行中不加入新 provider；
 * - disabled provider 的 load() 从不被调用（I/O 前过滤）；
 * - provider 故障局部化：单个 provider failed/unavailable 不影响其他 provider；
 * - 并发完成顺序不同仍生成确定性输出（按 rank+id 装配）；
 * - 两个测试 Session 可隔离构造，互不影响。
 */

import { describe, expect, it } from "vitest";
import { CapabilityRegistry } from "../../../src/extensions/capabilities/registry.ts";
import type { CapabilityDefinition, DiscoveryContext, DiscoveryProvider, DiscoveryProviderResult, ProviderStatus } from "../../../src/extensions/capabilities/types.ts";
import { extensionDiagnostic } from "../../../src/extensions/diagnostics.ts";

interface ProbeObservation {
	readonly value: string;
}

const probeCapability: CapabilityDefinition<ProbeObservation, { readonly values: readonly string[] }> = {
	id: "probe",
	displayName: "Probe capability",
	validateObservation: (observation) =>
		observation.value.startsWith("valid-") ? [] : [extensionDiagnostic("probe.invalid_observation", "warning", `invalid observation: ${observation.value}`, "probe", observation.value)],
	buildSnapshot: async (input) => ({ values: input.observations.map((observation) => observation.value) }),
};

function provider(
	id: string,
	options: {
		readonly capabilityId?: string;
		readonly rank?: number;
		readonly defaultEnabled?: boolean;
		readonly load?: (context: DiscoveryContext) => Promise<DiscoveryProviderResult<ProbeObservation>>;
	} = {},
): DiscoveryProvider<ProbeObservation> {
	return {
		id,
		displayName: `Provider ${id}`,
		capabilityId: options.capabilityId ?? "probe",
		rank: options.rank ?? 100,
		defaultEnabled: options.defaultEnabled ?? true,
		load: options.load ?? (async () => ({ ok: true, providerId: id, observations: [] })),
	};
}

function emptyResult(): DiscoveryProviderResult<ProbeObservation> {
	return { ok: true, providerId: "", observations: [] };
}

function buildRegistry(providers: readonly DiscoveryProvider<ProbeObservation>[]): CapabilityRegistry {
	const registry = new CapabilityRegistry();
	expect(registry.registerCapability(probeCapability)).toEqual({ ok: true });
	for (const item of providers) expect(registry.registerProvider(item)).toEqual({ ok: true });
	expect(registry.freeze()).toEqual({ ok: true });
	return registry;
}

function loadStatuses(registry: CapabilityRegistry, policy?: ReadonlyMap<string, boolean>): Promise<readonly ProviderStatus[]> {
	return registry.load({ ...(policy === undefined ? {} : { providerEnabled: policy }) }).then((result) => result.providerStatuses);
}

describe("P1 registry construction contract", () => {
	it("rejects duplicate capability, duplicate provider, unknown capability, and post-freeze registration with typed errors", () => {
		const registry = new CapabilityRegistry();
		expect(registry.registerCapability(probeCapability)).toEqual({ ok: true });
		expect(registry.registerCapability({ ...probeCapability })).toMatchObject({ ok: false, error: { code: "duplicate_capability", capabilityId: "probe" } });
		expect(registry.registerProvider(provider("p1"))).toEqual({ ok: true });
		expect(registry.registerProvider(provider("p1"))).toMatchObject({ ok: false, error: { code: "duplicate_provider", providerId: "p1", capabilityId: "probe" } });
		expect(registry.registerProvider(provider("p3", { capabilityId: "unknown-capability" }))).toMatchObject({ ok: false, error: { code: "unknown_capability", providerId: "p3", capabilityId: "unknown-capability" } });
		expect(registry.freeze()).toEqual({ ok: true });
		expect(registry.registerCapability({ ...probeCapability, id: "probe-2" })).toMatchObject({ ok: false, error: { code: "frozen" } });
		expect(registry.registerProvider(provider("p4"))).toMatchObject({ ok: false, error: { code: "frozen" } });
		expect(registry.isFrozen()).toBe(true);
	});

	it("lists providers deterministically by rank then id", () => {
		const registry = buildRegistry([provider("p1", { rank: 200 }), provider("p2", { rank: 50 }), provider("p3", { rank: 50 })]);
		expect(registry.providers().map((item) => item.id)).toEqual(["p2", "p3", "p1"]);
		expect(registry.capabilities()).toEqual(["probe"]);
	});

	it("keeps registry instances isolated across sessions", async () => {
		const first = buildRegistry([provider("first-only")]);
		const second = buildRegistry([provider("second-only")]);
		const firstResult = await first.load();
		const secondResult = await second.load();
		expect(firstResult.providerStatuses.map((item) => item.providerId)).toEqual(["first-only"]);
		expect(secondResult.providerStatuses.map((item) => item.providerId)).toEqual(["second-only"]);
		// 一个 Session 的 policy 不影响另一个。
		const firstAgain = await first.load({ providerEnabled: new Map([["second-only", true]]) });
		expect(firstAgain.providerStatuses.map((item) => item.providerId)).toEqual(["first-only"]);
	});
});

describe("P1 registry load orchestration", () => {
	it("never calls load() for disabled providers", async () => {
		let disabledCalls = 0;
		const registry = buildRegistry([
			provider("off", { load: async () => { disabledCalls += 1; return emptyResult(); } }),
			provider("on"),
		]);
		const statuses = await loadStatuses(registry, new Map([["off", false]]));
		expect(disabledCalls).toBe(0);
		expect(statuses.map((item) => [item.providerId, item.state])).toEqual([
			["off", "disabled"],
			["on", "loaded"],
		]);
		expect(statuses.find((item) => item.providerId === "off")?.effectiveEnabled).toBe(false);
	});

	it("marks a throwing provider failed and still loads the others", async () => {
		const registry = buildRegistry([
			provider("boom", { load: async () => { throw new Error("provider exploded"); } }),
			provider("fine", { load: async () => ({ ok: true, providerId: "fine", observations: [{ value: "valid-a" }] }) }),
		]);
		const result = await registry.load();
		expect(result.providerStatuses.map((item) => [item.providerId, item.state])).toEqual([
			["boom", "failed"],
			["fine", "loaded"],
		]);
		expect(result.providerStatuses.find((item) => item.providerId === "boom")?.lastError).toContain("provider exploded");
		expect(result.diagnostics.map((item) => item.code)).toContain("capability.provider_failed");
		expect(result.snapshots.get("probe")).toEqual({ values: ["valid-a"] });
	});

	it("marks an unavailable provider without observations", async () => {
		const registry = buildRegistry([
			provider("missing", { load: async () => ({ ok: false, providerId: "missing", code: "unavailable", message: "directory is missing" }) }),
		]);
		const result = await registry.load();
		expect(result.providerStatuses[0]).toMatchObject({ providerId: "missing", state: "unavailable", observationCount: 0 });
		expect(result.snapshots.get("probe")).toEqual({ values: [] });
	});

	it("rejects a provider result whose identity does not match the registered provider", async () => {
		const registry = buildRegistry([
			provider("honest", { load: async () => ({ ok: true, providerId: "impostor", observations: [{ value: "valid-a" }] }) }),
		]);
		const result = await registry.load();
		expect(result.providerStatuses[0]).toMatchObject({ providerId: "honest", state: "failed", observationCount: 0 });
		expect(result.diagnostics.map((item) => item.code)).toContain("capability.provider_identity_mismatch");
		expect(result.snapshots.get("probe")).toEqual({ values: [] });
	});

	it("aborts dispatch when the signal is already aborted", async () => {
		let calls = 0;
		const registry = buildRegistry([
			provider("a", { load: async () => { calls += 1; return emptyResult(); } }),
			provider("b", { load: async () => { calls += 1; return emptyResult(); } }),
		]);
		const controller = new AbortController();
		controller.abort();
		const result = await registry.load({ signal: controller.signal });
		expect(calls).toBe(0);
		expect(result.providerStatuses.map((item) => item.state)).toEqual(["aborted", "aborted"]);
	});

	it("lets a provider honor an abort signal mid-load through DiscoveryContext", async () => {
		const registry = buildRegistry([
			provider("signal-aware", {
				load: async (context) => context.signal?.aborted
					? { ok: false, providerId: "signal-aware", code: "aborted", message: "aborted by signal" }
					: { ok: true, providerId: "signal-aware", observations: [{ value: "valid-a" }] },
			}),
		]);
		const controller = new AbortController();
		controller.abort();
		const result = await registry.load({ signal: controller.signal });
		expect(result.providerStatuses[0]).toMatchObject({ providerId: "signal-aware", state: "aborted" });
	});

	it("collects validation diagnostics and keeps deterministic provider-ordered output", async () => {
		const low = provider("low", {
			rank: 50,
			load: async () => ({ ok: true, providerId: "low", observations: [{ value: "bad-low" }, { value: "valid-low" }] }),
		});
		const high = provider("high", {
			rank: 100,
			load: async () => ({ ok: true, providerId: "high", observations: [{ value: "bad-high" }] }),
		});
		const registry = buildRegistry([high, low]);
		const result = await registry.load();
		expect(result.providerStatuses.map((item) => item.providerId)).toEqual(["low", "high"]);
		expect(result.providerStatuses.find((item) => item.providerId === "low")).toMatchObject({ observationCount: 2, diagnosticCount: 1 });
		expect(result.providerStatuses.find((item) => item.providerId === "high")).toMatchObject({ observationCount: 1, diagnosticCount: 1 });
		const codes = result.diagnostics.map((item) => item.code);
		expect(codes).toEqual(["probe.invalid_observation", "probe.invalid_observation"]);
		expect(result.diagnostics.map((item) => item.path)).toEqual(["bad-low", "bad-high"]);
		// 同一 provider 内按 severity/code 稳定排序。
		const sameProvider = result.diagnostics.filter((item) => item.path === "bad-low");
		expect(sameProvider).toHaveLength(1);
	});

	it("builds a snapshot per capability from only its own observations", async () => {
		const secondCapability: CapabilityDefinition<ProbeObservation, { readonly doubled: readonly string[] }> = {
			id: "probe-2",
			displayName: "Second probe capability",
			validateObservation: () => [],
			buildSnapshot: async (input) => ({ doubled: input.observations.map((observation) => `${observation.value}${observation.value}`) }),
		};
		const registry = new CapabilityRegistry();
		expect(registry.registerCapability(probeCapability)).toEqual({ ok: true });
		expect(registry.registerCapability(secondCapability)).toEqual({ ok: true });
		expect(registry.registerProvider(provider("p1", { load: async () => ({ ok: true, providerId: "p1", observations: [{ value: "valid-one" }] }) }))).toEqual({ ok: true });
		expect(registry.registerProvider(provider("p2", { capabilityId: "probe-2", load: async () => ({ ok: true, providerId: "p2", observations: [{ value: "valid-two" }] }) }))).toEqual({ ok: true });
		expect(registry.freeze()).toEqual({ ok: true });
		const result = await registry.load();
		expect(result.snapshots.get("probe")).toEqual({ values: ["valid-one"] });
		expect(result.snapshots.get("probe-2")).toEqual({ doubled: ["valid-twovalid-two"] });
	});
});
