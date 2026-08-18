import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rmSyncRetry } from "../../helpers/cleanup.ts";
import { createRuntimeId, type SessionId } from "../../../src/runtime/protocol/ids.ts";
import { openSessionDatabase } from "../../../src/storage/session-store/database.ts";
import { OwnerStore } from "../../../src/storage/session-store/owner-store.ts";
import { installSessionStoreSchema } from "../../../src/storage/session-store/schema.ts";
import { SessionStore } from "../../../src/storage/session-store/session-store.ts";

const WORKER = fileURLToPath(new URL("../../fixtures/session-store/session-title-worker.ts", import.meta.url));

let directory: string;

beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "session-title-multi-connection-"));
});

afterEach(() => {
	rmSyncRetry(directory);
});

function setupOwnedSession(): { readonly dbPath: string; readonly sessionId: SessionId; readonly runtimeId: string } {
	const dbPath = join(directory, "state.db");
	const db = openSessionDatabase(dbPath);
	installSessionStoreSchema(db);
	const store = new SessionStore(db);
	const sessionId = createRuntimeId("session", "title-multi-connection");
	const runtimeId = createRuntimeId("runtime", "title-multi-connection");
	store.createSession({
		sessionId,
		workspaceId: createRuntimeId("workspace", "title-multi-connection"),
		repositoryId: createRuntimeId("repository", "title-multi-connection"),
		settingsDigest: "d".repeat(64),
	});
	db.runSync(
		"INSERT INTO session_owners (session_id, runtime_id, generation, state, updated_at_ms) VALUES (?, ?, 1, 'running', 1)",
		[sessionId, runtimeId],
	);
	db.close();
	return { dbPath, sessionId, runtimeId };
}

function spawnWorker(
	command: string,
	args: Record<string, unknown>,
): { readonly child: ChildProcess; readonly stdout: () => string; readonly stderr: () => string } {
	const child = spawn(process.execPath, ["--import", "tsx", WORKER, command, join(directory, "state.db"), args.sessionId as string, directory, JSON.stringify(args)], {
		stdio: ["ignore", "pipe", "pipe"],
	});
	let stdout = "";
	let stderr = "";
	child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
	child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
	return { child, stdout: () => stdout, stderr: () => stderr };
}

async function waitForFile(path: string, timeoutMs = 20_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!existsSync(path)) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${path}`);
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

async function waitForExit(worker: { readonly child: ChildProcess; readonly stdout: () => string; readonly stderr: () => string }): Promise<Record<string, unknown>> {
	const code = worker.child.exitCode ?? await new Promise<number | null>((resolve, reject) => {
		worker.child.once("error", reject);
		worker.child.once("exit", (exitCode) => resolve(exitCode));
	});
	if (code !== 0) throw new Error(`title worker failed: code=${String(code)} stderr=${worker.stderr()} stdout=${worker.stdout()}`);
	const lines = worker.stdout().trim().split("\n");
	return JSON.parse(lines.at(-1) ?? "{}") as Record<string, unknown>;
}

describe("SessionStore title CAS across real SQLite connections", () => {
	it("allows exactly one concurrent auto completion to win the unnamed-session CAS", { timeout: 60_000 }, async () => {
		const { dbPath, sessionId, runtimeId } = setupOwnedSession();
		const startFile = join(directory, "start-title-race");
		const workers = ["first", "second"].map((name) => spawnWorker("auto-title", {
			sessionId,
			runtimeId,
			generation: 1,
			title: `Generated title from ${name}`,
			readyFile: join(directory, `ready-${name}`),
			startFile,
		}));

		await Promise.all([waitForFile(join(directory, "ready-first")), waitForFile(join(directory, "ready-second"))]);
		writeFileSync(startFile, "go");
		const results = await Promise.all(workers.map(waitForExit));

		expect(results.filter((result) => result.ok === true)).toHaveLength(1);
		expect(results.filter((result) => result.ok === false)).toHaveLength(1);
		expect(results.filter((result) => result.ok === false).every((result) => result.code === "title_conflict" || result.code === "busy")).toBe(true);

		const db = openSessionDatabase(dbPath);
		const store = new SessionStore(db);
		const session = store.getSession(sessionId);
		expect(session?.title).toMatch(/^Generated title from (first|second)$/u);
		expect(session?.titleSource).toBe("auto");
		expect(store.replaySessionEvents(sessionId).filter((event) => event.eventType === "session.title_changed")).toHaveLength(1);
		expect(store.rebuildFromEvents(sessionId)).toMatchObject({ title: session?.title, titleSource: "auto" });
		db.close();
	});
});
