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

function context(): SessionDomainMutationContext {
	return { correlationId: "command_distribution" as SessionDomainMutationContext["correlationId"], effectId: "effect_1", expectedRevision: 1 };
}

function readPort(overrides: Partial<SessionDistributionReadPort> = {}): SessionDistributionReadPort {
	return {
		list: async () => ({ ok: true, value: { items: [{ packageId: "alpha@local", version: "1.0.0" }] } }),
		doctor: async () => ({ ok: true, value: { findings: [{ code: "doctor.completed", severity: "ok" }], counts: { ok: 1, warning: 0, error: 0 } } }),
		marketplaces: async () => ({ ok: true, value: { marketplaces: [{ name: "local" }], pendingUpdates: [] } }),
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
			"marketplace.discover",
			"marketplace.remove",
			"marketplace.update",
			"marketplace.upgrade",
			"plugin.disable",
			"plugin.distribution.list",
			"plugin.doctor",
			"plugin.enable",
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
		for (const mutate of ["plugin.install", "plugin.uninstall", "plugin.link", "plugin.upgrade", "marketplace.add", "marketplace.remove", "marketplace.update", "marketplace.upgrade"]) {
			expect(byOperation.get(mutate), mutate).toBe("mutate");
		}
	});

	it("routes each read operation to the distribution read port", async () => {
		const session = composition({ read: readPort(), mutate: mutatePort([]) });
		await expect(session.resources.query("plugin.distribution.list", {}, queryContext())).resolves.toMatchObject({ ok: true, value: { items: [{ packageId: "alpha@local" }] } });
		await expect(session.resources.query("plugin.doctor", {}, queryContext())).resolves.toMatchObject({ ok: true, value: { counts: { ok: 1 } } });
		await expect(session.resources.query("marketplace.discover", {}, queryContext())).resolves.toMatchObject({ ok: true, value: { marketplaces: [{ name: "local" }] } });
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

	it("rejects incomplete mutate payloads without calling the port", async () => {
		const calls: Array<Record<string, unknown>> = [];
		const session = composition({ read: readPort(), mutate: mutatePort(calls) });
		for (const [operation, payload, code] of [
			["plugin.install", {}, "spec_required"],
			["plugin.uninstall", {}, "plugin_id_required"],
			["plugin.link", { pluginId: "dev" }, "link_arguments_required"],
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
