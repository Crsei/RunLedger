import { describe, expect, it } from "vitest";
import {
	BUILTIN_COMPOSER_SHAPE_IDS,
	createComposerShapeRegistry,
	getComposerShapeOptions,
	getComposerStyle,
} from "../../../src/tui/composer/registry.ts";
import type { ComposerShapeDefinition } from "../../../src/tui/composer/registry.ts";

describe("composer shape registry P0 RED contract", () => {
	it("exposes the seven builtins in a stable order", () => {
		expect(BUILTIN_COMPOSER_SHAPE_IDS).toEqual([
			"box",
			"claude",
			"pi",
			"borderless",
			"rule",
			"field",
			"rail",
		]);
		expect(getComposerShapeOptions().map((option) => option.id)).toEqual([...BUILTIN_COMPOSER_SHAPE_IDS]);
	});

	it("uses the feature-bearing reference labels and descriptions", () => {
		expect(getComposerShapeOptions()).toEqual([
			{ id: "box", label: "Rounded Box (Default)", description: "Status line embedded in top border, compact 2-line prompt" },
			{ id: "claude", label: "Claude Code", description: "Full-width horizontal rules above and below, status line at bottom" },
			{ id: "pi", label: "Pi", description: "Framed horizontal rules with status line at bottom" },
			{ id: "borderless", label: "Borderless", description: "Clean prompt glyph with status line at bottom, no box borders" },
			{ id: "rule", label: "Top Rule Dock", description: "Single top rule with status docked onto it and below" },
			{ id: "field", label: "Compact Field", description: "Filled one-row field with accent end caps" },
			{ id: "rail", label: "Accent Rail", description: "Filled one-row field anchored by a single accent rail" },
		]);
	});

	it("falls back to box for an unknown shape without exposing the invalid id", () => {
		const style = getComposerStyle("not-a-real-shape");

		expect(style.id).toBe("box");
	});

	it("does not treat inherited object keys as registered styles", () => {
		for (const id of ["constructor", "toString", "__proto__"]) {
			expect(getComposerStyle(id).id).toBe("box");
		}
	});

	it("rejects whitespace-padded extension ids instead of changing their lookup key", () => {
		const registry = createComposerShapeRegistry();
		const base = getComposerStyle("box");

		const result = registry.installExtensionComposerShape({
			...base,
			id: " custom ",
			label: "Custom",
			description: "Invalid padded id",
			style: { ...base, id: " custom " },
		});

		expect(result.ok).toBe(false);
		expect(registry.getComposerShapeOptions().map((option) => option.id)).toEqual([...BUILTIN_COMPOSER_SHAPE_IDS]);
	});

	it("rejects blank labels and mismatched definition/style identities", () => {
		const registry = createComposerShapeRegistry();
		const base = getComposerStyle("box");
		const blankLabel = registry.installExtensionComposerShape({
			id: "blank-label",
			label: " ",
			style: { ...base, id: "blank-label", label: "Blank label" },
		});
		const mismatchedStyle = registry.installExtensionComposerShape({
			id: "definition-id",
			label: "Definition ID",
			style: { ...base, id: "style-id", label: "Style ID" },
		});

		expect(blankLabel).toEqual({ ok: false, diagnostic: { code: "invalid_registration", fallback: "box" } });
		expect(mismatchedStyle).toEqual({ ok: false, diagnostic: { code: "invalid_registration", fallback: "box" } });
		expect(registry.getComposerShapeOptions().map((option) => option.id)).toEqual([...BUILTIN_COMPOSER_SHAPE_IDS]);
	});

	it("rejects runtime-malformed definitions without throwing or changing options", () => {
		const registry = createComposerShapeRegistry();
		const base = getComposerStyle("box");
		const malformedDefinitions: readonly unknown[] = [
			null,
			{ id: 42, label: "Broken", style: base },
			{ id: "broken", label: null, style: base },
			{ id: "broken", label: "Broken", style: null },
		];

		for (const malformed of malformedDefinitions) {
			expect(() => registry.installExtensionComposerShape(malformed as ComposerShapeDefinition)).not.toThrow();
			expect(registry.installExtensionComposerShape(malformed as ComposerShapeDefinition)).toEqual({
				ok: false,
				diagnostic: { code: "invalid_registration", fallback: "box" },
			});
		}
		expect(registry.getComposerShapeOptions().map((option) => option.id)).toEqual([...BUILTIN_COMPOSER_SHAPE_IDS]);
	});

	it("rejects builtin replacement and duplicate extension ids without changing the first registration", () => {
		const registry = createComposerShapeRegistry();
		const base = getComposerStyle("box");
		const builtinReplacement = registry.installExtensionComposerShape({
			id: "box",
			label: "Replacement",
			style: { ...base, id: "box", label: "Replacement" },
		});
		const first = registry.installExtensionComposerShape({
			id: "custom",
			label: "First",
			style: { ...base, id: "custom", label: "First" },
		});
		const duplicate = registry.installExtensionComposerShape({
			id: "custom",
			label: "Second",
			style: { ...base, id: "custom", label: "Second" },
		});

		expect(builtinReplacement).toEqual({ ok: false, diagnostic: { code: "builtin_replacement", fallback: "box" } });
		expect(first.ok).toBe(true);
		expect(duplicate).toEqual({ ok: false, diagnostic: { code: "duplicate_registration", fallback: "box" } });
		expect(registry.getComposerStyle("custom").label).toBe("First");
	});

	it("keeps extension order and removes an extension after an idempotent disposer", () => {
		const registry = createComposerShapeRegistry();
		const base = getComposerStyle("box");
		const result = registry.installExtensionComposerShape({
			...base,
			id: "custom",
			label: "Custom",
			style: { ...base, id: "custom", label: "Custom" },
		});

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(registry.getComposerShapeOptions().at(-1)?.id).toBe("custom");
		expect(registry.getComposerStyle("custom").id).toBe("custom");
		result.dispose();
		result.dispose();
		expect(registry.getComposerShapeOptions().at(-1)?.id).toBe("rail");
		expect(registry.getComposerStyle("custom").id).toBe("box");
	});
});
