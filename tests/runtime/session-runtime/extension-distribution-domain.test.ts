import { describe, expect, it } from "vitest";
import { createSessionExtensionComposition } from "../../../src/runtime/session-runtime/extension-composition.ts";
import type {
	SessionDistributionMutationPort,
	SessionDistributionReadPort,
} from "../../../src/runtime/session-runtime/extension-composition.ts";
import type { ExtensionReloadResult } from "../../../src/extensions/manager.ts";
import type { SessionDomainMutationContext } from "../../../src/runtime/session-runtime/domain-router.ts";

const readyReload: ExtensionReloadResult = { status: "ready" };

function composition(distribution?: { readonly read: SessionDistributionReadPort; readonly mutate: SessionDistributionMutationPort }) {
	return createSessionExtensionComposition({
		sessionId: "session_distribution",
		generation: 1,
		manager: {
			load: async () => readyReload,
			reload: async () => readyReload,
			setEnabled: async () => readyReload,
			trust: async () => readyReload,
			untrust: async () => readyReload,
			trustSkill: async () => readyReload,
			untrustSkill: async () => readyReload,
			setSkillProviderEnabled: async () => readyReload,
			publicSnapshot: () => undefined,
		},
		mcp: {
			start: async () => ({ ok: true, snapshots: [], requiredFailures: [] }),
			snapshots: () => [],
			restart: async (serverId: string) => ({ ok: false, error: { code: "server_not_found" as const, message: serverId, retryable: false } }),
			tools: () => [],
			close: async () => undefined,
		},
		closeHooks: async () => undefined,
		closePlugins: async () => undefined,
		cleanup: async () => undefined,
		...(distribution === undefined ? {} : { distribution }),
	});
}

function queryContext(): { readonly correlationId: string; readonly effectId: string } {
	return { correlationId: "command_distribution", effectId: "effect_1" };
}

/** `SessionResourceDomainPort.mutate` 是可选方法；测试里必须存在。 */
function mutate(
	session: ReturnType<typeof composition>,
	operation: string,
	payload: Record<string, unknown>,
	ctx: SessionDomainMutationContext = context(),
) {
	const port = session.resources.mutate;
	if (port === undefined) throw new Error("distribution mutate port must be wired");
	return port(operation, payload, ctx);
}

function hostManager(): Parameters<typeof createSessionExtensionComposition>[0]["manager"] {
	return {
		load: async () => readyReload,
		reload: async () => readyReload,
		setEnabled: async () => readyReload,
		trust: async () => readyReload,
		untrust: async () => readyReload,
		trustSkill: async () => readyReload,
		untrustSkill: async () => readyReload,
		setSkillProviderEnabled: async () => readyReload,
		publicSnapshot: () => undefined,
	};
}

function hostMcp(overrides: Partial<Parameters<typeof createSessionExtensionComposition>[0]["mcp"]> = {}): Parameters<typeof createSessionExtensionComposition>[0]["mcp"] {
	return {
		start: async () => ({ ok: true, snapshots: [], requiredFailures: [] }),
		snapshots: () => [],
		restart: async (serverId: string) => ({ ok: false, error: { code: "server_not_found" as const, message: serverId, retryable: false } }),
		tools: () => [],
		close: async () => undefined,
		...overrides,
	};
}

function context(): SessionDomainMutationContext {
	return { correlationId: "command_distribution" as SessionDomainMutationContext["correlationId"], effectId: "effect_1", expectedRevision: 1 };
}

function readPort(overrides: Partial<SessionDistributionReadPort> = {}): SessionDistributionReadPort {
	return {
		list: async () => ({ ok: true, value: { items: [{ packageId: "alpha@local", version: "1.0.0" }] } }),
		doctor: async () => ({ ok: true, value: { findings: [{ code: "doctor.completed", severity: "ok" }], counts: { ok: 1, warning: 0, error: 0 } } }),
		marketplaces: async () => ({ ok: true, value: { marketplaces: [{ name: "local" }], pendingUpdates: [] } }),
		configRead: async () => ({ ok: true, value: { items: [] } }),
		featuresRead: async () => ({ ok: true, value: { items: [{ packageId: "alpha@local", enabled: ["bundle"] }] } }),
		...overrides,
	};
}

function mutatePort(calls: Array<Record<string, unknown>>, overrides: Partial<SessionDistributionMutationPort> = {}): SessionDistributionMutationPort {
	// 记录键用 `method`：marketplace 的 payload 自带 `name`，用 `name` 会撞键。
	const record = (method: string, payload: Record<string, unknown>) => { calls.push({ method, ...payload }); return { ok: true as const, value: { receipt: { packageId: "alpha@local", version: "1.0.0" } } }; };
	return {
		install: async (input) => record("install", input),
		uninstall: async (input) => record("uninstall", input),
		link: async (input) => record("link", input),
		upgrade: async (input) => record("upgrade", input),
		addMarketplace: async (input) => record("addMarketplace", input),
		removeMarketplace: async (input) => record("removeMarketplace", input),
		updateMarketplace: async (input) => record("updateMarketplace", input),
		upgradeFromMarketplace: async (input) => record("upgradeFromMarketplace", input),
		configWrite: async (input) => record("configWrite", input),
		featuresWrite: async (input) => record("featuresWrite", input),
		setAutoUpdate: async (input) => record("setAutoUpdate", input),
		...overrides,
	};
}

describe("session extension distribution domain", () => {
	it("publishes the frozen distribution operation set with read/mutate separation", async () => {
		const session = composition();
		const manifest = session.resources.operationManifest;
		const byOperation = new Map(manifest.map((entry) => [entry.operation, entry.access]));
		expect([...byOperation.keys()].filter((operation) => operation.startsWith("plugin.") || operation.startsWith("marketplace.")).sort()).toEqual([
			"marketplace.add",
			"marketplace.auto_update",
			"marketplace.discover",
			"marketplace.remove",
			"marketplace.update",
			"marketplace.upgrade",
			"plugin.config.read",
			"plugin.config.write",
			"plugin.disable",
			"plugin.distribution.list",
			"plugin.doctor",
			"plugin.enable",
			"plugin.features.read",
			"plugin.features.write",
			"plugin.install",
			"plugin.link",
			"plugin.list",
			"plugin.trust",
			"plugin.uninstall",
			"plugin.untrust",
			"plugin.upgrade",
		]);
		expect(byOperation.get("marketplace.discover")).toBe("read");
		expect(byOperation.get("plugin.doctor")).toBe("read");
		expect(byOperation.get("plugin.distribution.list")).toBe("read");
		expect(byOperation.get("plugin.features.read")).toBe("read");
		for (const mutate of ["plugin.install", "plugin.uninstall", "plugin.link", "plugin.upgrade", "plugin.config.write", "plugin.features.write", "marketplace.add", "marketplace.remove", "marketplace.update", "marketplace.auto_update", "marketplace.upgrade"]) {
			expect(byOperation.get(mutate), mutate).toBe("mutate");
		}
	});

	it("routes each read operation to the distribution read port", async () => {
		const session = composition({ read: readPort(), mutate: mutatePort([]) });
		await expect(session.resources.query("plugin.distribution.list", {}, queryContext())).resolves.toMatchObject({ ok: true, value: { items: [{ packageId: "alpha@local" }] } });
		await expect(session.resources.query("plugin.doctor", {}, queryContext())).resolves.toMatchObject({ ok: true, value: { counts: { ok: 1 } } });
		await expect(session.resources.query("marketplace.discover", {}, queryContext())).resolves.toMatchObject({ ok: true, value: { marketplaces: [{ name: "local" }] } });
		await expect(session.resources.query("plugin.features.read", {}, queryContext())).resolves.toMatchObject({ ok: true, value: { items: [{ packageId: "alpha@local", enabled: ["bundle"] }] } });
	});

	it("reports read failures with the port's code instead of an empty success", async () => {
		const session = composition({ read: readPort({ list: async () => ({ ok: false, code: "registry_invalid", message: "registry.json does not match" }) }), mutate: mutatePort([]) });
		await expect(session.resources.query("plugin.distribution.list", {}, queryContext())).resolves.toMatchObject({ ok: false, status: "failed", code: "registry_invalid" });
	});

	it("reports the distribution operations as unavailable when no port is wired", async () => {
		const session = composition();
		await expect(session.resources.query("plugin.distribution.list", {}, queryContext())).resolves.toMatchObject({ ok: false, code: "operation_unavailable" });
		await expect(mutate(session, "plugin.install", { spec: "alpha@local" })).resolves.toMatchObject({ ok: false, code: "operation_unavailable" });
	});

	it("routes each mutate operation with the session scope and validates its payload", async () => {
		const calls: Array<Record<string, unknown>> = [];
		const session = composition({ read: readPort(), mutate: mutatePort(calls) });
		await expect(mutate(session, "plugin.install", { spec: "alpha@local", scope: "workspace" })).resolves.toMatchObject({ ok: true });
		await expect(mutate(session, "plugin.uninstall", { pluginId: "alpha@local" })).resolves.toMatchObject({ ok: true });
		await expect(mutate(session, "plugin.link", { pluginId: "dev", name: "dev", localPath: "/tmp/dev" })).resolves.toMatchObject({ ok: true });
		await expect(mutate(session, "plugin.upgrade", { spec: "alpha@local" })).resolves.toMatchObject({ ok: true });
		await expect(mutate(session, "marketplace.add", { name: "local", sourceType: "local", sourceUri: "/tmp/mkt" })).resolves.toMatchObject({ ok: true });
		await expect(mutate(session, "marketplace.remove", { name: "local" })).resolves.toMatchObject({ ok: true });
		await expect(mutate(session, "marketplace.update", { name: "local" })).resolves.toMatchObject({ ok: true });
		await expect(mutate(session, "marketplace.upgrade", { marketplace: "local" })).resolves.toMatchObject({ ok: true });
		expect(calls).toEqual([
			{ method: "install", spec: "alpha@local", scope: "workspace" },
			{ method: "uninstall", packageId: "alpha@local", scope: "user" },
			{ method: "link", packageId: "dev", name: "dev", localPath: "/tmp/dev", scope: "user" },
			{ method: "upgrade", spec: "alpha@local", scope: "user" },
			{ method: "addMarketplace", name: "local", sourceType: "local", sourceUri: "/tmp/mkt" },
			{ method: "removeMarketplace", name: "local" },
			{ method: "updateMarketplace", name: "local" },
			{ method: "upgradeFromMarketplace", marketplace: "local", scope: "user" },
		]);
	});

	it("keeps every operation name inside the handshake descriptor pattern", async () => {
		const session = composition();
		// handshake 的 descriptor pattern 不接受大写；一个 `marketplace.autoUpdate`
		// 这样的名字会让整个 initialize_response 校验失败并变成 frame_malformed。
		const pattern = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u;
		for (const entry of session.resources.operationManifest) {
			expect(entry.operation, entry.operation).toMatch(pattern);
			expect(entry.operation.length, entry.operation).toBeLessThanOrEqual(128);
		}
	});

	it("routes the autoUpdate mode write and validates the mode", async () => {
		const calls: Array<Record<string, unknown>> = [];
		const session = composition({ read: readPort(), mutate: mutatePort(calls) });
		await expect(mutate(session, "marketplace.auto_update", { mode: "notify" })).resolves.toMatchObject({ ok: true });
		await expect(mutate(session, "marketplace.auto_update", { mode: "sometimes" })).resolves.toMatchObject({ ok: false, code: "auto_update_mode_required" });
		await expect(mutate(session, "marketplace.auto_update", {})).resolves.toMatchObject({ ok: false, code: "auto_update_mode_required" });
		expect(calls).toEqual([{ method: "setAutoUpdate", mode: "notify" }]);
	});

	it("distinguishes the three feature selections instead of collapsing them", async () => {
		const calls: Array<Record<string, unknown>> = [];
		const session = composition({ read: readPort(), mutate: mutatePort(calls) });
		// `*` = 声明默认值（null）、`none` = 全关（[]）、`a,b` = 精确集合。
		await expect(mutate(session, "plugin.features.write", { pluginId: "alpha@local", enabledFeatures: null })).resolves.toMatchObject({ ok: true });
		await expect(mutate(session, "plugin.features.write", { pluginId: "alpha@local", enabledFeatures: [] })).resolves.toMatchObject({ ok: true });
		await expect(mutate(session, "plugin.features.write", { pluginId: "alpha@local", enabledFeatures: ["bundle", "audit"] })).resolves.toMatchObject({ ok: true });
		expect(calls).toEqual([
			{ method: "featuresWrite", packageId: "alpha@local", enabledFeatures: null },
			{ method: "featuresWrite", packageId: "alpha@local", enabledFeatures: [] },
			{ method: "featuresWrite", packageId: "alpha@local", enabledFeatures: ["bundle", "audit"] },
		]);
	});

	it("rejects incomplete mutate payloads without calling the port", async () => {
		const calls: Array<Record<string, unknown>> = [];
		const session = composition({ read: readPort(), mutate: mutatePort(calls) });
		for (const [operation, payload, code] of [
			["plugin.install", {}, "spec_required"],
			["plugin.uninstall", {}, "plugin_id_required"],
			["plugin.link", { pluginId: "dev" }, "link_arguments_required"],
			["plugin.features.write", { pluginId: "alpha@local" }, "feature_selection_required"],
			["plugin.features.write", { pluginId: "alpha@local", enabledFeatures: "all" }, "feature_selection_required"],
			["plugin.features.write", { enabledFeatures: [] }, "plugin_id_required"],
			["marketplace.add", { name: "local" }, "marketplace_arguments_required"],
			["marketplace.remove", {}, "marketplace_name_required"],
			["marketplace.upgrade", {}, "marketplace_name_required"],
		] as const) {
			const result = await mutate(session, operation, payload as Record<string, unknown>);
			expect(result.ok, operation).toBe(false);
			if (!result.ok) expect(result.code).toBe(code);
		}
		expect(calls).toEqual([]);
	});

	it("records a failed mutate attempt as rejected rather than throwing", async () => {
		const session = composition({
			read: readPort(),
			mutate: mutatePort([], { install: async () => ({ ok: false, code: "install_script_forbidden", message: "package declares lifecycle scripts" }) }),
		});
		const result = await mutate(session, "plugin.install", { spec: "alpha@local" });
		expect(result).toMatchObject({ ok: false, status: "failed", code: "install_script_forbidden" });
	});
});

describe("session extension composition host port", () => {
	type HostPort = NonNullable<Parameters<typeof createSessionExtensionComposition>[0]["hostExtensions"]>;
	function hostPort(overrides: Partial<HostPort> = {}) {
		return {
			start: async () => ({ ok: true as const, tools: [] as readonly never[] }),
			tools: () => [] as readonly never[],
			inspect: async () => ({ host: "idle" }),
			shutdown: async () => undefined,
			dispatchEvent: async () => ({ ok: false as const, code: "host_unavailable", message: "none" }),
			...overrides,
		};
	}

	it("starts the host, exposes its tools and audits the admitted count", async () => {
		const audits: string[] = [];
		const tool = { name: "fixture_echo", label: "echo", description: "d", parameters: {}, execute: async () => ({ content: [], details: {} }) };
		const session = createSessionExtensionComposition({
			sessionId: "session_host",
			generation: 1,
			manager: hostManager(),
			mcp: hostMcp(),
			closeHooks: async () => undefined,
			closePlugins: async () => undefined,
			cleanup: async () => undefined,
			hostExtensions: hostPort({ start: async () => ({ ok: true, tools: [tool] as never }), tools: () => [tool] as never }),
			audit: async (event) => { audits.push(event.eventType); },
		});
		expect(session.extensionTools()).toEqual([]);
		await session.start();
		expect(session.extensionTools().map((entry) => entry.name)).toEqual(["fixture_echo"]);
		expect(audits).toContain("extension.host.tools_admitted");
	});

	it("keeps the session alive when the host fails to start", async () => {
		const audits: string[] = [];
		const session = createSessionExtensionComposition({
			sessionId: "session_host_failed",
			generation: 1,
			manager: hostManager(),
			mcp: hostMcp(),
			closeHooks: async () => undefined,
			closePlugins: async () => undefined,
			cleanup: async () => undefined,
			hostExtensions: hostPort({ start: async () => ({ ok: false, code: "extension_factory_failed", message: "exploded" }) }),
			audit: async (event) => { audits.push(event.eventType); },
		});
		// 不抛错：host 失败只记账，工具集保持为空（D2）。
		await expect(session.start()).resolves.toBeUndefined();
		expect(session.extensionTools()).toEqual([]);
		expect(audits).toContain("extension.host.start_failed");
	});

	it("reports host_unavailable for event dispatch when no host is assembled", async () => {
		const session = composition();
		await expect(session.dispatchExtensionEvent({ name: "PreToolUse", cancelable: true, payload: {} }))
			.resolves.toMatchObject({ ok: false, code: "host_unavailable" });
	});

	it("shuts the host down before closing MCP and hooks", async () => {
		const order: string[] = [];
		const session = createSessionExtensionComposition({
			sessionId: "session_host_shutdown",
			generation: 1,
			manager: hostManager(),
			mcp: hostMcp({ close: async () => { order.push("mcp"); } }),
			closeHooks: async () => { order.push("hooks"); },
			closePlugins: async () => undefined,
			cleanup: async () => undefined,
			hostExtensions: hostPort({ shutdown: async () => { order.push("host"); } }),
		});
		await session.shutdown("paused");
		expect(order).toEqual(["host", "mcp", "hooks"]);
	});
});

describe("extension.host.inspect", () => {
	it("publishes the operation as a read and routes it to the host port", async () => {
		const session = composition();
		const manifest = session.resources.operationManifest.find((entry) => entry.operation === "extension.host.inspect");
		expect(manifest).toEqual({ operation: "extension.host.inspect", capability: "session.extensions", access: "read" });

		// 没有 host 装配时报告 disabled，而不是返回空对象让调用方猜。
		await expect(session.resources.query("extension.host.inspect", {}, queryContext())).resolves.toMatchObject({
			ok: true,
			value: { host: "disabled" },
		});
	});

	it("returns the host's own bounded projection when one is assembled", async () => {
		const session = createSessionExtensionComposition({
			sessionId: "session_host_inspect",
			generation: 1,
			manager: hostManager(),
			mcp: hostMcp(),
			closeHooks: async () => undefined,
			closePlugins: async () => undefined,
			cleanup: async () => undefined,
			hostExtensions: {
				start: async () => ({ ok: true, tools: [] }),
				tools: () => [],
				inspect: async () => ({ host: "ready", generation: 3, registryDigest: "a".repeat(64), hostPid: 42, candidates: [{ packageId: "alpha@local", eligibility: "host-ready" }] }),
				shutdown: async () => undefined,
				dispatchEvent: async () => ({ ok: false, code: "host_unavailable", message: "none" }),
			},
			hostInspect: async () => ({ host: "ready", generation: 3, registryDigest: "a".repeat(64), hostPid: 42, candidates: [{ packageId: "alpha@local", eligibility: "host-ready" }] }),
		});
		await expect(session.resources.query("extension.host.inspect", {}, queryContext())).resolves.toMatchObject({
			ok: true,
			value: { host: "ready", generation: 3, hostPid: 42, candidates: [{ packageId: "alpha@local", eligibility: "host-ready" }] },
		});
	});
});

describe("plugin.config read/write domain routing", () => {
	it("publishes config read as a read and write as a mutate", async () => {
		const session = composition();
		const byOperation = new Map(session.resources.operationManifest.map((entry) => [entry.operation, entry.access]));
		expect(byOperation.get("plugin.config.read")).toBe("read");
		expect(byOperation.get("plugin.config.write")).toBe("mutate");
	});

	it("routes plugin.config.read to the read port", async () => {
		const session = composition({
			read: readPort({ configRead: async () => ({ ok: true, value: { items: [{ packageId: "alpha@local", declared: { theme: { type: "string" } }, values: { theme: "dark" } }] } }) }),
			mutate: mutatePort([]),
		});
		await expect(session.resources.query("plugin.config.read", {}, queryContext())).resolves.toMatchObject({
			ok: true,
			value: { items: [{ packageId: "alpha@local", values: { theme: "dark" } }] },
		});
	});

	it("validates the write payload before touching the port", async () => {
		const calls: Array<Record<string, unknown>> = [];
		const session = composition({ read: readPort(), mutate: mutatePort(calls) });
		for (const [payload, code] of [
			[{}, "plugin_id_required"],
			[{ pluginId: "alpha@local" }, "values_required"],
			[{ pluginId: "alpha@local", values: "nope" }, "values_required"],
		] as const) {
			const result = await mutate(session, "plugin.config.write", payload as Record<string, unknown>);
			expect(result.ok, code).toBe(false);
			if (!result.ok) expect(result.code).toBe(code);
		}
		expect(calls).toEqual([]);

		await expect(mutate(session, "plugin.config.write", { pluginId: "alpha@local", values: { theme: "dark" } })).resolves.toMatchObject({ ok: true });
		expect(calls).toEqual([{ method: "configWrite", packageId: "alpha@local", values: { theme: "dark" } }]);
	});

	it("propagates the settings schema rejection code", async () => {
		const session = composition({
			read: readPort(),
			mutate: mutatePort([], { configWrite: async () => ({ ok: false, code: "invalid_enum", message: "setting value is not one of the declared enum values" }) }),
		});
		const result = await mutate(session, "plugin.config.write", { pluginId: "alpha@local", values: { mode: "warp" } });
		expect(result).toMatchObject({ ok: false, code: "invalid_enum" });
	});
});

describe("session reload watch wiring", () => {
	it("starts the watcher with the session and stops it on shutdown", async () => {
		const order: string[] = [];
		const session = createSessionExtensionComposition({
			sessionId: "session_watch",
			generation: 1,
			manager: hostManager(),
			mcp: hostMcp(),
			closeHooks: async () => undefined,
			closePlugins: async () => undefined,
			cleanup: async () => undefined,
			reloadWatch: { start: () => { order.push("watch:start"); }, stop: () => { order.push("watch:stop"); } },
		});
		await session.start();
		expect(order).toEqual(["watch:start"]);
		await session.shutdown("paused");
		expect(order).toEqual(["watch:start", "watch:stop"]);
	});

	it("does not observe anything when no watcher is assembled (default off)", async () => {
		const session = composition();
		// 缺省组合没有 watcher：start/shutdown 不应因此失败，也不产生任何观察行为。
		await expect(session.start()).resolves.toBeUndefined();
		await expect(session.shutdown("paused")).resolves.toBeUndefined();
	});
});
