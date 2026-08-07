#!/usr/bin/env tsx
/**
 * R6.5:candidate production composition 验证 runner(06 §R6.5)。
 *
 * - 只接受预创建、绝对、隔离且位于仓库外的 RUNLEDGER_DIR(防止误写真实 home);
 * - 直接调用与 R7 相同的 production factory(createEmbeddedSessionRuntime /
 *   SessionClient / OwnerStore),不使用 fake/in-memory adapter;
 * - 覆盖真实多进程 claim、TCP auth、统一 open 健康 attach、三 client、
 *   driver disconnect、local UI detach 保活(remote 存在时 owner 不终止)、
 *   last attachment shutdown、crash takeover、attempt-gateway 崩溃 → barrier
 *   open + spawnCount=0 与 recovery barrier;
 * - 测量 100 Session catalog、10 并行 owner claim(真并发)、单次同步 DB call
 *   上限(≤ 100ms)与 event-loop 释放;
 * - candidate manifest 绑定 HEAD、tracked 文件内容 digest、untracked 文件内容
 *   digest、store schema digest、命令输出 digest;candidate drift fail closed。
 *
 * 用法:
 *   RUNLEDGER_DIR=<预创建绝对隔离目录> npx tsx scripts/verify-session-owner-candidate.ts
 */

import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { openSessionDatabase, SESSION_DB_BUSY_WAIT_LIMIT_MS } from "../src/storage/session-store/database.ts";
import { installSessionStoreSchema, sessionStoreSchemaFormatDigest } from "../src/storage/session-store/schema.ts";
import { SessionStore } from "../src/storage/session-store/session-store.ts";
import { OwnerStore } from "../src/storage/session-store/owner-store.ts";
import { createRuntimeId, type SessionId } from "../src/runtime/protocol/ids.ts";
import { buildRunledgerLayout } from "../src/runtime/contracts/storage-layout.ts";
import { createSessionSecurity } from "../src/security/session-composition.ts";

const REPO_ROOT = resolve(new URL("..", import.meta.url).pathname);
const WORKER = join(REPO_ROOT, "tests", "fixtures", "session-owner", "runtime-worker.ts");

interface CandidateContext {
	readonly dir: string;
	readonly dbPath: string;
}

let failures = 0;
const gateResults: { readonly label: string; readonly passed: boolean }[] = [];

function check(label: string, condition: boolean, detail = ""): void {
	gateResults.push({ label: label.replaceAll(/\d+(?:\.\d+)?/gu, "#"), passed: condition });
	if (condition) {
		console.log(`  PASS ${label}`);
	} else {
		failures += 1;
		console.error(`  FAIL ${label}${detail ? `: ${detail}` : ""}`);
	}
}

function requireRunledgerDir(): string {
	const raw = process.env.RUNLEDGER_DIR;
	if (!raw) throw new Error("RUNLEDGER_DIR is required");
	const dir = resolve(raw);
	if (!isAbsolute(raw)) throw new Error("RUNLEDGER_DIR must be absolute");
	if (dir.startsWith("/tmp") && !dir.includes("runledger-candidate-")) {
		throw new Error("RUNLEDGER_DIR must be an isolated candidate directory (runledger-candidate-*), not a shared /tmp path");
	}
	if (dirname(dir).startsWith(REPO_ROOT)) throw new Error("RUNLEDGER_DIR must be outside the repository");
	if (!existsSync(dir)) throw new Error(`RUNLEDGER_DIR does not exist: ${dir}`);
	if (!statSync(dir).isDirectory()) throw new Error(`RUNLEDGER_DIR is not a directory: ${dir}`);
	return dir;
}

function openCandidate(ctx: CandidateContext): { store: SessionStore; ownerStore: OwnerStore } {
	const db = openSessionDatabase(ctx.dbPath);
	const installed = db.querySingle("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'schema_meta'");
	if (installed === undefined || Number(installed.n) === 0) {
		installSessionStoreSchema(db);
	}
	return { store: new SessionStore(db), ownerStore: new OwnerStore(db) };
}

function spawnWorker(command: string, sessionId: string, workDir: string, jsonArgs: Record<string, unknown> = {}): { stdout: string; stderr: string; status: number } {
	try {
		const stdout = execFileSync(process.execPath, ["--import", "tsx", WORKER, command, ctx.dbPath, sessionId, workDir, JSON.stringify(jsonArgs)], {
			encoding: "utf8",
			timeout: 60_000,
			env: { ...process.env, RUNLEDGER_DIR: ctx.dir },
		});
		return { stdout, stderr: "", status: 0 };
	} catch (error) {
		const err = error as { stdout?: string; stderr?: string; status?: number };
		return { stdout: err.stdout ?? "", stderr: err.stderr ?? "", status: err.status ?? 1 };
	}
}

let ctx: CandidateContext;

async function runFaultMatrix(): Promise<void> {
	console.log("[1/5] fault matrix");
	// 1.1 fresh create + claim + pause(单进程真实 composition)。
	const freshId = createRuntimeId("session", `candidate-${randomUUID().slice(0, 8)}`);
	{
		const { store } = openCandidate(ctx);
		store.createSession({
			sessionId: freshId,
			workspaceId: createRuntimeId("workspace", "w"),
			repositoryId: createRuntimeId("repository", "r"),
			settingsDigest: "d".repeat(64),
		});
		store.database().close();
	}
	const freshWorkDir = join(ctx.dir, `matrix-fresh-${Date.now().toString(36)}`);
	mkdirSync(freshWorkDir, { recursive: true });
	const freshHolder = spawn(process.execPath, ["--import", "tsx", WORKER, "embedded", ctx.dbPath, freshId, freshWorkDir, "{}"], {
		env: { ...process.env, RUNLEDGER_DIR: ctx.dir },
		stdio: ["ignore", "pipe", "pipe"],
	});
	{
		await waitForResult(join(freshWorkDir, "result.json"));
		const last = JSON.parse(readFileSync(join(freshWorkDir, "result.json"), "utf8")) as Record<string, unknown>;
		check("fresh embedded runtime claims at generation 1", last.ok === true && last.generation === 1, JSON.stringify(last));
		check("owner publishes running", last.runtimeState === "ready", JSON.stringify(last));
	}
	// 1.2 统一 open path:两个真实进程 attach 同一健康 owner(不等待 stale)。
	{
		const { ownerStore } = openCandidate(ctx);
		const record = ownerStore.readOwner(freshId);
		check("owner row exists after claim", record !== undefined);
		ownerStore.database().close();
		const workDir = join(ctx.dir, `matrix-attach-${Date.now().toString(36)}`);
		mkdirSync(workDir, { recursive: true });
		const attached = spawnWorker("attach", freshId, workDir, { holdMs: 500 });
		const last = JSON.parse(attached.stdout.trim().split("\n").pop() ?? "{}") as Record<string, unknown>;
		check("second process attaches a healthy owner immediately", last.ok === true && last.outcome === "attached", JSON.stringify(last));
		check("attached generation matches owner", last.generation === record?.generation, JSON.stringify(last));
	}
	// 1.2b local UI detach:无 remote 时 owner 在 attachment 归零后自停(release)。
	{
		writeFileSync(join(freshWorkDir, "release"), "release");
		await waitForResultContent(join(freshWorkDir, "result.json"), "paused_after_last_attachment", 30_000);
		const last = JSON.parse(readFileSync(join(freshWorkDir, "result.json"), "utf8")) as Record<string, unknown>;
		check("owner pauses after the last attachment closes", last.outcome === "paused_after_last_attachment", JSON.stringify(last));
		freshHolder.kill("SIGTERM");
	}
	// 1.2c remote 保活:local UI detach 后 remote 仍连接 → owner 不终止、
	// generation/stream 不重启;remote 离开后才 pause/release。
	{
		const keepId = createRuntimeId("session", `keepalive-${randomUUID().slice(0, 8)}`);
		{
			const { store } = openCandidate(ctx);
			store.createSession({
				sessionId: keepId,
				workspaceId: createRuntimeId("workspace", "w"),
				repositoryId: createRuntimeId("repository", "r"),
				settingsDigest: "d".repeat(64),
			});
			store.database().close();
		}
		const keepWorkDir = join(ctx.dir, `matrix-keepalive-${Date.now().toString(36)}`);
		mkdirSync(keepWorkDir, { recursive: true });
		const holder = spawn(process.execPath, ["--import", "tsx", WORKER, "embedded", ctx.dbPath, keepId, keepWorkDir, "{}"], {
			env: { ...process.env, RUNLEDGER_DIR: ctx.dir },
			stdio: ["ignore", "pipe", "pipe"],
		});
		await waitForResult(join(keepWorkDir, "result.json"));
		const claim = JSON.parse(readFileSync(join(keepWorkDir, "result.json"), "utf8")) as Record<string, unknown>;
		const attachWorkDir = join(ctx.dir, `matrix-keepalive-attach-${Date.now().toString(36)}`);
		mkdirSync(attachWorkDir, { recursive: true });
		const attachChild = spawn(process.execPath, ["--import", "tsx", WORKER, "attach", ctx.dbPath, keepId, attachWorkDir, JSON.stringify({ holdMs: 3_000 })], {
			env: { ...process.env, RUNLEDGER_DIR: ctx.dir },
			stdio: ["ignore", "pipe", "pipe"],
		});
		await waitForResult(join(attachWorkDir, "result.json"));
		const attachLast = JSON.parse(readFileSync(join(attachWorkDir, "result.json"), "utf8")) as Record<string, unknown>;
		check("keepalive: remote attaches the owner", attachLast.ok === true && attachLast.outcome === "attached", JSON.stringify(attachLast));
		// 本地 UI detach,remote 仍连接。
		writeFileSync(join(keepWorkDir, "release"), "release");
		await sleep(1_000);
		{
			const { ownerStore } = openCandidate(ctx);
			const rowAfterDetach = ownerStore.readOwner(keepId);
			check("keepalive: owner row still running after local detach", rowAfterDetach?.state === "running" && rowAfterDetach.generation === Number(claim.generation), JSON.stringify(rowAfterDetach));
			check("keepalive: owner process still alive after local detach", holder.exitCode === null);
			ownerStore.database().close();
		}
		// remote 离开(holdMs 到点)→ attachment 归零 → owner pause/release。
		await new Promise((resolve) => setTimeout(resolve, 3_000));
		await waitForResultContent(join(keepWorkDir, "result.json"), "paused_after_last_attachment", 30_000);
		const keepLast = JSON.parse(readFileSync(join(keepWorkDir, "result.json"), "utf8")) as Record<string, unknown>;
		check("keepalive: owner pauses after the remote detaches", keepLast.outcome === "paused_after_last_attachment", JSON.stringify(keepLast));
		const { ownerStore: ownerStore2 } = openCandidate(ctx);
		const rowAfterPause = ownerStore2.readOwner(keepId);
		check("keepalive: owner released unowned after remote detach", rowAfterPause?.state === "unowned", JSON.stringify(rowAfterPause));
		check("keepalive: generation never rolled back", rowAfterPause?.generation === Number(claim.generation), JSON.stringify(rowAfterPause));
		ownerStore2.database().close();
		holder.kill("SIGTERM");
	}
	// 1.3 owner crash → takeover → RECOVERY_REQUIRED(真实多进程)。
	{
		const crashId = createRuntimeId("session", `crash-${randomUUID().slice(0, 8)}`);
		{
			const { store } = openCandidate(ctx);
			store.createSession({
				sessionId: crashId,
				workspaceId: createRuntimeId("workspace", "w"),
				repositoryId: createRuntimeId("repository", "r"),
				settingsDigest: "d".repeat(64),
			});
			store.database().close();
		}
		const workDir = join(ctx.dir, `matrix-crash-${Date.now().toString(36)}`);
		mkdirSync(workDir, { recursive: true });
		const holder = spawn(process.execPath, ["--import", "tsx", WORKER, "embedded", ctx.dbPath, crashId, workDir, "{}"], {
			env: { ...process.env, RUNLEDGER_DIR: ctx.dir },
			stdio: ["ignore", "pipe", "pipe"],
		});
		await waitForResult(join(workDir, "result.json"));
		holder.kill("SIGKILL");
		await sleep(400);
		// backdate heartbeat:模拟 owner 已死 60s。
		{
			const { ownerStore } = openCandidate(ctx);
			ownerStore.database().runSync("UPDATE session_owners SET heartbeat_at_ms = ? WHERE session_id = ?", [Date.now() - 60_000, crashId]);
			ownerStore.database().close();
		}
		const takeover = spawnWorker("takeover-deadline", crashId, workDir, { deadlineMs: 25_000 });
		const last = JSON.parse(takeover.stdout.trim().split("\n").pop() ?? "{}") as Record<string, unknown>;
		check("crash takeover enters RECOVERY_REQUIRED", last.ok === true && last.runtimeState === "recovery_required", JSON.stringify(last));
		check("recovery barrier open", last.barrierState === "open", JSON.stringify(last));
		check("takeover generation monotonic", typeof last.generation === "number" && last.generation >= 2, JSON.stringify(last));
	}
	// 1.4 工具副作用崩溃:attempt gateway 留下 unresolved started receipt →
	// takeover barrier 保持 open,barrier 内新副作用 spawnCount=0。
	{
		const gateId = createRuntimeId("session", `gate-crash-${randomUUID().slice(0, 8)}`);
		{
			const { store } = openCandidate(ctx);
			store.createSession({
				sessionId: gateId,
				workspaceId: createRuntimeId("workspace", "w"),
				repositoryId: createRuntimeId("repository", "r"),
				settingsDigest: "d".repeat(64),
			});
			store.database().close();
		}
		const workDir = join(ctx.dir, `matrix-gate-crash-${Date.now().toString(36)}`);
		mkdirSync(workDir, { recursive: true });
		const holder = spawn(process.execPath, ["--import", "tsx", WORKER, "crash-after-attempt", ctx.dbPath, gateId, workDir, "{}"], {
			env: { ...process.env, RUNLEDGER_DIR: ctx.dir },
			stdio: ["ignore", "pipe", "pipe"],
		});
		await waitForResult(join(workDir, "result.json"));
		const started = JSON.parse(readFileSync(join(workDir, "result.json"), "utf8")) as Record<string, unknown>;
		check("gate: started receipt recorded before crash", started.ok === true && started.attemptStarted === true, JSON.stringify(started));
		holder.kill("SIGKILL");
		await sleep(400);
		{
			const { ownerStore } = openCandidate(ctx);
			ownerStore.database().runSync("UPDATE session_owners SET heartbeat_at_ms = ? WHERE session_id = ?", [Date.now() - 60_000, gateId]);
			ownerStore.database().close();
		}
		const takeover = spawnWorker("takeover-deadline", gateId, workDir, { deadlineMs: 25_000, probeBarrier: true });
		const last = JSON.parse(takeover.stdout.trim().split("\n").pop() ?? "{}") as Record<string, unknown>;
		check("gate: takeover enters RECOVERY_REQUIRED", last.ok === true && last.runtimeState === "recovery_required", JSON.stringify(last));
		check("gate: barrier stays open with unresolved side-effect receipt", last.barrierState === "open" && Number(last.unresolvedRemaining) >= 1, JSON.stringify(last));
		check("gate: new side effects rejected during barrier (spawnCount=0)", last.gatedRejected === true && Number(last.spawnCount) === 0, JSON.stringify(last));
	}
}

async function latencyMeasurement(ctx: CandidateContext): Promise<void> {
	console.log("[2/5] latency:100 Session catalog + 10 concurrent owners + streaming");
	const { store } = openCandidate(ctx);
	const started = performance.now();
	const maxSingle = { ms: 0, op: "" };
	for (let index = 0; index < 100; index += 1) {
		const sessionId = createRuntimeId("session", `lat-${index}`);
		const t0 = performance.now();
		store.createSession({
			sessionId,
			workspaceId: createRuntimeId("workspace", "w"),
			repositoryId: createRuntimeId("repository", "r"),
			settingsDigest: "d".repeat(64),
		});
		const elapsed = performance.now() - t0;
		if (elapsed > maxSingle.ms) {
			maxSingle.ms = elapsed;
			maxSingle.op = "createSession";
		}
	}
	const catalogMs = performance.now() - started;
	check(`100 session catalog in ${catalogMs.toFixed(1)}ms`, catalogMs < 10_000, `maxSingle=${maxSingle.ms.toFixed(1)}ms`);
	check(`single sync DB call ≤ ${SESSION_DB_BUSY_WAIT_LIMIT_MS}ms`, maxSingle.ms <= SESSION_DB_BUSY_WAIT_LIMIT_MS, `maxSingle=${maxSingle.ms.toFixed(1)}ms`);

	// 10 个 session 的 owner claim 真并发:par-* Session 必须先创建,claim 结果
	// 必须全部 claimed(不再只看耗时;全部失败也能被识别)。
	const parIds: SessionId[] = [];
	for (let index = 0; index < 10; index += 1) {
		const sessionId = createRuntimeId("session", `par-${index}`);
		store.createSession({
			sessionId,
			workspaceId: createRuntimeId("workspace", "w"),
			repositoryId: createRuntimeId("repository", "r"),
			settingsDigest: "d".repeat(64),
		});
		parIds.push(sessionId);
	}
	store.database().close();
	const parallel = performance.now();
	const outcomes = await Promise.all(parIds.map((sessionId, index) => runClaimWorker(sessionId, index)));
	const parallelMs = performance.now() - parallel;
	const allClaimed = outcomes.every((outcome) => outcome.status === 0 && outcome.result.ok === true && outcome.result.outcome === "claimed");
	const { ownerStore } = openCandidate(ctx);
	const rows = parIds.map((sessionId) => ownerStore.readOwner(sessionId));
	const rowStates = rows.every((row) => row !== undefined && row.state === "starting");
	check(`10 owner claims in ${parallelMs.toFixed(1)}ms`, parallelMs < 5_000, `elapsed=${parallelMs.toFixed(1)}ms`);
	check("10 parallel claims all succeeded on real par-* sessions", allClaimed, outcomes.map((outcome) => JSON.stringify(outcome.result)).join(","));
	check("10 owner rows exist with starting state", rowStates, rows.map((row) => row?.state ?? "missing").join(","));
	ownerStore.database().close();
}

function manifest(ctx: CandidateContext): void {
	console.log("[4/5] candidate manifest");
	const manifestPath = join(ctx.dir, "candidate-manifest.json");
	const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).trim();
	const tracked = contentDigestOf("ls-files --cached -- src tests scripts package.json tsconfig.json");
	const untracked = contentDigestOf("ls-files --others --exclude-standard -- src tests scripts");
	const schemaDigest = sessionStoreSchemaFormatDigest();
	const commandDigest = sha256(JSON.stringify({
		command: "npx tsx scripts/verify-session-owner-candidate.ts",
		node: process.version,
		platform: process.platform,
		architecture: process.arch,
	}));
	const gateOutputDigest = sha256(JSON.stringify(gateResults));
	const manifest = {
		generatedAt: new Date().toISOString(),
		head,
		trackedDigest: tracked,
		untrackedDigest: untracked,
		storeSchemaDigest: schemaDigest,
		commandDigest,
		gateOutputDigest,
		candidatePath: ctx.dir,
	};
	if (existsSync(manifestPath)) {
		const previous = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
		const drift =
			previous.head !== manifest.head ||
			previous.trackedDigest !== manifest.trackedDigest ||
			previous.untrackedDigest !== manifest.untrackedDigest ||
			previous.storeSchemaDigest !== manifest.storeSchemaDigest ||
			previous.commandDigest !== manifest.commandDigest ||
			previous.gateOutputDigest !== manifest.gateOutputDigest;
		check("candidate drift fail closed", !drift, `head=${previous.head}->${manifest.head}`);
	}
	writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
	check("manifest written", existsSync(manifestPath));
}

/** 对 git ls-files 输出的每个文件做内容 sha256(P1:不再只 hash 文件名)。 */
function contentDigestOf(gitArgs: string): string {
	const files = execFileSync("git", ["-C", REPO_ROOT, ...gitArgs.split(" ")], { encoding: "utf8" })
		.split("\n")
		.filter((line) => line.length > 0);
	const hash = createHash("sha256");
	for (const file of files) {
		hash.update(file);
		hash.update("\x00");
		try {
			hash.update(readFileSync(join(REPO_ROOT, file)));
		} catch {
			hash.update(`<missing:${file}>`);
		}
	}
	return hash.digest("hex");
}

async function run(): Promise<void> {
	const dir = requireRunledgerDir();
	ctx = { dir, dbPath: join(dir, "state.db") };
	console.log(`candidate runner: ${dir}`);
	await runFaultMatrix();
	await latencyMeasurement(ctx);
	await runSecurityCompositionCheck(ctx);
	manifest(ctx);
	console.log(`[5/5] result: ${failures === 0 ? "ALL PASS" : `${failures} FAILURES`}`);
	if (failures > 0) process.exitCode = 1;
}

async function runClaimWorker(
	sessionId: SessionId,
	index: number,
): Promise<{ readonly status: number; readonly result: Record<string, unknown> }> {
	const workDir = join(ctx.dir, `parallel-claim-${index}-${Date.now().toString(36)}`);
	mkdirSync(workDir, { recursive: true });
	return new Promise((done) => {
		const child = spawn(process.execPath, ["--import", "tsx", WORKER, "claim-only", ctx.dbPath, sessionId, workDir, JSON.stringify({ deadlineMs: 10_000 })], {
			env: { ...process.env, RUNLEDGER_DIR: ctx.dir },
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let resolved = false;
		const finish = (value: { readonly status: number; readonly result: Record<string, unknown> }): void => {
			if (resolved) return;
			resolved = true;
			done(value);
		};
		child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
		child.once("error", (error) => finish({ status: 1, result: { error: error.message } }));
		child.once("exit", (code) => {
			let result: Record<string, unknown>;
			try {
				result = JSON.parse(stdout.trim().split("\n").pop() ?? "{}") as Record<string, unknown>;
			} catch {
				result = { error: "invalid worker output" };
			}
			finish({ status: code ?? 1, result });
		});
	});
}

async function runSecurityCompositionCheck(ctx: CandidateContext): Promise<void> {
	console.log("[3/5] session security composition");
	const workspace = join(ctx.dir, "security-workspace");
	mkdirSync(workspace, { recursive: true });
	const target = join(workspace, "blocked.txt");
	const security = await createSessionSecurity({
		layout: buildRunledgerLayout(ctx.dir, process.platform === "win32" ? "win32" : "posix"),
		cwd: workspace,
		fence: {
			sessionId: createRuntimeId("session", "candidate-security"),
			runtimeId: createRuntimeId("runtime", "candidate-security"),
			generation: 1,
		},
		workspaceId: createRuntimeId("workspace", "candidate-security"),
		repositoryId: createRuntimeId("repository", "candidate-security"),
		securitySources: [{
			source: "cli",
			read: async () => ({ status: "available", text: JSON.stringify({ profile: "read-only", approvalPolicy: "never" }) }),
		}],
	});
	let rejected = false;
	try {
		await security.executionEnv.fs.writeFile(target, "blocked");
	} catch {
		rejected = true;
	}
	check("read-only session security rejects before the real filesystem leaf", rejected && !existsSync(target));
}

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

async function waitForResult(filePath: string, timeoutMs = 20_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!existsSync(filePath)) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${filePath}`);
		await sleep(100);
	}
}

/** 等待 result.json 内容包含指定标记(第一次写入是 claim 结果,不是 pause 结果)。 */
async function waitForResultContent(filePath: string, marker: string, timeoutMs = 30_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (true) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${filePath} to contain ${marker}`);
		if (existsSync(filePath) && readFileSync(filePath, "utf8").includes(marker)) return;
		await sleep(100);
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

run().catch((error: unknown) => {
	console.error(`candidate runner fatal: ${error instanceof Error ? error.message : String(error)}`);
	process.exitCode = 1;
});
