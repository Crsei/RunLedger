import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildRunledgerLayout, sessionRelativeLocator, type RunledgerLayout } from "../../src/runtime/contracts/public.ts";
import { createRuntimeId } from "../../src/runtime/protocol/ids.ts";
import {
	migrateLegacyData,
} from "../../src/storage/migration.ts";

const cleanup: string[] = [];

afterEach(() => {
	for (const directory of cleanup.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture(): { root: string; source: string; layout: RunledgerLayout } {
	const root = mkdtempSync(join(tmpdir(), "runledger-migration-"));
	cleanup.push(root);
	return {
		root,
		source: join(root, "legacy"),
		layout: buildRunledgerLayout(join(root, "home"), "posix"),
	};
}

function currentSessionBytes(sessionId: string, createdAt: number): string {
	const header = {
		type: "ledger",
		id: "header_legacy",
		createdAt,
		sessionId,
		metadata: { cwd: "/legacy/workspace" },
	};
	const entry = {
		id: "entry_legacy",
		sessionId,
		parentId: "header_legacy",
		timestamp: createdAt,
		type: "custom",
		payload: { kind: "legacy-fixture" },
	};
	return `${JSON.stringify(header)}\n${JSON.stringify(entry)}\n`;
}

describe("destructive legacy migration", () => {
	it("publish→verify→delete 只删除成功发布的 session source", async () => {
		const { source, layout } = fixture();
		await mkdir(source, { recursive: true });
		const createdAt = Date.parse("2026-08-02T12:34:56.000Z");
		const sessionId = createRuntimeId("session", "legacy");
		const sourcePath = join(source, "legacy.jsonl");
		const bytes = currentSessionBytes(sessionId, createdAt);
		await writeFile(sourcePath, bytes, "utf8");
		await writeFile(join(source, "keep.txt"), "not in manifest", "utf8");

		const result = await migrateLegacyData({ layout, sourcePath, confirmDelete: true });
		const target = join(layout.home, sessionRelativeLocator(sessionId, new Date(createdAt).toISOString(), false));

		expect(result.items).toHaveLength(1);
		expect(result.items[0]).toMatchObject({ status: "source_deleted", sourcePath, targetPath: target });
		expect(existsSync(sourcePath)).toBe(false);
		expect(existsSync(join(source, "keep.txt"))).toBe(true);
		expect(readFileSync(target, "utf8")).toBe(bytes);
		expect(existsSync(result.manifestPath)).toBe(true);
		expect(existsSync(result.receiptPath)).toBe(true);
	});

	it("settings source 去除 sessionDir 后发布到 canonical settings 并删除 source", async () => {
		const { source, layout } = fixture();
		await mkdir(source, { recursive: true });
		const sourcePath = join(source, "settings.json");
		await writeFile(sourcePath, JSON.stringify({ model: "legacy", sessionDir: "/outside", unknown: true }), "utf8");

		const result = await migrateLegacyData({ layout, sourcePath, confirmDelete: true });
		expect(result.items[0]).toMatchObject({ status: "source_deleted", targetPath: layout.settings });
		expect(JSON.parse(await readFile(layout.settings, "utf8"))).toEqual({ model: "legacy" });
		expect(existsSync(sourcePath)).toBe(false);
	});

	it("directory source 只迁移已知 auth/AGENTS 文件，保留插件等无关文件", async () => {
		const { source, layout } = fixture();
		await mkdir(join(source, "sessions"), { recursive: true });
		const authPath = join(source, "auth.json");
		const agentsPath = join(source, "AGENTS.md");
		await writeFile(authPath, JSON.stringify({ fixture: { type: "api_key", key: "secret" } }), "utf8");
		await writeFile(agentsPath, "legacy instructions\n", "utf8");
		await writeFile(join(source, "plugin.js"), "do not touch", "utf8");

		const result = await migrateLegacyData({ layout, sourcePath: source, confirmDelete: true });
		expect(result.items.map((item) => item.objectKind).sort()).toEqual(["agents", "auth"]);
		expect(existsSync(authPath)).toBe(false);
		expect(existsSync(agentsPath)).toBe(false);
		expect(existsSync(join(source, "plugin.js"))).toBe(true);
		expect(JSON.parse(await readFile(layout.auth, "utf8"))).toEqual({ fixture: { type: "api_key", key: "secret" } });
		expect(await readFile(layout.agents, "utf8")).toBe("legacy instructions\n");
	});

	it("未确认时拒绝执行且 source bytes 不变", async () => {
		const { source, layout } = fixture();
		await mkdir(source, { recursive: true });
		const sourcePath = join(source, "settings.json");
		await writeFile(sourcePath, JSON.stringify({ model: "legacy" }), "utf8");
		const original = readFileSync(sourcePath, "utf8");

		await expect(migrateLegacyData({ layout, sourcePath, confirmDelete: false })).rejects.toMatchObject({
			code: "confirmation_required",
		});
		expect(readFileSync(sourcePath, "utf8")).toBe(original);
	});

	it("目标同 session ID 但 digest 不同则冲突停止，不覆盖或删除 source", async () => {
		const { source, layout } = fixture();
		await mkdir(source, { recursive: true });
		const createdAt = Date.parse("2026-08-02T12:34:56.000Z");
		const sessionId = createRuntimeId("session", "conflict");
		const sourcePath = join(source, "conflict.jsonl");
		const bytes = currentSessionBytes(sessionId, createdAt);
		await writeFile(sourcePath, bytes, "utf8");
		const target = join(layout.home, sessionRelativeLocator(sessionId, new Date(createdAt).toISOString(), false));
		await mkdir(join(layout.home, "sessions", "2026", "08", "02"), { recursive: true });
		await writeFile(target, bytes.replace("legacy-fixture", "existing-target"), "utf8");
		const originalTarget = readFileSync(target, "utf8");

		await expect(migrateLegacyData({ layout, sourcePath, confirmDelete: true })).rejects.toMatchObject({
			code: "conflict",
		});
		expect(readFileSync(sourcePath, "utf8")).toBe(bytes);
		expect(readFileSync(target, "utf8")).toBe(originalTarget);
	});

	it("相同 target digest 不重写目标，但仍按 manifest 删除重复 source", async () => {
		const { source, layout } = fixture();
		await mkdir(source, { recursive: true });
		const createdAt = Date.parse("2026-08-02T12:34:56.000Z");
		const sessionId = createRuntimeId("session", "dedupe");
		const bytes = currentSessionBytes(sessionId, createdAt);
		const target = join(layout.home, sessionRelativeLocator(sessionId, new Date(createdAt).toISOString(), false));
		await mkdir(join(layout.home, "sessions", "2026", "08", "02"), { recursive: true });
		await writeFile(target, bytes, "utf8");
		const sourcePath = join(source, "duplicate.jsonl");
		await writeFile(sourcePath, bytes, "utf8");

		const result = await migrateLegacyData({ layout, sourcePath, confirmDelete: true });
		const manifest = JSON.parse(readFileSync(result.manifestPath, "utf8")) as { items: Array<Record<string, unknown>> };
		expect(result.items[0]?.status).toBe("deduplicated_and_deleted");
		expect(manifest.items[0]).toMatchObject({ requestedDeleteAction: "delete_source", targetLocator: "sessions/2026/08/02/session_dedupe.jsonl" });
		expect(String(manifest.items[0]?.targetLocator)).not.toContain(layout.home);
		expect(existsSync(sourcePath)).toBe(false);
	});

	it("损坏或 unknown session format 不 fallback，source 保持不变", async () => {
		const { source, layout } = fixture();
		await mkdir(source, { recursive: true });
		const sourcePath = join(source, "broken.jsonl");
		await writeFile(sourcePath, "{ broken\n", "utf8");

		await expect(migrateLegacyData({ layout, sourcePath, confirmDelete: true })).rejects.toMatchObject({
			code: "rejected",
		});
		expect(existsSync(sourcePath)).toBe(true);
		expect(await stat(sourcePath)).toBeTruthy();
	});

	it("TOCTOU source digest 改变时停止且不删除 source", async () => {
		const { source, layout } = fixture();
		await mkdir(source, { recursive: true });
		const sourcePath = join(source, "settings.json");
		await writeFile(sourcePath, JSON.stringify({ model: "before" }), "utf8");

		await expect(migrateLegacyData({
			layout,
			sourcePath,
			confirmDelete: true,
			beforeDelete: async () => writeFile(sourcePath, JSON.stringify({ model: "changed" }), "utf8"),
		})).rejects.toMatchObject({ code: "source_changed" });
		expect(existsSync(sourcePath)).toBe(true);
		expect(existsSync(layout.settings)).toBe(false);
	});

	it("source 删除后 receipt 写入失败时不恢复已删除 source", async () => {
		const { source, layout } = fixture();
		await mkdir(source, { recursive: true });
		const sourcePath = join(source, "settings.json");
		await writeFile(sourcePath, JSON.stringify({ model: "before" }), "utf8");

		await expect(migrateLegacyData({
			layout,
			sourcePath,
			confirmDelete: true,
			afterDelete: () => { throw new Error("receipt sink failed"); },
		})).rejects.toMatchObject({ code: "receipt_failed" });
		expect(existsSync(sourcePath)).toBe(false);
		expect(JSON.parse(readFileSync(layout.settings, "utf8"))).toEqual({ model: "before" });
	});
});
