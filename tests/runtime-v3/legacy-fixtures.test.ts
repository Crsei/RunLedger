import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SessionManager } from "../../src/storage/session-manager.ts";
import { replaySession } from "../../src/storage/session-codec.ts";

function fixture(name: "v1-basic.jsonl" | "v2-basic.jsonl"): string {
	return fileURLToPath(new URL(`../fixtures/runtime-v3/legacy/${name}`, import.meta.url));
}

describe("legacy compatibility golden fixtures", () => {
	it("runs a real v1 JSONL fixture through the production reader without inventing tool data", async () => {
		const path = fixture("v1-basic.jsonl");
		const before = await readFile(path);
		const manager = await SessionManager.open(path);
		try {
			const replay = await replaySession(manager.ledger());
			expect(manager.ledger().header().version).toBe(1);
			expect(replay.messages).toEqual([
				{ role: "user", content: [{ type: "text", text: "legacy text" }] },
				{ role: "assistant", content: [{ type: "text", text: "legacy assistant" }], stopReason: "toolUse" },
			]);
			expect(replay.warnings).toHaveLength(1);
			expect(JSON.stringify(replay.messages)).not.toContain("unverifiable");
		} finally {
			await manager.closeAll();
		}
		expect(await readFile(path)).toEqual(before);
	});

	it("runs a real v2 JSONL fixture through the production reader losslessly", async () => {
		const path = fixture("v2-basic.jsonl");
		const before = await readFile(path);
		const manager = await SessionManager.open(path);
		try {
			const replay = await replaySession(manager.ledger());
			expect(manager.ledger().header().version).toBe(2);
			expect(replay.messages).toHaveLength(3);
			expect(replay.messages[1]).toMatchObject({
				role: "assistant",
				content: [
					{ type: "thinking", thinkingSignature: "signature" },
					{ type: "toolCall", id: "call-1", arguments: { path: "README.md" } },
				],
			});
			expect(replay.config).toEqual({ provider: "fixture", model: "fixture-1", thinkingLevel: "high" });
			expect(replay.warnings).toEqual([]);
		} finally {
			await manager.closeAll();
		}
		expect(await readFile(path)).toEqual(before);
	});
});
