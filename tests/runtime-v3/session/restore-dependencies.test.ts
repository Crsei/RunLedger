import { describe, expect, it } from "vitest";
import {
	SessionRestoreDependencyError,
	SessionRestoreDependencyRegistry,
	createSessionRestoreDependencySnapshot,
	isSessionRestoreDependencySnapshot,
	registerSessionRestoreDependencies,
	verifySessionRestoreDependencies,
	type SessionRestoreDependencyBinding,
} from "../../../src/runtime/session/restore-dependencies.ts";

function bindings(): readonly SessionRestoreDependencyBinding[] {
	return [
		{ kind: "tool", identity: "tool:write", generation: 2, handle: () => undefined },
		{ kind: "model", identity: "model:deepseek-v4-pro", generation: 4, handle: {} },
	];
}

describe("session restore dependencies", () => {
	it("canonicalizes snapshot order without serializing handles", () => {
		const snapshot = createSessionRestoreDependencySnapshot(bindings());

		expect(snapshot.entries.map((entry) => `${entry.kind}:${entry.identity}`)).toEqual([
			"model:model:deepseek-v4-pro",
			"tool:tool:write",
		]);
		expect(snapshot).not.toHaveProperty("handle");
		expect(JSON.stringify(snapshot)).not.toContain("handle");
		expect(isSessionRestoreDependencySnapshot(snapshot)).toBe(true);
	});

	it("rejects duplicate, malformed, and tampered registrations", async () => {
		expect(() => new SessionRestoreDependencyRegistry([
			...bindings(),
			{ kind: "tool", identity: "tool:write", generation: 3, handle: {} },
		])).toThrowError(SessionRestoreDependencyError);
		await expect(registerSessionRestoreDependencies(async () => [{
			kind: "tool",
			identity: "",
			generation: 0,
			handle: {},
		}])).rejects.toMatchObject({ code: "invalid_registration" });

		const snapshot = createSessionRestoreDependencySnapshot(bindings());
		expect(isSessionRestoreDependencySnapshot({
			...snapshot,
			entries: snapshot.entries.map((entry, index) =>
				index === 0 ? { ...entry, generation: entry.generation + 1 } : entry),
		})).toBe(false);
	});

	it("fails closed when a non-empty registry has no durable snapshot binding", () => {
		const registry = new SessionRestoreDependencyRegistry(bindings());
		expect(() => verifySessionRestoreDependencies(undefined, registry)).toThrow(
			expect.objectContaining({ code: "snapshot_missing" }),
		);
		expect(() => verifySessionRestoreDependencies(
			undefined,
			new SessionRestoreDependencyRegistry([]),
		)).not.toThrow();
	});
});
