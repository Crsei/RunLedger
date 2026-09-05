import { describe, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { type Renderable, BoxRenderable } from "@opentui/core";
import { createOpenTuiComponentRuntimeFromRenderer } from "../../src/tui/opentui/component-runtime.ts";
import { CustomEditor } from "../../src/tui/components/custom-editor.ts";
import { ProcessTerminal, TUI } from "../../src/tui/primitives.ts";
import { loadTheme } from "../../src/tui/theme/theme.ts";
import { makeEditorTheme, makeSelectListTheme } from "../../src/tui/theme/factories.ts";

function editorFixture() {
  const tui = new TUI(new ProcessTerminal());
  const theme = loadTheme("dark");
  const submitted: string[] = [];
  const editor = new CustomEditor(tui, makeEditorTheme(theme, makeSelectListTheme(theme)), {
    theme, selectListTheme: makeSelectListTheme(theme), onSubmit: (text) => submitted.push(text),
  });
  tui.setFocus(editor);
  return { tui, editor, submitted };
}

describe("native input reaches the composer", () => {
  test("bracketed multiline paste inserts at the cursor without submitting or dispatching shortcuts", async () => {
    const setup = await createTestRenderer({ width: 80, height: 24 });
    const { tui, editor, submitted } = editorFixture();
    const runtime = createOpenTuiComponentRuntimeFromRenderer(setup.renderer, {
      onInput: (input) => editor.handleInput(input),
      onPaste: (text) => tui.handlePaste(text),
      onResize: () => {},
    });
    try {
      editor.setText("前后");
      editor.handleInput("left");
      await setup.mockInput.pasteBracketedText("中文🙂\r\n第二行\tABC");
      expect(editor.getText()).toBe("前中文🙂\n第二行    ABC后");
      await setup.mockInput.pasteBracketedText("\n");
      expect(editor.getText()).toBe("前中文🙂\n第二行    ABC\n后");
      expect(submitted).toEqual([]);
      runtime.update({ body: [], footer: [], editorText: editor.getText() });
      await setup.renderOnce();
      expect(setup.captureCharFrame()).toContain("第二行    ABC");
      setup.mockInput.pressEnter();
      expect(submitted).toEqual(["前中文🙂\n第二行    ABC\n后"]);
    } finally { runtime.destroy(); }
  });

  test("legacy Ctrl+J inserts a newline while Enter submits", async () => {
    const setup = await createTestRenderer({ width: 80, height: 24 });
    const { editor, submitted } = editorFixture();
    const runtime = createOpenTuiComponentRuntimeFromRenderer(setup.renderer, {
      onInput: (input) => editor.handleInput(input), onResize: () => {},
    });
    try {
      editor.setText("第一行");
      setup.mockInput.pressKey("j", { ctrl: true });
      expect(editor.getText()).toBe("第一行\n");
      expect(submitted).toEqual([]);
      editor.handleInput("第二行");
      setup.mockInput.pressEnter();
      expect(submitted).toEqual(["第一行\n第二行"]);
    } finally { runtime.destroy(); }
  });

  test("a single thinking option uses content height above the composer", async () => {
    const setup = await createTestRenderer({ width: 80, height: 24 });
    const runtime = createOpenTuiComponentRuntimeFromRenderer(setup.renderer, {
      onInput: () => {}, onResize: () => {},
    });
    try {
      runtime.update({ body: ["conversation remains visible"], editorText: "draft", footer: ["model"],
        overlayAnchor: "bottom-left", overlay: [{ id: "thinking", kind: "select", title: "Thinking",
          options: [{ value: "off", label: "off", description: "reasoning disabled" }], selectedIndex: 0 }],
      });
      await setup.renderOnce();
      const find = (node: Renderable): BoxRenderable | undefined => {
        if (node.id === "runledger-overlay" && node instanceof BoxRenderable) return node;
        for (const child of node.getChildren()) { const result = find(child); if (result) return result; }
        return undefined;
      };
      expect(find(setup.renderer.root)?.height).toBe(5);
      expect(setup.captureCharFrame()).toContain("conversation remains visible");
    } finally { runtime.destroy(); }
  });
});
