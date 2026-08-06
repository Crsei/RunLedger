/**
 * R2:JSONL → SQLite 显式迁移 fixtures(06 §12.2 退出条件)。
 *
 * 覆盖:preflight(legacy writer 活跃 → legacy_host_active)、导入+归档成功、
 * 注入任一失败时 source 保持原位且 target 不标记完成、成功时 source 只归档
 * 不删除、verify 失败阻止归档、prune-legacy 只按 manifest 显式删除。
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import lockfile from "proper-lockfile";
import { createRuntimeId } from "../../../src/runtime/protocol/ids.ts";
import { openSessionDatabase } from "../../../src/storage/session-store/database.ts";
import { installSessionStoreSchema, SESSION_STORE_SCHEMA_VERSION } from "../../../src/storage/session-store/schema.ts";
import { beginOfflineMigration } from "../../../src/storage/session-store/schema-compatibility.ts";
import { SessionStore, sessionEventHash } from "../../../src/storage/session-store/session-store.ts";
import {
	JsonlMigrationError,
	enumerateCanonicalJsonl,
	migrateJsonlSessions,
	proveNoActiveLegacyWriter,
	pruneLegacyArchive,
} from "../../../src/storage/session-store/jsonl-migration.ts";
import { buildRunledgerLayout } from "../../../src/runtime/contracts/public.ts";

let dir: string;
let layout: ReturnType<typeof buildRunledgerLayout>;
let db: ReturnType<typeof openSessionDatabase>;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "session-store-migrate-"));
	layout = buildRunledgerLayout(dir, "posix");
	mkdirSync(layout.sessions, { recursive: true, mode: 0o700 });
	mkdirSync(join(layout.sessions, "2026", "08", "01"), { recursive: true, mode: 0o700 });
	db = openSessionDatabase(layout.database);
	installSessionStoreSchema(db);
});

afterEach(() => {
	db.close();
	rmSync(dir, { recursive: true, force: true });
});

function ledgerHeader(sessionId: string, cwd: string): string {
	return JSON.stringify({
		type: "ledger",
		id: createRuntimeId("event", "header"),
		createdAt: 1_752_000_000_000,
		sessionId,
		metadata: { cwd, model: "deepseek-v4-pro" },
	});
}

function ledgerEntry(id: string, sessionId: string, type: string, payload: Record<string, unknown>, timestamp: number): string {
	return JSON.stringify({ id, sessionId, parentId: id, timestamp, type, payload });
}

function writeFixtureSession(name: string, sessionId: string, entries: string[], cwd = "/work/a"): string {
	const lines = [ledgerHeader(sessionId, cwd), ...entries];
	const filePath = join(layout.sessions, "2026", "08", "01", `${name}.jsonl`);
	writeFileSync(filePath, lines.join("\n") + "\n", { mode: 0o600 });
	return filePath;
}

function standardEntries(sessionId: string): string[] {
	return [
		ledgerEntry(createRuntimeId("event", "e1"), sessionId, "message", { role: "user", content: [{ type: "text", text: "hi" }] }, 1000),
		ledgerEntry(createRuntimeId("event", "e2"), sessionId, "tool_call", { name: "echo", input: { text: "hi" } }, 2000),
		ledgerEntry(createRuntimeId("event", "e3"), sessionId, "tool_result", { output: "hi" }, 3000),
	];
}

function holdGate(): { release: () => void } {
	const gate = beginOfflineMigration(db);
	expect(gate).toMatchObject({ ok: true });
	if (!gate.ok) throw new Error("gate failed");
	return { release: gate.gate.release };
}

describe("R2 JSONL preflight", () => {
	it("returns legacy_host_active while a legacy writer holds the lock", async () => {
		const filePath = writeFixtureSession("s1", createRuntimeId("session", "s1"), standardEntries(createRuntimeId("session", "s1")));
		const files = await enumerateCanonicalJsonl(layout);
		expect(files).toHaveLength(1);
		const release = await lockfile.lock(filePath, { retries: 0, lockfilePath: filePath + ".lock" });
		try {
			await expect(proveNoActiveLegacyWriter(layout, files)).rejects.toMatchObject({
				name: "JsonlMigrationError",
				code: "legacy_host_active",
			});
		} finally {
			await release();
		}
	});

	it("rejects unsupported or tampered records without guessing", async () => {
		writeFixtureSession("s1", createRuntimeId("session", "s1"), standardEntries(createRuntimeId("session", "s1")));
		const tampered = join(layout.sessions, "2026", "08", "01", "tampered.jsonl");
		writeFileSync(tampered, ledgerHeader(createRuntimeId("session", "t"), "/x") + "\n{\"broken\": true}\n", { mode: 0o600 });
		await expect(enumerateCanonicalJsonl(layout)).rejects.toMatchObject({
			name: "JsonlMigrationError",
			code: "unsupported_session_format",
		});
	});
});

describe("R2 JSONL import and archive", () => {
	it("imports, verifies and atomically archives the source without deleting it", async () => {
		const sessionId = createRuntimeId("session", "s1");
		writeFixtureSession("s1", sessionId, standardEntries(sessionId));
		const gate = holdGate();
		try {
			const result = await migrateJsonlSessions({ layout, db, confirmArchive: true }, gate);
			expect(result.importedSessions).toBe(1);
			expect(result.importedEntries).toBe(3);
			expect(result.manifest.verified).toBe(true);
			// source 只归档不删除:原路径不存在,归档路径存在且 digest 一致。
			const archived = readFileSync(join(result.archiveDir, "sessions", "2026", "08", "01", "s1.jsonl"), "utf8");
			expect(archived).toContain(JSON.stringify({ role: "user", content: [{ type: "text", text: "hi" }] }));
			expect(readFileSync(join(result.archiveDir, "manifest.json"), "utf8")).toContain(result.manifest.manifestDigest);
			// SQLite target 可无损重放。
			const store = new SessionStore(db);
			const events = store.replaySessionEvents(sessionId);
			expect(events).toHaveLength(3);
			expect(events[0]?.previousEventHash).toBeNull();
			expect(events[2]?.currentEventHash).toBe(
				sessionEventHash(sessionId, 3, events[2]!.eventId, "tool_result", events[2]!.payloadJson, events[1]!.currentEventHash),
			);
			expect(store.replaySessionEvents(sessionId).length).toBe(3);
		} finally {
			gate.release();
		}
		// gate 释放后 projection 可读。
		expect(new SessionStore(db).projectSession(sessionId).headSequence).toBe(3);
	});

	it("keeps the source in place and the target incomplete when import fails", async () => {
		// 注入失败:两个文件使用同一 sessionId → sessions UNIQUE 冲突 → 整体回滚。
		const sessionId = createRuntimeId("session", "dup");
		writeFixtureSession("s1", sessionId, standardEntries(sessionId));
		writeFixtureSession("s2", sessionId, standardEntries(sessionId));
		const gate = holdGate();
		try {
			await expect(migrateJsonlSessions({ layout, db, confirmArchive: true }, gate)).rejects.toMatchObject({
				name: "JsonlMigrationError",
				code: "import_failed",
			});
			// source 保持原位,target 未标记完成,gate 仍可 abort。
			const s1 = readFileSync(join(layout.sessions, "2026", "08", "01", "s1.jsonl"), "utf8");
			const s2 = readFileSync(join(layout.sessions, "2026", "08", "01", "s2.jsonl"), "utf8");
			expect(s1.split("\n").filter(Boolean)).toHaveLength(4);
			expect(s2.split("\n").filter(Boolean)).toHaveLength(4);
			expect(db.querySingle("SELECT COUNT(*) AS n FROM sessions")?.n).toBe(0);
		} finally {
			gate.release();
		}
	});

	it("refuses to migrate without explicit --confirm-archive", async () => {
		const gate = holdGate();
		await expect(migrateJsonlSessions({ layout, db, confirmArchive: false }, gate)).rejects.toMatchObject({
			code: "confirm_archive_required",
		});
		gate.release();
	});
});

describe("R2 prune-legacy", () => {
	it("deletes the archive only with the manifest and explicit confirmation", async () => {
		const sessionId = createRuntimeId("session", "s1");
		writeFixtureSession("s1", sessionId, standardEntries(sessionId));
		const gate = holdGate();
		let archiveDir: string;
		try {
			const result = await migrateJsonlSessions({ layout, db, confirmArchive: true }, gate);
			archiveDir = result.archiveDir;
		} finally {
			gate.release();
		}
		const digest = archiveDir!.split(sep).pop()!;
		await expect(pruneLegacyArchive({ layout, manifestDigest: digest, confirmDelete: false })).rejects.toMatchObject({
			code: "confirm_archive_required",
		});
		const result = await pruneLegacyArchive({ layout, manifestDigest: digest, confirmDelete: true });
		expect(result.removedFiles).toBe(1);
		await expect(pruneLegacyArchive({ layout, manifestDigest: digest, confirmDelete: true })).rejects.toMatchObject({
			code: "source_read_failed",
		});
	});

	it("refuses deletion when an archived file is missing or tampered", async () => {
		const sessionId = createRuntimeId("session", "s1");
		writeFixtureSession("s1", sessionId, standardEntries(sessionId));
		const gate = holdGate();
		let archiveDir: string;
		try {
			const result = await migrateJsonlSessions({ layout, db, confirmArchive: true }, gate);
			archiveDir = result.archiveDir;
		} finally {
			gate.release();
		}
		rmSync(join(archiveDir!, "sessions"), { recursive: true, force: true });
		const digest = archiveDir!.split(sep).pop()!;
		await expect(pruneLegacyArchive({ layout, manifestDigest: digest, confirmDelete: true })).rejects.toMatchObject({
			code: "verify_failed",
		});
	});
});
