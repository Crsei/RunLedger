import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { localExecutionEnv } from "../../../src/runtime/execution-env.ts";
import { standardHarnessProfileRef } from "../../../src/runtime/harness-profiles/index.ts";
import { MemoryLedger } from "../../../src/runtime/ledger/memory-ledger.ts";
import type { LedgerSink } from "../../../src/runtime/ledger/types.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/ids.ts";
import { SqliteLedgerSink } from "../../../src/runtime/session-runtime/sqlite-ledger.ts";
import { makeToolContext } from "../../../src/runtime/tool-context.ts";
import { createStdlibTools } from "../../../src/runtime/tools/index.ts";
import { openSessionDatabase } from "../../../src/storage/session-store/database.ts";
import { OwnerStore } from "../../../src/storage/session-store/owner-store.ts";
import { installSessionStoreSchema } from "../../../src/storage/session-store/schema.ts";
import { SessionStore } from "../../../src/storage/session-store/session-store.ts";

function context(ledger: LedgerSink) {
	return makeToolContext({
		cwd: process.cwd(), env: localExecutionEnv(), ledger,
		signal: new AbortController().signal, sessionId: ledger.sessionId, toolCallId: "todo-context",
	});
}

describe("todo runtime ledger injection", () => {
	it("persists composed tools through ToolContext and restores into a fresh tool instance", async () => {
		const ledger = new MemoryLedger();
		const tool = createStdlibTools().get("todo")!;
		await tool.execute("init", { op: "init", items: ["first", "second"] }, undefined, undefined, context(ledger));
		expect(ledger.findByType("custom")).toHaveLength(1);
		expect(ledger.findByType("custom")[0]?.payload).toMatchObject({ kind: "todo_phases" });
		await tool.execute("done", { op: "done", task: "first" }, undefined, undefined, context(ledger));
		const restored = await createStdlibTools().get("todo")!.execute("view", { op: "view" }, undefined, undefined, context(ledger));
		expect(restored.details).toMatchObject({ phases: [{ name: "Tasks", tasks: [
			{ content: "first", status: "completed" }, { content: "second", status: "in_progress" },
		] }] });
		expect(ledger.findByType("custom")).toHaveLength(2);
	});

	it("prefers the invocation ledger over the construction ledger and isolates sessions", async () => {
		const fallback = new MemoryLedger();
		const first = new MemoryLedger();
		const second = new MemoryLedger();
		const tool = createStdlibTools(process.cwd(), { ledger: fallback }).get("todo")!;
		await tool.execute("init", { op: "init", items: ["runtime task"] }, undefined, undefined, context(first));
		expect(first.findByType("custom")).toHaveLength(1);
		expect(fallback.entries()).toHaveLength(0);
		const other = await tool.execute("view", { op: "view" }, undefined, undefined, context(second));
		expect(other.details).toMatchObject({ phases: [] });
	});

	it("retains construction-ledger fallback when context is absent or has no ledger", async () => {
		const ledger = new MemoryLedger();
		const tool = createStdlibTools(process.cwd(), { ledger }).get("todo")!;
		await tool.execute("init", { op: "init", items: ["fallback task"] });
		const withoutLedger = context(ledger);
		delete withoutLedger.ledger;
		const result = await tool.execute("done", { op: "done", task: "fallback task" }, undefined, undefined, withoutLedger);
		expect(result.details).toMatchObject({ phases: [{ tasks: [{ status: "completed" }] }] });
		expect(ledger.findByType("custom")).toHaveLength(2);
	});

	it("writes owner-fenced ledger.custom events and reads them after reopening SQLite", async () => {
		const root = mkdtempSync(join(tmpdir(), "runledger-todo-context-"));
		const path = join(root, "state.db");
		let db = openSessionDatabase(path);
		try {
			installSessionStoreSchema(db);
			let store = new SessionStore(db);
			const sessionId = createRuntimeId("session", "todo-context");
			store.createSession({ sessionId, workspaceId: createRuntimeId("workspace", "todo-context"),
				repositoryId: createRuntimeId("repository", "todo-context"), settingsDigest: "d".repeat(64), harnessProfile: standardHarnessProfileRef() });
			const claim = new OwnerStore(db).tryClaim({ mode: "fresh", sessionId }, {
				runtimeId: createRuntimeId("runtime", "todo-context"), endpoint: { host: "127.0.0.1", port: 12345 },
				authTokenHex: "a".repeat(64), ownerStartedAtMs: Date.now(),
			});
			if (!claim.ok || claim.outcome !== "claimed") throw new Error("test owner claim failed");
			let ledger = new SqliteLedgerSink({ store, fence: () => claim.fence });
			const tool = createStdlibTools(root).get("todo")!;
			await tool.execute("init", { op: "init", items: ["durable task"] }, undefined, undefined, context(ledger));
			const done = await tool.execute("done", { op: "done", task: "durable task" }, undefined, undefined, context(ledger));
			expect(store.replaySessionEvents(sessionId).filter((event) => event.eventType === "ledger.custom")).toHaveLength(2);
			db.close();
			db = openSessionDatabase(path);
			store = new SessionStore(db);
			ledger = new SqliteLedgerSink({ store, fence: () => claim.fence });
			const restored = await createStdlibTools(root).get("todo")!.execute("view", { op: "view" }, undefined, undefined, context(ledger));
			expect(restored.details).toMatchObject({ phases: (done.details as { phases: unknown }).phases });
			expect(ledger.findByType("custom")).toHaveLength(2);
		} finally {
			db.close();
			rmSync(root, { recursive: true, force: true });
		}
	});
});
