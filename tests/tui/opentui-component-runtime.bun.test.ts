import { describe, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import {
  createOpenTuiComponentRuntimeFromRenderer,
} from "../../src/tui/opentui/component-runtime.ts";

describe("OpenTUI component projection", () => {
  test("绘制 timeline/editor/footer/overlay，并由 owner 销毁 renderer", async () => {
    const setup = await createTestRenderer({ width: 60, height: 16 });
    const inputs: string[] = [];
    const themeModes: string[] = [];
    const runtime = createOpenTuiComponentRuntimeFromRenderer(setup.renderer, {
      onInput: (data) => inputs.push(data),
      onResize: () => {},
      onThemeMode: (mode) => themeModes.push(mode),
    });
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

      setup.mockInput.pressKey("c", { ctrl: true });
      await setup.mockInput.pasteBracketedText("粘贴内容");
      expect(inputs).toEqual(["ctrl+c", "粘贴内容"]);

      setup.resize(80, 18);
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
});
