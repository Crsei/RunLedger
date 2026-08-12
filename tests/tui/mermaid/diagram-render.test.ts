import { describe, expect, test } from "vitest";
import stringWidth from "string-width";
import { parseMermaidSource } from "../../../src/tui/mermaid/parse.ts";
import { renderMermaidDiagram } from "../../../src/tui/mermaid/render.ts";

const stateDiagramV2 = ["stateDiagram", "v" + "2"].join("-");

function plain(source: string, width = 80): string {
  const parsed = parseMermaidSource(source);
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) return "";
  const projected = renderMermaidDiagram(parsed.diagram as never, width);
  expect(projected).toMatchObject({ ok: true });
  if (!projected.ok) return "";
  expect(projected.lines.every((line) => stringWidth(line.text) <= width)).toBe(true);
  return projected.lines.map((line) => line.text).join("\n");
}

describe("Mermaid state, class, and ER projections", () => {
  test("renders state labels, choice shape, and transition labels", () => {
    const output = plain([
      stateDiagramV2,
      "direction LR",
      "[*] --> Idle",
      "Idle --> Check: ready",
      "state Check <<choice>>",
      "Check --> [*]: done",
    ].join("\n"));
    expect(output).toContain("Idle");
    expect(output).toContain("Check");
    expect(output).toContain("ready");
    expect(output).toContain("done");
  });

  test("renders class members and relation labels without dropping structure", () => {
    const output = plain([
      "classDiagram",
      "class User {",
      "+String name",
      "+login()",
      "}",
      "class Admin",
      "User <|-- Admin : inherits",
    ].join("\n"));
    expect(output).toContain("User");
    expect(output).toContain("String name");
    expect(output).toContain("login()");
    expect(output).toContain("Admin");
    expect(output).toContain("inherits");
  });

  test("renders all eight legal class members without the generic four-line truncation", () => {
    const members = Array.from({ length: 8 }, (_, index) => `+String field${index}`);
    const output = plain([
      "classDiagram",
      "class Complete {",
      ...members,
      "}",
    ].join("\n"));

    for (let index = 0; index < 8; index += 1) expect(output).toContain(`field${index}`);
  });

  test("renders class endpoint semantics and cardinality instead of generic arrows", () => {
    const output = plain([
      "classDiagram",
      "class Parent",
      "class Child",
      "class Whole",
      "class Part",
      "Parent <|-- Child",
      "Whole \"1\" *-- \"many\" Part : owns",
    ].join("\n"), 120);

    expect(output).toContain("△");
    expect(output).toContain("◆");
    expect(output).toContain("1");
    expect(output).toContain("many");
  });

  test("preserves left, right, and absent class association arrow heads", () => {
    const undirected = plain("classDiagram\nclass A\nclass B\nA -- B");
    const right = plain("classDiagram\nclass A\nclass B\nA --> B");
    const left = plain("classDiagram\nclass A\nclass B\nA <-- B");

    expect(undirected).not.toMatch(/[◀▶]/u);
    expect(right).toContain("▶");
    expect(left).toContain("◀");
    expect(left).not.toContain("▶");
  });

  test("renders ER keys, CJK labels, cardinality, and relation labels", () => {
    const output = plain([
      "erDiagram",
      "客户 ||--o{ 订单 : 下单",
      "客户 {",
      "string 编号 PK",
      "string 姓名",
      "}",
      "订单 {",
      "string 编号 PK",
      "}",
    ].join("\n"));
    expect(output).toContain("客户");
    expect(output).toContain("编号");
    expect(output).toContain("PK");
    expect(output).toContain("下单");
    expect(output).toContain("||");
    expect(output).toContain("o{");
  });
});
