import { test, expect } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { createOpenTuiComponentRuntimeFromRenderer } from "../../src/tui/opentui/component-runtime.ts";
import { freezeStreamPrefix, type SettledSpan } from "../../src/tui/opentui/settled-prefix.ts";

const FIXTURE = [
  "# Stable heading",
  "",
  "A paragraph with enough words to keep its rendered line stable.",
  "",
  "> a quoted line",
  "",
  "```ts",
  "const value = 1;",
  "```",
  "",
  "- first item",
  "- second item",
  "",
  "| name | value |",
  "| --- | --- |",
  "| alpha | short |",
  "",
  "$$",
  "x + y",
  "$$",
  "",
  "active tail grows here",
].join("\n");

test("keeps settled OpenTUI rows byte-stable while a markdown part grows", async () => {
  const setup = await createTestRenderer({ width: 72, height: 48 });
  const runtime = createOpenTuiComponentRuntimeFromRenderer(setup.renderer, {
    onInput: () => {},
    onResize: () => {},
  });
  let previous: SettledSpan | undefined;
  let previousRows: readonly string[] = [];

  try {
    for (let length = 1; length <= FIXTURE.length; length += 3) {
      const content = FIXTURE.slice(0, length);
      runtime.update({
        body: [{ id: "stream", kind: "markdown", content, streaming: true }],
        editorText: "",
        footer: [],
      });
      await setup.renderOnce();

      const settled = freezeStreamPrefix(content, previous);
      if (settled !== undefined) {
        const settledNode = setup.renderer.root.findDescendantById("runledger-block-stream-settled");
        expect(settledNode).toBeDefined();
        if (settledNode === undefined) continue;
        const rows = setup.captureCharFrame().split("\n")
          .slice(settledNode.screenY, settledNode.screenY + settledNode.height);
        expect(rows.slice(0, previousRows.length)).toEqual(previousRows);
        previousRows = rows;
        previous = settled;
      }
    }
  } finally {
    runtime.destroy();
  }
});

test("reuses the settled prefix and the original keyed tail across appends", async () => {
  const setup = await createTestRenderer({ width: 72, height: 20 });
  const runtime = createOpenTuiComponentRuntimeFromRenderer(setup.renderer, {
    onInput: () => {},
    onResize: () => {},
  });

  try {
    const first = "# Stable heading\n\nactive one";
    runtime.update({ body: [{ id: "stream", kind: "markdown", content: first, streaming: true }], editorText: "", footer: [] });
    await setup.renderOnce();
    const settledId = setup.renderer.root.findDescendantById("runledger-block-stream-settled")?.num;
    const tailId = setup.renderer.root.findDescendantById("runledger-block-stream")?.num;

    runtime.update({ body: [{ id: "stream", kind: "markdown", content: `${first} and more`, streaming: true }], editorText: "", footer: [] });
    await setup.renderOnce();

    expect(setup.renderer.root.findDescendantById("runledger-block-stream-settled")?.num).toBe(settledId);
    expect(setup.renderer.root.findDescendantById("runledger-block-stream")?.num).toBe(tailId);
    expect(setup.captureCharFrame()).toContain("active one and more");
  } finally {
    runtime.destroy();
  }
});

test("drops a settled prefix on rewind and restores the full current part", async () => {
  const setup = await createTestRenderer({ width: 72, height: 20 });
  const runtime = createOpenTuiComponentRuntimeFromRenderer(setup.renderer, {
    onInput: () => {},
    onResize: () => {},
  });

  try {
    runtime.update({ body: [{ id: "stream", kind: "markdown", content: "# Old\n\nold tail", streaming: true }], editorText: "", footer: [] });
    await setup.renderOnce();
    expect(setup.renderer.root.findDescendantById("runledger-block-stream-settled")).toBeDefined();

    runtime.update({ body: [{ id: "stream", kind: "markdown", content: "# Replacement\n\nnew tail", streaming: true }], editorText: "", footer: [] });
    await setup.renderOnce();
    expect(setup.renderer.root.findDescendantById("runledger-block-stream-settled")).toBeUndefined();
    expect(setup.captureCharFrame()).toContain("Replacement");
    expect(setup.captureCharFrame()).not.toContain("old tail");
  } finally {
    runtime.destroy();
  }
});

test("locks a closed table renderable while only its streaming tail grows", async () => {
  const setup = await createTestRenderer({ width: 72, height: 24 });
  const runtime = createOpenTuiComponentRuntimeFromRenderer(setup.renderer, {
    onInput: () => {},
    onResize: () => {},
  });

  try {
    const first = [
      "| name | value |",
      "| --- | --- |",
      "| alpha | short |",
      "",
      "tail",
    ].join("\n");
    runtime.update({ body: [{ id: "table-stream", kind: "markdown", content: first, streaming: true }], editorText: "", footer: [] });
    await setup.renderOnce();
    const settled = setup.renderer.root.findDescendantById("runledger-block-table-stream-settled");
    expect(settled).toBeDefined();
    if (settled === undefined) return;
    const settledId = settled.num;
    const firstRows = setup.captureCharFrame().split("\n").slice(settled.screenY, settled.screenY + settled.height);

    const second = `${first} grows with a much wider tail`;
    runtime.update({ body: [{ id: "table-stream", kind: "markdown", content: second, streaming: true }], editorText: "", footer: [] });
    await setup.renderOnce();
    const settledAgain = setup.renderer.root.findDescendantById("runledger-block-table-stream-settled");
    expect(settledAgain?.num).toBe(settledId);
    if (settledAgain === undefined) return;
    const secondRows = setup.captureCharFrame().split("\n").slice(settledAgain.screenY, settledAgain.screenY + settledAgain.height);

    expect(secondRows).toEqual(firstRows);
    expect(setup.captureCharFrame()).toContain("tail grows with a much wider tail");
  } finally {
    runtime.destroy();
  }
});

test("cold-finalizes a markdown part without leaving a streaming child or losing its rows", async () => {
  const setup = await createTestRenderer({ width: 72, height: 20 });
  const runtime = createOpenTuiComponentRuntimeFromRenderer(setup.renderer, {
    onInput: () => {},
    onResize: () => {},
  });

  try {
    const content = [
      "# Final heading",
      "",
      "```ts",
      "const result = 42;",
      "```",
      "",
      "final body",
    ].join("\n");
    runtime.update({ body: [{ id: "cold-final", kind: "markdown", content, streaming: false }], editorText: "", footer: [] });
    await setup.renderOnce();

    const node = setup.renderer.root.findDescendantById("runledger-block-cold-final");
    expect(node).toBeDefined();
    expect(setup.renderer.root.findDescendantById("runledger-block-cold-final-settled")).toBeUndefined();
    expect((node as { readonly streaming?: boolean } | undefined)?.streaming).toBe(false);
    expect(setup.captureCharFrame()).toContain("Final heading");
    expect(setup.captureCharFrame()).toContain("const result = 42;");
    expect(setup.captureCharFrame()).toContain("final body");
  } finally {
    runtime.destroy();
  }
});

test("finalizes an already split markdown part as one current renderable", async () => {
  const setup = await createTestRenderer({ width: 72, height: 20 });
  const runtime = createOpenTuiComponentRuntimeFromRenderer(setup.renderer, {
    onInput: () => {},
    onResize: () => {},
  });

  try {
    const streaming = "# Stable heading\n\nactive tail";
    runtime.update({ body: [{ id: "warm-final", kind: "markdown", content: streaming, streaming: true }], editorText: "", footer: [] });
    await setup.renderOnce();
    expect(setup.renderer.root.findDescendantById("runledger-block-warm-final-settled")).toBeDefined();
    const currentId = setup.renderer.root.findDescendantById("runledger-block-warm-final")?.num;

    const final = `${streaming} is now complete`;
    runtime.update({ body: [{ id: "warm-final", kind: "markdown", content: final, streaming: false }], editorText: "", footer: [] });
    await setup.renderOnce();

    const current = setup.renderer.root.findDescendantById("runledger-block-warm-final");
    expect(current?.num).toBe(currentId);
    expect(setup.renderer.root.findDescendantById("runledger-block-warm-final-settled")).toBeUndefined();
    expect((current as { readonly streaming?: boolean } | undefined)?.streaming).toBe(false);
    expect(setup.captureCharFrame()).toContain("Stable heading");
    expect(setup.captureCharFrame()).toContain("active tail is now complete");
  } finally {
    runtime.destroy();
  }
});

test("keeps nested-list continuation mutable before settling the completed list", async () => {
  const setup = await createTestRenderer({ width: 72, height: 24 });
  const runtime = createOpenTuiComponentRuntimeFromRenderer(setup.renderer, {
    onInput: () => {},
    onResize: () => {},
  });

  try {
    const open = [
      "- parent item",
      "  - nested item",
      "",
      "    nested continuation",
    ].join("\n");
    runtime.update({ body: [{ id: "nested-stream", kind: "markdown", content: open, streaming: true }], editorText: "", footer: [] });
    await setup.renderOnce();
    expect(setup.renderer.root.findDescendantById("runledger-block-nested-stream-settled")).toBeUndefined();

    const closed = `${open}\n\nnext paragraph`;
    runtime.update({ body: [{ id: "nested-stream", kind: "markdown", content: closed, streaming: true }], editorText: "", footer: [] });
    await setup.renderOnce();
    const settled = setup.renderer.root.findDescendantById("runledger-block-nested-stream-settled");
    expect(settled).toBeDefined();
    if (settled === undefined) return;
    const settledId = settled.num;
    const firstRows = setup.captureCharFrame().split("\n").slice(settled.screenY, settled.screenY + settled.height);

    runtime.update({ body: [{ id: "nested-stream", kind: "markdown", content: `${closed} grows`, streaming: true }], editorText: "", footer: [] });
    await setup.renderOnce();
    const settledAgain = setup.renderer.root.findDescendantById("runledger-block-nested-stream-settled");
    expect(settledAgain?.num).toBe(settledId);
    if (settledAgain === undefined) return;
    const secondRows = setup.captureCharFrame().split("\n").slice(settledAgain.screenY, settledAgain.screenY + settledAgain.height);
    expect(secondRows).toEqual(firstRows);
    expect(setup.captureCharFrame()).toContain("next paragraph grows");
  } finally {
    runtime.destroy();
  }
});

test("does not settle a long single line from visual wrapping alone", async () => {
  const setup = await createTestRenderer({ width: 36, height: 20 });
  const runtime = createOpenTuiComponentRuntimeFromRenderer(setup.renderer, {
    onInput: () => {},
    onResize: () => {},
  });

  try {
    const first = "long single line ".repeat(24);
    runtime.update({ body: [{ id: "long-line", kind: "markdown", content: first, streaming: true }], editorText: "", footer: [] });
    await setup.renderOnce();
    expect(setup.renderer.root.findDescendantById("runledger-block-long-line-settled")).toBeUndefined();

    const second = `${first}suffix arrives after wrapping`;
    runtime.update({ body: [{ id: "long-line", kind: "markdown", content: second, streaming: true }], editorText: "", footer: [] });
    await setup.renderOnce();
    expect(setup.renderer.root.findDescendantById("runledger-block-long-line-settled")).toBeUndefined();
    expect(setup.captureCharFrame()).toContain("suffix arrives after wrapping");
  } finally {
    runtime.destroy();
  }
});
