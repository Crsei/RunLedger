import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	buildMultiAgentPolicyReceipt,
	resolveMultiAgentPolicy,
} from "../../src/runtime/agents/limits.ts";
import { DEFAULT_RUNTIME_FEATURES, isRuntimeFeatureEnabled } from "../../src/runtime/runtime-features.ts";
import { buildRunledgerLayout, type RunledgerLayout } from "../../src/runtime/contracts/storage-layout.ts";
import {
	loadLayeredProjectSettings,
	saveProjectSettings,
	type LayeredProjectSettings,
	SettingsStorageError,
} from "../../src/storage/settings-manager.ts";

const cleanup: string[] = [];

afterEach(() => {
	for (const directory of cleanup.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture(): { readonly layout: RunledgerLayout } {
	const root = mkdtempSync(join(tmpdir(), "runledger-multi-agent-settings-"));
	cleanup.push(root);
	return { layout: buildRunledgerLayout(join(root, "home"), "posix") };
}

describe("layered multi-agent settings", () => {
	it("loads user and workspace layers independently from a canonical layout", async () => {
		const { layout } = fixture();
		await saveProjectSettings(
			{ layout },
			{ model: "parent-model", multiAgent: { enabled: true, maxToolCallsPerAgent: 8 } },
		);
		await saveProjectSettings(
			{ layout, workspaceKey: "ws-fixture" },
			{ autoTitle: false, multiAgent: { enabled: true, maxToolCallsPerAgent: 4 } },
		);

		const loaded = await loadLayeredProjectSettings({ layout, workspaceKey: "ws-fixture" });

		expect(loaded.user.settings).toMatchObject({ model: "parent-model" });
		expect(loaded.workspace.settings).toMatchObject({ autoTitle: false });
		expect(loaded.user.multiAgent).toMatchObject({ state: "valid", value: { enabled: true, maxToolCallsPerAgent: 8 } });
		expect(loaded.workspace.multiAgent).toMatchObject({ state: "valid", value: { enabled: true, maxToolCallsPerAgent: 4 } });
		expect(loaded.user.sourceDigest.digest).toMatch(/^[a-f0-9]{64}$/u);
		expect(loaded.workspace.sourceDigest.digest).toMatch(/^[a-f0-9]{64}$/u);
		expect(loaded.diagnostics).toEqual([]);
	});

	it("preserves an invalid multi-agent block as unavailable while ordinary settings remain usable", async () => {
		const { layout } = fixture();
		mkdirSync(layout.home, { recursive: true });
		writeFileSync(
			layout.settings,
			JSON.stringify({ model: "safe-parent-model", multiAgent: { enabled: true, unknownField: true } }),
			{ encoding: "utf8", mode: 0o600 },
		);

		const loaded = await loadLayeredProjectSettings({ layout, workspaceKey: "ws-fixture" });
		const resolution = resolveMultiAgentPolicy({
			runtimeEnabled: true,
			user: loaded.user.multiAgent.raw,
			workspace: loaded.workspace.multiAgent.raw,
		});

		expect(loaded.user.settings).toEqual({ model: "safe-parent-model" });
		expect(loaded.user.multiAgent).toMatchObject({ state: "invalid", raw: { enabled: true, unknownField: true } });
		expect(loaded.diagnostics).toEqual([
			expect.objectContaining({ code: "invalid_policy", path: "user.multiAgent.unknownField" }),
		]);
		expect(resolution.policy.enabled).toBe(false);
		expect(resolution.diagnostics).toEqual([
			expect.objectContaining({ code: "invalid_policy" }),
		]);
	});

	it("rejects workspace widening through the same effective policy resolver", async () => {
		const { layout } = fixture();
		await saveProjectSettings({ layout }, { multiAgent: { enabled: true, maxToolCallsPerAgent: 4 } });
		await saveProjectSettings(
			{ layout, workspaceKey: "ws-fixture" },
			{ multiAgent: { enabled: true, maxToolCallsPerAgent: 5 } },
		);

		const loaded = await loadLayeredProjectSettings({ layout, workspaceKey: "ws-fixture" });
		const resolution = resolveMultiAgentPolicy({
			runtimeEnabled: true,
			user: loaded.user.multiAgent.raw,
			workspace: loaded.workspace.multiAgent.raw,
		});

		expect(resolution.policy.enabled).toBe(false);
		expect(resolution.diagnostics).toEqual([
			expect.objectContaining({ code: "invalid_policy", path: "workspace.maxToolCallsPerAgent" }),
		]);
	});

	it("does not allow a workspace-only block to turn on the runtime", async () => {
		const { layout } = fixture();
		await saveProjectSettings(
			{ layout, workspaceKey: "ws-fixture" },
			{ multiAgent: { enabled: true } },
		);

		const loaded = await loadLayeredProjectSettings({ layout, workspaceKey: "ws-fixture" });
		const resolution = resolveMultiAgentPolicy({
			runtimeEnabled: true,
			user: loaded.user.multiAgent.raw,
			workspace: loaded.workspace.multiAgent.raw,
		});

		expect(resolution.policy.enabled).toBe(false);
		expect(resolution.diagnostics).toEqual([
			expect.objectContaining({ code: "invalid_policy", path: "workspace.enabled" }),
		]);
	});

	it("builds a deterministic receipt from independent source digests and effective policy", async () => {
		const { layout } = fixture();
		await saveProjectSettings({ layout }, { multiAgent: { enabled: true, maxReportBytes: 1024 } });
		const loaded = await loadLayeredProjectSettings({ layout, workspaceKey: "ws-fixture" });
		const resolution = resolveMultiAgentPolicy({
			runtimeEnabled: true,
			user: loaded.user.multiAgent.raw,
			workspace: loaded.workspace.multiAgent.raw,
		});
		const input = {
			runtimeEnabled: true,
			userSourceDigest: loaded.user.sourceDigest,
			workspaceSourceDigest: loaded.workspace.sourceDigest,
			resolution,
		};

		const first = buildMultiAgentPolicyReceipt(input);
		const second = buildMultiAgentPolicyReceipt(input);

		expect(first).toEqual(second);
		expect(first.receiptDigest.digest).toMatch(/^[a-f0-9]{64}$/u);
		expect(first.effectiveLimits.maxReportBytes).toBe(1024);
		expect(Object.isFrozen(first)).toBe(true);
	});

	it("keeps the runtime feature default closed", () => {
		expect(DEFAULT_RUNTIME_FEATURES.multiAgent).toBe(false);
		expect(isRuntimeFeatureEnabled(DEFAULT_RUNTIME_FEATURES, "multiAgent")).toBe(false);
	});

	it("uses a real layout type when saving the multi-agent block", async () => {
		const { layout } = fixture();
		await saveProjectSettings({ layout }, { multiAgent: { enabled: false, maxChildrenPerRoot: 1 } });
		const loaded: LayeredProjectSettings = await loadLayeredProjectSettings({ layout, workspaceKey: "ws-fixture" });
		expect(loaded.user.multiAgent.value).toEqual({ enabled: false, maxChildrenPerRoot: 1 });
	});

	it("fails closed for an invalid workspace storage key", async () => {
		const { layout } = fixture();
		await expect(loadLayeredProjectSettings({ layout, workspaceKey: "../outside" })).rejects.toMatchObject<Partial<SettingsStorageError>>({
			code: "invalid_workspace_key",
		});
	});
});
