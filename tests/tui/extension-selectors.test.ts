/**
 * TUI Session extension selectors 测试 —— /mcp、/plugins、/skills、/hooks
 * 经 extension.inspect workflow（B4 adapter）展示协商后的 Session snapshot，
 * 不再直接解析 raw response。
 */

import { describe, expect, it, vi } from "vitest";
import { Agent } from "../../src/runtime/agent.ts";
import { mockModel } from "../../src/runtime/providers/mock-stream.ts";
import { InteractiveMode } from "../../src/tui/interactive-mode.ts";
import { TUI, type Terminal } from "../../src/tui/index.ts";
import { ContractController, settleFrames } from "./fixtures/contract-integration.ts";
import type { SessionDomainResult } from "../../src/runtime/session-runtime/domain-router.ts";

class FakeTerminal implements Terminal {
  private input: ((data: string) => void) | undefined;
  readonly writes: string[] = [];
  startCount = 0;
  stopCount = 0;

  get columns(): number { return 100; }
  get rows(): number { return 30; }
  get kittyProtocolActive(): boolean { return false; }

  start(onInput: (data: string) => void): void {
    this.startCount += 1;
    this.input = onInput;
  }
  stop(): void {
    this.stopCount += 1;
    this.input = undefined;
  }
  async drainInput(): Promise<void> {}
  write(data: string): void { this.writes.push(data); }
  moveBy(): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(): void {}
  setProgress(): void {}
  send(data: string): void { this.input?.(data); }
}

interface StubController {
	readonly supports: (operation: string) => boolean;
	readonly querySessionDomain?: (operation: string, body: Record<string, unknown>, context: { readonly correlationId: string; readonly effectId: string }) => Promise<SessionDomainResult>;
	readonly commandSessionDomain?: (operation: string, body: Record<string, unknown>, context: { readonly correlationId: string; readonly effectId: string; readonly expectedRevision: number }) => Promise<SessionDomainResult>;
  readonly sessionId: string;
  readonly inFlight: boolean;
  readonly messages: unknown[];
  readonly warnings: string[];
  readonly auditEntries: unknown[];
  readonly toolCount: number;
  readonly currentSelection: { readonly provider?: string; readonly model?: unknown; readonly thinkingLevel: string };
  prompt: () => Promise<void>;
  dispose: () => void;
}

function stubController(query: Record<string, Record<string, unknown>>): StubController {
  return {
	supports: (operation) => operation in query,
    querySessionDomain: vi.fn(async (operation: string) => ({ ok: true, status: "ok", operation, domainRevision: 0, value: query[operation] ?? {} })),
    commandSessionDomain: vi.fn(async (operation: string) => ({ ok: true, status: "ok", operation, domainRevision: 0, value: query[operation] ?? {} })),
    sessionId: "session-tui-extension-selector",
    inFlight: false,
    messages: [],
    warnings: [],
    auditEntries: [],
    toolCount: 0,
    currentSelection: { thinkingLevel: "off" },
    prompt: async () => undefined,
    dispose: () => undefined,
  };
}

const extensionSnapshot = (descriptors: unknown[]): Record<string, unknown> => ({
  ok: true,
  snapshot: { snapshotId: "snap-1", generation: 1, digest: "abc", descriptors },
});

const mcpServer = { kind: "mcp-server", identity: { qualifiedId: "mcp-server:stdio", version: "1.0.0", digest: { algorithm: "sha256", digest: "d1" } }, displayName: "stdio-server", enabled: true, trusted: true, ready: true, activation: "ready" };
const plugin = { kind: "plugin", identity: { qualifiedId: "plugin:fixture", version: "1.0.0", digest: { algorithm: "sha256", digest: "d2" } }, displayName: "fixture", enabled: true, trusted: true, ready: true };
const skill = { kind: "skill", identity: { qualifiedId: "skill:fixture", version: "1.0.0", digest: { algorithm: "sha256", digest: "d3" } }, displayName: "skill", enabled: true, trusted: true, ready: true };
const hook = { kind: "hook", identity: { qualifiedId: "hook:pre-tool", version: "1.0.0", digest: { algorithm: "sha256", digest: "d4" } }, displayName: "pre-tool", enabled: true, trusted: true, ready: true };

describe("TUI extension selectors query the Session snapshot via the B4 workflow", () => {
  it("/mcp shows connected mcp-server resources from extension.inspect", async () => {
    const controller = stubController({ "extension.inspect": extensionSnapshot([mcpServer]) });
    const mode = new InteractiveMode({ controller: controller as never, terminal: new FakeTerminal() });
    const query = controller.querySessionDomain as ReturnType<typeof vi.fn>;

    await (mode as unknown as { openMcpServerSelector(): Promise<void> }).openMcpServerSelector();
    await settleFrames();
    const tui = (mode as unknown as { ui: TUI }).ui;
    expect(tui.hasOverlay()).toBe(true);
    expect(query).toHaveBeenCalledWith("extension.inspect", {}, expect.objectContaining({ correlationId: expect.any(String), effectId: expect.any(String) }));
  });

  it("/plugins /skills /hooks filter the typed extension workflow snapshot", async () => {
    const controller = stubController({ "extension.inspect": extensionSnapshot([plugin, skill, hook]) });
    const mode = new InteractiveMode({ controller: controller as never, terminal: new FakeTerminal() });
    const tui = (mode as unknown as { ui: TUI }).ui;

    await (mode as unknown as { openExtensionSelector(op: "plugin.list" | "skill.list" | "hook.list", label: string, name: string): Promise<void> }).openExtensionSelector("plugin.list", "plugins", "/plugins");
    await settleFrames();
    expect(tui.hasOverlay()).toBe(true);
    tui.hideOverlay();

    await (mode as unknown as { openExtensionSelector(op: "plugin.list" | "skill.list" | "hook.list", label: string, name: string): Promise<void> }).openExtensionSelector("skill.list", "skills", "/skills");
    await settleFrames();
    expect(tui.hasOverlay()).toBe(true);
    tui.hideOverlay();

    await (mode as unknown as { openExtensionSelector(op: "plugin.list" | "skill.list" | "hook.list", label: string, name: string): Promise<void> }).openExtensionSelector("hook.list", "hooks", "/hooks");
    await settleFrames();
    expect(tui.hasOverlay()).toBe(true);

    const query = controller.querySessionDomain as ReturnType<typeof vi.fn>;
    expect(query).toHaveBeenCalledWith("extension.inspect", {}, expect.objectContaining({ correlationId: expect.any(String), effectId: expect.any(String) }));
    // 不再直接调用 per-kind raw operations
    expect(query).not.toHaveBeenCalledWith("plugin.list", expect.anything());
    expect(query).not.toHaveBeenCalledWith("skill.list", expect.anything());
    expect(query).not.toHaveBeenCalledWith("hook.list", expect.anything());
  });

  it("empty snapshot shows a typed notice instead of an empty overlay", async () => {
    const controller = stubController({ "extension.inspect": extensionSnapshot([]) });
    const mode = new InteractiveMode({ controller: controller as never, terminal: new FakeTerminal() });
    await (mode as unknown as { openMcpServerSelector(): Promise<void> }).openMcpServerSelector();
    await settleFrames();
    const tui = (mode as unknown as { ui: TUI }).ui;
    expect(tui.hasOverlay()).toBe(false);
    expect(mode.getTuiState().extensionWorkflow.state).toBe("empty");
  });

  it("fails visibly when the Session domain query is unavailable", async () => {
    const controller = new ContractController();
    const mode = new InteractiveMode({ controller, terminal: new FakeTerminal() });
    const tui = (mode as unknown as { ui: TUI }).ui;
    // 本地 controller 无 querySessionDomain → capability unavailable → typed notice，不抛错。
    await (mode as unknown as { openMcpServerSelector(): Promise<void> }).openMcpServerSelector();
    expect(tui.hasOverlay()).toBe(false);
    expect(mode.getTuiState().capabilities.extensions.state).toBe("unavailable");
  });

  it("invalid Host body never reaches the workflow (typed validator)", async () => {
    const controller = stubController({ "extension.inspect": { ok: true, snapshot: { descriptors: [{ identity: { qualifiedId: "" } }, "garbage", null] } } });
    const mode = new InteractiveMode({ controller: controller as never, terminal: new FakeTerminal() });
    await (mode as unknown as { openExtensionSelector(op: "plugin.list" | "skill.list" | "hook.list", label: string, name: string): Promise<void> }).openExtensionSelector("plugin.list", "plugins", "/plugins");
    await settleFrames();
    const workflow = mode.getTuiState().extensionWorkflow;
    expect(workflow.state).toBe("empty"); // 全部被 validator 拒绝 → 空
  });
});

describe("TUI plan/compact/memory domain commands", () => {
  it("runs /plan /compact /memory queries through the Session domain channel", async () => {
    const terminal = new FakeTerminal();
    const agent = new Agent({
      initialState: { systemPrompt: "test", model: mockModel },
      streamFn: () => { throw new Error("stream not called"); },
    });
    const mode = new InteractiveMode({ agent, terminal } as never);
    const controller = stubController({
      "plan.inspect": { state: { status: "active", revision: 3, approval: { status: "approved" } } },
      "compaction.list": { checkpoints: [{ status: "completed" }] },
      "memory.inspect": { memory: { generation: 2, recordCount: 1, proposalCount: 1 } },
    });
    (mode as unknown as { controller: StubController }).controller = controller;
    const run = mode as unknown as {
      runDomainCommand(operation: string, body: Record<string, unknown>, commandName: string, readOnly: boolean): Promise<void>;
    };

    await run.runDomainCommand("plan.inspect", {}, "/plan", true);
    await run.runDomainCommand("compaction.list", {}, "/compact", true);
    await run.runDomainCommand("memory.inspect", {}, "/memory", true);

    const query = controller.querySessionDomain as ReturnType<typeof vi.fn>;
    expect(query).toHaveBeenCalledWith("plan.inspect", {}, expect.objectContaining({ correlationId: expect.any(String), effectId: expect.any(String) }));
    expect(query).toHaveBeenCalledWith("compaction.list", {}, expect.objectContaining({ correlationId: expect.any(String), effectId: expect.any(String) }));
    expect(query).toHaveBeenCalledWith("memory.inspect", {}, expect.objectContaining({ correlationId: expect.any(String), effectId: expect.any(String) }));
  });

  it("routes /remember proposal mutations through commandSessionDomain", async () => {
    const terminal = new FakeTerminal();
    const agent = new Agent({
      initialState: { systemPrompt: "test", model: mockModel },
      streamFn: () => { throw new Error("stream not called"); },
    });
    const mode = new InteractiveMode({ agent, terminal } as never);
    const controller = stubController({
      "memory.propose": { proposal: { proposalId: "proposal_abc" } },
    });
    (mode as unknown as { controller: StubController }).controller = controller;
    const run = mode as unknown as {
      runDomainCommand(operation: string, body: Record<string, unknown>, commandName: string, readOnly: boolean): Promise<void>;
    };

    await run.runDomainCommand("memory.propose", { scope: "workspace", title: "keep", content: "remember this", sourceKind: "user" }, "/remember", false);

    const command = controller.commandSessionDomain as ReturnType<typeof vi.fn>;
    expect(command).toHaveBeenCalledWith("memory.propose", expect.objectContaining({ content: "remember this", sourceKind: "user" }), expect.objectContaining({ expectedRevision: 0 }));
  });

  it("rejects plan/compact/memory commands without a Host connection", async () => {
    const terminal = new FakeTerminal();
    const agent = new Agent({
      initialState: { systemPrompt: "test", model: mockModel },
      streamFn: () => { throw new Error("stream not called"); },
    });
    const mode = new InteractiveMode({ agent, terminal } as never);
    const run = mode as unknown as {
      runDomainCommand(operation: string, body: Record<string, unknown>, commandName: string, readOnly: boolean): Promise<void>;
    };
    // 本地 controller（无 Host 通道）→ typed notice，不抛错。
    await expect(run.runDomainCommand("plan.inspect", {}, "/plan", true)).resolves.toBeUndefined();
  });
});
