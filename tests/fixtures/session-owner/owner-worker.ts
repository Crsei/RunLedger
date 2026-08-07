/**
 * R3 真实多进程 SessionOwner 测试 worker fixture(06 §5.2 并发证明)。
 *
 * 与生产使用完全相同的 SessionStore / OwnerStore / SessionOwner / TCP
 * transport 代码路径,由 vitest 以真实 `node --import tsx` 进程启动,
 * 用于证明"两个/十个真实进程争抢同一 DB/session 时至多一个 claim 成功"。
 *
 * 用法:
 *   node --import tsx owner-worker.ts <command> <dbPath> <sessionId> <workDir> [jsonArgs]
 *
 * 命令:
 *   setup            安装 schema 并创建 session
 *   claim-single     单次 tryClaim(fresh),打印 claimed/lost
 *   claim-and-hold   open() 成功后持有,直到 <workDir>/release 出现才 release
 *   open-deadline    open() 带 deadlineMs,打印 claimed/attached/timeout
 *   append-old       用旧 generation 尝试 appendEvent,打印错误 code
 *   heartbeat        touchHeartbeat(jsonArgs.fence),打印 ok/fenced
 *   read             打印 owner row projection
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openSessionDatabase } from "../../../src/storage/session-store/database.ts";
import { installSessionStoreSchema } from "../../../src/storage/session-store/schema.ts";
import { SessionStore } from "../../../src/storage/session-store/session-store.ts";
import { OwnerStore } from "../../../src/storage/session-store/owner-store.ts";
import { SessionOwner, type SessionOwnerOptions } from "../../../src/runtime/session-owner/session-owner.ts";
import { createTcpOwnerTransport } from "../../../src/runtime/session-server/owner-probe.ts";
import { createRuntimeId, type RuntimeInstanceId, type SessionId } from "../../../src/runtime/protocol/ids.ts";

const [command, dbPath, sessionId, workDir, jsonArgsRaw] = process.argv.slice(2);
const jsonArgs = jsonArgsRaw === undefined ? {} : (JSON.parse(jsonArgsRaw) as Record<string, unknown>);

const out = (value: Record<string, unknown>): void => {
	mkdirSync(workDir, { recursive: true });
	writeFileSync(join(workDir, "result.json"), JSON.stringify(value));
	process.stdout.write(`${JSON.stringify(value)}\n`);
};

function openStore(): { store: SessionStore; ownerStore: OwnerStore } {
	const db = openSessionDatabase(dbPath);
	const installed = db.querySingle("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'schema_meta'");
	if (installed === undefined || Number(installed.n) === 0) {
		installSessionStoreSchema(db);
	}
	return { store: new SessionStore(db), ownerStore: new OwnerStore(db) };
}

function makeOwner(): SessionOwner {
	const { store, ownerStore } = openStore();
	const options: SessionOwnerOptions = { store, ownerStore, transport: createTcpOwnerTransport() };
	return new SessionOwner(options);
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

try {
	if (command === "setup") {
		const db = openSessionDatabase(dbPath);
		installSessionStoreSchema(db);
		const store = new SessionStore(db);
		store.createSession({
			sessionId: sessionId as SessionId,
			workspaceId: createRuntimeId("workspace", "w"),
			repositoryId: createRuntimeId("repository", "r"),
			settingsDigest: "d".repeat(64),
		});
		db.close();
		out({ ok: true, pid: process.pid });
	} else if (command === "claim-single") {
		const owner = makeOwner();
		const result = await owner.tryClaim({ mode: "fresh", sessionId: sessionId as SessionId });
		if (result.ok) {
			out({ ok: true, pid: process.pid, outcome: result.outcome, generation: result.ok && "fence" in result ? result.fence.generation : undefined });
		} else {
			out({ ok: false, pid: process.pid, code: result.code });
		}
		// candidate listener 仍绑定,显式退出避免事件循环挂起。
		process.exit(0);
	} else if (command === "claim-and-hold") {
		const owner = makeOwner();
		const result = await owner.open(sessionId as SessionId);
		if (!result.ok || result.outcome !== "claimed") {
			out({ ok: false, pid: process.pid, code: result.ok ? "attached" : result.code });
			process.exit(0);
		}
		owner.startHeartbeat();
		out({ ok: true, pid: process.pid, outcome: "claimed", generation: result.fence.generation });
		const releaseFile = join(workDir, "release");
		const deadline = Date.now() + 30_000;
		while (!existsSync(releaseFile) && Date.now() < deadline) {
			await sleep(50);
		}
		owner.stopHeartbeat();
		owner.release("paused");
		out({ ok: true, pid: process.pid, outcome: "released", generation: result.fence.generation });
		process.exit(0);
	} else if (command === "open-deadline") {
		const deadlineMs = Number(jsonArgs.deadlineMs ?? 5_000);
		const owner = makeOwner();
		const outcome = await Promise.race([
			owner.open(sessionId as SessionId),
			sleep(deadlineMs).then(() => ({ ok: false as const, code: "open_timeout", retryable: true })),
		]);
		if (outcome.ok) {
			out({
				ok: true,
				pid: process.pid,
				outcome: outcome.outcome,
				generation: "fence" in outcome ? outcome.fence.generation : outcome.record.generation,
			});
		} else {
			out({ ok: false, pid: process.pid, code: outcome.code });
		}
		process.exit(0);
	} else if (command === "append-old") {
		const { store } = openStore();
		const generation = Number(jsonArgs.generation ?? 1);
		try {
			store.appendEvent(
				{ sessionId: sessionId as SessionId, runtimeId: String(jsonArgs.runtimeId) as RuntimeInstanceId, generation },
				{
					eventId: createRuntimeId("event", `old-writer-${process.pid}`),
					ownerGeneration: generation,
					eventType: "message",
					payloadJson: JSON.stringify({ role: "user", content: "x" }),
					createdAtMs: Date.now(),
					expectedPreviousEventHash: null,
				},
			);
			out({ ok: true, pid: process.pid });
		} catch (error) {
			out({ ok: false, pid: process.pid, code: error instanceof Error && "code" in error ? String((error as { code: unknown }).code) : "unknown", message: error instanceof Error ? error.message.slice(0, 80) : "" });
		}
	} else if (command === "heartbeat") {
		const { ownerStore } = openStore();
		const generation = Number(jsonArgs.generation ?? 1);
		const result = ownerStore.touchHeartbeat(
			{ sessionId: sessionId as SessionId, runtimeId: String(jsonArgs.runtimeId) as RuntimeInstanceId, generation },
			Date.now(),
		);
		out(result.ok ? { ok: true, pid: process.pid } : { ok: false, pid: process.pid, code: result.code });
	} else if (command === "read") {
		const { ownerStore } = openStore();
		const record = ownerStore.readOwner(sessionId as SessionId);
		out({ ok: true, pid: process.pid, record });
	} else {
		out({ error: `unknown command: ${command}` });
		process.exit(2);
	}
} catch (error) {
	out({ error: String(error instanceof Error ? error.message : error).slice(0, 300) });
	process.exit(3);
}
