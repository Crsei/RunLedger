import { MERMAID_LIMITS } from "../limits.ts";
import type {
  MermaidEdgeArrow,
  MermaidEdgeStyle,
  MermaidFlowDirection,
  MermaidFlowchartDiagram,
  MermaidFlowchartEdge,
  MermaidFlowchartGroup,
  MermaidFlowchartNode,
  MermaidFallbackReason,
  MermaidNodeShape,
  MermaidParseResult,
} from "../types.ts";

interface MutableGroup {
  readonly id: string;
  readonly label: string;
  readonly depth: number;
  readonly nodeIds: string[];
  readonly order: number;
}

interface MutableState {
  readonly direction: MermaidFlowDirection;
  readonly nodes: MermaidFlowchartNode[];
  readonly nodeById: Map<string, MermaidFlowchartNode>;
  readonly edges: MermaidFlowchartEdge[];
  readonly groups: MutableGroup[];
  readonly groupStack: MutableGroup[];
}

function failure(reason: MermaidFallbackReason): MermaidParseResult {
  return { ok: false, reason };
}

function cleanLabel(value: string): string {
  const entities: Record<string, string> = {
    "&amp;": "&",
    "&lt;": "<",
    "&gt;": ">",
    "&quot;": '"',
    "&#39;": "'",
  };
  let label = value.replace(/&(amp|lt|gt|quot|#39);/gu, (entity) => entities[entity] ?? entity);
  label = label.replace(/<br\s*\/?>/giu, " ");
  label = label.replace(/(\*\*|__|~~|[*_])/gu, "");
  label = label.replace(/[\u0000-\u001f\u007f]/gu, " ");
  if (label.startsWith('"') && label.endsWith('"') && label.length >= 2) label = label.slice(1, -1);
  return label.trim();
}

function parseNodeExpression(value: string): { readonly id: string; readonly label: string; readonly shape: MermaidNodeShape; readonly hasLabel: boolean } | undefined {
  const match = /^([^\s\[\](){}|]+)\s*(?:\[([^\]]*)\]|\(([^)]*)\)|\{([^}]*)\})?$/u.exec(value.trim());
  if (!match) return undefined;
  const id = match[1]!.trim();
  const rawLabel = match[2] ?? match[3] ?? match[4];
  const shape: MermaidNodeShape = match[2] !== undefined ? "rect" : match[3] !== undefined ? "round" : match[4] !== undefined ? "diamond" : "rect";
  return { id, label: cleanLabel(rawLabel ?? id), shape, hasLabel: rawLabel !== undefined };
}

function upsertNode(state: MutableState, expression: string): MermaidFlowchartNode | undefined {
  const parsed = parseNodeExpression(expression);
  if (!parsed) return undefined;
  const existing = state.nodeById.get(parsed.id);
  if (existing) {
    if (parsed.hasLabel && existing.label !== parsed.label && existing.label !== existing.id) return undefined;
    if (parsed.hasLabel && existing.shape !== "rect" && parsed.shape !== "rect" && existing.shape !== parsed.shape) return undefined;
    if (parsed.hasLabel && existing.label === existing.id && parsed.label !== existing.id) {
      const replacement: MermaidFlowchartNode = { ...existing, label: parsed.label, shape: parsed.shape };
      const index = state.nodes.findIndex((node) => node.id === existing.id);
      if (index >= 0) state.nodes[index] = replacement;
      state.nodeById.set(parsed.id, replacement);
      return replacement;
    }
    return existing;
  }
  if (state.nodes.length >= MERMAID_LIMITS.nodes) return undefined;
  const node: MermaidFlowchartNode = {
    id: parsed.id,
    label: parsed.label,
    shape: parsed.shape,
    order: state.nodes.length,
  };
  state.nodes.push(node);
  state.nodeById.set(node.id, node);
  for (const activeGroup of state.groupStack) {
    if (!activeGroup.nodeIds.includes(node.id)) activeGroup.nodeIds.push(node.id);
  }
  return node;
}

function parseEdgeOperator(operator: string): { readonly style: MermaidEdgeStyle; readonly arrow: MermaidEdgeArrow } {
  const style: MermaidEdgeStyle = operator.startsWith("-.") ? "dotted" : operator.startsWith("==") ? "thick" : "solid";
  const arrow: MermaidEdgeArrow = operator.endsWith(">") ? "arrow" : operator.endsWith("o") ? "circle" : operator.endsWith("x") ? "cross" : "none";
  return { style, arrow };
}

interface ParsedEdgeSegment {
  readonly left: string;
  readonly operator: string;
  readonly label?: string;
  readonly right: string;
}

type ParsedEdgeChain =
  | { readonly found: false }
  | { readonly found: true; readonly ok: false }
  | { readonly found: true; readonly ok: true; readonly segments: readonly ParsedEdgeSegment[] };

const edgeOperators = ["-.->", "-.-", "==>", "-->", "--o", "--x", "==", "--"] as const;

function findEdgeOperator(value: string, start: number): { readonly index: number; readonly operator: string } | undefined {
  let quote = false;
  let squareDepth = 0;
  let roundDepth = 0;
  let braceDepth = 0;
  for (let index = start; index < value.length; index += 1) {
    const character = value[index]!;
    if (character === '"') {
      quote = !quote;
      continue;
    }
    if (quote) continue;
    if (character === "[") squareDepth += 1;
    else if (character === "]") squareDepth = Math.max(0, squareDepth - 1);
    else if (character === "(") roundDepth += 1;
    else if (character === ")") roundDepth = Math.max(0, roundDepth - 1);
    else if (character === "{") braceDepth += 1;
    else if (character === "}") braceDepth = Math.max(0, braceDepth - 1);
    if (squareDepth > 0 || roundDepth > 0 || braceDepth > 0) continue;
    const operator = edgeOperators.find((candidate) => value.startsWith(candidate, index));
    if (operator !== undefined) return { index, operator };
  }
  return undefined;
}

function parseEdgeChain(line: string): ParsedEdgeChain {
  let operator = findEdgeOperator(line, 0);
  if (operator === undefined) return { found: false };
  let left = line.slice(0, operator.index).trim();
  if (left.length === 0) return { found: true, ok: false };
  const segments: ParsedEdgeSegment[] = [];
  while (operator !== undefined) {
    let cursor = operator.index + operator.operator.length;
    while (/\s/u.test(line[cursor] ?? "")) cursor += 1;
    let label: string | undefined;
    if (line[cursor] === "|") {
      const labelEnd = line.indexOf("|", cursor + 1);
      if (labelEnd < 0) return { found: true, ok: false };
      label = cleanLabel(line.slice(cursor + 1, labelEnd));
      cursor = labelEnd + 1;
      while (/\s/u.test(line[cursor] ?? "")) cursor += 1;
    }
    const next = findEdgeOperator(line, cursor);
    const right = line.slice(cursor, next?.index ?? line.length).trim();
    if (right.length === 0) return { found: true, ok: false };
    segments.push({ left, operator: operator.operator, ...(label === undefined ? {} : { label }), right });
    left = right;
    operator = next;
  }
  return { found: true, ok: true, segments };
}

function groupExpression(value: string, order: number, depth: number): MutableGroup | undefined {
  const parsed = parseNodeExpression(value.trim());
  if (!parsed) return undefined;
  return { id: parsed.id, label: parsed.label, depth, nodeIds: [], order };
}

function parseDirection(value: string): MermaidFlowDirection | undefined {
  const normalized = value.toUpperCase();
  return normalized === "TD" || normalized === "TB" || normalized === "BT" || normalized === "LR" || normalized === "RL"
    ? normalized
    : undefined;
}

export function parseFlowchart(source: string): MermaidParseResult {
  const lines = source.replace(/\r\n?/gu, "\n").split("\n");
  const header = (lines.shift() ?? "").trim();
  const headerMatch = /^(?:flowchart|graph)\s+(\S+)$/iu.exec(header);
  if (!headerMatch) return failure("unsupported_kind");
  const direction = parseDirection(headerMatch[1]!);
  if (!direction) return failure("malformed_source");

  const state: MutableState = {
    direction,
    nodes: [],
    nodeById: new Map(),
    edges: [],
    groups: [],
    groupStack: [],
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("%%")) continue;
    if (/^click\b/iu.test(line) || /^link\b/iu.test(line)) return failure("unsupported_syntax");

    if (/^subgraph(?:\s|$)/iu.test(line)) {
      const group = groupExpression(line.replace(/^subgraph\s*/iu, ""), state.groups.length, state.groupStack.length + 1);
      if (!group) return failure("malformed_source");
      if (state.groups.length >= MERMAID_LIMITS.groups) return failure("group_limit");
      if (group.depth > MERMAID_LIMITS.depth) return failure("depth_limit");
      state.groups.push(group);
      state.groupStack.push(group);
      continue;
    }
    if (line.toLowerCase() === "end") {
      if (state.groupStack.length === 0) return failure("malformed_source");
      state.groupStack.pop();
      continue;
    }
    if (/^direction\s+/iu.test(line)) {
      if (!parseDirection(line.replace(/^direction\s+/iu, ""))) return failure("malformed_source");
      continue;
    }

    const edgeChain = parseEdgeChain(line);
    if (edgeChain.found) {
      if (!edgeChain.ok) return failure("malformed_source");
      if (state.edges.length + edgeChain.segments.length > MERMAID_LIMITS.edges) return failure("edge_limit");
      for (const edge of edgeChain.segments) {
        const left = upsertNode(state, edge.left);
        const right = upsertNode(state, edge.right);
        if (!left || !right) return failure(state.nodes.length >= MERMAID_LIMITS.nodes ? "node_limit" : "malformed_source");
        const edgeStyle = parseEdgeOperator(edge.operator);
        state.edges.push({
          from: left.id,
          to: right.id,
          ...(edge.label === undefined || edge.label.length === 0 ? {} : { label: edge.label }),
          ...edgeStyle,
          order: state.edges.length,
        });
      }
      continue;
    }

    if (!upsertNode(state, line)) return failure(state.nodes.length >= MERMAID_LIMITS.nodes ? "node_limit" : "malformed_source");
  }

  if (state.groupStack.length > 0) return failure("malformed_source");
  if (state.nodes.length === 0) return failure("malformed_source");

  const groups: MermaidFlowchartGroup[] = state.groups.map((group) => ({
    id: group.id,
    label: group.label,
    depth: group.depth,
    nodeIds: [...group.nodeIds],
    order: group.order,
  }));
  return {
    ok: true,
    diagram: {
      kind: "flowchart",
      direction: state.direction,
      nodes: [...state.nodes],
      edges: [...state.edges],
      groups,
    },
  };
}
