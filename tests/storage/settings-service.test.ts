import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildRunledgerLayout, type RunledgerLayout } from "../../src/runtime/contracts/storage-layout.ts";
import { loadProjectSettings, saveProjectSettings } from "../../src/storage/settings-manager.ts";
import {
	SettingsCommandError,
	SettingsService,
	parseSettingCliValue,
} from "../../src/storage/settings-service.ts";

describe("SettingsService", () => {
	let root: string;
	let layout: RunledgerLayout;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "runledger-settings-service-"));
		layout = buildRunledgerLayout(join(root, "home"), "posix");
	});

	afterEach(() => rmSync(root, { recursive: true, force: true }));

	it("lists only schema-backed paths and gets schema defaults", async () => {
		const service = new SettingsService({ layout });
		const listed = await service.list();
		expect(listed.some((item) => item.path === "retry.maxRetries")).toBe(true);
		expect(listed.some((item) => item.path === "credentials.apiKey")).toBe(false);
		expect(await service.get("retry.maxRetries")).toMatchObject({ path: "retry.maxRetries", value: 0, source: "default" });
	});

	it("normalizes set values, persists through the canonical writer, and resets one path", async () => {
		const service = new SettingsService({ layout });
		await expect(service.set("retry.maxRetries", parseSettingCliValue("3"))).resolves.toMatchObject({ value: 3, source: "user" });
		expect(JSON.parse(readFileSync(layout.settings, "utf8"))).toEqual({ retry: { maxRetries: 3 } });
		await expect(service.reset("retry.maxRetries")).resolves.toMatchObject({ value: 0, source: "default" });
		expect(JSON.parse(readFileSync(layout.settings, "utf8"))).toEqual({});
		expect(existsSync(`${layout.settings}.tmp`)).toBe(false);
	});

	it("serializes concurrent canonical mutations without losing sibling paths", async () => {
		for (let attempt = 0; attempt < 8; attempt += 1) {
			await saveProjectSettings({ layout }, {});
			const service = new SettingsService({ layout });
			await Promise.all([
				service.set("retry.maxRetries", 3),
				service.set("retry.baseDelayMs", 125),
			]);
			expect(JSON.parse(readFileSync(layout.settings, "utf8"))).toEqual({
				retry: { maxRetries: 3, baseDelayMs: 125 },
			});
			await Promise.all([
				service.reset("retry.maxRetries"),
				service.set("retry.maxDelayMs", 2_000),
			]);
			expect(JSON.parse(readFileSync(layout.settings, "utf8"))).toEqual({
				retry: { baseDelayMs: 125, maxDelayMs: 2_000 },
			});
		}
	});

	it("rejects values the canonical writer cannot persist and retains every schema-backed tool limit", async () => {
		const service = new SettingsService({ layout });
		await expect(service.set("theme", "../invalid")).rejects.toMatchObject<Partial<SettingsCommandError>>({
			code: "invalid_value",
			path: "theme",
		});
		await service.set("tools.find.defaultLimit", 11);
		await service.set("tools.glob.defaultLimit", 12);
		await service.set("tools.ls.defaultLimit", 13);

		expect(JSON.parse(readFileSync(layout.settings, "utf8"))).toEqual({
			tools: {
				find: { defaultLimit: 11 },
				glob: { defaultLimit: 12 },
				ls: { defaultLimit: 13 },
			},
		});
	});

	it("rejects unknown, invalid, and workspace-forbidden mutations without creating a file", async () => {
		const service = new SettingsService({ layout });
		await expect(service.set("retry.maxRetries", "not-a-number")).rejects.toMatchObject<Partial<SettingsCommandError>>({ code: "invalid_value" });
		await expect(service.set("credentials.apiKey", "secret")).rejects.toMatchObject<Partial<SettingsCommandError>>({ code: "unknown_path" });
		await expect(new SettingsService({ layout, workspaceKey: "ws-fixture" }).set("recap.idleSeconds", 10)).rejects.toMatchObject<Partial<SettingsCommandError>>({ code: "scope_not_allowed" });
		expect(existsSync(layout.settings)).toBe(false);
	});

	it("resolves workspace values over user values and falls back to user after workspace reset", async () => {
		await saveProjectSettings({ layout }, { retry: { maxRetries: 2, baseDelayMs: 100 } });
		await saveProjectSettings({ layout, workspaceKey: "ws-fixture" }, { retry: { maxRetries: 4 } });

		const workspace = new SettingsService({ layout, workspaceKey: "ws-fixture" });
		expect(await workspace.get("retry.maxRetries")).toMatchObject({ value: 4, source: "workspace" });
		expect(await workspace.get("retry.baseDelayMs")).toMatchObject({ value: 100, source: "user" });
		await workspace.reset("retry.maxRetries");
		expect(await workspace.get("retry.maxRetries")).toMatchObject({ value: 2, source: "user" });
		expect(await loadProjectSettings({ layout })).toMatchObject({ retry: { maxRetries: 2 } });
	});

	it("parses CLI literals without turning arbitrary strings into executable input", () => {
		expect(parseSettingCliValue("true")).toBe(true);
		expect(parseSettingCliValue("42")).toBe(42);
		expect(parseSettingCliValue('"dark"')).toBe("dark");
		expect(parseSettingCliValue("dark")).toBe("dark");
	});

	it("parses bounded structured values as data for list and provider policy settings", () => {
		expect(parseSettingCliValue('["openai", "anthropic"]')).toEqual(["openai", "anthropic"]);
		expect(parseSettingCliValue('{"openai": 2, "anthropic": 1}')).toEqual({ openai: 2, anthropic: 1 });
	});
});
