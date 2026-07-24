import {
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { LedgerHeader } from "../../src/runtime/ledger/types.ts";
import type { LedgerEntry } from "../../src/runtime/ledger/types.ts";
import { DEFAULT_RUNTIME_FEATURES } from "../../src/runtime/runtime-features.ts";
import { V3SessionManager } from "../../src/storage/v3-session-manager.ts";
import { LocalSessionCatalogAdapter } from "../../src/tui/sessions/local-catalog-adapter.ts";

const roots: string[] = [];

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "runledger-session-catalog-"));
  roots.push(root);
  return root;
}

function writeLegacy(
  directory: string,
  version: 1 | 2,
  id: string,
  metadata: Record<string, unknown> = {},
  tail = "",
): string {
  const filePath = join(directory, `${id}.jsonl`);
  const header: LedgerHeader = {
    type: "ledger",
    version,
    id: `header-${id}`,
    createdAt: 1_700_000_000_000 + version,
    sessionId: id,
    metadata,
  };
  writeFileSync(filePath, `${JSON.stringify(header)}\n${tail}`, "utf8");
  return filePath;
}

function legacyEntry(
  sessionId: string,
  index: number,
  type: LedgerEntry["type"],
  payload: Record<string, unknown> = {},
): LedgerEntry {
  return {
    id: `entry-${sessionId}-${index}`,
    sessionId,
    parentId: `parent-${index}`,
    timestamp: 1_700_000_000_100 + index,
    type,
    payload,
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("LocalSessionCatalogAdapter.listLite", () => {
  it("returns an empty catalog for a missing directory", async () => {
    const root = temporaryRoot();
    const adapter = new LocalSessionCatalogAdapter({
      cwd: root,
      sessionDir: join(root, "missing"),
    });
    await expect(adapter.listLite({
      query: "",
      listRequestId: "list:1",
      signal: new AbortController().signal,
    })).resolves.toEqual({
      ok: true,
      value: { sessions: [], diagnostics: [] },
    });
  });

  it("reads only bounded headers for v1/v2 and filters by explicit title or id", async () => {
    const root = temporaryRoot();
    const largeTail = `${JSON.stringify({ payload: "x".repeat(4 * 1024 * 1024) })}\n`;
    const current = writeLegacy(root, 2, "session-current", {
      cwd: root,
      title: "Release audit",
    }, largeTail);
    writeLegacy(root, 1, "legacy-one", {});
    const adapter = new LocalSessionCatalogAdapter({
      cwd: root,
      sessionDir: root,
      currentSession: { id: "session-current", filePath: current },
    });

    const all = await adapter.listLite({
      query: "",
      listRequestId: "list:1",
      signal: new AbortController().signal,
    });
    expect(all).toMatchObject({
      ok: true,
      value: {
        sessions: expect.arrayContaining([
          expect.objectContaining({
            id: "session-current",
            title: "Release audit",
            format: "v2",
            isCurrent: true,
          }),
          expect.objectContaining({
            id: "legacy-one",
            title: "Untitled session",
            format: "v1",
          }),
        ]),
      },
    });
    const filtered = await adapter.listLite({
      query: "release",
      listRequestId: "list:2",
      signal: new AbortController().signal,
    });
    expect(filtered.ok && filtered.value.sessions.map((session) => session.id)).toEqual([
      "session-current",
    ]);
  });

  it("lists published v3 and reports corrupt, symlink, oversize, and staging entries", async () => {
    const root = temporaryRoot();
    const features = { ...DEFAULT_RUNTIME_FEATURES, sessionV3: true };
    const published = await V3SessionManager.create({
      cwd: root,
      sessionDir: root,
      features,
    });
    const staging = await V3SessionManager.create({
      cwd: root,
      sessionDir: root,
      features,
      writeGenesis: false,
      publication: { kind: "create", mode: "manual" },
    });
    writeFileSync(join(root, "corrupt.jsonl"), "{not-json}\n", "utf8");
    writeFileSync(join(root, "oversize.jsonl"), `${"x".repeat(100_000)}\n`, "utf8");
    const target = writeLegacy(root, 2, "symlink-target");
    symlinkSync(target, join(root, "linked.jsonl"));

    const adapter = new LocalSessionCatalogAdapter({ cwd: root, sessionDir: root });
    const result = await adapter.listLite({
      query: "",
      listRequestId: "list:1",
      signal: new AbortController().signal,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value.sessions).toHaveLength(2);
    expect(result.value.sessions).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: published.sessionId(), format: "v3" }),
      expect.objectContaining({ id: "symlink-target", format: "v2" }),
    ]));
    expect(result.value.diagnostics.map((item) => item.code).sort()).toEqual([
      "corrupt",
      "oversize",
      "staging",
      "symlink",
    ]);
    await published.closeAll();
    await staging.closeAll();
  });
});

describe("LocalSessionCatalogAdapter.enrich", () => {
  it("uses the injected exact current-session path when duplicate IDs exist", async () => {
    const root = temporaryRoot();
    const duplicate = writeLegacy(
      root,
      2,
      "duplicate",
      { cwd: "/wrong", title: "Wrong duplicate" },
    );
    const exact = join(root, "exact-current.jsonl");
    const header: LedgerHeader = {
      type: "ledger",
      version: 2,
      id: "header-exact",
      createdAt: 10,
      sessionId: "duplicate",
      metadata: { cwd: "/exact", title: "Exact current" },
    };
    writeFileSync(exact, `${JSON.stringify(header)}\n`, "utf8");
    expect(duplicate).not.toBe(exact);
    const adapter = new LocalSessionCatalogAdapter({
      cwd: root,
      sessionDir: root,
      currentSession: { id: "duplicate", filePath: exact },
    });
    const detail = await adapter.enrich({
      sessionId: "duplicate",
      enrichRequestId: "current:1",
      signal: new AbortController().signal,
    });
    expect(detail).toMatchObject({
      ok: true,
      value: {
        filePath: exact,
        summary: { title: "Exact current", cwd: "/exact", isCurrent: true },
      },
    });
  });

  it.each([1, 2] as const)("scans legacy v%s metadata without projecting transcript", async (version) => {
    const root = temporaryRoot();
    const id = `legacy-detail-v${version}`;
    const entries = [
      legacyEntry(id, 1, "message", { role: "user", content: "hello" }),
      legacyEntry(id, 2, "turn"),
      legacyEntry(id, 3, "tool_call"),
      legacyEntry(id, 4, "custom", {
        kind: "runtime.config",
        provider: "deepseek",
        model: "deepseek-v4-pro",
        thinkingLevel: "high",
      }),
    ];
    writeLegacy(
      root,
      version,
      id,
      { cwd: root, parentSessionId: "parent-session" },
      `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    );
    const adapter = new LocalSessionCatalogAdapter({ cwd: root, sessionDir: root });
    const detail = await adapter.enrich({
      sessionId: id,
      enrichRequestId: "enrich:1",
      signal: new AbortController().signal,
    });
    if (!detail.ok) throw new Error(detail.error.message);
    expect(detail).toMatchObject({
      ok: true,
      value: {
        summary: { id, format: `v${version}` },
        messageCount: 1,
        turnCount: 1,
        toolCount: 1,
        provider: "deepseek",
        model: "deepseek-v4-pro",
        thinkingLevel: "high",
        parentSessionId: "parent-session",
      },
    });
  });

  it("fully validates a published v3 chain and returns canonical head metadata", async () => {
    const root = temporaryRoot();
    const manager = await V3SessionManager.create({
      cwd: root,
      sessionDir: root,
      features: { ...DEFAULT_RUNTIME_FEATURES, sessionV3: true },
    });
    const adapter = new LocalSessionCatalogAdapter({ cwd: root, sessionDir: root });
    const detail = await adapter.enrich({
      sessionId: manager.sessionId(),
      enrichRequestId: "enrich:v3",
      signal: new AbortController().signal,
    });
    if (!detail.ok) throw new Error(detail.error.message);
    expect(detail).toMatchObject({
      ok: true,
      value: {
        summary: {
          id: manager.sessionId(),
          format: "v3",
          lifecycle: "active",
        },
        messageCount: 0,
        turnCount: 0,
        toolCount: 0,
        headSequence: 0,
      },
    });
    expect(detail.value.headEventHash).toMatch(/^[a-f0-9]{64}$/u);
    await manager.closeAll();
  });
});

describe("LocalSessionCatalogAdapter.loadFullPreview", () => {
  it("recovers v1 safe text and v2 canonical messages without unsafe legacy tool data", async () => {
    const root = temporaryRoot();
    const v1 = "preview-v1";
    const v1Rows = [
      legacyEntry(v1, 1, "message", { role: "user", content: "legacy user" }),
      legacyEntry(v1, 2, "message", { role: "assistant", content: "legacy assistant" }),
      legacyEntry(v1, 3, "tool_result", { content: "unsafe orphan" }),
    ];
    writeLegacy(root, 1, v1, {}, `${v1Rows.map(JSON.stringify).join("\n")}\n`);
    const v2 = "preview-v2";
    const v2Rows = [
      legacyEntry(v2, 1, "message", {
        schema: "agent-message/v1",
        message: { role: "user", content: [{ type: "text", text: "canonical user" }] },
      }),
    ];
    writeLegacy(root, 2, v2, {}, `${v2Rows.map(JSON.stringify).join("\n")}\n`);
    const adapter = new LocalSessionCatalogAdapter({ cwd: root, sessionDir: root });
    const v1Preview = await adapter.loadFullPreview({
      sessionId: v1,
      previewRequestId: "preview:1",
      signal: new AbortController().signal,
    });
    const v2Preview = await adapter.loadFullPreview({
      sessionId: v2,
      previewRequestId: "preview:2",
      signal: new AbortController().signal,
    });
    expect(v1Preview).toMatchObject({
      ok: true,
      value: {
        messages: [
          { role: "user", content: [{ text: "legacy user" }] },
          { role: "assistant", content: [{ text: "legacy assistant" }] },
        ],
      },
    });
    expect(v2Preview).toMatchObject({
      ok: true,
      value: { messages: [{ role: "user", content: [{ text: "canonical user" }] }] },
    });
  });

  it("replays verified v3 conversation events", async () => {
    const root = temporaryRoot();
    const manager = await V3SessionManager.create({
      cwd: root,
      sessionDir: root,
      features: { ...DEFAULT_RUNTIME_FEATURES, sessionV3: true },
    });
    await manager.sessionEvents().recordMessage({
      role: "user",
      content: [{ type: "text", text: "v3 preview" }],
    });
    const adapter = new LocalSessionCatalogAdapter({ cwd: root, sessionDir: root });
    const preview = await adapter.loadFullPreview({
      sessionId: manager.sessionId(),
      previewRequestId: "preview:v3",
      signal: new AbortController().signal,
    });
    expect(preview).toMatchObject({
      ok: true,
      value: {
        messages: [{ role: "user", content: [{ text: "v3 preview" }] }],
        truncated: false,
      },
    });
    await manager.closeAll();
  });

  it("returns only the latest 100 messages within 300,000 UTF-8 bytes", async () => {
    const root = temporaryRoot();
    const id = "bounded-preview";
    const rows: LedgerEntry[] = [];
    for (let index = 0; index < 105; index++) {
      rows.push(legacyEntry(id, index, "message", {
        schema: "agent-message/v1",
        message: {
          role: "user",
          content: [{ type: "text", text: `${index}:${"x".repeat(2_500)}` }],
        },
      }));
    }
    writeLegacy(root, 2, id, {}, `${rows.map(JSON.stringify).join("\n")}\n`);
    const adapter = new LocalSessionCatalogAdapter({ cwd: root, sessionDir: root });
    const preview = await adapter.loadFullPreview({
      sessionId: id,
      previewRequestId: "preview:bounded",
      signal: new AbortController().signal,
    });
    if (!preview.ok) throw new Error(preview.error.message);
    expect(preview.value.messages).toHaveLength(100);
    expect(preview.value.truncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(preview.value.messages), "utf8")).toBeLessThanOrEqual(
      300_000,
    );
    expect(JSON.stringify(preview.value.messages[0])).toContain("5:");
  });
});
