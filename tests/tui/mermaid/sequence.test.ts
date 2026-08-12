import { describe, expect, test } from "vitest";
import { parseMermaidSource } from "../../../src/tui/mermaid/parse.ts";
import { MERMAID_LIMITS } from "../../../src/tui/mermaid/limits.ts";

describe("bounded Mermaid sequence diagrams", () => {
  test("preserves participant order, sync/async/dotted/self messages, and autonumber", () => {
    const result = parseMermaidSource([
      "sequenceDiagram",
      "  autonumber",
      "  actor Client as Client",
      "  participant Server as Server",
      "  Client->>Server: Request",
      "  Server-->>Client: Response",
      "  Client->>Client: Retry",
      "  Client-x Server: Lost",
    ].join("\n"));

    expect(result).toMatchObject({
      ok: true,
      diagram: {
        kind: "sequence",
        autonumber: true,
        participants: [
          { id: "Client", label: "Client", participantType: "actor" },
          { id: "Server", label: "Server", participantType: "participant" },
        ],
        messages: [
          { from: "Client", to: "Server", style: "solid", arrow: "arrow", number: 1 },
          { from: "Server", to: "Client", style: "dotted", arrow: "arrow", number: 2 },
          { from: "Client", to: "Client", self: true, number: 3 },
          { from: "Client", to: "Server", arrow: "cross", lost: true, number: 4 },
        ],
      },
    });
  });

  test("parses CJK labels, notes, and nested loop/alt/critical blocks", () => {
    const result = parseMermaidSource([
      "sequenceDiagram",
      "  participant 客户端 as 客户端",
      "  participant 服务端 as 服务端",
      "  Note over 客户端,服务端: 请求链路 🚀",
      "  loop retry",
      "    客户端->>服务端: 请求",
      "    alt success",
      "      服务端-->>客户端: 返回",
      "    else failure",
      "      服务端--x 客户端: 失败",
      "    end",
      "  end",
      "  critical commit",
      "    option durable",
      "    客户端->>服务端: 提交",
      "  end",
    ].join("\n"));

    expect(result).toMatchObject({ ok: true, diagram: { kind: "sequence" } });
    if (!result.ok) return;
    expect(result.diagram.participants.map((participant) => participant.id)).toEqual(["客户端", "服务端"]);
    expect(result.diagram.notes).toEqual([
      expect.objectContaining({ position: "over", participantIds: ["客户端", "服务端"], text: "请求链路 🚀" }),
    ]);
    expect(result.diagram.blocks).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "loop", label: "retry", depth: 1 }),
      expect.objectContaining({ kind: "alt", label: "success", depth: 2, branches: ["failure"] }),
      expect.objectContaining({ kind: "critical", label: "commit", depth: 1 }),
    ]));
  });

  test("accepts box and rect presentation blocks without changing message order", () => {
    const result = parseMermaidSource([
      "sequenceDiagram",
      "  participant A",
      "  participant B",
      "  box lightblue Transport",
      "    rect rgb(240, 240, 240)",
      "      A->>B: payload",
      "    end",
      "  end",
    ].join("\n"));

    expect(result).toMatchObject({
      ok: true,
      diagram: {
        blocks: [
          { kind: "box", label: "Transport" },
          { kind: "rect", label: "rgb(240, 240, 240)" },
        ],
        messages: [{ from: "A", to: "B", label: "payload" }],
      },
    });
  });

  test("falls back for orphan arrows, unknown statements, and unclosed blocks", () => {
    expect(parseMermaidSource([
      "sequenceDiagram",
      "participant A",
      "A->>Missing: orphan",
    ].join("\n"))).toEqual({ ok: false, reason: "malformed_source" });

    expect(parseMermaidSource([
      "sequenceDiagram",
      "participant A",
      "participant B",
      "A->>B: request",
      "link A: Dashboard @ https://example.invalid",
    ].join("\n"))).toEqual({ ok: false, reason: "unsupported_syntax" });

    expect(parseMermaidSource([
      "sequenceDiagram",
      "participant A",
      "loop retry",
      "A->>A: self",
    ].join("\n"))).toEqual({ ok: false, reason: "malformed_source" });
  });

  test("enforces participant and sequence item budgets without truncation", () => {
    const messages = Array.from({ length: MERMAID_LIMITS.edges + 1 }, () => "A->>B: item");
    expect(parseMermaidSource([
      "sequenceDiagram",
      "participant A",
      "participant B",
      ...messages,
    ].join("\n"))).toEqual({ ok: false, reason: "sequence_limit" });

    const participants = Array.from({ length: MERMAID_LIMITS.nodes + 1 }, (_, index) => `participant P${index}`);
    expect(parseMermaidSource(["sequenceDiagram", ...participants].join("\n"))).toEqual({
      ok: false,
      reason: "node_limit",
    });
  });
});
