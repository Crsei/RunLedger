import { CodeRenderable, type Renderable } from "@opentui/core";
import { requireNode, MarkdownRenderable, BoxRenderable, ScrollBoxRenderable, TextRenderable, TextareaRenderable } from "./fixtures/opentui-nodes.ts";
import { describe, expect, spyOn, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import stringWidth from "string-width";
import stripAnsi from "strip-ansi";
import {
  createOpenTuiComponentRuntimeFromRenderer,
  type OpenTuiComponentFrame,
} from "../../src/tui/opentui/component-runtime.ts";
import { TuiPerformanceObserver } from "../../src/tui/opentui/performance-observer.ts";
import { ChatContainer } from "../../src/tui/components/chat-container.ts";
import { rowToBlocks } from "../../src/tui/timeline/selectors.ts";
import type { TimelineRow } from "../../src/tui/timeline/types.ts";
import { editorHeight } from "../../src/tui/editor-height.ts";
import { editorBackgroundFromTerminal } from "../../src/tui/theme/editor-background.ts";
import { loadTheme } from "../../src/tui/theme/theme.ts";
import { TUI, ProcessTerminal } from "../../src/tui/primitives.ts";
import { resolveUiTheme } from "../../src/tui/theme/ui-theme.ts";
import { makeSelectListTheme } from "../../src/tui/theme/factories.ts";
import { SlashCommandPopup } from "../../src/tui/components/slash-command-popup.ts";
import { builtinCommandDescriptors } from "../../src/tui/commands/registry.ts";
import { PermissionRequestView } from "../../src/tui/components/permission-request-view.ts";
import { approvalChoices, parseApprovalReverseRequest } from "../../src/tui/approval.ts";
import { RenderableRegistry } from "../../src/tui/opentui/component-runtime/renderable-registry.ts";

describe("OpenTUI component projection", () => {
  test("animates status and footer without historical projection and falls back on layout changes", async () => {
    const setup = await createTestRenderer({ width: 80, height: 18 });
    const runtime = createOpenTuiComponentRuntimeFromRenderer(setup.renderer, { onInput: () => {}, onResize: () => {} });
    const status = { indicator: "•", header: "Working", elapsed: "1s" };
    const frame = { body: [{ id: "historical", kind: "text" as const, content: "historical output" }], editorText: "draft", footer: ["footer"], statusIndicator: status };
    const reconcile = spyOn(RenderableRegistry.prototype, "reconcile");
    try {
      runtime.update(frame);
      await setup.renderOnce();
      const body = requireNode(setup.renderer.root, "runledger-block-historical", TextRenderable);
      const bodyId = body.num;
      reconcile.mockClear();
      for (let tick = 2; tick <= 20; tick++) {
        expect(runtime.updateStatusFrame?.({ statusIndicator: { ...status, elapsed: `${tick}s` }, footer: [`footer ${tick}s`] })).toBe(true);
      }
      await setup.renderOnce();
      expect(reconcile).not.toHaveBeenCalled();
      expect(runtime.getLastDirtyPartIds()).toEqual([]);
      expect(requireNode(setup.renderer.root, "runledger-block-historical", TextRenderable).num).toBe(bodyId);
      expect(setup.captureCharFrame()).toContain("historical output");
      expect(setup.captureCharFrame()).toContain("20s");
      expect(setup.captureCharFrame()).toContain("draft");
      expect(setup.captureCharFrame()).toContain("footer 20s");
      expect(runtime.updateStatusFrame?.({ statusIndicator: status, footer: ["footer", "second row"] })).toBe(false);
      expect(runtime.updateStatusFrame?.({ statusIndicator: undefined, footer: frame.footer })).toBe(false);
      runtime.update({ ...frame, statusIndicator: undefined });
      await setup.renderOnce();
      expect(reconcile).toHaveBeenCalledTimes(1);
      expect(setup.captureCharFrame()).not.toContain("Working");
    } finally { reconcile.mockRestore(); runtime.destroy(); }
  });

  test("renders submitted user background and cyan inline commands and file links", async () => {
    const setup = await createTestRenderer({ width: 80, height: 18 });
    const runtime = createOpenTuiComponentRuntimeFromRenderer(setup.renderer, { onInput: () => {}, onResize: () => {} });
    const row: TimelineRow = { kind: "user", id: "sent", timestamp: "2026-09-05T00:00:00.000Z", displayOrder: 0, status: "succeeded", text: { text: "submitted prompt", truncated: false, byteLength: 16 } };
    try {
      for (const mode of ["dark", "light"] as const) {
        setup.renderer.emit("theme_mode", mode);
        const theme = loadTheme(mode);
        runtime.update({
          body: [...rowToBlocks(row), { id: "reply", kind: "markdown", content: "Run `npm test` and open [source](src/index.ts:12).", streaming: false }],
          editorText: "", footer: ["identity "+"x".repeat(72), { kind: "status-line", segments: [{ accent: "usage", text: "$0.03" }] }],
          editorAppearance: { backgroundColor: theme.editorBackground, promptColor: theme.accent, placeholderColor: theme.muted },
        });
        await setup.renderOnce();
        const node = requireNode(setup.renderer.root, "runledger-block-timeline-sent", TextRenderable);
        const expectedBackground = mode === "dark" ? [40, 42, 48] : [244, 244, 244];
        expect(node.bg.toInts().slice(0, 3)).toEqual(expectedBackground);
        const waitForHighlights = async (node: Renderable): Promise<void> => {
          if (node instanceof CodeRenderable) await node.highlightingDone;
          for (const child of node.getChildren()) await waitForHighlights(child);
        };
        for (let pass = 0; pass < 3; pass++) {
          await waitForHighlights(setup.renderer.root);
          await setup.renderOnce();
        }
        expect(setup.captureCharFrame()).toContain("$0.03");
        const userLine = setup.captureSpans().lines.find((line) => line.spans.some((span) => span.text.includes("submitted prompt")));
        expect(userLine?.spans.every((span) => span.bg.toInts().slice(0, 3).join(",") === expectedBackground.join(","))).toBe(true);
        const spans = setup.captureSpans().lines.flatMap((line) => line.spans);
        for (const label of ["npm test", "source", "src/index.ts:12"]) {
          expect(spans.find((span) => span.text.includes(label))?.fg.toInts().slice(0, 3)).toEqual(mode === "dark" ? [125, 207, 255] : [0, 102, 204]);
        }
      }
    } finally { runtime.destroy(); setup.renderer.destroy(); }
  });

  test("keeps the native transcript scrollbar hidden by default and reserves space only when enabled", async () => {
    const setup = await createTestRenderer({ width: 40, height: 10 });
    const runtime = createOpenTuiComponentRuntimeFromRenderer(setup.renderer, {
      onInput: () => {},
      onResize: () => {},
    });
    const body = Array.from({ length: 30 }, (_, index) => ({
      id: `scrollbar-entry-${index}`,
      kind: "text" as const,
      content: `entry ${index} ${"x".repeat(24)}`,
    }));
    try {
      runtime.update({
        body,
        editorText: "draft",
        footer: ["idle"],
        transcriptScrollPresentation: {
          visible: false,
          trackColor: "#112233",
          thumbColor: "#445566",
        },
      } as Parameters<typeof runtime.update>[0]);
      await setup.renderOnce();
      const transcript = requireNode(setup.renderer.root, "runledger-transcript", ScrollBoxRenderable);
      expect(transcript.verticalScrollBar.visible).toBe(false);
      const transcriptId = transcript.num;
      const editorId = requireNode(setup.renderer.root, "runledger-editor", TextareaRenderable).num;
      const firstBodyId = requireNode(setup.renderer.root, "runledger-block-scrollbar-entry-0", TextRenderable).num;
      const hiddenBodyWidth = transcript.getChildren()[0]?.width;

      runtime.update({
        body,
        editorText: "draft",
        footer: ["idle"],
        transcriptScrollPresentation: {
          visible: true,
          trackColor: "#112233",
          thumbColor: "#445566",
        },
      } as Parameters<typeof runtime.update>[0]);
      await setup.renderOnce();

      expect(transcript.verticalScrollBar.visible).toBe(true);
      expect(transcript.verticalScrollBar.x + transcript.verticalScrollBar.width).toBe(40);
      expect(transcript.verticalScrollBar.slider.x).toBe(39);
      expect(transcript.getChildren()[0]?.width).toBeLessThan(hiddenBodyWidth ?? 0);
      expect(transcript.num).toBe(transcriptId);
      expect(requireNode(setup.renderer.root, "runledger-editor", TextareaRenderable).num).toBe(editorId);
      expect(requireNode(setup.renderer.root, "runledger-block-scrollbar-entry-0", TextRenderable).num).toBe(firstBodyId);
    } finally {
      runtime.destroy();
    }
  });

  test("updates the existing native scrollbar colors from a later frame", async () => {
    const setup = await createTestRenderer({ width: 40, height: 10 });
    const runtime = createOpenTuiComponentRuntimeFromRenderer(setup.renderer, {
      onInput: () => {},
      onResize: () => {},
    });
    const frame = (trackColor: string, thumbColor: string) => ({
      body: Array.from({ length: 30 }, (_, index) => `theme entry ${index}`),
      editorText: "",
      footer: [],
      transcriptScrollPresentation: { visible: true, trackColor, thumbColor },
    });
    try {
      runtime.update(frame("#112233", "#445566") as Parameters<typeof runtime.update>[0]);
      await setup.renderOnce();
      const transcript = requireNode(setup.renderer.root, "runledger-transcript", ScrollBoxRenderable);
      const barId = transcript.verticalScrollBar.num;
      expect(transcript.verticalScrollBar.slider.backgroundColor.toInts()).toEqual([17, 34, 51, 255]);
      expect(transcript.verticalScrollBar.slider.foregroundColor.toInts()).toEqual([68, 85, 102, 255]);

      runtime.update(frame("#223344", "#667788") as Parameters<typeof runtime.update>[0]);
      await setup.renderOnce();
      expect(transcript.verticalScrollBar.num).toBe(barId);
      expect(transcript.verticalScrollBar.slider.backgroundColor.toInts()).toEqual([34, 51, 68, 255]);
      expect(transcript.verticalScrollBar.slider.foregroundColor.toInts()).toEqual([102, 119, 136, 255]);
    } finally {
      runtime.destroy();
    }
  });

  test("carries explicit UI colors and OSC 11 background through TUI frame assembly", async () => {
    const setup = await createTestRenderer({ width: 40, height: 10 });
    const runtime = createOpenTuiComponentRuntimeFromRenderer(setup.renderer, { onInput: () => {}, onResize: () => {} });
    const tui = new TUI(new ProcessTerminal());
    // 使用真实帧组装与渲染器，仅替换终端启动以保持测试隔离。
    Reflect.set(tui, "runtime", runtime);
    const render = async () => { Reflect.get(tui, "renderFrame").call(tui); await setup.renderOnce(); };
    const screen = requireNode(setup.renderer.root, "runledger-screen", BoxRenderable);
    try {
      tui.setUiTheme(resolveUiTheme({}, "dark", {}));
      await render();
      expect(screen.backgroundColor.toInts().slice(0, 3)).toEqual([11, 14, 20]);
      tui.setTerminalBackground({ r: 26, g: 43, b: 60 });
      tui.showOverlay({ render: () => ["overlay"], invalidate: () => {} });
      await render();
      expect(screen.backgroundColor.toInts().slice(0, 3)).toEqual([26, 43, 60]);
      const overlay = requireNode(setup.renderer.root, "runledger-overlay", BoxRenderable);
      expect(overlay.backgroundColor.toInts().slice(0, 3)).toEqual([26, 43, 60]);
      tui.setUiTheme(resolveUiTheme({ colors: { common: { background: "#222222", primary: "#abcdef" } } }, "dark", {}));
      await render();
      expect(screen.backgroundColor.toInts().slice(0, 3)).toEqual([34, 34, 34]);
      expect(overlay.backgroundColor.toInts().slice(0, 3)).toEqual([34, 34, 34]);
      const text = requireNode(setup.renderer.root, "runledger-overlay-content-0", TextRenderable);
      expect(text.fg.toInts().slice(0, 3)).toEqual([171, 205, 239]);
      tui.setTerminalBackground(undefined);
      await render();
      expect(screen.backgroundColor.toInts().slice(0, 3)).toEqual([34, 34, 34]);
    } finally { runtime.destroy(); }
  });

  test("uses the native track and thumb to update the transcript scrollTop", async () => {
    const setup = await createTestRenderer({ width: 40, height: 12 });
    const runtime = createOpenTuiComponentRuntimeFromRenderer(setup.renderer, {
      onInput: () => {},
      onResize: () => {},
    });
    try {
      runtime.update({
        body: Array.from({ length: 80 }, (_, index) => ({
          id: `mouse-entry-${index}`,
          kind: "text" as const,
          content: `mouse entry ${index}`,
        })),
        editorText: "draft",
        footer: ["idle"],
        transcriptScrollPresentation: {
          visible: true,
          trackColor: "#112233",
          thumbColor: "#445566",
        },
      });
      await setup.renderOnce();
      const transcript = requireNode(setup.renderer.root, "runledger-transcript", ScrollBoxRenderable);
      transcript.scrollTop = 0;
      await setup.renderOnce();
      const slider = transcript.verticalScrollBar.slider;
      const maxScrollTop = transcript.scrollHeight - transcript.viewport.height;
      expect(maxScrollTop).toBeGreaterThan(0);
      expect(slider.height).toBeGreaterThan(2);

      await setup.mockMouse.click(slider.x, slider.y + slider.height - 1);
      await setup.renderOnce();
      const trackPosition = transcript.scrollTop;
      expect(trackPosition).toBeGreaterThan(0);
      expect(trackPosition).toBeLessThanOrEqual(maxScrollTop);

      transcript.scrollTop = 0;
      await setup.renderOnce();
      await setup.mockMouse.drag(slider.x, slider.y, slider.x, slider.y + slider.height - 1);
      await setup.renderOnce();
      expect(transcript.scrollTop).toBeGreaterThan(trackPosition);
      expect(transcript.scrollTop).toBeLessThanOrEqual(maxScrollTop);
    } finally {
      runtime.destroy();
    }
  });

  test("keeps wheel and PageUp behavior identical while the scrollbar is hidden", async () => {
    const setup = await createTestRenderer({ width: 40, height: 12 });
    const runtime = createOpenTuiComponentRuntimeFromRenderer(setup.renderer, {
      onInput: () => {},
      onResize: () => {},
    });
    const body = Array.from({ length: 60 }, (_, index) => ({
      id: `hidden-entry-${index}`,
      kind: "text" as const,
      content: `hidden entry ${index}`,
    }));
    try {
      runtime.update({
        body,
        editorText: "draft",
        footer: ["idle"],
        transcriptScrollPresentation: { visible: false, trackColor: "#112233", thumbColor: "#445566" },
      });
      await setup.renderOnce();
      const transcript = requireNode(setup.renderer.root, "runledger-transcript", ScrollBoxRenderable);
      const bottom = transcript.scrollTop;
      await setup.mockMouse.scroll(10, 10, "up");
      await setup.renderOnce();
      expect(transcript.scrollTop).toBeLessThan(bottom);
      const afterWheel = transcript.scrollTop;
      setup.mockInput.pressKey("\x1b[5~");
      await setup.renderOnce();
      expect(transcript.scrollTop).toBeLessThan(afterWheel);
      expect(requireNode(setup.renderer.root, "runledger-editor", TextareaRenderable).plainText).toBe("draft");
    } finally {
      runtime.destroy();
    }
  });

  test("recomputes native scrollbar geometry across resize without rebuilding content", async () => {
    const setup = await createTestRenderer({ width: 60, height: 14 });
    const runtime = createOpenTuiComponentRuntimeFromRenderer(setup.renderer, {
      onInput: () => {},
      onResize: () => {},
    });
    try {
      runtime.update({
        body: Array.from({ length: 100 }, (_, index) => ({
          id: `resize-entry-${index}`,
          kind: "text" as const,
          content: `resize entry ${index} ${"wide content ".repeat(4)}`,
        })),
        editorText: "draft",
        footer: ["idle"],
        transcriptScrollPresentation: { visible: true, trackColor: "#112233", thumbColor: "#445566" },
      });
      await setup.renderOnce();
      const transcript = requireNode(setup.renderer.root, "runledger-transcript", ScrollBoxRenderable);
      const first = requireNode(setup.renderer.root, "runledger-block-resize-entry-0", TextRenderable);
      transcript.scrollTop = 0;
      await setup.renderOnce();
      const firstId = first?.num;
      const narrowScrollSize = transcript.verticalScrollBar.scrollSize;
      const narrowViewportSize = transcript.verticalScrollBar.viewportSize;

      setup.resize(143, 18);
      await setup.renderOnce();
      expect(transcript.verticalScrollBar.x + transcript.verticalScrollBar.width).toBe(143);
      expect(transcript.verticalScrollBar.viewportSize).not.toBe(narrowViewportSize);
      expect(transcript.verticalScrollBar.scrollSize).toBeLessThan(narrowScrollSize);
      expect(requireNode(setup.renderer.root, "runledger-block-resize-entry-0", TextRenderable).num).toBe(firstId);
      expect(transcript.scrollTop).toBe(0);

      setup.resize(40, 12);
      await setup.renderOnce();
      expect(transcript.verticalScrollBar.x + transcript.verticalScrollBar.width).toBe(40);
      expect(transcript.verticalScrollBar.scrollPosition).toBe(transcript.scrollTop);
      expect(requireNode(setup.renderer.root, "runledger-editor", TextareaRenderable).plainText).toBe("draft");
    } finally {
      runtime.destroy();
    }
  });

  test("keeps reader position and native selection separate while toggling or dragging the scrollbar", async () => {
    const setup = await createTestRenderer({ width: 60, height: 12 });
    const copy = spyOn(setup.renderer, "copyToClipboardOSC52").mockReturnValue(true);
    const runtime = createOpenTuiComponentRuntimeFromRenderer(setup.renderer, {
      onInput: () => {},
      onResize: () => {},
    });
    const body = Array.from({ length: 80 }, (_, index) => ({
      id: `selection-entry-${index}`,
      kind: "text" as const,
      content: `selectable entry ${index}`,
    }));
    const frame = (visible: boolean) => ({
      body,
      editorText: "draft",
      footer: ["idle"],
      transcriptScrollPresentation: { visible, trackColor: "#112233", thumbColor: "#445566" },
    });
    try {
      runtime.update(frame(false));
      await setup.renderOnce();
      const transcript = requireNode(setup.renderer.root, "runledger-transcript", ScrollBoxRenderable);
      transcript.scrollTop = 10;
      await setup.renderOnce();

      runtime.update(frame(true));
      await setup.renderOnce();
      expect(transcript.scrollTop).toBe(10);
      await setup.mockMouse.drag(
        transcript.verticalScrollBar.slider.x,
        transcript.verticalScrollBar.slider.y,
        transcript.verticalScrollBar.slider.x,
        transcript.verticalScrollBar.slider.y + transcript.verticalScrollBar.slider.height - 1,
      );
      await setup.renderOnce();
      expect(transcript.scrollTop).toBeGreaterThan(10);
      expect(setup.renderer.getSelection()?.getSelectedText() ?? "").toBe("");
      expect(copy).not.toHaveBeenCalled();

      transcript.scrollTop = 0;
      await setup.renderOnce();
      await setup.mockMouse.drag(0, 0, 16, 0);
      expect(setup.renderer.getSelection()?.getSelectedText()).toContain("selectable entry");
      expect(copy).toHaveBeenCalled();
    } finally {
      copy.mockRestore();
      runtime.destroy();
    }
  });

  test("capturing overlays prevent the transcript scrollbar from consuming mouse input", async () => {
    const setup = await createTestRenderer({ width: 60, height: 14 });
    const runtime = createOpenTuiComponentRuntimeFromRenderer(setup.renderer, {
      onInput: () => {},
      onResize: () => {},
    });
    try {
      runtime.update({
        body: Array.from({ length: 80 }, (_, index) => `overlay entry ${index}`),
        editorText: "draft",
        footer: ["idle"],
        overlay: [{ id: "modal", kind: "text", content: "capturing modal" }],
        overlayAnchor: "center",
        transcriptScrollPresentation: { visible: true, trackColor: "#112233", thumbColor: "#445566" },
      });
      await setup.renderOnce();
      const transcript = requireNode(setup.renderer.root, "runledger-transcript", ScrollBoxRenderable);
      transcript.scrollTop = 0;
      await setup.renderOnce();
      const before = transcript.scrollTop;

      await setup.mockMouse.click(
        transcript.verticalScrollBar.slider.x,
        transcript.verticalScrollBar.slider.y + transcript.verticalScrollBar.slider.height - 1,
      );
      await setup.renderOnce();
      expect(transcript.scrollTop).toBe(before);
    } finally {
      runtime.destroy();
    }
  });
  test("wraps complete canonical Timeline user/assistant/thinking content at narrow width", async () => {
    const setup = await createTestRenderer({ width: 40, height: 30 });
    const runtime = createOpenTuiComponentRuntimeFromRenderer(setup.renderer, { onInput: () => {}, onResize: () => {} });
    const bounded = (text: string) => ({ text, truncated: false, byteLength: new TextEncoder().encode(text).byteLength });
    const rows: TimelineRow[] = [
      { kind: "user", id: "user:0", timestamp: "2026-08-09T00:00:00.000Z", displayOrder: 0, status: "succeeded", text: bounded("user first line\nuser final suffix") },
      { kind: "assistant", id: "assistant:1", timestamp: "2026-08-09T00:00:00.000Z", displayOrder: 1, status: "succeeded", streaming: false, thinking: bounded("thinking first line\nthinking final suffix"), text: bounded("assistant first paragraph\n\nassistant final suffix") },
    ];
    try {
      runtime.update({ body: rows.flatMap((row) => rowToBlocks(row)), editorText: "", footer: [] });
      await setup.renderOnce();
      expect(requireNode(setup.renderer.root, "runledger-block-timeline-user-0", TextRenderable).plainText).toBe("user first line\nuser final suffix");
      expect(requireNode(setup.renderer.root, "runledger-block-timeline-assistant-1-thinking", MarkdownRenderable)).toBeDefined();
      expect(requireNode(setup.renderer.root, "runledger-block-timeline-assistant-1-text", MarkdownRenderable)).toBeDefined();
      const frame = setup.captureCharFrame();
      expect(frame).toContain("thinking final suffix");
      expect(frame).toContain("assistant final suffix");
      expect(frame.split("\n").every((line) => stringWidth(stripAnsi(line)) <= 40)).toBe(true);
	  // 首帧后 OpenTUI finalizes completed Markdown；等待该帧再销毁 TreeSitter owner。
	  await setup.renderOnce();
    } finally {
      runtime.destroy();
    }
  });

  test("renders and reflows a stable run separator at 60/80/143 columns", async () => {
    const setup = await createTestRenderer({ width: 60, height: 16 });
    const runtime = createOpenTuiComponentRuntimeFromRenderer(setup.renderer, { onInput: () => {}, onResize: () => {} });
    const chat = new ChatContainer();
    chat.setTimelineBlocks([{ id: "timeline-run:run-native", kind: "separator", label: "stop · Worked for 12s" }], 1);
    try {
      for (const width of [60, 80, 143]) {
        setup.resize(width, 16);
        runtime.update({ body: chat.present(width), editorText: "", footer: ["done:stop"] });
        await setup.renderOnce();
        const line = setup.captureCharFrame().split("\n").find((candidate) => candidate.includes("stop · Worked for 12s"));
        expect(line).toBeDefined();
        expect(stringWidth((line ?? "").trimEnd())).toBe(width);
        expect(requireNode(setup.renderer.root, "runledger-block-timeline-run-run-native", TextRenderable)).toBeDefined();
      }
    } finally {
      runtime.destroy();
    }
  });
  test("copies a non-empty native selection without forwarding Ctrl+C", async () => {
    const setup = await createTestRenderer({ width: 60, height: 16 });
    const inputs: string[] = [];
    const copy = spyOn(setup.renderer, "copyToClipboardOSC52").mockReturnValue(true);
    const runtime = createOpenTuiComponentRuntimeFromRenderer(setup.renderer, {
      onInput: (data: string) => inputs.push(data),
      onResize: () => {},
    });
    try {
      runtime.update({
        body: ["RunLedger copy target"],
        editorText: "",
        footer: ["idle"],
      });
      await setup.renderOnce();
      await setup.mockMouse.drag(0, 0, 9, 0);
      const selectedText = setup.renderer.getSelection()?.getSelectedText();
      expect(selectedText).toContain("RunLedger");
      copy.mockClear();

      setup.mockInput.pressKey("c", { ctrl: true });

      expect(copy).toHaveBeenCalledWith(selectedText);
      expect(inputs).toEqual([]);
    } finally {
      copy.mockRestore();
      runtime.destroy();
    }
  });

  test("writes an explicit OSC 52 copy for caller-supplied text", async () => {
    const setup = await createTestRenderer({ width: 60, height: 16 });
    const copy = spyOn(setup.renderer, "copyToClipboardOSC52").mockReturnValue(true);
    const runtime = createOpenTuiComponentRuntimeFromRenderer(setup.renderer, {
      onInput: () => {},
      onResize: () => {},
    });
    try {
      runtime.update({ body: ["copy target"], editorText: "", footer: ["idle"] });
      await setup.renderOnce();

      // `/dump` 的剪贴板通道：不依赖鼠标选区，空文本必须失败且不写出序列。
      expect(setup.renderer.getSelection()?.getSelectedText() ?? "").toBe("");
      expect(runtime.copyText("")).toBe(false);
      expect(copy).not.toHaveBeenCalled();

      expect(runtime.copyText("## System Prompt\nassembled body")).toBe(true);
      expect(copy).toHaveBeenCalledWith("## System Prompt\nassembled body");
      copy.mockReturnValue(false);
      expect(runtime.copyText("unsupported terminal")).toBe(false);
      expect(setup.renderer.getSelection()?.getSelectedText() ?? "").toBe("");
    } finally {
      copy.mockRestore();
      runtime.destroy();
    }
  });

  test("copies a native conversation selection when mouse selection finishes", async () => {
    const setup = await createTestRenderer({ width: 60, height: 16 });
    const inputs: string[] = [];
    const copy = spyOn(setup.renderer, "copyToClipboardOSC52").mockReturnValue(true);
    const runtime = createOpenTuiComponentRuntimeFromRenderer(setup.renderer, {
      onInput: (data: string) => inputs.push(data),
      onResize: () => {},
    });
    try {
      runtime.update({
        body: [
          { id: "user-1", kind: "text", content: "user: copy this question" },
          {
            id: "assistant-1",
            kind: "markdown",
            content: "assistant: **copy this answer**",
            streaming: false,
          },
        ],
        editorText: "",
        footer: ["idle"],
      });
      await setup.renderOnce();
      const answer = requireNode(setup.renderer.root, "runledger-block-assistant-1", MarkdownRenderable);
      await setup.mockMouse.drag(0, 0, 18, answer.screenY);
      const selectedText = setup.renderer.getSelection()?.getSelectedText();
      expect(selectedText).toContain("user: copy this");
      expect(selectedText).toContain("assistant:");

      expect(copy).toHaveBeenCalledWith(selectedText);
      expect(inputs).toEqual([]);
    } finally {
      copy.mockRestore();
      runtime.destroy();
    }
  });

  test("updates keyed streaming blocks without rebuilding history, editor, or overlay", async () => {
    const setup = await createTestRenderer({ width: 60, height: 16 });
    const runtime = createOpenTuiComponentRuntimeFromRenderer(setup.renderer, {
      onInput: () => {},
      onResize: () => {},
    });
    try {
      runtime.update({
        body: [
          { id: "history-1", kind: "text", content: "history" },
          { id: "active-1", kind: "markdown", content: "first", streaming: true },
        ],
        editorText: "draft",
        footer: ["status"],
        overlay: [{ id: "overlay-1", kind: "text", content: "overlay" }],
      });
      await setup.renderOnce();

      const historyBefore = requireNode(setup.renderer.root, "runledger-block-history-1", TextRenderable);
      const activeBefore = requireNode(setup.renderer.root, "runledger-block-active-1", MarkdownRenderable);
      const editorBefore = requireNode(setup.renderer.root, "runledger-editor", TextareaRenderable);
      const overlayBefore = setup.renderer.root.findDescendantById("runledger-overlay");
      expect(historyBefore).toBeDefined();
      expect(activeBefore).toBeDefined();
      expect(editorBefore).toBeDefined();
      expect(overlayBefore).toBeDefined();

      runtime.update({
        body: [
          { id: "history-1", kind: "text", content: "history" },
          { id: "active-1", kind: "markdown", content: "first second", streaming: true },
        ],
        editorText: "draft changed",
        footer: ["status"],
        overlay: [{ id: "overlay-1", kind: "text", content: "overlay changed" }],
      });
      await setup.renderOnce();

      expect(requireNode(setup.renderer.root, "runledger-block-history-1", TextRenderable).num)
        .toBe(historyBefore.num);
      expect(requireNode(setup.renderer.root, "runledger-block-active-1", MarkdownRenderable).num)
        .toBe(activeBefore.num);
      expect(requireNode(setup.renderer.root, "runledger-editor", TextareaRenderable).num)
        .toBe(editorBefore.num);
      expect(setup.renderer.root.findDescendantById("runledger-overlay")?.num)
        .toBe(overlayBefore?.num);
      expect(setup.captureCharFrame()).toContain("first second");
      expect(setup.captureCharFrame()).toContain("overlay changed");
    } finally {
      runtime.destroy();
    }
  });

  test("records projection work separately from native frame rendering", async () => {
    const setup = await createTestRenderer({ width: 60, height: 16 });
    const observer = new TuiPerformanceObserver();
    const runtime = createOpenTuiComponentRuntimeFromRenderer(setup.renderer, {
      onInput: () => {},
      onResize: () => {},
      performanceObserver: observer,
    });
    try {
      runtime.update({
        body: [{ id: "assistant-1", kind: "markdown", content: "hello", streaming: true }],
        editorText: "",
        footer: ["status"],
      });
      await setup.renderOnce();
      const snapshot = observer.snapshot();
      expect(snapshot.projectionCount).toBe(1);
      expect(snapshot.projectionChars).toBeGreaterThanOrEqual("hello".length + "status".length);
      expect(snapshot.nativeFrameCount).toBeGreaterThanOrEqual(1);
      expect(snapshot.nativeCellsUpdated).toBeGreaterThan(0);
    } finally {
      runtime.destroy();
    }
  });

  test("mounts transcript blocks as direct ScrollBox children for viewport culling", async () => {
    const setup = await createTestRenderer({ width: 60, height: 16 });
    const runtime = createOpenTuiComponentRuntimeFromRenderer(setup.renderer, {
      onInput: () => {},
      onResize: () => {},
    });
    try {
      runtime.update({
        body: Array.from({ length: 100 }, (_, index) => ({
          id: `entry-${index}`,
          kind: "text" as const,
          content: `entry ${index}`,
        })),
        editorText: "",
        footer: [],
      });
      await setup.renderOnce();
      const transcript = requireNode(setup.renderer.root, "runledger-transcript", ScrollBoxRenderable);
      expect(transcript.getChildren().length).toBe(100);
      expect(transcript.viewportCulling).toBe(true);
    } finally {
      runtime.destroy();
    }
  });

  test("preserves a reader's scroll position while streaming appends new entries", async () => {
    const setup = await createTestRenderer({ width: 60, height: 12 });
    const runtime = createOpenTuiComponentRuntimeFromRenderer(setup.renderer, {
      onInput: () => {},
      onResize: () => {},
    });
    try {
      const rows = (count: number) => Array.from({ length: count }, (_, index) => ({
        id: `entry-${index}`,
        kind: "text" as const,
        content: `entry ${index}`,
      }));
      runtime.update({ body: rows(40), editorText: "", footer: [] });
      await setup.renderOnce();
      const transcript = requireNode(setup.renderer.root, "runledger-transcript", ScrollBoxRenderable);
      transcript.scrollTop = 0;
      runtime.update({
        body: [...rows(40), { id: "entry-40", kind: "text", content: "new output" }],
        editorText: "",
        footer: [],
      });
      await setup.renderOnce();
      expect(transcript.scrollTop).toBe(0);
    } finally {
      runtime.destroy();
    }
  });

  test("routes PageUp/PageDown to the transcript scroll box without editing the draft", async () => {
    const setup = await createTestRenderer({ width: 60, height: 12 });
    const runtime = createOpenTuiComponentRuntimeFromRenderer(setup.renderer, {
      onInput: () => {},
      onResize: () => {},
    });
    try {
      runtime.update({
        body: Array.from({ length: 40 }, (_, index) => ({
          id: `entry-${index}`,
          kind: "text" as const,
          content: `entry ${index}`,
        })),
        editorText: "draft",
        footer: [],
      });
      await setup.renderOnce();
      const transcript = requireNode(setup.renderer.root, "runledger-transcript", ScrollBoxRenderable);
      const bottom = transcript.scrollTop;
      setup.mockInput.pressKey("\x1b[5~");
      await setup.renderOnce();
      expect(transcript.scrollTop).toBeLessThan(bottom);
      expect(requireNode(setup.renderer.root, "runledger-editor", TextareaRenderable).plainText).toBe("draft");
    } finally {
      runtime.destroy();
    }
  });

  test("routes the mouse wheel outside the transcript to the session history", async () => {
    const setup = await createTestRenderer({ width: 60, height: 12 });
    const runtime = createOpenTuiComponentRuntimeFromRenderer(setup.renderer, {
      onInput: () => {},
      onResize: () => {},
    });
    try {
      runtime.update({
        body: Array.from({ length: 40 }, (_, index) => ({
          id: `entry-${index}`,
          kind: "text" as const,
          content: `entry ${index}`,
        })),
        editorText: "draft",
        footer: [],
      });
      await setup.renderOnce();
      const transcript = requireNode(setup.renderer.root, "runledger-transcript", ScrollBoxRenderable);
      const bottom = transcript.scrollTop;

      // 用户提交请求后鼠标通常仍停在 composer；滚轮仍应移动 session 历史。
      await setup.mockMouse.scroll(10, 10, "up");
      await setup.renderOnce();
      expect(transcript.scrollTop).toBeLessThan(bottom);

      const scrolledUp = transcript.scrollTop;
      await setup.mockMouse.scroll(10, 10, "down");
      await setup.renderOnce();
      expect(transcript.scrollTop).toBeGreaterThan(scrolledUp);

      await setup.mockMouse.scroll(10, 11, "up");
      await setup.renderOnce();
      expect(transcript.scrollTop).toBeLessThan(bottom);
      expect(requireNode(setup.renderer.root, "runledger-editor", TextareaRenderable).plainText).toBe("draft");
    } finally {
      runtime.destroy();
    }
  });

  test("keeps the editor cursor at the end of the draft as it grows", async () => {
    const setup = await createTestRenderer({ width: 60, height: 16 });
    const runtime = createOpenTuiComponentRuntimeFromRenderer(setup.renderer, {
      onInput: () => {},
      onResize: () => {},
    });
    try {
      runtime.update({ body: [], editorText: "", footer: [] });
      await setup.renderOnce();
      const editor = requireNode(setup.renderer.root, "runledger-editor", TextareaRenderable);
      for (const ch of "hello") {
        runtime.update({ body: [], editorText: editor.plainText + ch, footer: [] });
        await setup.renderOnce();
        expect(editor.cursorOffset).toBe(editor.plainText.length);
      }
      runtime.update({ body: [], editorText: "hello world", footer: [] });
      await setup.renderOnce();
      expect(editor.cursorOffset).toBe(editor.plainText.length);
    } finally {
      runtime.destroy();
    }
  });

  test("projects an explicit model cursor offset into the native textarea", async () => {
    const setup = await createTestRenderer({ width: 60, height: 16 });
    const runtime = createOpenTuiComponentRuntimeFromRenderer(setup.renderer, {
      onInput: () => {},
      onResize: () => {},
    });
    try {
      const frame = {
        body: [],
        editorText: "hello",
        editorCursorOffset: 2,
        footer: [],
      } as Parameters<typeof runtime.update>[0] & { readonly editorCursorOffset: number };
      runtime.update(frame);
      await setup.renderOnce();
      const editor = requireNode(setup.renderer.root, "runledger-editor", TextareaRenderable);
      expect(editor.plainText).toBe("hello");
      expect(editor.cursorOffset).toBe(2);
    } finally {
      runtime.destroy();
    }
  });

  test("places the hardware cursor after CJK cells, including a wrapped mixed-width line", async () => {
    const setup = await createTestRenderer({ width: 30, height: 8 });
    const runtime = createOpenTuiComponentRuntimeFromRenderer(setup.renderer, {
      onInput: () => {},
      onResize: () => {},
    });
    try {
      const cjk = "测试中文输入";
      runtime.update({ body: [], editorText: cjk, editorCursorOffset: cjk.length, footer: [] });
      await setup.renderOnce();
      const editor = requireNode(setup.renderer.root, "runledger-editor", TextareaRenderable);
      expect(setup.renderer.getCursorState()).toMatchObject({
        x: editor.screenX + stringWidth(cjk) + 1,
        y: editor.screenY + 1,
        visible: true,
      });

      setup.resize(12, 8);
      const mixed = "abc测试xyz中文尾";
      runtime.update({ body: [], editorText: mixed, editorCursorOffset: mixed.length, footer: [] });
      await setup.renderOnce();
      expect(editor.visualCursor.visualRow).toBe(1);
      expect(setup.renderer.getCursorState()).toMatchObject({
        x: editor.screenX + stringWidth("xyz中文尾") + 1,
        y: editor.screenY + 2,
        visible: true,
      });
    } finally {
      runtime.destroy();
    }
  });

  test("separates chat, composer and panels through resize, long drafts and close", async () => {
    const setup = await createTestRenderer({ width: 80, height: 24 });
    const runtime = createOpenTuiComponentRuntimeFromRenderer(setup.renderer, {
      onInput: () => {}, onResize: () => {},
    });
    try {
      for (const [width, height] of [[80, 24], [40, 12], [143, 36]]) {
        setup.resize(width!, height!);
        for (const compact of [true, false]) {
          const frame: OpenTuiComponentFrame = {
            body: Array.from({ length: 80 }, (_, index) => `CHAT_MARKER_${index}`),
            editorText: "draft\n".repeat(30), footer: ["FOOTER_MARKER"],
            overlay: [{ kind: "text", content: "PANEL_MARKER\n".repeat(30) }],
            overlayAnchor: "bottom-left", overlayNonCapturing: compact,
          };
          runtime.update(frame);
          await setup.renderOnce();
          const root = setup.renderer.root;
          const panel = root.findDescendantById("runledger-overlay")!;
          const editor = root.findDescendantById("runledger-editor-row")!;
          const chat = root.findDescendantById("runledger-transcript")!;
          const footer = root.findDescendantById("runledger-footer")!;
          expect(chat.screenY + chat.height).toBeLessThanOrEqual(editor.screenY);
          expect(editor.screenY + editor.height).toBeLessThanOrEqual(panel.screenY);
          expect(panel.screenY + panel.height).toBeLessThanOrEqual(footer.screenY);
          expect(footer.screenY + footer.height).toBeLessThanOrEqual(height!);
          const rows = setup.captureCharFrame().split("\n");
          expect(rows.some((row) => row.includes("PANEL_MARKER"))).toBe(true);
          expect(rows.filter((row) => row.includes("PANEL_MARKER")).every((row) => !row.includes("CHAT_MARKER"))).toBe(true);
          runtime.update({ body: frame.body, editorText: "", footer: frame.footer });
          await setup.renderOnce();
          expect(setup.captureCharFrame()).not.toContain("PANEL_MARKER");
          expect(setup.renderer.currentFocusedRenderable?.id).toBe("runledger-editor");
        }
      }
    } finally { runtime.destroy(); }
  });

  test("projects slash popup rows as single-line text rows with the command box attached below the editor", async () => {
    const setup = await createTestRenderer({ width: 80, height: 24 });
    const runtime = createOpenTuiComponentRuntimeFromRenderer(setup.renderer, {
      onInput: () => {},
      onResize: () => {},
    });
    try {
      const popup = new SlashCommandPopup({
        commands: builtinCommandDescriptors(),
        theme: makeSelectListTheme(loadTheme("dark")),
      });
      popup.setFilter("/c");
      runtime.update({
        body: [],
        editorText: "/c",
        footer: ["done:stop"],
        overlay: popup.present(76),
        overlayAnchor: "bottom-left",
        overlayNonCapturing: true,
      });
      await setup.renderOnce();
      const frame = setup.captureCharFrame();
      // 命令名与描述在同一行(计划 P2 行规格)
      const clearLine = frame.split("\n").find((line) => line.includes("/clear"));
      expect(clearLine).toBeDefined();
      expect(clearLine).toContain("Clear chat");
      // 无原生 select 堆叠节点
      expect(setup.renderer.root.findDescendantById("runledger-overlay-select-0")).toBeUndefined();
      // 弹窗在输入框下方占据独立布局行。
      const overlayBox = setup.renderer.root.findDescendantById("runledger-overlay") as { readonly bottom?: number; readonly left?: number; readonly width?: number } | undefined;
      expect(overlayBox?.bottom).toBeUndefined();
      expect(overlayBox?.left).toBe(0);
    } finally {
      runtime.destroy();
    }
  });

  test("restores modal chrome when a compact popup is replaced without an empty frame", async () => {
    const setup = await createTestRenderer({ width: 80, height: 24 });
    const runtime = createOpenTuiComponentRuntimeFromRenderer(setup.renderer, {
      onInput: () => {},
      onResize: () => {},
    });
    try {
      runtime.update({
        body: [],
        editorText: "/c",
        footer: ["idle"],
        overlay: [{ kind: "text", content: "/clear  Clear chat" }],
        overlayAnchor: "bottom-left",
        overlayNonCapturing: true,
      });
      await setup.renderOnce();

      runtime.update({
        body: [],
        editorText: "",
        editorHeight: 5,
        statusIndicator: { indicator: "●", header: "Waiting", elapsed: "1s" },
        footer: ["identity", "usage"],
        overlay: [{
          kind: "select",
          title: "/commands",
          options: [{ value: "help", label: "/help", description: "Show help" }],
          selectedIndex: 0,
        }],
        overlayAnchor: "bottom-left",
        overlayNonCapturing: false,
      });
      await setup.renderOnce();

      const overlayBox = setup.renderer.root.findDescendantById("runledger-overlay") as {
        readonly left?: number;
        readonly width?: number;
        readonly bottom?: number;
        readonly border?: boolean;
        readonly backgroundColor?: { readonly a: number };
      } | undefined;
      expect(overlayBox?.left).toBe(1);
      expect(overlayBox?.width).toBe(72);
      // 普通面板参与纵向布局，不使用底部绝对偏移。
      expect(overlayBox?.bottom).toBeUndefined();
      expect(overlayBox?.border).toBe(true);
      expect(overlayBox?.backgroundColor?.a).toBe(1);
    } finally {
      runtime.destroy();
    }
  });

  test("keeps a provider selector's lower rows inside the modal chrome", async () => {
    const setup = await createTestRenderer({ width: 80, height: 24 });
    const runtime = createOpenTuiComponentRuntimeFromRenderer(setup.renderer, {
      onInput: () => {},
      onResize: () => {},
    });
    try {
      runtime.update({
        body: [],
        editorText: "",
        footer: ["idle"],
        overlay: [{
          id: "provider",
          kind: "select",
          title: "/provider — all built-ins",
          options: Array.from({ length: 20 }, (_, index) => ({
            value: `provider-${index}`,
            label: `provider-${index}`,
            description: "configured",
          })),
          selectedIndex: 0,
        }],
        overlayAnchor: "bottom-left",
      });
      await setup.renderOnce();

      const overlay = setup.renderer.root.findDescendantById("runledger-overlay");
      const select = setup.renderer.root.findDescendantById("runledger-overlay-select-provider");
      expect(overlay).toBeDefined();
      expect(select).toBeDefined();
      if (!overlay || !select) return;

      expect(select.screenY + select.height).toBeLessThanOrEqual(overlay.screenY + overlay.height - 1);
    } finally {
      runtime.destroy();
    }
  });

  test("moves a provider selector to a lower row when clicked with the mouse", async () => {
    const setup = await createTestRenderer({ width: 80, height: 24 });
    const runtime = createOpenTuiComponentRuntimeFromRenderer(setup.renderer, {
      onInput: () => {},
      onResize: () => {},
    });
    try {
      runtime.update({
        body: [],
        editorText: "",
        footer: ["idle"],
        overlay: [{
          id: "provider",
          kind: "select",
          title: "/provider — all built-ins",
          options: Array.from({ length: 20 }, (_, index) => ({
            value: `provider-${index}`,
            label: `provider-${index}`,
            description: "configured",
          })),
          selectedIndex: 0,
        }],
        overlayAnchor: "bottom-left",
      });
      await setup.renderOnce();

      const select = setup.renderer.root.findDescendantById("runledger-overlay-select-provider") as {
        readonly screenX: number;
        readonly screenY: number;
        getSelectedIndex(): number;
      } | undefined;
      expect(select).toBeDefined();
      if (!select) return;

      await setup.mockMouse.click(select.screenX + 4, select.screenY + 8);
      await setup.renderOnce();

      expect(select.getSelectedIndex()).toBe(4);
    } finally {
      runtime.destroy();
    }
  });

  test("docks ordinary modals below the editor even with a legacy center anchor", async () => {
    const setup = await createTestRenderer({ width: 80, height: 24 });
    const runtime = createOpenTuiComponentRuntimeFromRenderer(setup.renderer, {
      onInput: () => {},
      onResize: () => {},
    });
    try {
      runtime.update({
        body: [],
        editorText: "",
        footer: ["idle"],
        overlay: [{
          kind: "select",
          title: "Approval required",
          options: [{ value: "deny", label: "Deny", description: "Reject" }],
          selectedIndex: 0,
        }],
        overlayAnchor: "center",
      });
      await setup.renderOnce();

      const overlayBox = setup.renderer.root.findDescendantById("runledger-overlay") as {
        readonly left?: number;
        readonly top?: number;
        readonly bottom?: number;
      } | undefined;
      expect(overlayBox?.left).toBe(1);
      expect(overlayBox?.top).toBeUndefined();
      expect(overlayBox?.bottom).toBeUndefined();
    } finally {
      runtime.destroy();
    }
  });

  test("shows a new-content indicator while reading history and clears it at the bottom", async () => {
    const setup = await createTestRenderer({ width: 60, height: 12 });
    const runtime = createOpenTuiComponentRuntimeFromRenderer(setup.renderer, {
      onInput: () => {},
      onResize: () => {},
    });
    try {
      const rows = (count: number) => Array.from({ length: count }, (_, index) => ({
        id: `entry-${index}`,
        kind: "text" as const,
        content: `entry ${index}`,
      }));
      runtime.update({ body: rows(40), editorText: "draft", footer: [] });
      await setup.renderOnce();
      const transcript = requireNode(setup.renderer.root, "runledger-transcript", ScrollBoxRenderable);
      transcript.scrollTop = 0;
      runtime.update({ body: rows(41), editorText: "draft", footer: [] });
      await setup.renderOnce();

      expect(setup.renderer.root.findDescendantById("runledger-new-content")).toBeDefined();
      expect(setup.captureCharFrame()).toContain("new content");

      for (let index = 0; index < 41 && setup.captureCharFrame().includes("new content"); index += 1) {
        setup.mockInput.pressKey("\x1b[6~");
        await setup.renderOnce();
      }
      expect(setup.captureCharFrame()).not.toContain("new content");
      expect(requireNode(setup.renderer.root, "runledger-editor", TextareaRenderable).plainText).toBe("draft");
    } finally {
      runtime.destroy();
    }
  });

  test("a growing streaming markdown block never shows the new-content indicator", async () => {
    const setup = await createTestRenderer({ width: 80, height: 10 });
    const runtime = createOpenTuiComponentRuntimeFromRenderer(setup.renderer, {
      onInput: () => {},
      onResize: () => {},
    });
    try {
      const transcript = requireNode(setup.renderer.root, "runledger-transcript", ScrollBoxRenderable);
      let text = "line\n";
      let sawIndicator = false;
      for (let i = 0; i < 60; i++) {
        text += `line ${i} padding content here\n`;
        runtime.update({
          body: [{ id: "md", kind: "markdown", content: text, streaming: true }],
          editorText: "",
          footer: [],
        });
        await setup.renderOnce();
        // 内容尚未超出视口时 scrollTop 可能为负，但此时必然处于底部，
        // 不得因此误积累 pendingNewContent 并显示“new content”提示。
        if (setup.captureCharFrame().includes("new content")) {
          sawIndicator = true;
          break;
        }
      }
      expect(sawIndicator).toBe(false);
      expect(setup.captureCharFrame()).toContain("line 59");
    } finally {
      runtime.destroy();
    }
  });

  test("keeps 10,000 keyed history entries available to viewport culling", async () => {
    const setup = await createTestRenderer({ width: 80, height: 20 });
    const runtime = createOpenTuiComponentRuntimeFromRenderer(setup.renderer, {
      onInput: () => {},
      onResize: () => {},
    });
    try {
      runtime.update({
        body: Array.from({ length: 10_000 }, (_, index) => ({
          id: `history-${index}`,
          kind: "text" as const,
          content: `history ${index}`,
        })),
        editorText: "",
        footer: [],
      });
      await setup.renderOnce();
      const transcript = requireNode(setup.renderer.root, "runledger-transcript", ScrollBoxRenderable);
      expect(transcript.getChildren().length).toBe(10_000);
      expect(transcript.viewportCulling).toBe(true);
      expect(setup.captureCharFrame()).toContain("history 9999");
    } finally {
      runtime.destroy();
    }
  });

  test("keeps key content within compact, standard, and wide terminal widths", async () => {
    for (const width of [60, 80, 143]) {
      const setup = await createTestRenderer({ width, height: 16 });
      const runtime = createOpenTuiComponentRuntimeFromRenderer(setup.renderer, {
        onInput: () => {},
        onResize: () => {},
      });
      try {
        runtime.update({
          body: [
            { id: "history", kind: "text", content: "审计 history 🧭 ".repeat(8) },
            { id: "active", kind: "markdown", content: "# streaming\n\n正文内容 ".repeat(4), streaming: true },
          ],
          editorText: "draft",
          footer: ["idle · deepseek-v4-pro"],
        });
        await setup.renderOnce();
        const editorBefore = requireNode(setup.renderer.root, "runledger-editor", TextareaRenderable);
        setup.resize(width, 18);
        await setup.renderOnce();
        const lines = setup.captureCharFrame().split("\n");
        expect(lines.every((line) => stringWidth(stripAnsi(line)) <= width)).toBe(true);
        expect(requireNode(setup.renderer.root, "runledger-editor", TextareaRenderable).num).toBe(editorBefore.num);
        expect(requireNode(setup.renderer.root, "runledger-editor", TextareaRenderable).plainText).toBe("draft");
      } finally {
        runtime.destroy();
      }
    }
  });

  test("绘制 timeline/editor/footer/overlay，并由 owner 销毁 renderer", async () => {
    const setup = await createTestRenderer({ width: 60, height: 16 });
    const inputs: string[] = [];
    const actions: Array<{ readonly type: string }> = [];
    const themeModes: string[] = [];
    const runtimeOptions = {
      onInput: (data: string) => inputs.push(data),
      onResize: () => {},
      onActions: (next: readonly { readonly type: string }[]) => actions.push(...next),
      onThemeMode: (mode: "dark" | "light") => themeModes.push(mode),
    };
    const runtime = createOpenTuiComponentRuntimeFromRenderer(setup.renderer, runtimeOptions);
    try {
      runtime.update({
        body: ["RunLedger", "assistant: ready"],
        editorText: "draft",
        footer: ["idle · deepseek-v4-pro"],
        overlay: ["Select model", "→ deepseek-v4-pro"],
      });
      await setup.renderOnce();
      const frame = setup.captureCharFrame();
      expect(frame).toContain("assistant: ready");
      expect(frame).toContain("draft");
      expect(frame).toContain("idle · deepseek-v4-pro");
      expect(frame).toContain("Select model");

      await setup.mockMouse.drag(0, 0, 9, 0);
      expect(setup.renderer.getSelection()?.getSelectedText()).toContain("RunLedger");

      setup.renderer.clearSelection();
      setup.mockInput.pressKey("c", { ctrl: true });
      await setup.mockInput.pasteBracketedText("粘贴内容");
      expect(inputs).toEqual(["ctrl+c", "粘贴内容"]);
	  expect(actions.map((action) => action.type)).toContain("composer.changed");

      setup.resize(80, 18);
	  setup.renderer.emit("blur");
	  setup.renderer.emit("focus");
	  expect(actions).toEqual(expect.arrayContaining([
		{ type: "interaction.viewport-resized", columns: 80, rows: 18 },
		{ type: "interaction.focus-changed", focused: false },
		{ type: "interaction.focus-changed", focused: true },
	  ]));
      runtime.update({
        body: ["resize keeps one current projection"],
        editorText: "draft after resize",
        footer: ["80 columns"],
      });
      await setup.renderOnce();
      const resized = setup.captureCharFrame();
      expect(resized).toContain("draft after resize");
      expect(resized.split("\n").every((line) => line.length <= 80)).toBe(true);

      runtime.update({
        body: [{ kind: "markdown", content: "# Native Markdown\n\n**bold body**", streaming: true }],
        editorText: "",
        footer: ["markdown streaming"],
      });
      await setup.renderOnce();
      const markdown = setup.captureCharFrame();
      expect(markdown).toContain("Native Markdown");
      expect(markdown).toContain("bold body");
      expect(markdown).not.toContain("**bold body**");
      const darkHeading = setup.captureSpans().lines
        .flatMap((line) => line.spans)
        .find((span) => span.text.includes("Native Markdown"))?.fg.toInts().slice(0, 3);
      setup.renderer.emit("theme_mode", "light");
      runtime.update({
        body: [{ kind: "markdown", content: "# Native Markdown", streaming: false }],
        editorText: "",
        footer: [],
      });
      await setup.renderOnce();
      const lightHeading = setup.captureSpans().lines
        .flatMap((line) => line.spans)
        .find((span) => span.text.includes("Native Markdown"))?.fg.toInts().slice(0, 3);
      expect(lightHeading).not.toEqual(darkHeading);
      expect(themeModes).toEqual(["light"]);

      runtime.update({
        body: ["selector projection"],
        editorText: "",
        footer: ["overlay"],
        overlay: [{
          kind: "select",
          title: "Select provider",
          query: "deep",
          options: [
            { value: "deepseek", label: "DeepSeek", description: "configured" },
            { value: "openai", label: "OpenAI", description: "not configured" },
          ],
          selectedIndex: 0,
        }],
      });
      await setup.renderOnce();
      const selector = setup.captureCharFrame();
      expect(selector).toContain("Select provider");
      expect(selector).toContain("deep");
      expect(selector).toContain("DeepSeek");
      expect(setup.renderer.currentFocusedRenderable?.id).toBe("runledger-overlay-query-0");

      runtime.update({ body: ["overlay closed"], editorText: "restored", footer: [] });
      await setup.renderOnce();
      expect(setup.renderer.currentFocusedRenderable?.id).toBe("runledger-editor");

      runtime.update({
        body: ["auth"],
        editorText: "",
        footer: [],
        overlay: [{
          kind: "input",
          title: "Provider secret",
          message: "Enter API key",
          value: "••••••",
          placeholder: "sk-…",
        }],
      });
      await setup.renderOnce();
      const secret = setup.captureCharFrame();
      expect(secret).toContain("••••••");
      expect(secret).not.toContain("s3cr3t");
      expect(setup.renderer.currentFocusedRenderable?.id).toBe("runledger-overlay-input-0");

    } finally {
      runtime.destroy();
    }
    expect(setup.renderer.isDestroyed).toBe(true);
  });

  test("renders a Codex-style permission request in the secondary view below the Composer", async () => {
    const setup = await createTestRenderer({ width: 72, height: 16 });
    const runtime = createOpenTuiComponentRuntimeFromRenderer(setup.renderer, {
      onInput: () => {},
      onResize: () => {},
    });
    try {
      const request = parseApprovalReverseRequest({
        requestType: "permission",
        toolName: "bash",
        summary: "Sandbox blocked tsx from creating its IPC socket.",
        cwd: "/workspace",
        requests: [{ kind: "shell", command: "npm run check", cwd: "/workspace", analysis: "known" }],
      });
      expect(request).toBeDefined();
      if (request === undefined) return;
      const view = new PermissionRequestView({
        request,
        choices: approvalChoices(request),
        onSelect: () => {},
        onCancel: () => {},
      });
      runtime.update({
        body: [{ id: "history", kind: "text", content: "historical conversation" }],
        editorText: "",
        footer: ["Waiting for approval"],
        overlay: view.present(68),
        overlayAnchor: "bottom-left",
      });
      await setup.renderOnce();
      const frame = setup.captureCharFrame();
      expect(requireNode(setup.renderer.root, "runledger-block-history", TextRenderable).plainText).toBe("historical conversation");
      expect(frame).toContain("Would you like to run the following command?");
      expect(frame).toContain("Environment: local");
      expect(frame).toContain("$ npm run check");
      expect(frame).toContain("Yes, proceed");
      expect(frame).toContain("No, and tell RunLedger what to do differently");
      expect(frame).toContain("Waiting for approval");
      const overlay = setup.renderer.root.findDescendantById("runledger-overlay");
      const select = setup.renderer.root.findDescendantById("runledger-overlay-select-2");
      const editorRow = requireNode(setup.renderer.root, "runledger-editor-row", BoxRenderable);
      expect(overlay).toBeDefined();
      expect(select).toBeDefined();
      expect(editorRow).toBeDefined();
      if (overlay !== undefined && select !== undefined && editorRow !== undefined) {
        expect(overlay.screenY).toBeGreaterThanOrEqual(editorRow.screenY + editorRow.height);
        expect(select.screenY + select.height).toBeLessThanOrEqual(overlay.screenY + overlay.height - 1);
      }
      expect(setup.renderer.currentFocusedRenderable?.id).toBe("runledger-overlay-select-2");
    } finally {
      runtime.destroy();
    }
    expect(setup.renderer.isDestroyed).toBe(true);
  });

  test("M8 editor row height is frame-driven with a 3-row default", async () => {
    const setup = await createTestRenderer({ width: 60, height: 16 });
    const runtime = createOpenTuiComponentRuntimeFromRenderer(setup.renderer, {
      onInput: () => {},
      onResize: () => {},
    });
    try {
      runtime.update({ body: [], editorText: "", footer: [] });
      await setup.renderOnce();
      const editorRow = requireNode(setup.renderer.root, "runledger-editor-row", BoxRenderable);
      expect(editorRow).toBeDefined();
      expect(editorRow.height).toBe(3);

      runtime.update({ body: [], editorText: "", editorHeight: 5, footer: [] });
      await setup.renderOnce();
      expect(editorRow.height).toBe(5);

      runtime.update({ body: [], editorText: "", footer: [] });
      await setup.renderOnce();
      expect(editorRow.height).toBe(5);
      expect(requireNode(setup.renderer.root, "runledger-editor", TextareaRenderable).plainText).toBe("");
    } finally {
      runtime.destroy();
    }
  });

  test("M8 keeps the Codex composer inset and renders indented parameters below its surface", async () => {
    const setup = await createTestRenderer({ width: 40, height: 8 });
    const runtime = createOpenTuiComponentRuntimeFromRenderer(setup.renderer, {
      onInput: () => {},
      onResize: () => {},
    });
    try {
      runtime.update({ body: [], editorText: "", footer: ["identity", "parameters"] });
      await setup.renderOnce();

      const editorRow = requireNode(setup.renderer.root, "runledger-editor-row", BoxRenderable);
      const editor = requireNode(setup.renderer.root, "runledger-editor", TextareaRenderable);
      const footer = requireNode(setup.renderer.root, "runledger-footer", TextRenderable);
      expect(editorRow.height).toBe(3);
      expect(editor.y - editorRow.y).toBe(1);
      expect(editor.y + editor.height + 1).toBe(footer?.y);
      expect(editorRow.y + editorRow.height).toBe(footer?.y);
      expect(footer?.height).toBe(2);
      expect(footer?.plainText).toBe("  identity\n  parameters");
      const frame = setup.captureCharFrame().split("\n");
      expect(frame[footer?.y ?? 0]).toStartWith("  identity");
      expect(frame[(footer?.y ?? 0) + 1]).toStartWith("  parameters");
    } finally {
      runtime.destroy();
    }
  });

  test("M8 editor row keeps a stable prompt gutter and a wrapping textarea", async () => {
    const setup = await createTestRenderer({ width: 40, height: 30 });
    const runtime = createOpenTuiComponentRuntimeFromRenderer(setup.renderer, {
      onInput: () => {},
      onResize: () => {},
    });
    try {
      runtime.update({
        body: [],
        editorText: "x".repeat(200),
        editorHeight: 8,
        footer: [],
      });
      await setup.renderOnce();
      const prompt = requireNode(setup.renderer.root, "runledger-editor-prompt", TextRenderable);
      expect(prompt?.plainText).toBe("› ");
      expect(setup.captureCharFrame().split("\n").every((line) => stringWidth(stripAnsi(line)) <= 40)).toBe(true);
    } finally {
      runtime.destroy();
    }
  });

  test("M8 reserves the Codex right inset after the two-column prompt gutter", async () => {
    const setup = await createTestRenderer({ width: 40, height: 16 });
    const runtime = createOpenTuiComponentRuntimeFromRenderer(setup.renderer, {
      onInput: () => {},
      onResize: () => {},
    });
    try {
      runtime.update({ body: [], editorText: "draft", footer: [] });
      await setup.renderOnce();
      const prompt = requireNode(setup.renderer.root, "runledger-editor-prompt", TextRenderable);
      const editor = requireNode(setup.renderer.root, "runledger-editor", TextareaRenderable);
      expect(prompt?.x).toBe(0);
      expect(prompt?.width).toBe(2);
      expect(editor.x).toBe(2);
      expect(editor.width).toBe(37);
      expect(editor.x + editor.width).toBe(39);
    } finally {
      runtime.destroy();
    }
  });

  test("M8 word-wrapped drafts receive enough rows to render every word", async () => {
    const setup = await createTestRenderer({ width: 20, height: 12 });
    const runtime = createOpenTuiComponentRuntimeFromRenderer(setup.renderer, {
      onInput: () => {},
      onResize: () => {},
    });
    const draft = "1234567890 1234567890 1234567890";
    try {
      runtime.update({
        body: ["transcript"],
        editorText: draft,
        editorHeight: editorHeight(draft, 20),
        footer: ["hint", "footer"],
      });
      await setup.renderOnce();
      const frame = setup.captureCharFrame();
      expect(frame.match(/1234567890/gu)?.length).toBe(3);
    } finally {
      runtime.destroy();
    }
  });

  test("M8 caps a long draft so transcript and footer remain visible", async () => {
    const setup = await createTestRenderer({ width: 40, height: 16 });
    const runtime = createOpenTuiComponentRuntimeFromRenderer(setup.renderer, {
      onInput: () => {},
      onResize: () => {},
    });
    const draft = "x".repeat(500);
    try {
      runtime.update({
        body: ["transcript-marker"],
        editorText: draft,
        editorHeight: editorHeight(draft, 40),
        footer: ["hint-marker", "footer-marker"],
      });
      await setup.renderOnce();
      const transcript = requireNode(setup.renderer.root, "runledger-transcript", ScrollBoxRenderable);
      const editorRow = requireNode(setup.renderer.root, "runledger-editor-row", BoxRenderable);
      const footer = requireNode(setup.renderer.root, "runledger-footer", TextRenderable);
      expect(transcript.height).toBeGreaterThanOrEqual(1);
      expect(editorRow.height + (footer?.height ?? 0) + (transcript.height ?? 0)).toBeLessThanOrEqual(16);
      expect((footer?.y ?? 16) + (footer?.height ?? 0)).toBeLessThanOrEqual(16);
      expect(setup.captureCharFrame()).toContain("footer-marker");
    } finally {
      runtime.destroy();
    }
  });

  test("M8 usage footer height survives narrow resize and protects the editor", async () => {
    const setup = await createTestRenderer({ width: 40, height: 10 });
    const runtime = createOpenTuiComponentRuntimeFromRenderer(setup.renderer, {
      onInput: () => {},
      onResize: () => {},
    });
    const footer = ["identity", "in 1.2k · out 300 · ctx 2.0k/8.0k (25.0%)"];
    try {
      runtime.update({
        body: ["transcript-marker"],
        editorText: "x".repeat(500),
        editorHeight: 100,
        footer: [footer[0]!],
      });
      await setup.renderOnce();
      const editorRow = requireNode(setup.renderer.root, "runledger-editor-row", BoxRenderable);
      const oneRowEditorHeight = editorRow.height ?? 0;

      runtime.update({
        body: ["transcript-marker"],
        editorText: "x".repeat(500),
        editorHeight: 100,
        footer,
      });
      await setup.renderOnce();
      const twoRowEditor = requireNode(setup.renderer.root, "runledger-editor-row", BoxRenderable);
      const footerNode = requireNode(setup.renderer.root, "runledger-footer", TextRenderable);
      expect(footerNode.height).toBe(2);
      expect((twoRowEditor?.height ?? 0)).toBeLessThan(oneRowEditorHeight);
      expect((twoRowEditor?.height ?? 0) + (footerNode.height ?? 0) + 1).toBeLessThanOrEqual(10);

      setup.resize(24, 10);
      runtime.update({
        body: ["transcript-marker"],
        editorText: "draft",
        editorHeight: 4,
        footer,
      });
      await setup.renderOnce();
      expect(requireNode(setup.renderer.root, "runledger-footer", TextRenderable).height).toBe(2);
      expect(setup.captureCharFrame()).toContain("out 300");
    } finally {
      runtime.destroy();
    }
  });

  test("M8 applies frame-driven editor appearance (background/prompt/placeholder)", async () => {
    const setup = await createTestRenderer({ width: 60, height: 16 });
    const runtime = createOpenTuiComponentRuntimeFromRenderer(setup.renderer, {
      onInput: () => {},
      onResize: () => {},
    });
    try {
      runtime.update({
        body: [],
        editorText: "",
        editorAppearance: {
          backgroundColor: "#282a30",
          promptColor: "#7dcfff",
          placeholderColor: "#666666",
        },
        footer: [],
      });
      await setup.renderOnce();
      const row = requireNode(setup.renderer.root, "runledger-editor-row", BoxRenderable);
      expect(row?.backgroundColor.toInts().slice(0, 3)).toEqual([0x28, 0x2a, 0x30]);
      const prompt = requireNode(setup.renderer.root, "runledger-editor-prompt", TextRenderable);
      expect(prompt?.plainText).toBe("› ");
      const placeholderSpan = setup.captureSpans().lines
        .flatMap((line) => line.spans)
        .find((span) => span.text.includes("Message RunLedger"));
      expect(placeholderSpan?.fg.toInts().slice(0, 3)).toEqual([0x66, 0x66, 0x66]);
      const promptSpan = setup.captureSpans().lines
        .flatMap((line) => line.spans)
        .find((span) => span.text.includes("›"));
      expect(promptSpan?.fg.toInts().slice(0, 3)).toEqual([0x7d, 0xcf, 0xff]);
      expect((promptSpan?.attributes ?? 0) & 1).toBe(1); // TextAttributes.BOLD
    } finally {
      runtime.destroy();
    }
  });

  test("M8 forwards OSC 11 replies through onOsc for terminal background tracking", async () => {
    const setup = await createTestRenderer({ width: 60, height: 16 });
    const oscs: string[] = [];
    const runtime = createOpenTuiComponentRuntimeFromRenderer(setup.renderer, {
      onInput: () => {},
      onResize: () => {},
      onOsc: (sequence) => oscs.push(sequence),
    });
    try {
      setup.mockInput.pressKey("\x1b]11;rgb:0b0e/0b0e/1414\x07");
      await setup.waitFor(() => oscs.some((sequence) => sequence.includes("rgb:0b0e/0b0e/1414")));
      expect(oscs).toContain("\x1b]11;rgb:0b0e/0b0e/1414\x07");
    } finally {
      runtime.destroy();
    }
  });

  test("M8 theme_mode callback applies the recomputed editor background to the native row", async () => {
    const setup = await createTestRenderer({ width: 60, height: 16 });
    let runtime: ReturnType<typeof createOpenTuiComponentRuntimeFromRenderer> | undefined;
    runtime = createOpenTuiComponentRuntimeFromRenderer(setup.renderer, {
      onInput: () => {},
      onResize: () => {},
      onThemeMode: (mode) => {
        const theme = loadTheme(mode);
        runtime?.update({
          body: [],
          editorText: "",
          editorAppearance: {
            backgroundColor: editorBackgroundFromTerminal(theme, undefined),
            promptColor: theme.accent,
            placeholderColor: theme.hint,
          },
          footer: [],
        });
      },
    });
    try {
      runtime.update({
        body: [],
        editorText: "",
        editorAppearance: {
          backgroundColor: "#282a30",
          promptColor: "#7dcfff",
          placeholderColor: "#666666",
        },
        footer: [],
      });
      await setup.renderOnce();
      setup.renderer.emit("theme_mode", "light");
      await setup.renderOnce();
      const row = requireNode(setup.renderer.root, "runledger-editor-row", BoxRenderable);
      expect(row?.backgroundColor.toInts().slice(0, 3)).toEqual([0xf4, 0xf4, 0xf4]);
    } finally {
      runtime.destroy();
    }
  });
});
