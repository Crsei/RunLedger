import { describe, expect, it } from "vitest";
import { ExtensionTurnLifecycle } from "../../src/extensions/turn-lifecycle.ts";
import type { ExtensionReloadResult, ExtensionPublicSnapshot } from "../../src/extensions/host-manager.ts";

function snapshot(generation: number): ExtensionPublicSnapshot {
	return {
		snapshotId: `snapshot_extension-${generation}`,
		generation,
		createdAt: "2026-08-05T00:00:00.000Z",
		digest: String(generation).repeat(64),
		counts: { plugins: 0, skills: 0, hooks: 0, mcpServers: 0, mcpTools: 0, ready: 0, blocked: 0, disabled: 0, error: 0 },
		descriptors: [],
		diagnostics: [],
	};
}

describe("Host extension turn lifecycle", () => {
	it("runs Host-owned SessionStart and SessionEnd hooks around the resident turn", async () => {
		const calls: string[] = [];
		const manager = {
			beginTurn: () => snapshot(1),
			endTurn: async (): Promise<ExtensionReloadResult | undefined> => undefined,
		};
		const lifecycle = new ExtensionTurnLifecycle({
			manager,
			sessionId: "session_hook-lifecycle",
			hookRuntime: {
				run: async (input) => {
					calls.push(input.event);
					return { decision: "allow", blocked: false, finalInput: input.input, additionalContext: [], requiresRevalidation: false, requiresAuthorization: false };
				},
			},
		});

		await lifecycle.handle({ type: "agent_start", timestamp: 1 });
		await lifecycle.handle({ type: "agent_end", timestamp: 2 });
		expect(calls).toEqual(["SessionStart", "SessionEnd"]);
	});

	it("holds the current snapshot through a turn and applies pending reload at agent idle", async () => {
		const calls: string[] = [];
		const next = snapshot(2);
		const manager = {
			beginTurn: () => { calls.push("begin"); return snapshot(1); },
			endTurn: async (): Promise<ExtensionReloadResult | undefined> => { calls.push("end"); return { status: "ready", snapshot: next }; },
		};
		const applied: number[] = [];
		const lifecycle = new ExtensionTurnLifecycle({ manager, onIdleReload: async (result) => { if (result.snapshot) applied.push(result.snapshot.generation); } });

		await lifecycle.handle({ type: "agent_start", timestamp: 1 });
		await lifecycle.handle({ type: "agent_start", timestamp: 2 });
		expect(calls).toEqual(["begin"]);
		await lifecycle.handle({ type: "agent_end", timestamp: 3 });

		expect(calls).toEqual(["begin", "end"]);
		expect(applied).toEqual([2]);
	});
});
