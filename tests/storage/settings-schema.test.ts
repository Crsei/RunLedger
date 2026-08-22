import { describe, expect, it } from "vitest";
import {
	SETTINGS_SCHEMA,
	getSettingDefinition,
	normalizeSettingValue,
	type SettingPath,
} from "../../src/storage/settings-schema.ts";

describe("settings schema", () => {
	it("declares one typed definition per effective path with explicit authority and apply mode", () => {
		const paths = Object.keys(SETTINGS_SCHEMA);
		expect(new Set(paths).size).toBe(paths.length);
		expect(paths).toContain("retry.maxRetries");
		expect(paths).toContain("compaction.thresholdPercent");
		expect(paths).toContain("memory.backend");
		for (const path of paths) {
			const definition = getSettingDefinition(path as SettingPath);
			expect(definition?.scope.length).toBeGreaterThan(0);
			expect(["live", "next-turn", "startup"]).toContain(definition?.apply);
		}
	});

	it("normalizes bounded values and rejects invalid values with stable diagnostics", () => {
		expect(normalizeSettingValue("retry.maxRetries", 3, "user")).toEqual({ ok: true, value: 3 });
		expect(normalizeSettingValue("retry.maxRetries", 11, "user")).toMatchObject({
		ok: false,
		diagnostic: { code: "out_of_range", path: "retry.maxRetries" },
	});
		expect(normalizeSettingValue("retry.maxRetries", "3", "user")).toMatchObject({
		ok: false,
		diagnostic: { code: "invalid_value", path: "retry.maxRetries" },
	});
		expect(normalizeSettingValue("recap.idleSeconds", 10, "workspace")).toMatchObject({
		ok: false,
		diagnostic: { code: "scope_not_allowed", path: "recap.idleSeconds" },
	});
		expect(normalizeSettingValue("memory.backend", "off", "workspace")).toEqual({ ok: true, value: "off" });
		expect(normalizeSettingValue("memory.backend", "remote", "user")).toMatchObject({
			ok: false,
			diagnostic: { code: "invalid_value", path: "memory.backend" },
		});
	});

	it("declares shellPath as a user-owned startup setting", () => {
		expect(getSettingDefinition("shellPath")).toMatchObject({
			group: "startup",
			scope: ["user"],
			apply: "startup",
			defaultValue: undefined,
		});
		expect(normalizeSettingValue("shellPath", "/usr/local/bin/runledger-shell", "user")).toEqual({
			ok: true,
			value: "/usr/local/bin/runledger-shell",
		});
		expect(normalizeSettingValue("shellPath", "relative-shell", "user")).toMatchObject({
			ok: false,
			diagnostic: { code: "invalid_value", path: "shellPath" },
		});
		expect(normalizeSettingValue("shellPath", "/tmp/\u0000shell", "user")).toMatchObject({
			ok: false,
			diagnostic: { code: "invalid_value", path: "shellPath" },
		});
		expect(normalizeSettingValue("shellPath", "/usr/bin/sh", "workspace")).toMatchObject({
			ok: false,
			diagnostic: { code: "scope_not_allowed", path: "shellPath" },
		});
	});

	it("declares git.enabled as a live presentation-only user/workspace setting", () => {
		expect(getSettingDefinition("git.enabled")).toMatchObject({
			group: "git",
			scope: ["user", "workspace"],
			apply: "live",
			defaultValue: true,
		});
		expect(normalizeSettingValue("git.enabled", false, "workspace")).toEqual({ ok: true, value: false });
	});

	it("declares startup-owned symbol and color accessibility settings", () => {
		expect(getSettingDefinition("symbolPreset")).toMatchObject({
			group: "display",
			scope: ["user"],
			apply: "startup",
			defaultValue: "unicode",
		});
		expect(getSettingDefinition("colorBlindMode")).toMatchObject({
			group: "display",
			scope: ["user"],
			apply: "startup",
			defaultValue: false,
		});
		expect(normalizeSettingValue("symbolPreset", "ascii", "user")).toEqual({ ok: true, value: "ascii" });
		expect(normalizeSettingValue("symbolPreset", "emoji", "user")).toMatchObject({
			ok: false,
			diagnostic: { code: "invalid_value", path: "symbolPreset" },
		});
		expect(normalizeSettingValue("colorBlindMode", true, "user")).toEqual({ ok: true, value: true });
	});

	it("does not expose unknown or credential-bearing paths", () => {
		expect(normalizeSettingValue("credentials.apiKey" as SettingPath, "secret", "user")).toMatchObject({
		ok: false,
			diagnostic: { code: "unknown_path" },
		});
		expect(normalizeSettingValue("display.collapseCompacted" as SettingPath, true, "user")).toMatchObject({
			ok: false,
			diagnostic: { code: "unknown_path" },
		});
		expect(normalizeSettingValue("startup.changelogMode" as SettingPath, "notify", "user")).toMatchObject({
			ok: false,
			diagnostic: { code: "unknown_path" },
		});
		expect(Object.values(SETTINGS_SCHEMA).some((definition) => definition.secret)).toBe(false);
	});

	it("fails closed for deferred Goal, title-replan, and Todo settings", () => {
		for (const path of [
			"goal.enabled",
			"goal.statusInFooter",
			"goal.continuationModes",
			"title.refreshOnReplan",
			"tasks.todoClearDelay",
			"providers.imageOrder",
			"task.agentIdleTtlMs",
			"task.maxEffort",
		]) {
			expect(getSettingDefinition(path)).toBeUndefined();
			expect(normalizeSettingValue(path, true, "user")).toMatchObject({
				ok: false,
				diagnostic: { code: "unknown_path", path },
			});
		}
	});
});
