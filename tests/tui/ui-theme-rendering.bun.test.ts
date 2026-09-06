import { CodeRenderable, type Renderable } from "@opentui/core";
import { expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { createOpenTuiComponentRuntimeFromRenderer } from "../../src/tui/opentui/component-runtime.ts";
import { resolveUiTheme } from "../../src/tui/theme/ui-theme.ts";
import type { PresentationBlock } from "../../src/tui/presentation.ts";

test("thinking and prose retain independent colors through streaming and theme changes", async () => {
  const setup = await createTestRenderer({ width: 80, height: 30 });
  const runtime = createOpenTuiComponentRuntimeFromRenderer(setup.renderer, { onInput: () => {}, onResize: () => {} });
  const update = async (streaming: boolean, mode: "dark" | "light", variant: "thinking" | undefined = "thinking") => {
    const body: PresentationBlock[] = [
      { id: "thought", kind: "markdown", variant, content: "Thought **bold** then plain. `inline` after code. [link](https://example.test) afterlink.\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nTrailing thought", streaming },
      { id: "answer", kind: "markdown", content: "Answer plain", streaming: false },
    ];
    runtime.update({ body, editorText: "", footer: [], uiTheme: resolveUiTheme({}, mode, {}) });
    await setup.flush();
    await finishHighlights(setup.renderer.root);
    await setup.flush();
  };
  const colorFor = (text: string) => setup.captureSpans().lines.flatMap(line => line.spans).find(span => span.text.includes(text))?.fg.toInts().slice(0, 3);
  try {
    await update(true, "dark");
    expect(colorFor("Thought")).toEqual([119, 125, 136]);
    expect(colorFor("Answer")).toEqual([230, 230, 230]);
    expect(colorFor("then plain")).toEqual([119, 125, 136]);
    expect(colorFor("after code")).toEqual([119, 125, 136]);
    expect(colorFor("afterlink")).toEqual([119, 125, 136]);
    expect(colorFor("inline")).toEqual([125, 207, 255]);
    expect(colorFor("Trailing")).toEqual([119, 125, 136]);
    await update(true, "light");
    expect(colorFor("Thought")).toEqual([108, 108, 108]);
    expect(colorFor("Trailing")).toEqual([108, 108, 108]);
    await update(false, "light");
    expect(colorFor("Thought")).toEqual([108, 108, 108]);
    expect(colorFor("Answer")).toEqual([26, 26, 26]);

    // 显式使用普通块，验证同内容节点复用的样式失效。
    runtime.update({ body: [{ id: "thought", kind: "markdown", content: "Thought", streaming: false }], editorText: "", footer: [], uiTheme: resolveUiTheme({}, "light", {}) });
    await setup.flush();
    await finishHighlights(setup.renderer.root);
    await setup.flush();
    expect(colorFor("Thought")).toEqual([26, 26, 26]);
    runtime.update({ body: [
      { id: "thought", kind: "markdown", variant: "thinking", content: "CustomThought", streaming: false },
      { id: "user", kind: "text", role: "user", content: "CustomUser" },
      { id: "answer", kind: "markdown", content: "CustomAnswer", streaming: false },
    ], editorText: "", footer: [], uiTheme: resolveUiTheme({ colors: { common: { thinkingText: "#123456", userMessage: "#abcdef", assistantMessage: "#654321", background: "#222222" } } }, "dark", {}) });
    await setup.flush();
    await finishHighlights(setup.renderer.root);
    await setup.flush();
    expect(colorFor("CustomThought")).toEqual([18, 52, 86]);
    expect(colorFor("CustomUser")).toEqual([171, 205, 239]);
    expect(colorFor("CustomAnswer")).toEqual([101, 67, 33]);
  } finally { await finishHighlights(setup.renderer.root); runtime.destroy(); }
});

async function finishHighlights(node: Renderable): Promise<void> {
  if (node instanceof CodeRenderable) await node.highlightingDone;
  await Promise.all(node.getChildren().map(finishHighlights));
}
