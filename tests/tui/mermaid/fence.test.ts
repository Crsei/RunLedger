import { describe, expect, test } from "vitest";
import { inspectMermaidFence } from "../../../src/tui/mermaid/fence.ts";

describe("Mermaid fenced block contract", () => {
  test("accepts a closed case-insensitive backtick fence and preserves source", () => {
    const result = inspectMermaidFence([
      "```Mermaid theme=base",
      "flowchart TD",
      "  A --> B",
      "```",
    ].join("\n"));

    expect(result).toEqual({
      ok: true,
      language: "mermaid",
      marker: "`",
      markerLength: 3,
      source: "flowchart TD\n  A --> B",
    });
  });

  test("accepts a longer tilde fence when the closing marker matches", () => {
    const result = inspectMermaidFence([
      "~~~~mermaid",
      "sequenceDiagram",
      "  A->>B: hello",
      "~~~~",
    ].join("\n"));

    expect(result).toMatchObject({
      ok: true,
      marker: "~",
      markerLength: 4,
      source: "sequenceDiagram\n  A->>B: hello",
    });
  });

  test("rejects an open fence so OpenTUI can keep rendering source while streaming", () => {
    expect(inspectMermaidFence("```mermaid\nflowchart TD\n  A --> B\n")).toEqual({
      ok: false,
      reason: "open_fence",
    });
  });

  test("rejects a non-Mermaid code fence without consuming it", () => {
    expect(inspectMermaidFence("```typescript\nconst value = 1;\n```")).toEqual({
      ok: false,
      reason: "unsupported_kind",
    });
  });

  test("rejects a blank Mermaid source", () => {
    expect(inspectMermaidFence("```mermaid\n\n```")).toEqual({
      ok: false,
      reason: "blank_source",
    });
  });

  test("rejects source above the bounded byte budget before parsing", () => {
    const source = "flowchart TD\n" + "  A --> B\n".repeat(7_000);
    const result = inspectMermaidFence(`\`\`\`mermaid\n${source}\`\`\``);

    expect(result).toEqual({
      ok: false,
      reason: "source_limit",
    });
  });
});
