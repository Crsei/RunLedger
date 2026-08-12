import { describe, expect, test } from "vitest";
import stringWidth from "string-width";
import { parseMermaidSource } from "../../../src/tui/mermaid/parse.ts";
import { renderMermaidDiagram } from "../../../src/tui/mermaid/render.ts";

describe("Mermaid sequence projection", () => {
  test("renders lanes, message labels, notes, block labels, and autonumber", () => {
    const parsed = parseMermaidSource([
      "sequenceDiagram",
      "autonumber",
      "participant 客户端 as 客户端",
      "participant 服务端 as 服务端",
      "Note over 客户端,服务端: 请求链路",
      "loop retry",
      "客户端->>服务端: 请求",
      "服务端-->>客户端: 返回",
      "end",
    ].join("\n"));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const projected = renderMermaidDiagram(parsed.diagram, 80);
    expect(projected).toMatchObject({ ok: true, width: 80 });
    if (!projected.ok) return;
    const output = projected.lines.map((line) => line.text).join("\n");
    expect(output).toContain("客户端");
    expect(output).toContain("服务端");
    expect(output).toContain("请求链路");
    expect(output).toContain("retry");
    expect(output).toContain("请求");
    expect(output).toContain("返回");
    expect(output).toContain("1");
    expect(projected.lines.every((line) => stringWidth(line.text) <= 80)).toBe(true);
  });

  test("keeps self and lost messages visible in a narrow rectangular frame", () => {
    const parsed = parseMermaidSource([
      "sequenceDiagram",
      "participant A",
      "participant B",
      "A->>A: self",
      "A-x B: lost",
    ].join("\n"));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const projected = renderMermaidDiagram(parsed.diagram, 40);
    expect(projected).toMatchObject({ ok: true });
    if (!projected.ok) return;
    const output = projected.lines.map((line) => line.text).join("\n");
    expect(output).toContain("self");
    expect(output).toContain("lost");
    expect(projected.lines.every((line) => stringWidth(line.text) <= 40)).toBe(true);
  });

  test("keeps source order and draws a block around the items in its scope", () => {
    const parsed = parseMermaidSource([
      "sequenceDiagram",
      "participant A",
      "participant B",
      "Note over A,B: before",
      "loop bounded scope",
      "A->>B: inside one",
      "B-->>A: inside two",
      "end",
      "Note over A,B: after",
    ].join("\n"));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const projected = renderMermaidDiagram(parsed.diagram, 80);
    expect(projected.ok).toBe(true);
    if (!projected.ok) return;
    const rows = projected.lines.map((line) => line.text);
    const rowOf = (text: string): number => rows.findIndex((row) => row.includes(text));
    const blockTop = rowOf("bounded scope");
    const firstMessage = rowOf("inside one");
    const secondMessage = rowOf("inside two");
    const blockBottom = rows.findIndex((row, index) => index > secondMessage && row.includes("└"));

    expect(rowOf("before")).toBeLessThan(blockTop);
    expect(blockTop).toBeLessThan(firstMessage);
    expect(firstMessage).toBeLessThan(secondMessage);
    expect(blockBottom).toBeGreaterThan(secondMessage);
    expect(blockBottom).toBeLessThan(rowOf("after"));
  });

  test("keeps alt and critical branch labels between the messages they separate", () => {
    const parsed = parseMermaidSource([
      "sequenceDiagram",
      "participant A",
      "participant B",
      "alt success",
      "A->>B: primary",
      "else failure",
      "B-->>A: recovery",
      "end",
      "critical commit",
      "A->>B: write",
      "option durable",
      "B-->>A: replay",
      "end",
    ].join("\n"));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const projected = renderMermaidDiagram(parsed.diagram, 80);
    expect(projected.ok).toBe(true);
    if (!projected.ok) return;
    const rows = projected.lines.map((line) => line.text);
    const rowOf = (text: string): number => rows.findIndex((row) => row.includes(text));
    expect(rowOf("primary")).toBeLessThan(rowOf("failure"));
    expect(rowOf("failure")).toBeLessThan(rowOf("recovery"));
    expect(rowOf("write")).toBeLessThan(rowOf("option durable"));
    expect(rowOf("option durable")).toBeLessThan(rowOf("replay"));
  });
});
