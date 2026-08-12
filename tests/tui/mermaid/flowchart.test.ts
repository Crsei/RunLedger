import { describe, expect, test } from "vitest";
import stringWidth from "string-width";
import { parseMermaidSource } from "../../../src/tui/mermaid/parse.ts";
import { renderMermaidDiagram } from "../../../src/tui/mermaid/render.ts";

describe("bounded Mermaid flowcharts", () => {
  test("parses directions, shaped nodes, edge labels, and a cycle without dropping structure", () => {
    const result = parseMermaidSource([
      "flowchart TD",
      "  A[Start] --> B{Ready?}",
      "  B -->|yes| C(RunLedger)",
      "  B -->|no| A",
    ].join("\n"));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.diagram.kind).toBe("flowchart");
    expect(result.diagram.direction).toBe("TD");
    expect(result.diagram.nodes.map((node) => node.id)).toEqual(["A", "B", "C"]);
    expect(result.diagram.nodes.map((node) => node.shape)).toEqual(["rect", "diamond", "round"]);
    expect(result.diagram.edges).toHaveLength(3);
    expect(result.diagram.edges[1]?.label).toBe("yes");
  });

  test("renders deterministic semantic lines within the requested width", () => {
    const parsed = parseMermaidSource([
      "flowchart LR",
      "  start[开始] -->|继续| finish[完成 ✅]",
    ].join("\n"));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const projected = renderMermaidDiagram(parsed.diagram, 40);
    expect(projected).toMatchObject({ ok: true, width: 40 });
    if (!projected.ok) return;
    const plain = projected.lines.map((line) => line.text).join("\n");
    expect(plain).toContain("开始");
    expect(plain).toContain("完成 ✅");
    expect(plain).toContain("继续");
    expect(projected.lines.every((line) => stringWidth(line.text) <= 40)).toBe(true);
  });

  test("parses unspaced and chained edges as topology instead of node ids", () => {
    const result = parseMermaidSource([
      "flowchart LR",
      "  A-->B-->C",
    ].join("\n"));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.diagram.kind).toBe("flowchart");
    expect(result.diagram.nodes.map((node) => node.id)).toEqual(["A", "B", "C"]);
    expect(result.diagram.edges.map((edge) => [edge.from, edge.to])).toEqual([
      ["A", "B"],
      ["B", "C"],
    ]);
  });

  test("fails closed for an unknown structural statement instead of drawing a partial graph", () => {
    const result = parseMermaidSource([
      "flowchart TD",
      "  A --> B",
      "  click B \"https://example.invalid\"",
    ].join("\n"));

    expect(result).toEqual({ ok: false, reason: "unsupported_syntax" });
  });

  test("fails closed for a malformed edge", () => {
    expect(parseMermaidSource("flowchart TD\n  A -->")).toEqual({
      ok: false,
      reason: "malformed_source",
    });
  });
});
