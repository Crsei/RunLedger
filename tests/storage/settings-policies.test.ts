import { describe, expect, it } from "vitest";
import {
	resolveDisplaySettings,
	resolveProviderPolicy,
	resolveStartupSettings,
	resolveTaskPolicy,
	resolveToolPolicy,
} from "../../src/storage/settings-policies.ts";
import { SettingsResolver } from "../../src/storage/settings-resolver.ts";
import { normalizeSettingValue, type SettingPath } from "../../src/storage/settings-schema.ts";

describe("settings policy projections", () => {
	it("projects bounded display and startup settings without changing runtime truth", () => {
		expect(resolveDisplaySettings({
			symbolPreset: "ascii",
			colorBlindMode: true,
			statusLine: { preset: "compact", separator: " | ", sessionAccent: false },
			display: { smoothStreaming: false, hideToolActivity: true, showTokenUsage: false },
			tui: { renderMermaid: false },
		})).toMatchObject({
			symbolPreset: "ascii",
			colorBlindMode: true,
			statusLine: { preset: "compact", separator: " | ", sessionAccent: false },
			display: { smoothStreaming: false, hideToolActivity: true, showTokenUsage: false },
			tui: { renderMermaid: false },
		});
		expect(resolveDisplaySettings({ statusLine: { separator: "\u001b[31m" } }).statusLine.separator).toBe(" · ");
		expect(resolveStartupSettings({ autoResume: true, startup: { quiet: true, showSplash: false } })).toEqual({
			autoResume: true,
			startup: { quiet: true, showSplash: false },
		});
	});

	it("maps tool approval modes and bounds tool output policy", () => {
		expect(resolveToolPolicy({
			approval: "record",
			approvalMode: "always-ask",
			artifactSpillThreshold: 1024,
			artifactTailBytes: 2048,
			read: { defaultLimit: 50 },
			bash: { defaultTimeoutMs: 5000 },
		})).toMatchObject({
			approval: "record",
			approvalMode: "always-ask",
			approvalPolicy: "granular",
			artifactSpillThreshold: 1024,
			artifactTailBytes: 2048,
			read: { defaultLimit: 50 },
			bash: { defaultTimeoutMs: 5000 },
		});
		expect(resolveToolPolicy({ artifactSpillThreshold: -1 }).artifactSpillThreshold).toBe(64_000);
	});

	it("normalizes provider and bounded task policy while rejecting widening values", () => {
		expect(resolveProviderPolicy({
			disabledProviders: ["openai", "openai", " anthropic "],
			maxInFlightRequests: { openai: 2, anthropic: 1 },
		})).toEqual({
			disabledProviders: ["openai", "anthropic"],
			maxInFlightRequests: { openai: 2, anthropic: 1 },
		});
		expect(resolveProviderPolicy({ imageOrder: ["openrouter"] })).toEqual({});
		expect(resolveTaskPolicy({ maxConcurrency: 99, maxRecursionDepth: -1 })).toMatchObject({
			maxConcurrency: 1,
			maxRecursionDepth: 1,
		});
	});

	it("keeps real display, tool, provider, task, and workspace paths in the effective resolver", () => {
		const resolver = new SettingsResolver({
			user: {
				symbolPreset: "nerd",
				colorBlindMode: true,
				statusLine: { preset: "compact", separator: " | " },
				tools: { approval: "record", approvalMode: "always-ask", read: { defaultLimit: 50 } },
				providers: { maxInFlightRequests: { openai: 2 } },
				task: { maxConcurrency: 2 },
			},
			workspace: {
				tools: { read: { defaultLimit: 100 } },
				"workspace": { additionalDirectories: ["packages/shared"] },
			},
			overrides: { display: { showTokenUsage: false } },
		});

		expect(resolver.get("statusLine.preset" as SettingPath)).toBe("compact");
		expect(resolver.effectiveRuntimeSnapshot().display).toMatchObject({
			symbolPreset: "nerd",
			colorBlindMode: true,
		});
		expect(resolver.get("tools.read.defaultLimit" as SettingPath)).toBe(50);
		expect(resolver.get("providers.maxInFlightRequests" as SettingPath)).toEqual({ openai: 2 });
		expect(resolver.get("task.maxConcurrency" as SettingPath)).toBe(2);
		expect(resolver.get("workspace.additionalDirectories" as SettingPath)).toEqual(["packages/shared"]);
		expect(resolver.get("display.showTokenUsage" as SettingPath)).toBe(false);
	});

	it("rejects invalid structured policy values before they reach storage or runtime", () => {
		expect(normalizeSettingValue("tools.approvalMode", "unrestricted", "user")).toMatchObject({
		ok: false,
		diagnostic: { code: "invalid_value", path: "tools.approvalMode" },
	});
		expect(normalizeSettingValue("task.maxConcurrency", 0, "user")).toMatchObject({
		ok: false,
		diagnostic: { code: "out_of_range", path: "task.maxConcurrency" },
	});
		expect(normalizeSettingValue("workspace.additionalDirectories", ["packages/shared"], "workspace")).toEqual({
		ok: true,
		value: ["packages/shared"],
	});
	});
});
