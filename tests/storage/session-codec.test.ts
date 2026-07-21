import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentMessage } from "../../src/runtime/types.ts";
import { isLedgerLocked } from "../../src/runtime/ledger/lockfile.ts";
import type { LedgerEntry, LedgerHeader } from "../../src/runtime/ledger/types.ts";
import { newId } from "../../src/runtime/ledger/types.ts";
import { appendRuntimeConfig, replaySession } from "../../src/storage/session-codec.ts";
import { SessionManager } from "../../src/storage/session-manager.ts";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "runledger-codec-"));
  cleanup.push(dir);
  return dir;
}

function messageEntry(header: LedgerHeader, message: AgentMessage): LedgerEntry {
  return {
    id: newId(),
    sessionId: header.sessionId,
    parentId: header.id,
    timestamp: Date.now(),
    type: "message",
    payload: {
      schema: "agent-message/v1",
      role: message.role,
      message,
    },
  };
}

describe("session codec v2", () => {
  it("跨 reopen 无损恢复 thinking signature、tool arguments/result 与 runtime config", async () => {
    const cwd = await tempDir();
    const manager = await SessionManager.create({ cwd, sessionDir: cwd });
    const header = manager.ledger().header();
    const messages: AgentMessage[] = [
      { role: "user", content: [{ type: "text", text: "inspect" }] },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "private chain", thinkingSignature: "signed-thinking" },
          {
            type: "toolCall",
            id: "call-restore",
            name: "read",
            arguments: { path: "README.md", offset: 2 },
            thoughtSignature: "tool-signature",
          },
        ],
        stopReason: "toolUse",
        api: "mock",
        provider: "fixture",
        model: "fixture-1",
        timestamp: 123,
      },
      {
        role: "toolResult",
        content: [{
          type: "toolResult",
          toolCallId: "call-restore",
          toolName: "read",
          content: [{ type: "text", text: "file contents" }],
          details: { truncated: false },
          isError: false,
        }],
      },
    ];
    for (const message of messages) await manager.ledger().append(messageEntry(header, message));
    await appendRuntimeConfig(
      manager.ledger(),
      { provider: "fixture", model: "fixture-1", thinkingLevel: "high" },
      "model",
    );
    const sessionId = manager.sessionId();
    const filePath = manager.filePath();
    await manager.closeAll();

    const reopened = await SessionManager.open(filePath);
    const replay = await replaySession(reopened.ledger());

    expect(reopened.sessionId()).toBe(sessionId);
    expect(reopened.ledger().header().version).toBe(2);
    expect(replay.messages).toEqual(messages);
    expect(replay.config).toEqual({ provider: "fixture", model: "fixture-1", thinkingLevel: "high" });
    expect(replay.warnings).toEqual([]);
    await reopened.closeAll();
  });

  it("legacy v1 只恢复安全文本并给出 warning，不伪造 tool args/signature", async () => {
    const cwd = await tempDir();
    const filePath = join(cwd, "legacy.jsonl");
    const header: LedgerHeader = {
      type: "ledger",
      version: 1,
      id: "legacy-header",
      createdAt: 1,
      sessionId: "legacy-session",
      metadata: { cwd },
    };
    const entries: LedgerEntry[] = [
      {
        id: "u1",
        sessionId: header.sessionId,
        parentId: header.id,
        timestamp: 2,
        type: "message",
        payload: { role: "user", content: "hello" },
      },
      {
        id: "a1",
        sessionId: header.sessionId,
        parentId: "u1",
        timestamp: 3,
        type: "message",
        payload: { role: "assistant", content: "safe answer", stopReason: "toolUse" },
      },
      {
        id: "t1",
        sessionId: header.sessionId,
        parentId: "a1",
        timestamp: 4,
        type: "tool_result",
        payload: { toolCallId: "unknown", toolName: "bash", content: "legacy audit" },
      },
    ];
    await writeFile(filePath, [header, ...entries].map((row) => JSON.stringify(row)).join("\n") + "\n");

    const manager = await SessionManager.open(filePath);
    const replay = await replaySession(manager.ledger());

    expect(replay.warnings).toHaveLength(1);
    expect(replay.warnings[0]).toContain("Legacy session v1");
    expect(replay.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "hello" }] },
      { role: "assistant", content: [{ type: "text", text: "safe answer" }], stopReason: "toolUse" },
    ]);
    expect(JSON.stringify(replay.messages)).not.toContain("unknown");
    expect(replay.auditEntries).toEqual([entries[2]]);
    await manager.closeAll();
  });
});

describe("session identity, fork and whole-session lock", () => {
  it("fork 生成新 sessionId、改写 entries 并保留父会话身份", async () => {
    const cwd = await tempDir();
    const source = await SessionManager.create({ cwd, sessionDir: cwd });
    await source.ledger().append({
      id: "source-entry",
      sessionId: source.sessionId(),
      parentId: source.ledger().header().id,
      timestamp: Date.now(),
      type: "custom",
      payload: { kind: "fixture" },
    });
    const sourceId = source.sessionId();
    const sourcePath = source.filePath();
    await source.closeAll();

    const fork = await SessionManager.forkFrom(sourcePath, cwd, cwd);
    const text = await readFile(fork.filePath(), "utf8");
    const rows = text.trim().split(/\r?\n/).map((line) => JSON.parse(line) as LedgerHeader | LedgerEntry);
    const forkHeader = rows[0] as LedgerHeader;
    const forkEntry = rows[1] as LedgerEntry;

    expect(fork.sessionId()).not.toBe(sourceId);
    expect(forkHeader.metadata).toMatchObject({
      parentSession: sourcePath,
      parentSessionId: sourceId,
      cwd,
    });
    expect(forkEntry.sessionId).toBe(fork.sessionId());
    expect(forkEntry.parentId).toBe(forkHeader.id);
    await fork.closeAll();
  });

  it("acquireLock 持有到 closeAll，且重复调用幂等", async () => {
    const cwd = await tempDir();
    const manager = await SessionManager.create({ cwd, sessionDir: cwd });

    await manager.acquireLock();
    await manager.acquireLock();
    expect(await isLedgerLocked(manager.filePath())).toBe(true);

    await manager.closeAll();
    expect(await isLedgerLocked(manager.filePath())).toBe(false);
  });
});
