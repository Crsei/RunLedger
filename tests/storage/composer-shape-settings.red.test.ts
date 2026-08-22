import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadProjectSettings, saveProjectSettings, updateProjectSettings } from "../../src/storage/settings-manager.ts";
import { buildRunledgerLayout, type RunledgerLayout } from "../../src/runtime/contracts/storage-layout.ts";

describe("composer.shape P0 RED contract", () => {
	let root: string | undefined;

	afterEach(() => {
		if (root !== undefined) rmSync(root, { recursive: true, force: true });
	});

	it("keeps a valid composer.shape in the canonical user settings", async () => {
		root = mkdtempSync(join(tmpdir(), "runledger-composer-shape-settings-"));
		const layout: RunledgerLayout = buildRunledgerLayout(join(root, "home"), "posix");
		mkdirSync(layout.home, { recursive: true });
		writeFileSync(layout.settings, JSON.stringify({ composer: { shape: "pi" } }), "utf8");

		expect(await loadProjectSettings({ layout })).toMatchObject({
			composer: { shape: "pi" },
		});
	});

	it("round-trips composer.shape without dropping unrelated user settings", async () => {
		root = mkdtempSync(join(tmpdir(), "runledger-composer-shape-settings-"));
		const layout: RunledgerLayout = buildRunledgerLayout(join(root, "home"), "posix");

		await saveProjectSettings({ layout }, {
			provider: "deepseek",
			composer: { shape: "claude" },
		});

		expect(await loadProjectSettings({ layout })).toMatchObject({
			provider: "deepseek",
			composer: { shape: "claude" },
		});
	});

	it("does not give workspace settings authority over composer.shape", async () => {
		root = mkdtempSync(join(tmpdir(), "runledger-composer-shape-settings-"));
		const layout: RunledgerLayout = buildRunledgerLayout(join(root, "home"), "posix");
		await saveProjectSettings({ layout, workspaceKey: "workspace" }, {
			composer: { shape: "rail" },
			provider: "deepseek",
		});

		expect(await loadProjectSettings({ layout, workspaceKey: "workspace" })).toEqual({ provider: "deepseek" });
	});

	it("drops whitespace-padded composer ids instead of normalizing an unsafe value", async () => {
		root = mkdtempSync(join(tmpdir(), "runledger-composer-shape-settings-"));
		const layout: RunledgerLayout = buildRunledgerLayout(join(root, "home"), "posix");
		mkdirSync(layout.home, { recursive: true });
		writeFileSync(layout.settings, JSON.stringify({ composer: { shape: " pi " } }), "utf8");

		expect(await loadProjectSettings({ layout })).toEqual({});
	});

	it("serializes user settings updates so a concurrent shape change keeps unrelated fields", async () => {
		root = mkdtempSync(join(tmpdir(), "runledger-composer-shape-settings-"));
		const layout: RunledgerLayout = buildRunledgerLayout(join(root, "home"), "posix");
		let releaseFirst: (() => void) | undefined;
		let enteredFirst: (() => void) | undefined;
		const firstEntered = new Promise<void>((resolve) => { enteredFirst = resolve; });
		const firstMayFinish = new Promise<void>((resolve) => { releaseFirst = resolve; });

		const first = updateProjectSettings({ layout }, async (current) => {
			enteredFirst?.();
			await firstMayFinish;
			return { ...current, composer: { shape: "rail" } };
		});
		await firstEntered;
		const second = updateProjectSettings({ layout }, (current) => ({ ...current, theme: "ansi" }));
		releaseFirst?.();

		await Promise.all([first, second]);
		expect(await loadProjectSettings({ layout })).toMatchObject({ composer: { shape: "rail" }, theme: "ansi" });
	});
});
