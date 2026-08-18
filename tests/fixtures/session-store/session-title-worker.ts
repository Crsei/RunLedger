/**
 * P5 title CAS worker:每个 worker 打开自己的 SQLite connection,在同一
 * start barrier 后提交一个 auto title。这个 fixture 不绕过 SessionStore,
 * 用于证明跨进程的 BEGIN IMMEDIATE + unnamed-session CAS 只有一个 winner。
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openSessionDatabase } from "../../../src/storage/session-store/database.ts";
import { SessionStore } from "../../../src/storage/session-store/session-store.ts";
import type { OwnerFence } from "../../../src/runtime/session-owner/types.ts";

const [command, dbPath, sessionId, workDir, jsonArgsRaw] = process.argv.slice(2);
const jsonArgs = jsonArgsRaw === undefined ? {} : (JSON.parse(jsonArgsRaw) as Record<string, unknown>);

function out(value: Record<string, unknown>): void {
	mkdirSync(workDir ?? ".", { recursive: true });
	writeFileSync(join(workDir ?? ".", `result-${process.pid}.json`), JSON.stringify(value));
	process.stdout.write(`${JSON.stringify(value)}\n`);
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

try {
	if (command !== "auto-title") {
		out({ ok: false, code: "unknown_command" });
		process.exit(2);
	}

	const db = openSessionDatabase(dbPath);
	const store = new SessionStore(db);
	const readyFile = String(jsonArgs.readyFile);
	const startFile = String(jsonArgs.startFile);
	writeFileSync(readyFile, String(process.pid));
	while (!existsSync(startFile)) await sleep(10);

	const fence: OwnerFence = {
		sessionId: sessionId as OwnerFence["sessionId"],
		runtimeId: String(jsonArgs.runtimeId) as OwnerFence["runtimeId"],
		generation: Number(jsonArgs.generation),
	};
	try {
		const titled = store.setTitle(fence, {
			title: String(jsonArgs.title),
			source: "auto",
			trigger: "first-user-message",
			expectedTitle: null,
		});
		out({ ok: true, pid: process.pid, title: titled.title });
	} catch (error) {
		const candidate = error as { readonly code?: unknown; readonly message?: unknown };
		out({
			ok: false,
			pid: process.pid,
			code: typeof candidate.code === "string" ? candidate.code : "unknown",
			message: typeof candidate.message === "string" ? candidate.message.slice(0, 160) : "",
		});
	}
	db.close();
} catch (error) {
	out({ ok: false, code: "worker_error", message: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300) });
	process.exit(3);
}
