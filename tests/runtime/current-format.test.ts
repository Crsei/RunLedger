import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { JsonlLedger } from "../../src/runtime/ledger/jsonl-ledger.ts";
import {
	isCurrentLedgerHeader,
	UnsupportedSessionFormatError,
	type LedgerHeader,
} from "../../src/runtime/ledger/types.ts";
import { SessionManager } from "../../src/storage/session-manager.ts";

function currentHeader(sessionId = "session_fixture"): LedgerHeader {
	return {
		type: "ledger",
		id: "header_fixture",
		createdAt: 1,
		sessionId,
		metadata: { cwd: "/fixture" },
	};
}

describe("current session format", () => {
	it("accepts only the exact current ledger header shape", () => {
		const unsupportedSchemaField = ["schema", "Version"].join("");
		expect(isCurrentLedgerHeader(currentHeader())).toBe(true);
		expect(isCurrentLedgerHeader({ ...currentHeader(), [unsupportedSchemaField]: 1 })).toBe(false);
		expect(isCurrentLedgerHeader({ ...currentHeader(), unsupported: true })).toBe(false);
	});

	it("rejects a malformed current entry instead of silently continuing", async () => {
		const dir = await mkdtemp(join(tmpdir(), "runledger-current-format-"));
		const filePath = join(dir, "malformed.jsonl");
		const validEntry = {
			id: "valid-entry",
			sessionId: currentHeader().sessionId,
			parentId: currentHeader().id,
			timestamp: 2,
			type: "custom",
			payload: { marker: true },
		};
		const original = `${JSON.stringify(currentHeader())}\n${JSON.stringify(validEntry)}\n{"id":"broken"\n`;
		await writeFile(filePath, original, "utf8");

		try {
			const ledger = new JsonlLedger({ filePath });
			await expect(ledger.initialize()).rejects.toThrow(SyntaxError);
			expect(await ledger.entries()).toEqual([]);
			await expect(readFile(filePath, "utf8")).resolves.toBe(original);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("rejects a structurally invalid current entry", async () => {
		const dir = await mkdtemp(join(tmpdir(), "runledger-current-entry-shape-"));
		const filePath = join(dir, "invalid-entry.jsonl");
		const original = `${JSON.stringify(currentHeader())}\n${JSON.stringify({ id: "incomplete" })}\n`;
		await writeFile(filePath, original, "utf8");

		try {
			const ledger = new JsonlLedger({ filePath });
			await expect(ledger.initialize()).rejects.toBeInstanceOf(UnsupportedSessionFormatError);
			await expect(readFile(filePath, "utf8")).resolves.toBe(original);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("rejects a malformed source during fork instead of dropping its entry", async () => {
		const dir = await mkdtemp(join(tmpdir(), "runledger-current-fork-"));
		const source = join(dir, "source.jsonl");
		const original = `${JSON.stringify(currentHeader())}\n{"id":"broken"\n`;
		await writeFile(source, original, "utf8");

		try {
			await expect(SessionManager.forkFrom(source, "/target", dir)).rejects.toThrow(SyntaxError);
			await expect(readFile(source, "utf8")).resolves.toBe(original);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("rejects an empty source during fork without creating a target", async () => {
		const sourceDir = await mkdtemp(join(tmpdir(), "runledger-current-empty-source-"));
		const targetDir = await mkdtemp(join(tmpdir(), "runledger-current-empty-target-"));
		const sourcePath = join(sourceDir, "empty.jsonl");
		await writeFile(sourcePath, "", "utf8");

		try {
			await expect(SessionManager.forkFrom(sourcePath, "/target", targetDir)).rejects.toBeInstanceOf(
				UnsupportedSessionFormatError,
			);
			expect(await readdir(targetDir)).toEqual([]);
		} finally {
			await rm(sourceDir, { recursive: true, force: true });
			await rm(targetDir, { recursive: true, force: true });
		}
	});

	it("rebuilds explicitly with truncate without reading an unsupported source", async () => {
		const dir = await mkdtemp(join(tmpdir(), "runledger-current-truncate-"));
		const filePath = join(dir, "unsupported.jsonl");
		const unsupportedField = ["schema", "Version"].join("");
		await writeFile(
			filePath,
			`${JSON.stringify({ type: "ledger", [unsupportedField]: 1 })}\nunsupported\n`,
			"utf8",
		);

		try {
			const ledger = new JsonlLedger({ filePath, truncate: true, sessionId: "rebuilt" });
			await expect(ledger.initialize()).resolves.toBeUndefined();
			expect(ledger.header().sessionId).toBe("rebuilt");
			expect(JSON.parse((await readFile(filePath, "utf8")).split("\n")[0]!)).toEqual(ledger.header());
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
