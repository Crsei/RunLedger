/**
 * R6 真实多进程 production composition worker fixture。
 *
 * 与生产使用完全相同的 createEmbeddedSessionRuntime / SessionClient 代码路径,
 * 由 vitest 以真实 `node --import tsx` 进程启动,证明:
 * - 两个进程 attach 同一 Session 观察同一 runtime(健康 owner 即时 attach,
 *   走 SessionClient.openSession 统一 open path,不绕 attachTo);
 * - owner 进程被 kill 后,另一进程经 stale + 3 probes + CAS takeover 进入
 *   RECOVERY_REQUIRED;
 * - 不同 Session 并行 owner;本地 view detach 后 remote attachment 保活,
 *   attachment 归零才 pause/release;
 * - 工具副作用经 attempt gateway 落 started receipt 后崩溃 → takeover barrier
 *   open + 新副作用 spawnCount=0;
 * - 旧 owner 被 fence 后完整 self-stop(server 关闭 + 领域中断 + 客户端断开)。
 *
 * 用法:
 *   node --import tsx runtime-worker.ts <command> <dbPath> <sessionId> <workDir> [jsonArgs]
 * 命令:
 *   setup             安装 schema + 创建 session
 *   claim-only        独立 SQLite connection 做 bounded retry claim 后退出
 *   embedded          createEmbeddedSessionRuntime 并持有到 release 文件出现;
 *                     本地 view detach 后等待 attachment 归零自停
 *   attach            SessionClient.openSession 统一 open(健康 owner 即时 attach)
 *   takeover-deadline createEmbeddedSessionRuntime(deadlineMs),打印 state/generation;
 *                     probeBarrier=true 时验证 barrier 内 gated 写被拒 + spawnCount
 *   crash-after-attempt 经真实 gateway 对阻塞 FIFO 执行 Write;started receipt 落库后
 *                     挂起等待 SIGKILL(不 settle,模拟工具执行中崩溃)
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openSessionDatabase } from "../../../src/storage/session-store/database.ts";
import { installSessionStoreSchema } from "../../../src/storage/session-store/schema.ts";
import { SessionStore } from "../../../src/storage/session-store/session-store.ts";
import { OwnerStore } from "../../../src/storage/session-store/owner-store.ts";
import { SessionClient } from "../../../src/cli/session-client.ts";
import { createEmbeddedSessionRuntime } from "../../../src/cli/embedded-session-runtime.ts";
import { gatedExecutionEnv } from "../../../src/runtime/session-runtime/attempt-gateway.ts";
import { localExecutionEnv } from "../../../src/runtime/execution-env.ts";
import { createRuntimeId, type SessionId } from "../../../src/runtime/protocol/ids.ts";

const [command, dbPath, sessionId, workDir, jsonArgsRaw] = process.argv.slice(2);
const jsonArgs = jsonArgsRaw === undefined ? {} : (JSON.parse(jsonArgsRaw) as Record<string, unknown>);

const out = (value: Record<string, unknown>): void => {
	mkdirSync(workDir, { recursive: true });
	writeFileSync(join(workDir, "result.json"), JSON.stringify(value));
	process.stdout.write(`${JSON.stringify(value)}\n`);
};

function openStores(): { store: SessionStore; ownerStore: OwnerStore } {
	const db = openSessionDatabase(dbPath);
	const installed = db.querySingle("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'schema_meta'");
	if (installed === undefined || Number(installed.n) === 0) {
		installSessionStoreSchema(db);
	}
	return { store: new SessionStore(db), ownerStore: new OwnerStore(db) };
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
	} else if (command === "claim-only") {
		const { store, ownerStore } = openStores();
		const deadline = Date.now() + Number(jsonArgs.deadlineMs ?? 10_000);
		let attempt = 0;
		for (;;) {
			const result = ownerStore.tryClaim({ mode: "fresh", sessionId: sessionId as SessionId }, {
				runtimeId: createRuntimeId("runtime", `claim-${process.pid}`),
				endpoint: { host: "127.0.0.1", port: 30_000 + (process.pid % 20_000) },
				authTokenHex: "a".repeat(64),
				ownerStartedAtMs: Date.now(),
			});
			if (result.ok || !result.retryable || Date.now() >= deadline) {
				out({
					ok: result.ok,
					pid: process.pid,
					attempts: attempt + 1,
					...(result.ok ? { outcome: result.outcome } : { code: result.code }),
				});
				store.database().close();
				process.exit(0);
			}
			attempt += 1;
			await sleep(Math.min(25 * 2 ** attempt, 250));
		}
	} else if (command === "embedded") {
		const { store, ownerStore } = openStores();
		const embedded = await createEmbeddedSessionRuntime({ sessionId: sessionId as SessionId, store, ownerStore });
		if (embedded.runtime === undefined) {
			out({ ok: false, pid: process.pid, code: "attached_not_owner" });
			process.exit(0);
		}
		out({
			ok: true,
			pid: process.pid,
			generation: embedded.owner.currentFence?.generation,
			runtimeState: embedded.runtime.runtimeState,
			port: embedded.server.endpoint?.port,
			attachments: embedded.server.connectionCounts(),
		});
		// reportFence:不等待 release,直接等待被 fence 后的完整 self-stop。
		if (jsonArgs.reportFence === true) {
			const fenceDeadline = Date.now() + Number(jsonArgs.fenceDeadlineMs ?? 15_000);
			while (embedded.runtime.runtimeState !== "fenced" && Date.now() < fenceDeadline) {
				await sleep(50);
			}
			out({
				ok: true,
				pid: process.pid,
				outcome: embedded.runtime.runtimeState === "fenced" ? "fenced" : "not_fenced",
				runtimeState: embedded.runtime.runtimeState,
				fenceCleared: embedded.owner.currentFence === undefined,
				attachments: embedded.server.connectionCounts(),
			});
			process.exit(0);
		}
		// 持有直到 release 文件出现(等待本地 UI detach 信号)。
		const releaseFile = join(workDir, "release");
		const deadline = Date.now() + 30_000;
		while (!existsSync(releaseFile) && Date.now() < deadline) {
			await sleep(50);
		}
		// 模拟 CLI finally:关闭本地 view(不直接 pause)。
		await embedded.handle.close().catch(() => undefined);
		// attachment count 决定 runtime lifetime:归零自停;remote 保活时继续持有。
		const pauseDeadline = Date.now() + Number(jsonArgs.pauseDeadlineMs ?? 30_000);
			while (embedded.runtime.runtimeState !== "stopping" && Date.now() < pauseDeadline) {
				await sleep(50);
			}
			await embedded.runtime.waitForStopped();
		const finalState = embedded.runtime.runtimeState;
		out({
			ok: true,
			pid: process.pid,
			outcome: finalState === "stopping" ? "paused_after_last_attachment" : "still_running",
			runtimeState: finalState,
			attachments: embedded.server.connectionCounts(),
		});
		process.exit(0);
	} else if (command === "attach") {
		const { store, ownerStore } = openStores();
		const client = new SessionClient({
			store,
			ownerStore,
			claimTransport: {
				bindCandidate: async () => {
					throw new Error("attach-only client must not claim");
				},
				closeCandidate: async () => undefined,
				probe: async () => ({ ok: false as const, code: "connect_failed" as const }),
			},
		});
		// 统一 open path:健康 owner 即时 attach,不进入 retry/takeover。
		const opened = await client.openSession(sessionId as SessionId);
		if (!opened.ok) {
			out({ ok: false, pid: process.pid, code: opened.code });
			process.exit(0);
		}
		out({ ok: true, pid: process.pid, outcome: "attached", generation: opened.handle.generation, runtimeId: opened.handle.runtimeId });
		await sleep(Number(jsonArgs.holdMs ?? 1_000));
		await opened.handle.close();
		process.exit(0);
	} else if (command === "takeover-deadline") {
		const { store, ownerStore } = openStores();
		const outcome = await Promise.race([
			createEmbeddedSessionRuntime({ sessionId: sessionId as SessionId, store, ownerStore }),
			sleep(Number(jsonArgs.deadlineMs ?? 10_000)).then(() => ({ timeout: true as const })),
		]);
		if ("timeout" in outcome) {
			out({ ok: false, pid: process.pid, code: "open_timeout" });
			process.exit(0);
		}
		if (outcome.runtime === undefined) {
			out({ ok: false, pid: process.pid, code: "attached_not_owner" });
			process.exit(0);
		}
		// probeBarrier:验证 barrier 内 gated 副作用被拒 + spawnCount=0 + assess 保持 open。
		let gatedRejected = false;
		let spawnCount = outcome.runtime.sideEffectSpawnCount;
		let unresolvedRemaining = 0;
		if (jsonArgs.probeBarrier === true) {
			const gated = gatedExecutionEnv(localExecutionEnv(workDir), () => outcome.runtime, sessionId as SessionId);
			try {
				await gated.fs.writeFile(join(workDir, "barrier-probe.txt"), "x");
			} catch {
				gatedRejected = true;
			}
			spawnCount = outcome.runtime.sideEffectSpawnCount;
			unresolvedRemaining = outcome.runtime.recoveryAssess().unresolvedRemaining;
		}
		out({
			ok: true,
			pid: process.pid,
			generation: outcome.owner.currentFence?.generation,
			runtimeState: outcome.runtime.runtimeState,
			barrierState: outcome.runtime.barrierState,
			gatedRejected,
			spawnCount,
			unresolvedRemaining,
		});
		process.exit(0);
	} else if (command === "crash-after-attempt") {
		const { store, ownerStore } = openStores();
		const embedded = await createEmbeddedSessionRuntime({ sessionId: sessionId as SessionId, store, ownerStore });
		if (embedded.runtime === undefined) {
			out({ ok: false, pid: process.pid, code: "attached_not_owner" });
			process.exit(0);
		}
		// 真实 gateway 路径:对无 reader 的 FIFO 执行 Write —— beginAttempt 已落
		// started receipt,open() 阻塞 → 进程被 SIGKILL 时不会 settle。
		mkdirSync(workDir, { recursive: true });
		const fifo = join(workDir, "gate.fifo");
		try {
			execFileSync("mkfifo", [fifo]);
		} catch {
			out({ ok: false, pid: process.pid, code: "mkfifo_unavailable" });
			process.exit(0);
		}
		const gated = gatedExecutionEnv(localExecutionEnv(workDir), () => embedded.runtime, sessionId as SessionId);
		out({ ok: true, pid: process.pid, generation: embedded.owner.currentFence?.generation, attemptStarted: true });
		// 阻塞直到被 SIGKILL;不 settle,保留 unresolved started receipt。
		await gated.fs.writeFile(fifo, "boom").then(
			() => out({ ok: true, pid: process.pid, outcome: "write_completed_unexpectedly" }),
			() => out({ ok: true, pid: process.pid, outcome: "write_rejected" }),
		);
		process.exit(0);
	} else {
		out({ error: `unknown command: ${command}` });
		process.exit(2);
	}
} catch (error) {
	out({ error: String(error instanceof Error ? error.message : error).slice(0, 300) });
	process.exit(3);
}
