import { describe, expect, spyOn, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import stringWidth from "string-width";
import stripAnsi from "strip-ansi";
import {
  createOpenTuiComponentRuntimeFromRenderer,
} from "../../src/tui/opentui/component-runtime.ts";
import { TuiPerformanceObserver } from "../../src/tui/opentui/performance-observer.ts";
import { ChatContainer } from "../../src/tui/components/chat-container.ts";
import { rowToBlocks } from "../../src/tui/timeline/selectors.ts";
import type { TimelineRow } from "../../src/tui/timeline/types.ts";

describe("OpenTUI component projection", () => {
  test("wraps complete canonical Timeline user/assistant/thinking content at narrow width", async () => {
    const setup = await createTestRenderer({ width: 40, height: 30 });
    const runtime = createOpenTuiComponentRuntimeFromRenderer(setup.renderer, { onInput: () => {}, onResize: () => {} });
    const bounded = (text: string) => ({ text, truncated: false, byteLength: new TextEncoder().encode(text).byteLength });
    const rows: TimelineRow[] = [
      { kind: "user", id: "user:0", timestamp: "2026-08-09T00:00:00.000Z", displayOrder: 0, status: "succeeded", text: bounded("user first line\nuser final suffix") },
      { kind: "assistant", id: "assistant:1", timestamp: "2026-08-09T00:00:00.000Z", displayOrder: 1, status: "succeeded", streaming: false, thinking: bounded("thinking first line\nthinking final suffix"), text: bounded("assistant first paragraph\n\nassistant final suffix") },
    ];
    try {
      runtime.update({ body: rows.flatMap(rowToBlocks), editorText: "", footer: [] });
      await setup.renderOnce();
      expect(setup.renderer.root.findDescendantById("runledger-block-timeline-user-0")?.plainText).toBe("user first line\nuser final suffix");
      expect(setup.renderer.root.findDescendantById("runledger-block-timeline-assistant-1-thinking")).toBeDefined();
      expect(setup.renderer.root.findDescendantById("runledger-block-timeline-assistant-1-text")).toBeDefined();
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
        expect(setup.renderer.root.findDescendantById("runledger-block-timeline-run-run-native")).toBeDefined();
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
      onInput: (data) => inputs.push(data),
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

  test("copies a native conversation selection when mouse selection finishes", async () => {
    const setup = await createTestRenderer({ width: 60, height: 16 });
    const inputs: string[] = [];
    const copy = spyOn(setup.renderer, "copyToClipboardOSC52").mockReturnValue(true);
    const runtime = createOpenTuiComponentRuntimeFromRenderer(setup.renderer, {
      onInput: (data) => inputs.push(data),
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
      await setup.mockMouse.drag(0, 0, 18, 1);
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

      const historyBefore = setup.renderer.root.findDescendantById("runledger-block-history-1");
      const activeBefore = setup.renderer.root.findDescendantById("runledger-block-active-1");
      const editorBefore = setup.renderer.root.findDescendantById("runledger-editor");
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

      expect(setup.renderer.root.findDescendantById("runledger-block-history-1")?.num)
        .toBe(historyBefore?.num);
      expect(setup.renderer.root.findDescendantById("runledger-block-active-1")?.num)
        .toBe(activeBefore?.num);
      expect(setup.renderer.root.findDescendantById("runledger-editor")?.num)
        .toBe(editorBefore?.num);
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
      const transcript = setup.renderer.root.findDescendantById("runledger-transcript");
      expect(transcript?.getChildren().length).toBe(100);
      expect(transcript?.viewportCulling).toBe(true);
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
      const transcript = setup.renderer.root.findDescendantById("runledger-transcript");
      expect(transcript).toBeDefined();
      if (!transcript) return;
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
      const transcript = setup.renderer.root.findDescendantById("runledger-transcript");
      expect(transcript).toBeDefined();
      if (!transcript) return;
      const bottom = transcript.scrollTop;
      setup.mockInput.pressKey("\x1b[5~");
      await setup.renderOnce();
      expect(transcript.scrollTop).toBeLessThan(bottom);
      expect(setup.renderer.root.findDescendantById("runledger-editor")?.plainText).toBe("draft");
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
      const editor = setup.renderer.root.findDescendantById("runledger-editor");
      expect(editor).toBeDefined();
      if (!editor) return;
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
      const transcript = setup.renderer.root.findDescendantById("runledger-transcript");
      expect(transcript).toBeDefined();
      if (!transcript) return;
      transcript.scrollTop = 0;
      runtime.update({ body: rows(41), editorText: "draft", footer: [] });
      await setup.renderOnce();

      expect(setup.renderer.root.findDescendantById("runledger-new-content")).toBeDefined();
      expect(setup.captureCharFrame()).toContain("new content");

      for (let index = 0; index < 8; index += 1) {
        setup.mockInput.pressKey("\x1b[6~");
        await setup.renderOnce();
      }
      expect(setup.captureCharFrame()).not.toContain("new content");
      expect(setup.renderer.root.findDescendantById("runledger-editor")?.plainText).toBe("draft");
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
      const transcript = setup.renderer.root.findDescendantById("runledger-transcript");
      expect(transcript).toBeDefined();
      if (!transcript) return;
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
      const transcript = setup.renderer.root.findDescendantById("runledger-transcript");
      expect(transcript?.getChildren().length).toBe(10_000);
      expect(transcript?.viewportCulling).toBe(true);
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
        const editorBefore = setup.renderer.root.findDescendantById("runledger-editor");
        setup.resize(width, 18);
        await setup.renderOnce();
        const lines = setup.captureCharFrame().split("\n");
        expect(lines.every((line) => stringWidth(stripAnsi(line)) <= width)).toBe(true);
        expect(setup.renderer.root.findDescendantById("runledger-editor")?.num).toBe(editorBefore?.num);
        expect(setup.renderer.root.findDescendantById("runledger-editor")?.plainText).toBe("draft");
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
      onInput: (data) => inputs.push(data),
      onResize: () => {},
      onActions: (next: readonly { readonly type: string }[]) => actions.push(...next),
      onThemeMode: (mode) => themeModes.push(mode),
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

  test("S6 renders the approval decision overlay in the real OpenTUI renderer", async () => {
    const setup = await createTestRenderer({ width: 72, height: 16 });
    const runtime = createOpenTuiComponentRuntimeFromRenderer(setup.renderer, {
      onInput: () => {},
      onResize: () => {},
    });
    try {
      runtime.update({
        body: [{ id: "approval-context", kind: "text", content: "write requests a governed mutation" }],
        editorText: "",
        footer: ["Waiting for approval"],
        overlay: [{
          kind: "select",
          title: "Approval required",
          options: [
            { value: "allow-once", label: "Allow once" },
            { value: "deny", label: "Deny" },
          ],
          selectedIndex: 0,
        }],
      });
      await setup.renderOnce();
      const frame = setup.captureCharFrame();
      expect(frame).toContain("Approval required");
      expect(frame).toContain("Allow once");
      expect(frame).toContain("Deny");
      expect(frame).toContain("Waiting for approval");
      expect(setup.renderer.currentFocusedRenderable?.id).toBe("runledger-overlay-select-0");
    } finally {
      runtime.destroy();
    }
    expect(setup.renderer.isDestroyed).toBe(true);
  });
});
