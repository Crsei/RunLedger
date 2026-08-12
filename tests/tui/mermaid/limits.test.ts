import { describe, expect, test } from "vitest";
import { createMermaidCanvas } from "../../../src/tui/mermaid/layout/canvas.ts";
import { MERMAID_LIMITS } from "../../../src/tui/mermaid/limits.ts";
import { parseMermaidSource } from "../../../src/tui/mermaid/parse.ts";

function bareNodes(count: number): string {
  return ["flowchart TD", ...Array.from({ length: count }, (_, index) => `N${index}`)].join("\n");
}

function repeatedEdges(count: number): string {
  return ["flowchart TD", "A", "B", ...Array.from({ length: count }, () => "A --> B")].join("\n");
}

describe("Mermaid flowchart resource limits", () => {
  test("accepts the exact node and edge budgets and rejects one over", () => {
    expect(parseMermaidSource(bareNodes(MERMAID_LIMITS.nodes)).ok).toBe(true);
    expect(parseMermaidSource(bareNodes(MERMAID_LIMITS.nodes + 1))).toEqual({ ok: false, reason: "node_limit" });
    expect(parseMermaidSource(repeatedEdges(MERMAID_LIMITS.edges)).ok).toBe(true);
    expect(parseMermaidSource(repeatedEdges(MERMAID_LIMITS.edges + 1))).toEqual({ ok: false, reason: "edge_limit" });
  });

  test("checks canvas multiplication before allocating typed arrays", () => {
    expect(createMermaidCanvas(1_024, 512)).toBeDefined();
    expect(createMermaidCanvas(1_024, 513)).toBeUndefined();
    expect(createMermaidCanvas(0, 1)).toBeUndefined();
  });

  test("rejects UTF-8 source bytes above the parser budget", () => {
    const source = `flowchart TD\nA[${"界".repeat(MERMAID_LIMITS.sourceBytes)}]`;
    expect(parseMermaidSource(source)).toEqual({ ok: false, reason: "source_limit" });
  });
});
