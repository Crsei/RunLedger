import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	createCliHideThinkingSettings,
	resolveHideThinkingBlock,
} from "../../src/cli/hide-thinking-settings.ts";
import { buildRunledgerLayout } from "../../src/runtime/contracts/storage-layout.ts";
import { loadProjectSettings, saveProjectSettings } from "../../src/storage/settings-manager.ts";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("CLI thinking visibility composition", () => {
	it("resolves CLI true over settings and otherwise uses the persisted default", () => {
		expect(resolveHideThinkingBlock(true, false)).toBe(true);
		expect(resolveHideThinkingBlock(undefined, true)).toBe(true);
		expect(resolveHideThinkingBlock(undefined, false)).toBe(false);
		expect(resolveHideThinkingBlock(undefined, undefined)).toBe(false);
	});

	it("persists only hideThinkingBlock while preserving other canonical settings", async () => {
		const root = mkdtempSync(join(tmpdir(), "rl-hide-thinking-"));
		roots.push(root);
		const layout = buildRunledgerLayout(join(root, "home"), "posix");
		mkdirSync(layout.home, { recursive: true });
		await saveProjectSettings({ layout }, { provider: "anthropic", model: "claude" });

		const port = createCliHideThinkingSettings(layout);
		expect(await port.save(true)).toEqual({ ok: true });
		expect(await loadProjectSettings({ layout })).toEqual({
			provider: "anthropic",
			model: "claude",
			hideThinkingBlock: true,
		});
	});
});
