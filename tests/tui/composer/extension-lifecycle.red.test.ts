import { describe, expect, it } from "vitest";
import {
	createTrustedComposerShapeLifecycle,
	createTrustedComposerShapeSource,
} from "../../../src/tui/composer/extension-lifecycle.ts";
import { createComposerShapeRegistry, getComposerStyle } from "../../../src/tui/composer/registry.ts";
import type { ComposerShapeDefinition } from "../../../src/tui/composer/registry.ts";

function definition(id: string, label = id): ComposerShapeDefinition {
	const base = getComposerStyle("box");
	return {
		id,
		label,
		description: `Trusted ${label}`,
		style: { ...base, id, label, description: `Trusted ${label}` },
	};
}

describe("trusted composer shape extension lifecycle", () => {
	it("installs only an explicit trusted source and removes it idempotently", () => {
		const registry = createComposerShapeRegistry();
		const source = createTrustedComposerShapeSource("first-party.demo", () => [definition("demo")]);
		const lifecycle = createTrustedComposerShapeLifecycle(registry, [source]);

		expect(lifecycle.load()).toEqual({ ok: true, installed: ["first-party.demo"] });
		expect(registry.getComposerShapeOptions().at(-1)?.id).toBe("demo");

		lifecycle.dispose();
		lifecycle.dispose();
		expect(registry.getComposerStyle("demo").id).toBe("box");
		expect(registry.getComposerShapeOptions().at(-1)?.id).toBe("rail");
	});

	it("rolls back a failed reload and retains the last good source", () => {
		const registry = createComposerShapeRegistry();
		let current: readonly ComposerShapeDefinition[] = [definition("stable")];
		const source = createTrustedComposerShapeSource("first-party.demo", () => current);
		const lifecycle = createTrustedComposerShapeLifecycle(registry, [source]);

		expect(lifecycle.load().ok).toBe(true);
		current = [definition("replacement"), null as unknown as ComposerShapeDefinition];

		expect(lifecycle.reload()).toEqual({
			ok: false,
			diagnostic: { code: "registration_failed", sourceId: "first-party.demo", fallback: "previous" },
		});
		expect(registry.getComposerStyle("stable").id).toBe("stable");
		expect(registry.getComposerStyle("replacement").id).toBe("box");
	});

	it("rejects duplicate trusted source identities without disturbing the registry", () => {
		const registry = createComposerShapeRegistry();
		const lifecycle = createTrustedComposerShapeLifecycle(registry, [
			createTrustedComposerShapeSource("same", () => [definition("one")]),
			createTrustedComposerShapeSource("same", () => [definition("two")]),
		]);

		expect(lifecycle.load()).toEqual({
			ok: false,
			diagnostic: { code: "duplicate_source", sourceId: "same", fallback: "box" },
		});
		expect(registry.getComposerStyle("one").id).toBe("box");
		expect(registry.getComposerStyle("two").id).toBe("box");
	});
});
