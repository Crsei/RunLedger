import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { composeCliSyntaxThemes } from "../../src/cli/syntax-theme-composition.ts";
import type { NativeSyntaxAddon } from "../../src/tui/highlight/native-loader.ts";
import { buildRunledgerLayout } from "../../src/runtime/contracts/storage-layout.ts";

const cleanup: string[] = [];
const THEME = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict><key>name</key><string>Fixture</string><key>settings</key><array>
<dict><key>settings</key><dict><key>foreground</key><string>#ffffff</string></dict></dict>
</array></dict></plist>`;

afterEach(() => {
	for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

function addon(registrations: string[]): NativeSyntaxAddon {
	return {
		engineInfo: () => ({ addon: "runledger-syntax-highlighter", apiVersion: 1, engineBuildId: "syntax-highlighter@0.0.1:test" }),
		builtinThemes: () => [],
		registerCustomTheme: (name) => {
			registrations.push(name);
			return name === "broken" ? { ok: false, reason: "theme_invalid" } : { ok: true };
		},
		highlightAsync: async () => ({ ok: false, reason: "empty" }),
		foregroundForScopes: () => undefined,
		diffScopeBackgrounds: () => undefined,
	};
}

describe("CLI custom syntax theme composition", () => {
	it("is wired by the standard CLI before InteractiveMode creation", () => {
		const main = readFileSync("src/cli/main.ts", "utf8");
		expect(main).toContain("composeCliSyntaxThemes(layout, settings.theme)");
		expect(main).toContain("syntaxThemeController: syntaxThemes.controller");
		expect(main).toContain("createCliSyntaxThemeSettings(layout, syntaxThemes.customThemeNames)");
	});

	it("registers validated bytes before resolving a configured custom theme", async () => {
		const root = mkdtempSync(join(tmpdir(), "runledger-theme-composition-"));
		cleanup.push(root);
		const layout = buildRunledgerLayout(join(root, "home"), "posix");
		mkdirSync(join(layout.home, "themes"), { recursive: true });
		writeFileSync(join(layout.home, "themes", "company-audit.tmTheme"), THEME);
		const registrations: string[] = [];
		const composition = await composeCliSyntaxThemes(layout, "company-audit", () => ({
			ok: true,
			addon: addon(registrations),
			info: { addon: "runledger-syntax-highlighter", apiVersion: 1, engineBuildId: "syntax-highlighter@0.0.1:test" },
		}));

		expect(registrations).toEqual(["company-audit"]);
		expect(composition.controller.snapshot()).toMatchObject({ activeName: "company-audit", configuredName: "company-audit" });
		expect(composition.customThemeNames).toEqual(["company-audit"]);
		expect(composition.controller.themeEntries()).toContainEqual({ name: "company-audit", kind: "custom", available: true });
		expect(composition.takeWarnings()).toEqual([]);
	});

	it("falls back adaptively, exposes load errors, and emits one path-free warning once", async () => {
		const root = mkdtempSync(join(tmpdir(), "runledger-theme-composition-"));
		cleanup.push(root);
		const layout = buildRunledgerLayout(join(root, "home"), "posix");
		mkdirSync(join(layout.home, "themes"), { recursive: true });
		writeFileSync(join(layout.home, "themes", "broken.tmTheme"), THEME);
		const composition = await composeCliSyntaxThemes(layout, "missing-custom", () => ({
			ok: true,
			addon: addon([]),
			info: { addon: "runledger-syntax-highlighter", apiVersion: 1, engineBuildId: "syntax-highlighter@0.0.1:test" },
		}));

		expect(composition.controller.snapshot()).toMatchObject({ activeName: "catppuccin-mocha", configuredName: undefined });
		expect(composition.controller.themeEntries()).toEqual(expect.arrayContaining([
			{ name: "broken", kind: "custom", available: false, error: "custom_theme_invalid" },
			{ name: "missing-custom", kind: "custom", available: false, error: "custom_theme_missing" },
		]));
		const warning = composition.takeWarnings();
		expect(warning).toHaveLength(1);
		expect(warning[0]).toContain("/theme");
		expect(warning.join("\n")).not.toContain(layout.home);
		expect(composition.takeWarnings()).toEqual([]);
	});
});
