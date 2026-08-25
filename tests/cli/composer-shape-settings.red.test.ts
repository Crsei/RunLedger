import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createComposerShapeRegistry } from "../../src/tui/composer/registry.ts";
import { createCliComposerShapeSettings } from "../../src/cli/composer-shape-settings.ts";
import { buildRunledgerLayout, type RunledgerLayout } from "../../src/runtime/contracts/storage-layout.ts";

describe("CLI composer shape settings port", () => {
	let root: string | undefined;

	afterEach(() => {
		if (root !== undefined) rmSync(root, { recursive: true, force: true });
	});

	it("saves only a registered shape and preserves unrelated settings", async () => {
		root = mkdtempSync(join(tmpdir(), "runledger-composer-shape-cli-"));
		const layout: RunledgerLayout = buildRunledgerLayout(join(root, "home"), "posix");
		const port = createCliComposerShapeSettings(layout, createComposerShapeRegistry());

		expect(await port.save("claude")).toEqual({ ok: true });
		expect(JSON.parse(readFileSync(layout.settings, "utf8"))).toMatchObject({
			composer: { shape: "claude" },
		});
	});

	it("rejects an unknown shape without changing the canonical settings file", async () => {
		root = mkdtempSync(join(tmpdir(), "runledger-composer-shape-cli-"));
		const layout: RunledgerLayout = buildRunledgerLayout(join(root, "home"), "posix");
		const port = createCliComposerShapeSettings(layout, createComposerShapeRegistry());

		expect(await port.save("not-real")).toEqual({ ok: false, code: "unknown_composer_shape" });
		expect(() => readFileSync(layout.settings, "utf8")).toThrow();
	});
});
