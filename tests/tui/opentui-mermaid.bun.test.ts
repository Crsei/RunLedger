import { describe, expect, spyOn, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { createOpenTuiComponentRuntimeFromRenderer } from "../../src/tui/opentui/component-runtime.ts";
import { MermaidBlockRenderable } from "../../src/tui/opentui/mermaid-block-renderable.ts";
import { TuiPerformanceObserver } from "../../src/tui/opentui/performance-observer.ts";

async function renderMarkdown(content: string, height = 20, width = 80): Promise<{
  readonly frame: string;
  readonly destroy: () => void;
}> {
  const setup = await createTestRenderer({ width, height });
  const runtime = createOpenTuiComponentRuntimeFromRenderer(setup.renderer, {
    onInput: () => {},
    onResize: () => {},
  });
  runtime.update({
    body: [{ id: "assistant-mermaid", kind: "markdown", content, streaming: false }],
    editorText: "",
    footer: [],
  });
  for (let pass = 0; pass < 4; pass += 1) await setup.renderOnce();
  return {
    frame: setup.captureCharFrame(),
    destroy: () => runtime.destroy(),
  };
}

function findMermaidBlock(root: { getChildren(): Array<unknown> }): MermaidBlockRenderable | undefined {
  const visit = (node: unknown): MermaidBlockRenderable | undefined => {
    if (node instanceof MermaidBlockRenderable) return node;
    if (!node || typeof node !== "object" || !("getChildren" in node) || typeof node.getChildren !== "function") return undefined;
    for (const child of node.getChildren()) {
      const found = visit(child);
      if (found) return found;
    }
    return undefined;
  };
  return visit(root);
}

describe("OpenTUI Mermaid code-block seam", () => {
  test("projects a closed Mermaid fence through the real Unicode engine", async () => {
    const rendered = await renderMarkdown([
      "```mermaid",
      "flowchart LR",
      "  A[Start] --> B[Done]",
      "```",
    ].join("\n"));
    try {
      expect(rendered.frame).toContain("Start");
      expect(rendered.frame).toContain("Done");
      expect(rendered.frame).not.toContain("[Mermaid diagram: flowchart]");
    } finally {
      rendered.destroy();
    }
  });

  test("reflows a Mermaid block across width buckets while keeping its native block identity", async () => {
    const setup = await createTestRenderer({ width: 40, height: 30 });
    const runtime = createOpenTuiComponentRuntimeFromRenderer(setup.renderer, { onInput: () => {}, onResize: () => {} });
    try {
      const content = ["```mermaid", "flowchart LR", "  A[Start] --> B[Finish]", "```"].join("\n");
      runtime.update({ body: [{ id: "resize-mermaid", kind: "markdown", content, streaming: false }], editorText: "", footer: [] });
      await setup.renderOnce();
      const before = findMermaidBlock(setup.renderer.root);
      expect(before).toBeDefined();
      for (const width of [80, 120, 40]) {
        setup.resize(width, 30);
        runtime.update({ body: [{ id: "resize-mermaid", kind: "markdown", content, streaming: false }], editorText: "", footer: [] });
        await setup.renderOnce();
        expect(setup.captureCharFrame()).toContain("Start");
        expect(setup.captureCharFrame()).toContain("Finish");
      }
      const after = findMermaidBlock(setup.renderer.root);
      expect(after?.num).toBe(before?.num);
    } finally {
      runtime.destroy();
    }
  });

  test("keeps semantic spans theme-aware without putting ANSI bytes into the projection", async () => {
    const setup = await createTestRenderer({ width: 80, height: 20 });
    const runtime = createOpenTuiComponentRuntimeFromRenderer(setup.renderer, { onInput: () => {}, onResize: () => {} });
    try {
      const content = ["```mermaid", "flowchart TD", "  A[Start] --> B[Done]", "```"].join("\n");
      runtime.update({ body: [{ id: "theme-mermaid", kind: "markdown", content, streaming: false }], editorText: "", footer: [] });
      await setup.renderOnce();
      const block = findMermaidBlock(setup.renderer.root);
      expect(block).toBeInstanceOf(MermaidBlockRenderable);
      if (!(block instanceof MermaidBlockRenderable)) return;
      const dark = block.content.chunks.map((chunk) => chunk.fg?.toString() ?? "default").join("|");
      expect(block.plainText).not.toMatch(/\x1b/u);
      setup.renderer.emit("theme_mode", "light");
      await setup.renderOnce();
      const light = block.content.chunks.map((chunk) => chunk.fg?.toString() ?? "default").join("|");
      expect(light).not.toBe(dark);
    } finally {
      runtime.destroy();
    }
  });

  test("uses the latest theme for Mermaid blocks created after the theme event", async () => {
    const setup = await createTestRenderer({ width: 80, height: 20 });
    const runtime = createOpenTuiComponentRuntimeFromRenderer(setup.renderer, { onInput: () => {}, onResize: () => {} });
    try {
      setup.renderer.emit("theme_mode", "light");
      const content = ["```mermaid", "flowchart TD", "  A[Start] --> B[Done]", "```"].join("\n");
      runtime.update({ body: [{ id: "created-in-light", kind: "markdown", content, streaming: false }], editorText: "", footer: [] });
      for (let pass = 0; pass < 4; pass += 1) await setup.renderOnce();
      const block = findMermaidBlock(setup.renderer.root);
      expect(block).toBeInstanceOf(MermaidBlockRenderable);
      if (!(block instanceof MermaidBlockRenderable)) return;
      const light = block.content.chunks.map((chunk) => chunk.fg?.toString() ?? "default").join("|");

      setup.renderer.emit("theme_mode", "dark");
      await setup.renderOnce();
      const dark = block.content.chunks.map((chunk) => chunk.fg?.toString() ?? "default").join("|");
      expect(dark).not.toBe(light);
    } finally {
      runtime.destroy();
    }
  });

  test("shares bounded projection cache entries across repeated Mermaid blocks", async () => {
    const setup = await createTestRenderer({ width: 80, height: 30 });
    const observer = new TuiPerformanceObserver();
    const runtime = createOpenTuiComponentRuntimeFromRenderer(setup.renderer, {
      onInput: () => {},
      onResize: () => {},
      performanceObserver: observer,
    });
    const content = ["```mermaid", "flowchart TD", "  A[Start] --> B[Done]", "```"].join("\n");
    try {
      runtime.update({
        body: [
          { id: "mermaid-one", kind: "markdown", content, streaming: false },
          { id: "mermaid-two", kind: "markdown", content, streaming: false },
        ],
        editorText: "",
        footer: [],
      });
      for (let pass = 0; pass < 5; pass += 1) await setup.renderOnce();
      const snapshot = observer.snapshot();
      expect(setup.captureCharFrame()).toContain("Done");
      expect(snapshot.mermaidProjectionCount).toBeGreaterThanOrEqual(2);
      expect(snapshot.mermaidCacheMisses).toBeGreaterThanOrEqual(1);
      expect(snapshot.mermaidCacheHits).toBeGreaterThanOrEqual(1);
      expect(snapshot.mermaidCacheEntries).toBe(1);
      expect(snapshot.mermaidCacheBytes).toBeGreaterThan(0);
    } finally {
      runtime.destroy();
    }
  });

  test("selects Unicode Mermaid glyphs and sends the selected art through OSC52", async () => {
    const setup = await createTestRenderer({ width: 80, height: 20 });
    const copy = spyOn(setup.renderer, "copyToClipboardOSC52").mockReturnValue(true);
    const runtime = createOpenTuiComponentRuntimeFromRenderer(setup.renderer, { onInput: () => {}, onResize: () => {} });
    try {
      runtime.update({
        body: [{ id: "selectable-mermaid", kind: "markdown", content: [
          "```mermaid",
          "flowchart TD",
          "  A[Start] --> B[Done]",
          "```",
        ].join("\n"), streaming: false }],
        editorText: "",
        footer: [],
      });
      for (let pass = 0; pass < 5; pass += 1) await setup.renderOnce();
      await setup.mockMouse.drag(0, 1, 9, 2);
      const selected = setup.renderer.getSelection()?.getSelectedText() ?? "";
      expect(selected).toContain("┌");
      expect(copy).toHaveBeenCalledWith(selected);
    } finally {
      copy.mockRestore();
      runtime.destroy();
    }
  });

  test("destroys Mermaid body projections when their keyed Markdown block is removed", async () => {
    const setup = await createTestRenderer({ width: 80, height: 20 });
    const runtime = createOpenTuiComponentRuntimeFromRenderer(setup.renderer, { onInput: () => {}, onResize: () => {} });
    try {
      const content = ["```mermaid", "flowchart TD", "  A[Start] --> B[Done]", "```"].join("\n");
      runtime.update({ body: [{ id: "removable-mermaid", kind: "markdown", content, streaming: false }], editorText: "", footer: [] });
      for (let pass = 0; pass < 5; pass += 1) await setup.renderOnce();
      const block = findMermaidBlock(setup.renderer.root);
      expect(block).toBeDefined();

      runtime.update({ body: [{ id: "kept-text", kind: "text", content: "kept sibling" }], editorText: "", footer: [] });
      await setup.renderOnce();
      expect(block?.isDestroyed).toBe(true);
      expect(setup.captureCharFrame()).toContain("kept sibling");
    } finally {
      runtime.destroy();
    }
  });

  test("replaces only Mermaid blocks in mixed Markdown and leaves failed blocks as source", async () => {
    const rendered = await renderMarkdown([
      "Heading",
      "item",
      "```mermaid",
      "flowchart TD",
      "  A[Good] --> B[Graph]",
      "```",
      "```mermaid",
      "flowchart TD",
      "  A --> B",
      "  click B \"https://example.invalid\"",
      "```",
      "```typescript",
      "const value = 1;",
      "```",
    ].join("\n"), 80);
    try {
      expect(rendered.frame).toContain("Heading");
      expect(rendered.frame).toContain("item");
      expect(rendered.frame).toContain("Good");
      expect(rendered.frame).toContain("click B");
      expect(rendered.frame).toContain("const value = 1;");
    } finally {
      rendered.destroy();
    }
  });

  test("replaces a closed Mermaid fence with the custom block projection", async () => {
    const rendered = await renderMarkdown([
      "```mermaid",
      "flowchart TD",
      "  A --> B",
      "```",
    ].join("\n"));
    try {
      expect(rendered.frame).toContain("A");
      expect(rendered.frame).toContain("B");
      expect(rendered.frame).not.toContain("[Mermaid diagram: flowchart]");
    } finally {
      rendered.destroy();
    }
  });

  test("keeps an open Mermaid fence on the native source fallback", async () => {
    const rendered = await renderMarkdown([
      "```mermaid",
      "flowchart TD",
      "  A --> B",
    ].join("\n"));
    try {
      expect(rendered.frame).toContain("flowchart TD");
      expect(rendered.frame).not.toContain("[Mermaid diagram: flowchart]");
    } finally {
      rendered.destroy();
    }
  });

  test("does not change ordinary code fences", async () => {
    const rendered = await renderMarkdown([
      "```typescript",
      "const value = 1;",
      "```",
    ].join("\n"));
    try {
      expect(rendered.frame).toContain("const value = 1;");
      expect(rendered.frame).not.toContain("[Mermaid diagram: flowchart]");
    } finally {
      rendered.destroy();
    }
  });

  test("renders a supported state diagram through the same custom block seam", async () => {
    const rendered = await renderMarkdown([
      "```mermaid",
      "stateDiagram",
      "  [*] --> Ready",
      "```",
    ].join("\n"));
    try {
      expect(rendered.frame).toContain("Ready");
      expect(rendered.frame).not.toContain("[Mermaid diagram: state]");
    } finally {
      rendered.destroy();
    }
  });

  test("falls back to the native Mermaid source when a narrow layout cannot fit", async () => {
    const rendered = await renderMarkdown([
      "```mermaid",
      "flowchart LR",
      "  A[Start] --> B[Finish]",
      "```",
    ].join("\n"), 20, 20);
    try {
      expect(rendered.frame).toContain("flowchart LR");
      expect(rendered.frame).toContain("A[Start]");
      expect(rendered.frame).toContain("Finish]");
    } finally {
      rendered.destroy();
    }
  });

  test("retries a previously fallen-back Mermaid block after the terminal widens", async () => {
    const setup = await createTestRenderer({ width: 20, height: 20 });
    const runtime = createOpenTuiComponentRuntimeFromRenderer(setup.renderer, { onInput: () => {}, onResize: () => {} });
    const content = ["```mermaid", "flowchart LR", "  A[Start] --> B[Finish]", "```"].join("\n");
    try {
      runtime.update({ body: [{ id: "recovering-mermaid", kind: "markdown", content, streaming: false }], editorText: "", footer: [] });
      for (let pass = 0; pass < 5; pass += 1) await setup.renderOnce();
      expect(setup.captureCharFrame()).toContain("flowchart LR");

      setup.resize(80, 20);
      runtime.update({ body: [{ id: "recovering-mermaid", kind: "markdown", content, streaming: false }], editorText: "", footer: [] });
      for (let pass = 0; pass < 5; pass += 1) await setup.renderOnce();
      expect(setup.captureCharFrame()).toContain("Start");
      expect(setup.captureCharFrame()).not.toContain("flowchart LR");
    } finally {
      runtime.destroy();
    }
  });

  test("keeps the Markdown renderable identity while an open fence becomes closed", async () => {
    const setup = await createTestRenderer({ width: 80, height: 20 });
    const runtime = createOpenTuiComponentRuntimeFromRenderer(setup.renderer, {
      onInput: () => {},
      onResize: () => {},
    });
    try {
      const id = "streaming-mermaid";
      const renderableId = `runledger-block-${id}`;
      runtime.update({
        body: [{ id, kind: "markdown", content: "```mermaid\nflowchart TD\n  A --> B\n", streaming: true }],
        editorText: "",
        footer: [],
      });
      for (let pass = 0; pass < 4; pass += 1) await setup.renderOnce();
      const before = setup.renderer.root.findDescendantById(renderableId);
      expect(before).toBeDefined();
      expect(setup.captureCharFrame()).not.toContain("[Mermaid diagram: flowchart]");

      runtime.update({
        body: [{ id, kind: "markdown", content: "```mermaid\nflowchart TD\n  A --> B\n```", streaming: false }],
        editorText: "",
        footer: [],
      });
      for (let pass = 0; pass < 4; pass += 1) await setup.renderOnce();
      const after = setup.renderer.root.findDescendantById(renderableId);
      expect(after?.num).toBe(before?.num);
      expect(setup.captureCharFrame()).toContain("A");
      expect(setup.captureCharFrame()).toContain("B");
      expect(setup.captureCharFrame()).not.toContain("flowchart TD");
    } finally {
      runtime.destroy();
    }
  });
});
