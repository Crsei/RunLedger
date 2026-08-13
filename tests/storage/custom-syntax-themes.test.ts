import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildRunledgerLayout } from "../../src/runtime/contracts/storage-layout.ts";
import { loadCustomSyntaxThemes } from "../../src/storage/custom-syntax-themes.ts";

const cleanup: string[] = [];
const MINIMAL_THEME = Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict><key>name</key><string>Fixture</string><key>settings</key><array><dict>
<key>settings</key><dict><key>foreground</key><string>#ffffff</string></dict>
</dict></array></dict></plist>`);

afterEach(() => {
	for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("custom syntax theme storage boundary", () => {
	it("returns sorted safe names and bounded bytes without exposing paths", async () => {
		const root = mkdtempSync(join(tmpdir(), "runledger-custom-themes-"));
		cleanup.push(root);
		const layout = buildRunledgerLayout(join(root, "home"), "posix");
		const themes = join(layout.home, "themes");
		mkdirSync(themes, { recursive: true });
		writeFileSync(join(themes, "Zulu.tmTheme"), MINIMAL_THEME);
		writeFileSync(join(themes, "alpha.tmTheme"), MINIMAL_THEME);
		writeFileSync(join(themes, "ignored.txt"), "not a theme");
		const loaded = await loadCustomSyntaxThemes(layout);
		expect(loaded).toMatchObject({ themes: [{ name: "alpha" }, { name: "Zulu" }], errors: [] });
		expect(loaded.themes.every((theme) => Buffer.from(theme.bytes).equals(MINIMAL_THEME))).toBe(true);
		expect(JSON.stringify(loaded)).not.toContain(layout.home);
	});

	it("rejects symlinks, unsafe names, and oversized files without reading outside home", async () => {
		const root = mkdtempSync(join(tmpdir(), "runledger-custom-themes-"));
		cleanup.push(root);
		const layout = buildRunledgerLayout(join(root, "home"), "posix");
		const themes = join(layout.home, "themes");
		mkdirSync(themes, { recursive: true });
		const outside = join(root, "outside.tmTheme");
		writeFileSync(outside, MINIMAL_THEME);
		if (process.platform !== "win32") symlinkSync(outside, join(themes, "linked.tmTheme"));
		writeFileSync(join(themes, "too-large.tmTheme"), Buffer.alloc(512 * 1024 + 1));
		writeFileSync(join(themes, "bad name.tmTheme"), MINIMAL_THEME);
		writeFileSync(join(themes, "bad..name.tmTheme"), MINIMAL_THEME);
		const loaded = await loadCustomSyntaxThemes(layout);
		expect(loaded.themes).toEqual([]);
		expect(loaded.errors.filter((error) => error.code === "custom_theme_invalid_name")).toHaveLength(2);
		expect(loaded.errors.map((error) => error.code)).toEqual(expect.arrayContaining([
			"custom_theme_invalid_name",
			"custom_theme_oversize",
			...(process.platform === "win32" ? [] : ["custom_theme_not_regular"]),
		]));
		expect(JSON.stringify(loaded)).not.toContain(outside);
	});
});
