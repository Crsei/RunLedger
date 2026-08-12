import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createCliSyntaxThemeSettings } from "../../src/cli/syntax-theme-settings.ts";
import { buildRunledgerLayout } from "../../src/runtime/contracts/storage-layout.ts";
import { saveProjectSettings } from "../../src/storage/settings-manager.ts";

const cleanup: string[] = [];

afterEach(() => {
	for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("CLI syntax theme settings port", () => {
	it("merges the canonical theme without discarding unrelated user settings", async () => {
		const root = mkdtempSync(join(tmpdir(), "runledger-theme-settings-"));
		cleanup.push(root);
		const layout = buildRunledgerLayout(join(root, "home"), "posix");
		await saveProjectSettings({ layout }, { provider: "deepseek", model: "v4", theme: "dracula" });
		const port = createCliSyntaxThemeSettings(layout);
		expect(await port.save("ansi")).toEqual({ ok: true });
		expect(JSON.parse(readFileSync(layout.settings, "utf8"))).toMatchObject({ provider: "deepseek", model: "v4", theme: "ansi" });
	});

	it("returns a bounded error code and never accepts path-like names", async () => {
		const root = mkdtempSync(join(tmpdir(), "runledger-theme-settings-"));
		cleanup.push(root);
		const port = createCliSyntaxThemeSettings(buildRunledgerLayout(join(root, "home"), "posix"));
		expect(await port.save("../outside")).toEqual({ ok: false, code: "syntax_theme_invalid" });
	});

	it("persists only custom names registered by the startup composition", async () => {
		const root = mkdtempSync(join(tmpdir(), "runledger-theme-settings-"));
		cleanup.push(root);
		const layout = buildRunledgerLayout(join(root, "home"), "posix");
		const port = createCliSyntaxThemeSettings(layout, ["company-audit"]);
		expect(await port.save("company-audit")).toEqual({ ok: true });
		expect(JSON.parse(readFileSync(layout.settings, "utf8"))).toMatchObject({ theme: "company-audit" });
		expect(await port.save("missing-custom")).toEqual({ ok: false, code: "syntax_theme_invalid" });
	});
});
