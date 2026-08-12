import { describe, expect, test } from "vitest";
import { parseMermaidSource } from "../../../src/tui/mermaid/parse.ts";
import { MERMAID_LIMITS } from "../../../src/tui/mermaid/limits.ts";

describe("bounded Mermaid ER diagrams", () => {
  test("parses entities, keyed attributes, relation cardinality, and labels", () => {
    const result = parseMermaidSource([
      "erDiagram",
      "  CUSTOMER ||--o{ ORDER : places",
      "  CUSTOMER {",
      "    string id PK",
      "    string name",
      "  }",
      "  ORDER {",
      "    string id PK",
      "    string customer_id FK",
      "  }",
    ].join("\n"));

    expect(result).toMatchObject({
      ok: true,
      diagram: {
        kind: "er",
        entities: [
          { id: "CUSTOMER", attributes: [{ name: "id", keys: ["PK"] }, { name: "name", keys: [] }] },
          { id: "ORDER", attributes: [{ name: "id", keys: ["PK"] }, { name: "customer_id", keys: ["FK"] }] },
        ],
        relations: [{ from: "CUSTOMER", to: "ORDER", leftCardinality: "||", rightCardinality: "o{", label: "places" }],
      },
    });
  });

  test("preserves CJK entities and supports identifying and non-identifying relations", () => {
    const result = parseMermaidSource([
      "erDiagram",
      "  客户 ||--o{ 订单 : 下单",
      "  客户 {",
      "    string 编号 PK",
      "    string 姓名",
      "  }",
      "  订单 {",
      "    string 编号 PK",
      "  }",
      "  订单 }o..|| 客户 : references",
    ].join("\n"));

    expect(result).toMatchObject({
      ok: true,
      diagram: {
        relations: [
          { identifying: true, label: "下单" },
          { identifying: false, label: "references" },
        ],
      },
    });
  });

  test("falls back for incomplete entities, unknown cardinality, and malformed statements", () => {
    expect(parseMermaidSource([
      "erDiagram",
      "  CUSTOMER {",
      "    string id PK",
    ].join("\n"))).toEqual({ ok: false, reason: "malformed_source" });

    expect(parseMermaidSource([
      "erDiagram",
      "  CUSTOMER ||??o{ ORDER : places",
    ].join("\n"))).toEqual({ ok: false, reason: "unsupported_syntax" });

    expect(parseMermaidSource([
      "erDiagram",
      "  CUSTOMER ||--o{ ORDER : places",
      "  garbage statement",
    ].join("\n"))).toEqual({ ok: false, reason: "unsupported_syntax" });
  });

  test("rejects an entity with more than the shared member budget", () => {
    const attributes = Array.from({ length: MERMAID_LIMITS.membersPerEntity + 1 }, (_, index) => `string field${index}`);
    expect(parseMermaidSource(["erDiagram", "ENTITY {", ...attributes, "}"].join("\n"))).toEqual({
      ok: false,
      reason: "member_limit",
    });
  });
});
