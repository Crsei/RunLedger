/**
 * TUI Host extension selectors 测试 —— /mcp、/plugins、/skills、/hooks
 * 经 controller.queryHostDomain 展示真实 Host snapshot，而不是空列表占位。
 */

import { describe, expect, it, vi } from "vitest";
import { Agent } from "../../src/runtime/agent.ts";
import { mockModel } from "../../src/runtime/providers/mock-stream.ts";
import type { StreamFn } from "../../src/runtime/types.ts";
import type { AssistantMessage, AssistantMessageEventStream } from "../../src/types.ts";
import { InteractiveMode } from "../../src/tui/interactive-mode.ts";
import { TUI, type Terminal } from "../../src/tui/index.ts";

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
  moveBy(_lines: number): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(_title: string): void {}
  setMode(_mode: "raw" | "cooked"): void {}
  setSize(_columns: number, _rows: number): void {}
  getSize(): { columns: number; rows: number } { return { columns: 100, rows: 30 }; }
  onResize(_listener: () => void): () => void { return () => undefined; }
  send(data: string): void { this.input?.(data); }
}

function immediateStopStream(): StreamFn {
  return async function* immediateStop(): AssistantMessageEventStream {
    yield { type: "start", timestamp: Date.now() };
    yield {
      type: "done",
      timestamp: Date.now(),
      stopReason: "stop",
      assistantMessage: { role: "assistant", content: [], model: mockModel.id, provider: mockModel.provider },
    } as AssistantMessageEventStream extends AsyncGenerator<infer E> ? E : never;
  };
}

interface StubController {
  readonly queryHostDomain?: (operation: string, body?: Record<string, unknown>) => Promise<Record<string, unknown>>;
  readonly commandHostDomain?: (operation: string, body?: Record<string, unknown>) => Promise<Record<string, unknown>>;
  readonly sessionId: string;
  readonly inFlight: boolean;
  readonly messages: unknown[];
  readonly warnings: string[];
  readonly auditEntries: unknown[];
  readonly toolCount: number;
  prompt: () => Promise<void>;
  dispose: () => void;
}

function stubController(query: Record<string, Record<string, unknown>>): StubController {
  return {
    queryHostDomain: vi.fn(async (operation: string) => query[operation] ?? { ok: true }),
    commandHostDomain: vi.fn(async (operation: string) => query[operation] ?? { ok: true }),
    sessionId: "session-tui-extension-selector",
    inFlight: false,
    messages: [],
    warnings: [],
    auditEntries: [],
    toolCount: 0,
    prompt: async () => undefined,
    dispose: () => undefined,
  };
}

describe("TUI extension selectors query the Host snapshot", () => {
  it("/mcp shows connected servers from mcp.list instead of an empty placeholder", async () => {
    const terminal = new FakeTerminal();
    const agent = new Agent({
      initialState: { systemPrompt: "test", model: mockModel },
      streamFn: immediateStopStream(),
    });
    const mode = new InteractiveMode({ agent, terminal } as never);
    (mode as unknown as { controller: StubController }).controller = stubController({
      "mcp.list": { servers: [{ serverId: "stdio-server", transport: "stdio", state: "running", tools: ["a", "b"] }], toolCount: 2 },
    });

    await (mode as unknown as { openMcpServerSelector(): Promise<void> }).openMcpServerSelector();
    const tui = (mode as unknown as { ui: TUI }).ui;
    expect(tui.hasOverlay()).toBe(true);
  });

  it("/plugins /skills /hooks query the real extension snapshot descriptors", async () => {
    const terminal = new FakeTerminal();
    const agent = new Agent({
      initialState: { systemPrompt: "test", model: mockModel },
      streamFn: immediateStopStream(),
    });
    const mode = new InteractiveMode({ agent, terminal } as never);
    const controller = stubController({
      "plugin.list": { descriptors: [{ identity: { qualifiedId: "plugin:fixture" }, enabled: true, trusted: true, ready: true }] },
      "skill.list": { descriptors: [{ identity: { qualifiedId: "skill:fixture" }, enabled: true, trusted: true, activation: "ready" }] },
      "hook.list": { descriptors: [{ identity: { qualifiedId: "hook:pre-tool" }, enabled: true, trusted: true, ready: true }] },
    });
    (mode as unknown as { controller: StubController }).controller = controller;

    const tui = (mode as unknown as { ui: TUI }).ui;
    await (mode as unknown as { openExtensionSelector(op: "plugin.list" | "skill.list" | "hook.list", label: string, name: string): Promise<void> }).openExtensionSelector("plugin.list", "plugins", "/plugins");
    expect(tui.hasOverlay()).toBe(true);
    tui.hideOverlay();

    await (mode as unknown as { openExtensionSelector(op: "plugin.list" | "skill.list" | "hook.list", label: string, name: string): Promise<void> }).openExtensionSelector("skill.list", "skills", "/skills");
    expect(tui.hasOverlay()).toBe(true);
    tui.hideOverlay();

    await (mode as unknown as { openExtensionSelector(op: "plugin.list" | "skill.list" | "hook.list", label: string, name: string): Promise<void> }).openExtensionSelector("hook.list", "hooks", "/hooks");
    expect(tui.hasOverlay()).toBe(true);

    const query = controller.queryHostDomain as ReturnType<typeof vi.fn>;
    expect(query).toHaveBeenCalledWith("plugin.list", {});
    expect(query).toHaveBeenCalledWith("skill.list", {});
    expect(query).toHaveBeenCalledWith("hook.list", {});
  });

  it("fails visibly when the Host domain query is unavailable", async () => {
    const terminal = new FakeTerminal();
    const agent = new Agent({
      initialState: { systemPrompt: "test", model: mockModel },
      streamFn: immediateStopStream(),
    });
    const mode = new InteractiveMode({ agent, terminal } as never);
    const tui = (mode as unknown as { ui: TUI }).ui;
    // 本地 controller 无 queryHostDomain → typed notice，不抛错。
    await (mode as unknown as { openMcpServerSelector(): Promise<void> }).openMcpServerSelector();
    expect(tui.hasOverlay()).toBe(false);
  });
});

describe("TUI plan/compact/memory domain commands", () => {
  it("runs /plan /compact /memory queries through the Host domain channel", async () => {
    const terminal = new FakeTerminal();
    const agent = new Agent({
      initialState: { systemPrompt: "test", model: mockModel },
      streamFn: immediateStopStream(),
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

    const query = controller.queryHostDomain as ReturnType<typeof vi.fn>;
    expect(query).toHaveBeenCalledWith("plan.inspect", {});
    expect(query).toHaveBeenCalledWith("compaction.list", {});
    expect(query).toHaveBeenCalledWith("memory.inspect", {});
  });

  it("routes /remember proposal mutations through commandHostDomain", async () => {
    const terminal = new FakeTerminal();
    const agent = new Agent({
      initialState: { systemPrompt: "test", model: mockModel },
      streamFn: immediateStopStream(),
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

    const command = controller.commandHostDomain as ReturnType<typeof vi.fn>;
    expect(command).toHaveBeenCalledWith("memory.propose", expect.objectContaining({ content: "remember this", sourceKind: "user" }));
  });

  it("rejects plan/compact/memory commands without a Host connection", async () => {
    const terminal = new FakeTerminal();
    const agent = new Agent({
      initialState: { systemPrompt: "test", model: mockModel },
      streamFn: immediateStopStream(),
    });
    const mode = new InteractiveMode({ agent, terminal } as never);
    const run = mode as unknown as {
      runDomainCommand(operation: string, body: Record<string, unknown>, commandName: string, readOnly: boolean): Promise<void>;
    };
    // 本地 controller（无 Host 通道）→ typed notice，不抛错。
    await expect(run.runDomainCommand("plan.inspect", {}, "/plan", true)).resolves.toBeUndefined();
  });
});
