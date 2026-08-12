import { describe, expect, test } from "vitest";
import { parseMermaidSource } from "../../../src/tui/mermaid/parse.ts";
import { layoutFlowchart } from "../../../src/tui/mermaid/layout/graph.ts";
import { createMermaidCanvas } from "../../../src/tui/mermaid/layout/canvas.ts";

function parseFlowchart(source: string) {
  const result = parseMermaidSource(source);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(`expected flowchart, got ${result.reason}`);
  return result.diagram;
}

describe("Mermaid flowchart layout", () => {
  test("keeps node order deterministic across all primary directions", () => {
    for (const direction of ["TD", "TB", "BT", "LR", "RL"] as const) {
      const diagram = parseFlowchart([
        `flowchart ${direction}`,
        "  A --> B",
        "  B --> C",
      ].join("\n"));
      const first = layoutFlowchart(diagram, 80);
      const second = layoutFlowchart(diagram, 80);
      expect(first).toEqual(second);
      expect(first.ok).toBe(true);
      if (!first.ok) continue;
      expect(first.layout.nodes.map((node) => node.id)).toEqual(["A", "B", "C"]);
      expect(first.layout.width * first.layout.height).toBeLessThanOrEqual(524_288);
    }
  });

  test("frames nested subgraphs without losing the inner node membership", () => {
    const diagram = parseFlowchart([
      "flowchart TD",
      "  subgraph Outer",
      "    subgraph Inner",
      "      A[Node]",
      "    end",
      "  end",
    ].join("\n"));
    expect(diagram.groups.map((group) => group.nodeIds)).toEqual([["A"], ["A"]]);
    const result = layoutFlowchart(diagram, 80);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.layout.groups.map((group) => group.id)).toEqual(["Inner", "Outer"]);
  });

  test("projects solid, dotted, and thick edges with distinguishable glyphs", () => {
    const canvas = createMermaidCanvas(8, 3);
    expect(canvas).toBeDefined();
    if (!canvas) return;
    const segment = [{ x: 0, y: 0 }, { x: 6, y: 0 }];
    canvas.drawPolyline(segment, "edge", 1);
    canvas.drawPolyline(segment.map((point) => ({ ...point, y: 1 })), "edge", 2);
    canvas.drawPolyline(segment.map((point) => ({ ...point, y: 2 })), "edge", 3);

    expect(canvas.toStyledLines().map((line) => line.text)).toEqual([
      "───────",
      "┄┄┄┄┄┄┄",
      "━━━━━━━",
    ]);
  });
});
