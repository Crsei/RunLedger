import { describe, expect, test, vi } from "vitest";
import {
  DeltaCoalescer,
  type StreamingDelta,
} from "../../src/tui/opentui/delta-coalescer.ts";
import {
  FrameScheduler,
  type FrameClock,
} from "../../src/tui/opentui/frame-scheduler.ts";
import { RenderCache } from "../../src/tui/opentui/render-cache.ts";
import { HeightIndex } from "../../src/tui/opentui/viewport-window.ts";
import { decideMarkdownProjection } from "../../src/tui/opentui/markdown-budget.ts";
import { TUI, type Terminal } from "../../src/tui/primitives.ts";
import { ChatContainer } from "../../src/tui/components/chat-container.ts";
import { InteractiveMode } from "../../src/tui/interactive-mode.ts";
import { Agent } from "../../src/runtime/agent.ts";
import { mockModel } from "../../src/runtime/providers/mock-stream.ts";
import { TuiPerformanceObserver } from "../../src/tui/opentui/performance-observer.ts";
import type { AssistantMessage } from "../../src/types.ts";
import type { TuiEvent } from "../../src/tui/types.ts";
import { SettingsResolver } from "../../src/storage/settings-resolver.ts";

class TestTerminal implements Terminal {
  readonly columns = 80;
  readonly rows = 24;
  readonly kittyProtocolActive = false;
  readonly writes: string[] = [];
  private resizeHandler: (() => void) | undefined;

  start(_onInput: (data: string) => void, onResize: () => void): void { this.resizeHandler = onResize; }
  stop(): void {}
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
  emitResize(): void { this.resizeHandler?.(); }
}

class TestClock implements FrameClock {
  private currentTime = 0;
  private nextId = 1;
  private readonly timers = new Map<number, { at: number; callback: () => void }>();

  now(): number {
    return this.currentTime;
  }

  setTimeout(callback: () => void, delayMs: number): number {
    const id = this.nextId++;
    this.timers.set(id, { at: this.currentTime + delayMs, callback });
    return id;
  }

  clearTimeout(handle: number): void {
    this.timers.delete(handle);
  }

  advance(delayMs: number): void {
    this.currentTime += delayMs;
    const ready = [...this.timers.entries()]
      .filter(([, timer]) => timer.at <= this.currentTime)
      .sort(([, left], [, right]) => left.at - right.at);
    for (const [id, timer] of ready) {
      this.timers.delete(id);
      timer.callback();
    }
  }
}

function assistantPartial(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: mockModel.api,
    provider: mockModel.provider,
    model: mockModel.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 0,
  };
}

describe("Plan 18 streaming state", () => {
  test("falls back to lossless plain text for an over-budget open code fence and upgrades after completion", () => {
    const content = "```ts\n123456789";
    const budget = {
      maxStreamingCharacters: 1_000,
      maxStreamingLines: 100,
      maxOpenFenceCharacters: 8,
    };
    const decision = decideMarkdownProjection(content, true, budget);
    expect(decision).toMatchObject({ mode: "plain-text", reason: "open-fence-limit", openFence: true });
    // policy 只选择 renderer，不返回或改写正文。
    expect(decideMarkdownProjection(content, false, budget)).toMatchObject({ mode: "markdown", openFence: true });
  });

  test("protects large tables and single lines with separate streaming budgets", () => {
    expect(decideMarkdownProjection("x".repeat(11), true, {
      maxStreamingCharacters: 10,
      maxStreamingLines: 100,
      maxOpenFenceCharacters: 100,
    })).toMatchObject({ mode: "plain-text", reason: "streaming-character-limit" });
    expect(decideMarkdownProjection("| a | b |\n| - | - |\n| 1 | 2 |\n| 3 | 4 |", true, {
      maxStreamingCharacters: 1_000,
      maxStreamingLines: 3,
      maxOpenFenceCharacters: 100,
    })).toMatchObject({ mode: "plain-text", reason: "streaming-line-limit", lines: 4 });
  });

  test("does not scan fence state after the character budget already selects plain text", () => {
    const decision = decideMarkdownProjection(`\`\`\`ts\n${"x".repeat(100)}`, true, {
      maxStreamingCharacters: 10,
      maxStreamingLines: 100,
      maxOpenFenceCharacters: 100,
    });
    expect(decision).toMatchObject({
      mode: "plain-text",
      reason: "streaming-character-limit",
      openFence: false,
    });
  });

  test("coalesces only adjacent lossless text and keeps latest supersedable status", () => {
    const coalescer = new DeltaCoalescer();
    const text = (value: string): StreamingDelta => ({
      kind: "append-text",
      entryId: "entry:assistant-1",
      partId: "part:markdown-1",
      generation: 1,
      text: value,
    });

    for (const character of "hello world") coalescer.push(text(character));
    coalescer.push({
      kind: "replace-status",
      key: "assistant:status",
      entryId: "entry:assistant-1",
      generation: 1,
      status: "thinking",
    });
    coalescer.push({
      kind: "replace-status",
      key: "assistant:status",
      entryId: "entry:assistant-1",
      generation: 1,
      status: "writing",
    });
    coalescer.push(text("!"));

    const drained = coalescer.drain();
    expect(drained).toHaveLength(3);
    expect(drained[0]).toMatchObject({ kind: "append-text", text: "hello world" });
    expect(drained[1]).toMatchObject({ kind: "replace-status", status: "writing" });
    expect(drained[2]).toMatchObject({ kind: "append-text", text: "!" });
    expect(coalescer.stats.mergedTextEvents).toBe(10);
    expect(coalescer.stats.supersededStatusEvents).toBe(1);
    expect(coalescer.queuedBytes).toBe(0);
  });

  test("10,000 one-character deltas stay lossless with one pending projection item", () => {
    const coalescer = new DeltaCoalescer();
    for (let index = 0; index < 10_000; index += 1) {
      coalescer.push({
        kind: "append-text",
        entryId: "entry:assistant-1",
        partId: "part:markdown-1",
        generation: 1,
        text: String.fromCharCode(65 + (index % 26)),
      });
    }

    const drained = coalescer.drain();
    expect(drained).toHaveLength(1);
    expect(drained[0]?.kind === "append-text" ? drained[0].text.length : 0).toBe(10_000);
    expect(coalescer.stats.mergedTextEvents).toBe(9_999);
  });

  test("does not let a new generation supersede a pending status from an older generation", () => {
    const coalescer = new DeltaCoalescer();
    coalescer.push({
      kind: "replace-status",
      key: "assistant:status",
      entryId: "entry:assistant-1",
      generation: 1,
      status: "old",
    });
    coalescer.push({
      kind: "replace-status",
      key: "assistant:status",
      entryId: "entry:assistant-1",
      generation: 2,
      status: "new",
    });

    expect(coalescer.drain()).toEqual([
      expect.objectContaining({ generation: 1, status: "old" }),
      expect.objectContaining({ generation: 2, status: "new" }),
    ]);
  });

  test("reports pressure without dropping accepted semantic text", () => {
    const pressureLevels: string[] = [];
    const coalescer = new DeltaCoalescer({
      softByteLimit: 4,
      hardByteLimit: 8,
      now: () => 100,
      onPressure: (snapshot) => pressureLevels.push(snapshot.level),
    });

    coalescer.push({
      kind: "append-text",
      entryId: "entry:assistant-1",
      partId: "part:markdown-1",
      generation: 1,
      text: "12345",
      receivedAt: 90,
    });
    coalescer.push({
      kind: "append-text",
      entryId: "entry:assistant-1",
      partId: "part:markdown-1",
      generation: 1,
      text: "67890",
      receivedAt: 95,
    });

    expect(coalescer.pressure.level).toBe("hard");
    expect(coalescer.pressure.queuedBytes).toBe(10);
    expect(coalescer.pressure.oldestAgeMs).toBe(10);
    expect(pressureLevels).toEqual(["soft", "hard"]);
    expect(coalescer.drain()[0]).toMatchObject({ kind: "append-text", text: "1234567890" });
  });

  test("schedules one frame window for a burst and force-flushes terminal work", () => {
    const clock = new TestClock();
    const reasons: string[] = [];
    const scheduler = new FrameScheduler({
      clock,
      frameWindowMs: 20,
      onFrame: (reason) => reasons.push(reason),
    });

    for (let i = 0; i < 10_000; i++) scheduler.markDirty();
    expect(reasons).toEqual([]);
    clock.advance(19);
    expect(reasons).toEqual([]);
    clock.advance(1);
    expect(reasons).toEqual(["window"]);

    scheduler.markDirty();
    scheduler.flush("terminal");
    expect(reasons).toEqual(["window", "terminal"]);
    clock.advance(100);
    expect(reasons).toEqual(["window", "terminal"]);
    scheduler.destroy();
  });

  test("schedules an animation frame through the shared scheduler without a private ticker", () => {
    const clock = new TestClock();
    const reasons: string[] = [];
    const scheduler = new FrameScheduler({
      clock,
      frameWindowMs: 20,
      onFrame: (reason) => reasons.push(reason),
    });

    scheduler.scheduleFrameIn(32);
    clock.advance(31);
    expect(reasons).toEqual([]);
    clock.advance(1);
    expect(reasons).toEqual(["scheduled"]);

    scheduler.scheduleFrameIn(32);
    scheduler.scheduleFrameIn(1);
    clock.advance(1);
    expect(reasons).toEqual(["scheduled", "scheduled"]);
    scheduler.destroy();
  });

  test("flushes early when backlog age or size crosses the fairness budget", () => {
    const clock = new TestClock();
    const reasons: string[] = [];
    const scheduler = new FrameScheduler({
      clock,
      frameWindowMs: 20,
      backlogLimits: { maxQueuedEvents: 32, maxQueuedBytes: 1024, maxOldestAgeMs: 50 },
      onFrame: (reason) => reasons.push(reason),
    });

    scheduler.markDirty({ queuedEvents: 40, queuedBytes: 0, oldestAgeMs: 0 });
    expect(reasons).toEqual(["force"]);
    scheduler.markDirty({ queuedEvents: 1, queuedBytes: 1, oldestAgeMs: 60 });
    expect(reasons).toEqual(["force", "force"]);
    scheduler.destroy();
  });

  test("TUI ordinary render requests share one application frame window", async () => {
    vi.useFakeTimers();
    try {
      const terminal = new TestTerminal();
      const tui = new TUI(terminal);
      let renders = 0;
      tui.addChild({
        render: () => {
          renders += 1;
          return [`frame ${renders}`];
        },
        invalidate: () => {},
      });

      await tui.start();
      expect(renders).toBe(1);
      for (let i = 0; i < 100; i++) tui.requestRender();
      expect(renders).toBe(1);
      vi.advanceTimersByTime(16);
      expect(renders).toBe(2);
      tui.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  test("TUI runs render-preparation hooks once per application frame", async () => {
    vi.useFakeTimers();
    try {
      const terminal = new TestTerminal();
      const tui = new TUI(terminal);
      let preparations = 0;
      tui.addBeforeRenderListener(() => { preparations += 1; });
      await tui.start();
      expect(preparations).toBe(1);
      for (let i = 0; i < 100; i++) tui.requestRender();
      vi.advanceTimersByTime(16);
      expect(preparations).toBe(2);
      tui.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  test("coalesces a resize storm into one scheduled application frame", async () => {
    vi.useFakeTimers();
    try {
      const terminal = new TestTerminal();
      const tui = new TUI(terminal);
      let renders = 0;
      tui.addChild({
        render: () => {
          renders += 1;
          return [`frame ${renders}`];
        },
        invalidate: () => {},
      });

      await tui.start();
      expect(renders).toBe(1);
      for (let index = 0; index < 20; index += 1) terminal.emitResize();
      expect(renders).toBe(1);
      vi.advanceTimersByTime(16);
      expect(renders).toBe(2);
      tui.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  test("ChatContainer assigns a stable entry key to a persistent component", () => {
    let content = "first";
    const chat = new ChatContainer();
    chat.push({
      present: () => [{ kind: "markdown", content, streaming: true }],
      render: () => [content],
      invalidate: () => {},
    });

    const first = chat.present(80)[0];
    content = "second";
    const second = chat.present(80)[0];
    expect(first?.id).toMatch(/^chat-/u);
    expect(second?.id).toBe(first?.id);
  });

  test("InteractiveMode forwards text_delta as the semantic append", () => {
    const agent = new Agent({
      initialState: { systemPrompt: "test", model: mockModel },
      streamFn: () => {
        throw new Error("stream not called");
      },
    });
    const mode = new InteractiveMode({ agent, terminal: new TestTerminal() });
    const handleEvent = Reflect.get(mode, "handleEvent");
    expect(typeof handleEvent).toBe("function");
    if (typeof handleEvent !== "function") return;
    const dispatch = (handleEvent as (event: TuiEvent) => void).bind(mode);
    dispatch({ type: "message_start", timestamp: 0, role: "assistant" });
    dispatch({
      type: "message_update",
      timestamp: 1,
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex: 0,
        delta: "a",
        partial: assistantPartial("a"),
      },
    });
    dispatch({
      type: "message_update",
      timestamp: 2,
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex: 0,
        delta: "b",
        // 这个 partial 故意只代表旧快照；正文语义来自 delta。
        partial: assistantPartial("a"),
      },
    });

    const refs = Reflect.get(mode, "refs") as { chat: ChatContainer };
    expect(refs.chat.present(80)).toContainEqual(expect.objectContaining({
      kind: "markdown",
      content: "ab",
    }));
  });

  test("InteractiveMode replaces streaming partial usage with the completed assistant usage", () => {
    const agent = new Agent({
      initialState: { systemPrompt: "test", model: mockModel },
      streamFn: () => {
        throw new Error("stream not called");
      },
    });
    const mode = new InteractiveMode({ agent, terminal: new TestTerminal() });
    const handleEvent = Reflect.get(mode, "handleEvent");
    expect(typeof handleEvent).toBe("function");
    if (typeof handleEvent !== "function") return;
    const dispatch = (handleEvent as (event: TuiEvent) => void).bind(mode);
    const message = (output: number): AssistantMessage => ({
      ...assistantPartial("partial"),
      usage: {
        input: 10,
        output,
        cacheRead: 20,
        cacheWrite: 2,
        totalTokens: 10 + output + 20 + 2,
        cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 },
        reported: { input: true, output: true, cacheRead: true, cacheWrite: true, cost: true },
      },
    });

    dispatch({ type: "message_start", timestamp: 100, role: "assistant" });
    dispatch({
      type: "message_update",
      timestamp: 200,
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex: 0,
        delta: "partial",
        partial: message(2),
      },
    });
    expect(mode.getUsageSnapshot().cumulative.output).toMatchObject({ state: "exact", value: 2 });

    dispatch({
      type: "message_update",
      timestamp: 300,
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex: 0,
        delta: "!",
        partial: message(3),
      },
    });
    expect(mode.getUsageSnapshot().cumulative.output).toMatchObject({ state: "exact", value: 3 });

    dispatch({
      type: "message_end",
      timestamp: 500,
      role: "assistant",
      stopReason: "stop",
      message: { ...message(4), durationMs: 400, timingSource: "provider" },
    });
    expect(mode.getUsageSnapshot().cumulative.output).toMatchObject({ state: "exact", value: 4 });
  });

  test("InteractiveMode ignores assistant usage events after the active run has ended", () => {
    const agent = new Agent({
      initialState: { systemPrompt: "test", model: mockModel },
      streamFn: () => {
        throw new Error("stream not called");
      },
    });
    const mode = new InteractiveMode({ agent, terminal: new TestTerminal() });
    const handleEvent = Reflect.get(mode, "handleEvent");
    expect(typeof handleEvent).toBe("function");
    if (typeof handleEvent !== "function") return;
    const dispatch = (handleEvent as (event: TuiEvent) => void).bind(mode);
    const message = (output: number): AssistantMessage => ({
      ...assistantPartial("reply"),
      usage: {
        input: 1,
        output,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 1 + output,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        reported: { input: true, output: true, cacheRead: true, cacheWrite: true, cost: true },
      },
    });

    dispatch({ type: "agent_start", timestamp: 1, runId: "run-current" });
    dispatch({ type: "message_start", timestamp: 2, role: "assistant" });
    dispatch({ type: "message_end", timestamp: 3, role: "assistant", stopReason: "stop", message: message(4) });
    dispatch({ type: "agent_end", timestamp: 4, runId: "run-current", stopReason: "stop" });
    const afterRun = mode.getUsageSnapshot().cumulative.output;
    expect(afterRun).toMatchObject({ state: "exact", value: 4 });

    dispatch({ type: "message_start", timestamp: 5, role: "assistant" });
    dispatch({ type: "message_end", timestamp: 6, role: "assistant", stopReason: "stop", message: message(99) });
    expect(mode.getUsageSnapshot().cumulative.output).toMatchObject({ state: "exact", value: 4 });
  });

  test("InteractiveMode ignores a stale run generation while a newer run is active", () => {
    const agent = new Agent({
      initialState: { systemPrompt: "test", model: mockModel },
      streamFn: () => {
        throw new Error("stream not called");
      },
    });
    const mode = new InteractiveMode({ agent, terminal: new TestTerminal() });
    const handleEvent = Reflect.get(mode, "handleEvent");
    expect(typeof handleEvent).toBe("function");
    if (typeof handleEvent !== "function") return;
    const dispatch = (handleEvent as (event: TuiEvent) => void).bind(mode);
    const message = (output: number): AssistantMessage => ({
      ...assistantPartial("reply"),
      usage: {
        input: 1,
        output,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 1 + output,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        reported: { input: true, output: true, cacheRead: true, cacheWrite: true, cost: true },
      },
    });

    dispatch({ type: "agent_start", timestamp: 1, runId: "run-old" });
    dispatch({ type: "message_start", timestamp: 2, role: "assistant", runId: "run-old" } as TuiEvent);
    dispatch({ type: "message_end", timestamp: 3, role: "assistant", stopReason: "stop", message: message(4), runId: "run-old" } as TuiEvent);
    dispatch({ type: "agent_end", timestamp: 4, runId: "run-old", stopReason: "stop" });
    dispatch({ type: "agent_start", timestamp: 5, runId: "run-new" });

    dispatch({ type: "message_start", timestamp: 6, role: "assistant", runId: "run-old" } as TuiEvent);
    dispatch({ type: "message_end", timestamp: 7, role: "assistant", stopReason: "stop", message: message(99), runId: "run-old" } as TuiEvent);
    expect(mode.getUsageSnapshot().cumulative.output).toMatchObject({ state: "exact", value: 4 });
  });

  test("InteractiveMode queues streaming deltas until the shared frame preparation phase", async () => {
    vi.useFakeTimers();
    try {
      const agent = new Agent({
        initialState: { systemPrompt: "test", model: mockModel },
        streamFn: () => {
          throw new Error("stream not called");
        },
      });
      const mode = new InteractiveMode({ agent, terminal: new TestTerminal() });
      const runPromise = mode.run();
      await Promise.resolve();
      const handleEvent = Reflect.get(mode, "handleEvent");
      expect(typeof handleEvent).toBe("function");
      if (typeof handleEvent !== "function") return;
      const dispatch = (handleEvent as (event: TuiEvent) => void).bind(mode);
      dispatch({ type: "message_start", timestamp: 0, role: "assistant" });
      dispatch({
        type: "message_update",
        timestamp: 1,
        assistantMessageEvent: {
          type: "text_delta",
          contentIndex: 0,
          delta: "a",
          partial: assistantPartial("a"),
        },
      });
      dispatch({
        type: "message_update",
        timestamp: 2,
        assistantMessageEvent: {
          type: "text_delta",
          contentIndex: 0,
          delta: "b",
          partial: assistantPartial("a"),
        },
      });

      const refs = Reflect.get(mode, "refs") as { chat: ChatContainer };
      expect(refs.chat.present(80)).not.toContainEqual(expect.objectContaining({ content: "ab" }));
      vi.advanceTimersByTime(16);
      expect(refs.chat.present(80)).toContainEqual(expect.objectContaining({ content: "ab" }));
      mode.quit();
      await runPromise;
    } finally {
      vi.useRealTimers();
    }
  });

  test("display.smoothStreaming=false flushes each streaming delta immediately", async () => {
    const agent = new Agent({
      initialState: { systemPrompt: "test", model: mockModel },
      streamFn: () => {
        throw new Error("stream not called");
      },
    });
    const mode = new InteractiveMode({
      agent,
      terminal: new TestTerminal(),
      runtimeSettings: new SettingsResolver({ user: { display: { smoothStreaming: false } } }).effectiveRuntimeSnapshot(),
    });
    const runPromise = mode.run();
    await Promise.resolve();
    const handleEvent = Reflect.get(mode, "handleEvent");
    expect(typeof handleEvent).toBe("function");
    if (typeof handleEvent !== "function") return;
    const dispatch = (handleEvent as (event: TuiEvent) => void).bind(mode);
    dispatch({ type: "message_start", timestamp: 0, role: "assistant" });
    dispatch({
      type: "message_update",
      timestamp: 1,
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex: 0,
        delta: "immediate",
        partial: assistantPartial("immediate"),
      },
    });

    const refs = Reflect.get(mode, "refs") as { chat: ChatContainer };
    expect(refs.chat.present(80)).toContainEqual(expect.objectContaining({ content: "immediate" }));
    mode.quit();
    await runPromise;
  });

  test("terminal assistant event drains pending text before finalizing without duplicating the partial", async () => {
    vi.useFakeTimers();
    try {
      const agent = new Agent({
        initialState: { systemPrompt: "test", model: mockModel },
        streamFn: () => {
          throw new Error("stream not called");
        },
      });
      const mode = new InteractiveMode({ agent, terminal: new TestTerminal() });
      const runPromise = mode.run();
      await Promise.resolve();
      const handleEvent = Reflect.get(mode, "handleEvent");
      if (typeof handleEvent !== "function") return;
      const dispatch = (handleEvent as (event: TuiEvent) => void).bind(mode);
      dispatch({ type: "message_start", timestamp: 0, role: "assistant" });
      dispatch({
        type: "message_update",
        timestamp: 1,
        assistantMessageEvent: {
          type: "text_delta",
          contentIndex: 0,
          delta: "ab",
          partial: assistantPartial("a"),
        },
      });
      dispatch({
        type: "message_end",
        timestamp: 2,
        role: "assistant",
        stopReason: "stop",
        message: assistantPartial("ab"),
      });

      const refs = Reflect.get(mode, "refs") as { chat: ChatContainer };
      expect(refs.chat.present(80)).toContainEqual(expect.objectContaining({
        kind: "markdown",
        content: "ab",
        streaming: false,
      }));
      vi.advanceTimersByTime(32);
      expect(refs.chat.present(80)).toContainEqual(expect.objectContaining({ content: "ab" }));
      mode.quit();
      await runPromise;
    } finally {
      vi.useRealTimers();
    }
  });

  test("InteractiveMode reports accepted and coalesced streaming queue work", async () => {
    vi.useFakeTimers();
    try {
      const observer = new TuiPerformanceObserver();
      const agent = new Agent({
        initialState: { systemPrompt: "test", model: mockModel },
        streamFn: () => {
          throw new Error("stream not called");
        },
      });
      const mode = new InteractiveMode({ agent, terminal: new TestTerminal(), performanceObserver: observer });
      const runPromise = mode.run();
      await Promise.resolve();
      const handleEvent = Reflect.get(mode, "handleEvent");
      if (typeof handleEvent !== "function") return;
      const dispatch = (handleEvent as (event: TuiEvent) => void).bind(mode);
      dispatch({ type: "message_start", timestamp: 0, role: "assistant" });
      for (const delta of ["a", "b"]) {
        dispatch({
          type: "message_update",
          timestamp: 1,
          assistantMessageEvent: {
            type: "text_delta",
            contentIndex: 0,
            delta,
            partial: assistantPartial(delta),
          },
        });
      }
      expect(observer.snapshot()).toMatchObject({ queuedEvents: 2, coalescedTextEvents: 1 });
      mode.quit();
      await runPromise;
    } finally {
      vi.useRealTimers();
    }
  });

  test("performance observer separates queue, projection, and native frame counters", () => {
    const observer = new TuiPerformanceObserver();
    observer.recordQueued({ events: 4, bytes: 12 });
    observer.recordQueueDepth({ events: 2, bytes: 8, oldestAgeMs: 7, pressureLevel: "soft" });
    observer.recordQueueDepth({ events: 0, bytes: 0, oldestAgeMs: 0, pressureLevel: "normal" });
    observer.recordCoalesced({ textEvents: 3, supersededStatusEvents: 1 });
    observer.recordProjection({ durationMs: 4.5, processedChars: 12, dirtyEntries: 1 });
    observer.recordProjection({ durationMs: 9.5, processedChars: 3, dirtyEntries: 2 });
    observer.recordNativeFrame({ durationMs: 2.25, cellsUpdated: 18 });
    observer.recordGenerationDiscard();

    expect(observer.snapshot()).toEqual({
      queuedEvents: 4,
      queuedBytes: 12,
      currentQueuedEvents: 0,
      currentQueuedBytes: 0,
      oldestQueueAgeMs: 0,
      peakQueuedEvents: 2,
      peakQueuedBytes: 8,
      pressureLevel: "normal",
      pressureEvents: 2,
      coalescedTextEvents: 3,
      supersededStatusEvents: 1,
      projectionCount: 2,
      projectionChars: 15,
      projectionTimeMs: 14,
      dirtyEntryCount: 3,
      nativeFrameCount: 1,
      nativeFrameTimeMs: 2.25,
      nativeCellsUpdated: 18,
      generationDiscardCount: 1,
      mermaidProjectionCount: 0,
      mermaidProjectionTimeMs: 0,
      mermaidCacheHits: 0,
      mermaidCacheMisses: 0,
      mermaidCacheEntries: 0,
      mermaidCacheBytes: 0,
      mermaidCacheEvictions: 0,
      mermaidCacheOversized: 0,
      mermaidFallbackCount: 0,
	  highlightRequests: 0,
	  highlightOk: 0,
	  highlightFallbacks: 0,
	  highlightCacheHits: 0,
	  highlightCacheMisses: 0,
	  highlightCacheEvictions: 0,
		  highlightDurationMs: 0,
		  highlightQueueWaitMs: 0,
		  highlightNativeDurationMs: 0,
		  highlightAdapterDurationMs: 0,
		  highlightFallbackReasons: {
		    empty: 0,
		    unknown_language: 0,
		    oversize_bytes: 0,
		    oversize_lines: 0,
		    native_unavailable: 0,
		    theme_invalid: 0,
		    highlight_error: 0,
		    timeout: 0,
		    queue_pressure: 0,
		    stale_generation: 0,
		  },
	  highlightInputBytes: 0,
	  highlightInputLines: 0,
	  highlightActiveJobs: 0,
	  highlightQueuedJobs: 0,
	  highlightQueuedBytes: 0,
	  highlightCacheEntries: 0,
	  highlightCacheBytes: 0,
		  highlightCacheSpans: 0,
		  highlightThemeRevision: 0,
		  highlightEngineBuildId: "native-unavailable",
    });
  });

  test("records Mermaid cache latency and bounded cache counters in the shared observer", () => {
    const observer = new TuiPerformanceObserver();
    observer.recordMermaidProjection({ durationMs: 3.5, cacheHit: false, fallback: false });
    observer.recordMermaidProjection({ durationMs: 0.5, cacheHit: true, fallback: true });
    observer.recordMermaidCache({ entries: 4, bytes: 512, evictions: 2, oversized: 1 });

    expect(observer.snapshot()).toMatchObject({
      mermaidProjectionCount: 2,
      mermaidProjectionTimeMs: 4,
      mermaidCacheHits: 1,
      mermaidCacheMisses: 1,
      mermaidCacheEntries: 4,
      mermaidCacheBytes: 512,
      mermaidCacheEvictions: 2,
      mermaidCacheOversized: 1,
      mermaidFallbackCount: 1,
    });
  });

  test("render cache keys width/theme/generation and evicts derived output by budget", () => {
    const cache = new RenderCache<string>({ maxEntries: 2, maxBytes: 6 });
    const baseKey = {
      entryId: "entry-1",
      partId: "part-1",
      width: 80,
      contentGeneration: 1,
      themeGeneration: 1,
    };

    cache.set(baseKey, "abc", 3);
    expect(cache.get(baseKey)).toBe("abc");
    expect(cache.get({ ...baseKey, partId: "part-2" })).toBeUndefined();
    expect(cache.get({ ...baseKey, width: 100 })).toBeUndefined();
    cache.set({ ...baseKey, entryId: "entry-2" }, "def", 3);
    cache.set({ ...baseKey, entryId: "entry-3" }, "ghi", 3);

    expect(cache.get(baseKey)).toBeUndefined();
    expect(cache.snapshot()).toMatchObject({ entries: 2, bytes: 6, evictions: 1, misses: 3 });
    cache.invalidateGenerationBelow(2);
    expect(cache.snapshot().entries).toBe(0);
  });

  test("height index returns visible overscan window and preserves scroll anchors", () => {
    const index = new HeightIndex([2, 3, 4, 5, 6]);
    expect(index.totalHeight).toBe(20);
    expect(index.findIndexAtOffset(0)).toBe(0);
    expect(index.findIndexAtOffset(5)).toBe(2);
    expect(index.getWindow({ scrollTop: 5, viewportHeight: 5, overscan: 2 })).toMatchObject({
      start: 2,
      end: 4,
      overscanStart: 1,
      overscanEnd: 4,
    });

    const anchor = index.captureAnchor(3, 1);
    index.update(1, 8);
    expect(index.restoreAnchor(anchor)).toBe(15);
  });
});
