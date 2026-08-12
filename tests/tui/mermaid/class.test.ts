import { describe, expect, test } from "vitest";
import { parseMermaidSource } from "../../../src/tui/mermaid/parse.ts";
import { MERMAID_LIMITS } from "../../../src/tui/mermaid/limits.ts";

describe("bounded Mermaid class diagrams", () => {
  test("parses classes, members, inheritance, and declaration order", () => {
    const result = parseMermaidSource([
      "classDiagram",
      "  class User {",
      "    +String name",
      "    +login()",
      "  }",
      "  class Admin",
      "  User <|-- Admin",
    ].join("\n"));

    expect(result).toMatchObject({
      ok: true,
      diagram: {
        kind: "class",
        classes: [
          { id: "User", members: [{ display: "+String name" }, { display: "+login()" }] },
          { id: "Admin", members: [] },
        ],
        relations: [{ from: "User", to: "Admin", relation: "inheritance" }],
      },
    });
  });

  test("preserves generics, CJK members, relation labels, and cardinality", () => {
    const result = parseMermaidSource([
      "classDiagram",
      "  class 容器~T~ {",
      "    +T 值",
      "    +添加(T item)",
      "  }",
      "  class 项目",
      "  容器~T~ *-- 项目 : owns",
      "  项目 \"1\" --> \"*\" 容器~T~ : belongs",
    ].join("\n"));

    expect(result).toMatchObject({ ok: true, diagram: { kind: "class" } });
    if (!result.ok) return;
    expect(result.diagram.classes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "容器",
        label: "容器<T>",
        members: expect.arrayContaining([expect.objectContaining({ display: "+T 值" })]),
      }),
      expect.objectContaining({ id: "项目" }),
    ]));
    expect(result.diagram.relations).toEqual(expect.arrayContaining([
      expect.objectContaining({ from: "容器", to: "项目", relation: "composition", label: "owns" }),
      expect.objectContaining({ from: "项目", to: "容器", leftCardinality: "1", rightCardinality: "*", label: "belongs" }),
    ]));
  });

  test("supports the common relation operators", () => {
    const result = parseMermaidSource([
      "classDiagram",
      "  class A",
      "  class B",
      "  class C",
      "  class D",
      "  A o-- B : aggregates",
      "  B ..> C : depends",
      "  C --> D : associates",
    ].join("\n"));

    expect(result).toMatchObject({
      ok: true,
      diagram: {
        relations: [
          { relation: "aggregation" },
          { relation: "dependency" },
          { relation: "association" },
        ],
      },
    });
  });

  test("falls back for namespace, malformed members, and unclosed class bodies", () => {
    expect(parseMermaidSource([
      "classDiagram",
      "  namespace Accounts {",
      "    class User",
      "  }",
    ].join("\n"))).toEqual({ ok: false, reason: "unsupported_syntax" });

    expect(parseMermaidSource([
      "classDiagram",
      "  class User {",
      "    +String name",
      "  User <|-- Admin",
    ].join("\n"))).toEqual({ ok: false, reason: "malformed_source" });

    const members = Array.from({ length: MERMAID_LIMITS.membersPerEntity + 1 }, (_, index) => `+String field${index}`);
    expect(parseMermaidSource(["classDiagram", "class User {", ...members, "}"].join("\n"))).toEqual({
      ok: false,
      reason: "member_limit",
    });
  });
});
