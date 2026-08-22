import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentMessage } from "../../src/runtime/types.ts";
import { buildRunledgerLayout } from "../../src/runtime/contracts/public.ts";
import { isLedgerLocked } from "../../src/runtime/ledger/lockfile.ts";
import {
  UnsupportedSessionFormatError,
  type LedgerEntry,
  type LedgerHeader,
} from "../../src/runtime/ledger/types.ts";
import { newId } from "../../src/runtime/ledger/types.ts";
import { appendRuntimeConfig, projectSessionReplay, replaySession } from "../../src/storage/session-codec.ts";
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
      role: message.role,
      message,
    },
  };
}

describe("session codec", () => {
	it("applies a checkpoint projection and only the requested ledger tail", () => {
		const first: AgentMessage = { role: "user", content: [{ type: "text", text: "before checkpoint" }] };
		const second: AgentMessage = { role: "user", content: [{ type: "text", text: "tail" }] };
		const seed = {
			messages: [first],
			config: { provider: "fixture" },
			auditEntries: [],
			warnings: [],
		};
		const tail: LedgerEntry[] = [{
			id: "tail-entry",
			sessionId: "session_tail",
			parentId: "checkpoint",
			timestamp: 2,
			type: "message",
			payload: { role: second.role, message: second },
		}];

		const replay = projectSessionReplay(tail, seed);
		expect(replay.messages).toEqual([first, second]);
		expect(replay.config).toEqual({ provider: "fixture" });
	});

	it("replays the immutable settings digest from a runtime config event", () => {
		const settingsDigest = "a".repeat(64);
		const replay = projectSessionReplay([{
			id: "settings-runtime-config",
			sessionId: "session-settings",
			parentId: "header-settings",
			timestamp: 1,
			type: "custom",
			payload: {
				kind: "runtime.config",
				source: "startup",
				settingsDigest,
				settingsSourceLayers: { "display.showTokenUsage": "user" },
				settingsApplyModes: { "display.showTokenUsage": "live" },
				settingsDiagnostics: [{ code: "invalid_value", path: "retry.maxRetries", source: "workspace" }],
			},
		}]);

		expect(replay.config).toMatchObject({
			settingsDigest,
			settingsSourceLayers: { "display.showTokenUsage": "user" },
			settingsApplyModes: { "display.showTokenUsage": "live" },
			settingsDiagnostics: [{ code: "invalid_value", path: "retry.maxRetries", source: "workspace" }],
		});
	});

	it("drops malformed settings diagnostics during replay", () => {
		const replay = projectSessionReplay([{
			id: "malformed-settings-runtime-config",
			sessionId: "session-settings",
			parentId: "header-settings",
			timestamp: 1,
			type: "custom",
			payload: {
				kind: "runtime.config",
				source: "startup",
				settingsDiagnostics: [{ code: "invalid_value", path: "retry.maxRetries", source: "untrusted" }],
			},
		}]);

		expect(replay.config.settingsDiagnostics).toBeUndefined();
	});

  it("跨 reopen 无损恢复 thinking signature、tool arguments/result 与 runtime config", async () => {
    const cwd = await tempDir();
    const layout = buildRunledgerLayout(join(cwd, "home"), "posix");
    const manager = await SessionManager.create({ cwd, layout });
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

    const reopened = await SessionManager.open(layout, filePath);
    const replay = await replaySession(reopened.ledger());

    expect(reopened.sessionId()).toBe(sessionId);
    expect(replay.messages).toEqual(messages);
    expect(replay.config).toEqual({ provider: "fixture", model: "fixture-1", thinkingLevel: "high" });
    expect(replay.warnings).toEqual([]);
    await reopened.closeAll();
  });

  it("拒绝不支持的 session 格式且不修改源文件", async () => {
    const cwd = await tempDir();
    const layout = buildRunledgerLayout(join(cwd, "home"), "posix");
    const filePath = join(layout.sessions, "2026", "08", "02", "unsupported.jsonl");
    await mkdir(join(layout.sessions, "2026", "08", "02"), { recursive: true });
    const original = JSON.stringify({ type: "unsupported-ledger", payload: "unchanged" }) + "\n";
    await writeFile(filePath, original);

    await expect(SessionManager.open(layout, filePath)).rejects.toBeInstanceOf(UnsupportedSessionFormatError);
    await expect(readFile(filePath, "utf8")).resolves.toBe(original);
  });
});

describe("session identity, fork and whole-session lock", () => {
  it("fork 生成新 sessionId、改写 entries 并保留父会话身份", async () => {
    const cwd = await tempDir();
    const layout = buildRunledgerLayout(join(cwd, "home"), "posix");
    const source = await SessionManager.create({ cwd, layout });
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

    const fork = await SessionManager.forkFrom(layout, sourcePath, cwd);
    const text = await readFile(fork.filePath(), "utf8");
    const rows = text.trim().split(/\r?\n/).map((line) => JSON.parse(line) as LedgerHeader | LedgerEntry);
    const forkHeader = rows[0] as LedgerHeader;
    const forkEntry = rows[1] as LedgerEntry;

    expect(fork.sessionId()).not.toBe(sourceId);
    expect(forkHeader.metadata).toMatchObject({
      parentSession: relative(layout.home, sourcePath).replaceAll("\\", "/"),
      parentSessionId: sourceId,
      cwd,
    });
    expect(forkEntry.sessionId).toBe(fork.sessionId());
    expect(forkEntry.parentId).toBe(forkHeader.id);
    await fork.closeAll();
  });

  it("acquireLock 持有到 closeAll，且重复调用幂等", async () => {
    const cwd = await tempDir();
    const layout = buildRunledgerLayout(join(cwd, "home"), "posix");
    const manager = await SessionManager.create({ cwd, layout });

    await manager.acquireLock();
    await manager.acquireLock();
    expect(await isLedgerLocked(manager.filePath())).toBe(true);

    await manager.closeAll();
    expect(await isLedgerLocked(manager.filePath())).toBe(false);
  });
});
