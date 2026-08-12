import { describe, expect, test } from "vitest";
import { parseMermaidSource } from "../../../src/tui/mermaid/parse.ts";
import { MERMAID_LIMITS } from "../../../src/tui/mermaid/limits.ts";

const stateDiagramV2 = ["stateDiagram", "v" + "2"].join("-");

describe("bounded Mermaid state diagrams", () => {
  test("parses direction, start/end transitions, labels, and declaration order", () => {
    const result = parseMermaidSource([
      stateDiagramV2,
      "  direction LR",
      "  [*] --> Idle",
      "  Idle --> Running: start",
      "  Running --> Idle: pause",
      "  Running --> [*]: stop",
    ].join("\n"));

    expect(result).toMatchObject({ ok: true, diagram: { kind: "state", direction: "LR" } });
    if (!result.ok) return;
    const start = result.diagram.states.find((state) => state.stateType === "start");
    const end = result.diagram.states.find((state) => state.stateType === "end");
    expect(start).toBeDefined();
    expect(end).toBeDefined();
    expect(start?.id).not.toBe(end?.id);
    expect(result.diagram.states.map((state) => state.id)).toEqual([
      start?.id,
      "Idle",
      "Running",
      end?.id,
    ]);
    expect(result.diagram.transitions).toEqual([
      expect.objectContaining({ from: start?.id, to: "Idle" }),
      expect.objectContaining({ from: "Idle", to: "Running", label: "start" }),
      expect.objectContaining({ from: "Running", to: "Idle", label: "pause" }),
      expect.objectContaining({ from: "Running", to: end?.id, label: "stop" }),
    ]);
  });

  test("supports display labels, choice states, and a closed composite state", () => {
    const result = parseMermaidSource([
      "stateDiagram",
      "  state \"Waiting for input\" as Waiting",
      "  state Check <<choice>>",
      "  state Parent {",
      "    [*] --> Child",
      "    Child --> [*]",
      "  }",
      "  Waiting --> Check: ready",
      "  Check --> Parent",
    ].join("\n"));

    expect(result).toMatchObject({ ok: true, diagram: { kind: "state" } });
    if (!result.ok) return;
    expect(result.diagram.states).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "Waiting", label: "Waiting for input" }),
      expect.objectContaining({ id: "Check", stateType: "choice" }),
      expect.objectContaining({ id: "Parent" }),
    ]));
    expect(result.diagram.groups).toEqual([expect.objectContaining({ id: "Parent", stateIds: ["Child"] })]);
  });

  test("keeps CJK and emoji labels in the state IR", () => {
    const result = parseMermaidSource([
      stateDiagramV2,
      "  [*] --> 等待",
      "  等待 --> 运行中: 开始 🚀",
      "  运行中 --> [*]: 完成",
    ].join("\n"));

    expect(result).toMatchObject({ ok: true, diagram: { kind: "state" } });
    if (!result.ok) return;
    expect(result.diagram.states).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "等待", label: "等待" }),
      expect.objectContaining({ id: "运行中", label: "运行中" }),
    ]));
    expect(result.diagram.transitions).toEqual(expect.arrayContaining([
      expect.objectContaining({ from: "等待", to: "运行中", label: "开始 🚀" }),
    ]));
  });

  test("falls back for an unknown note and an unclosed composite", () => {
    expect(parseMermaidSource([
      stateDiagramV2,
      "[*] --> Ready",
      "note right of Ready",
      "  not supported",
      "end note",
    ].join("\n"))).toEqual({ ok: false, reason: "unsupported_syntax" });

    expect(parseMermaidSource([
      stateDiagramV2,
      "state Parent {",
      "  [*] --> Child",
    ].join("\n"))).toEqual({ ok: false, reason: "malformed_source" });

    expect(parseMermaidSource([
      stateDiagramV2,
      "[*] --> A",
      "A --> B",
      "B --> C",
      ...Array.from({ length: MERMAID_LIMITS.edges }, () => "A --> B"),
    ].join("\n"))).toEqual({ ok: false, reason: "edge_limit" });
  });

  test("rejects a state with more than the shared node budget", () => {
    const source = [
      stateDiagramV2,
      ...Array.from({ length: MERMAID_LIMITS.nodes + 1 }, (_, index) => `S${index} --> S${index + 1}`),
    ].join("\n");
    expect(parseMermaidSource(source)).toEqual({ ok: false, reason: "node_limit" });
  });
});
