import { describe, expect, test } from "vitest";
import stringWidth from "string-width";
import { MermaidProjectionCache, makeMermaidCacheKey } from "../../../src/tui/mermaid/cache.ts";
import { displayWidth, graphemes, wrapDisplayWidth } from "../../../src/tui/mermaid/display-width.ts";
import { parseMermaidSource } from "../../../src/tui/mermaid/parse.ts";
import { renderMermaidDiagram } from "../../../src/tui/mermaid/render.ts";

describe("Mermaid bounded parser adversarial inputs", () => {
  test("uses grapheme/display width rather than UTF-16 length", () => {
    const value = "界👩‍💻e\u0301";
    expect(graphemes(value)).toEqual(["界", "👩‍💻", "e\u0301"]);
    expect(displayWidth(value)).toBe(stringWidth(value));
    expect(wrapDisplayWidth(value, 2, 4).every((line) => displayWidth(line) <= 2)).toBe(true);
  });

  test("normalizes CRLF and ignores comments without swallowing nodes", () => {
    const result = parseMermaidSource("flowchart TD\r\n%% comment\r\nA[Start] --> B[End]\r\n");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.diagram.nodes.map((node) => node.label)).toEqual(["Start", "End"]);
  });

  test("produces rectangular, width-bounded rows for wide glyphs", () => {
    const parsed = parseMermaidSource("flowchart LR\nA[界] --> B[👩‍💻]");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const rendered = renderMermaidDiagram(parsed.diagram, 40);
    expect(rendered.ok).toBe(true);
    if (!rendered.ok) return;
    expect(rendered.lines.every((line) => stringWidth(line.text) <= 40)).toBe(true);
    expect(rendered.lines.map((line) => line.text).join("\n")).toContain("界");
    expect(rendered.lines.map((line) => line.text).join("\n")).toContain("👩‍💻");
  });

  test("keeps deterministic mutation inputs typed and non-throwing", () => {
    const base = "flowchart TD\nA[Start] --> B[Done]\nB --> C[Close]";
    for (let index = 0; index < 128; index += 1) {
      const offset = (index * 11) % base.length;
      const mutated = `${base.slice(0, offset)}${base.slice(offset + 1)}`;
      expect(() => parseMermaidSource(mutated)).not.toThrow();
    }

    const control = parseMermaidSource("flowchart TD\nA[\u0000\u200b] --> B[Done]");
    expect(control.ok).toBe(true);
    if (control.ok) {
      expect(control.diagram.nodes[0]?.label).not.toContain("\u0000");
      expect(() => renderMermaidDiagram(control.diagram, 40)).not.toThrow();
    }
  });

  test("bounds long labels, duplicate edges, and deep groups without partial success", () => {
    const longLabel = parseMermaidSource(`flowchart TD\nA[${"x".repeat(10_000)}] --> B[Done]`);
    expect(longLabel.ok).toBe(true);
    if (longLabel.ok) {
      const rendered = renderMermaidDiagram(longLabel.diagram, 80);
      expect(rendered.ok).toBe(true);
      if (rendered.ok) expect(rendered.lines.every((line) => displayWidth(line.text) <= 80)).toBe(true);
    }

    const duplicateEdges = parseMermaidSource([
      "flowchart TD",
      ...Array.from({ length: 513 }, () => "A --> B"),
    ].join("\n"));
    expect(duplicateEdges.ok).toBe(false);

    const openGroups = ["flowchart TD", ...Array.from({ length: 7 }, (_, index) => `subgraph G${index}`), "A[Node]", ...Array.from({ length: 7 }, () => "end")].join("\n");
    const deepGroups = parseMermaidSource(openGroups);
    expect(deepGroups.ok).toBe(false);
  });

  test("keeps warm cache reads below the M6 latency target", () => {
    const cache = new MermaidProjectionCache();
    const key = makeMermaidCacheKey("flowchart TD\nA --> B", 80);
    cache.set(key, {
      ok: true,
      width: 80,
      height: 1,
      lines: [{ text: "A -> B", spans: [] }],
      estimatedBytes: 64,
    });
    const durations: number[] = [];
    for (let index = 0; index < 1_000; index += 1) {
      const startedAt = performance.now();
      expect(cache.get(key)).toBeDefined();
      durations.push(performance.now() - startedAt);
    }
    durations.sort((left, right) => left - right);
    const p95 = durations[Math.floor(durations.length * 0.95)] ?? Number.POSITIVE_INFINITY;
    expect(p95).toBeLessThanOrEqual(2);
  });

  test("keeps simple, dense, near-limit, and fallback inputs within the sync budget", () => {
    const cases = [
      "flowchart LR\nA[Start] --> B[Done]",
      ["flowchart TD", ...Array.from({ length: 40 }, (_, index) => `A${index} --> B${index}`)].join("\n"),
      ["flowchart TD", ...Array.from({ length: 120 }, (_, index) => `N${index}[Node ${index}]`)].join("\n"),
      "mindmap\n  root((unsupported))",
    ];
    const durations = cases.map((source) => {
      const startedAt = performance.now();
      const parsed = parseMermaidSource(source);
      if (parsed.ok) renderMermaidDiagram(parsed.diagram, 80);
      return performance.now() - startedAt;
    });
    expect(durations.every((duration) => Number.isFinite(duration) && duration <= 50)).toBe(true);
  });

  test("finishes the legal 128-node 512-labelled-edge workload within the sync budget", () => {
    const edges = Array.from({ length: 512 }, (_, index) => {
      const from = index % 128;
      const to = (from + 1 + Math.floor(index / 128)) % 128;
      return `N${from} -->|edge ${index}| N${to}`;
    });
    const source = ["flowchart TD", ...edges].join("\n");
    const startedAt = performance.now();
    const parsed = parseMermaidSource(source);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) renderMermaidDiagram(parsed.diagram, 80);
    const duration = performance.now() - startedAt;

    expect(duration).toBeLessThanOrEqual(50);
  });
});
