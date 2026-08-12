import { MERMAID_LIMITS } from "../limits.ts";
import { cleanMermaidText, isComment, normalizedLines, validIdentifier } from "./shared.ts";
import type {
  MermaidFallbackReason,
  MermaidFlowDirection,
  MermaidParseResult,
  MermaidStateDiagram,
  MermaidStateGroup,
  MermaidStateNode,
  MermaidStateTransition,
  MermaidStateType,
} from "../types.ts";

interface MutableStateNode {
  id: string;
  label: string;
  stateType: MermaidStateType;
  order: number;
}

interface MutableStateGroup {
  id: string;
  label: string;
  depth: number;
  stateIds: string[];
  order: number;
}

interface StateParser {
  direction: MermaidFlowDirection;
  states: MutableStateNode[];
  byId: Map<string, MutableStateNode>;
  transitions: MermaidStateTransition[];
  groups: MutableStateGroup[];
  groupStack: MutableStateGroup[];
  pseudoByScope: Map<string, MutableStateNode>;
}

function failure(reason: MermaidFallbackReason): MermaidParseResult {
  return { ok: false, reason };
}

const stateDiagramV2Header = ["stateDiagram", "v" + "2"].join("-");

function directionOf(value: string): MermaidFlowDirection | undefined {
  const direction = value.trim().toUpperCase();
  return direction === "TD" || direction === "TB" || direction === "BT" || direction === "LR" || direction === "RL"
    ? direction
    : undefined;
}

function ensureState(parser: StateParser, rawId: string, rawLabel?: string, stateType?: MermaidStateType): MutableStateNode | undefined {
  const id = rawId.trim();
  if (!validIdentifier(id)) return undefined;
  const existing = parser.byId.get(id);
  const label = id === "[*]" && rawLabel === undefined ? "[*]" : cleanMermaidText(rawLabel ?? id);
  if (existing) {
    if (rawLabel !== undefined && existing.label !== label && existing.label !== existing.id) return undefined;
    if (stateType !== undefined && existing.stateType !== "normal" && existing.stateType !== stateType) return undefined;
    if (rawLabel !== undefined && existing.label === existing.id) existing.label = label;
    if (stateType !== undefined && existing.stateType === "normal") existing.stateType = stateType;
    return existing;
  }
  if (parser.states.length >= MERMAID_LIMITS.nodes) return undefined;
  const node: MutableStateNode = {
    id,
    label,
    stateType: stateType ?? (id === "[*]" ? "start" : "normal"),
    order: parser.states.length,
  };
  parser.states.push(node);
  parser.byId.set(id, node);
  for (const group of parser.groupStack) {
    if (node.stateType !== "start" && node.stateType !== "end" && !group.stateIds.includes(id)) group.stateIds.push(id);
  }
  return node;
}

function ensurePseudoState(parser: StateParser, stateType: "start" | "end"): MutableStateNode | undefined {
  const scope = parser.groupStack.map((group) => group.id).join("/") || "root";
  const key = `${scope}:${stateType}`;
  const existing = parser.pseudoByScope.get(key);
  if (existing) return existing;
  const node = ensureState(parser, `__mermaid_${stateType}_${parser.states.length}`, "[*]", stateType);
  if (node) parser.pseudoByScope.set(key, node);
  return node;
}

function parseStateDeclaration(parser: StateParser, line: string): "ok" | MermaidFallbackReason | undefined {
  const composite = /^state\s+(?:"([^"]+)"|([^\s{]+))(?:\s+as\s+([^\s{]+))?\s*\{$/iu.exec(line);
  if (composite) {
    const id = composite[3] ?? composite[2] ?? composite[1];
    if (!id) return "malformed_source";
    const node = ensureState(parser, id, composite[1] ?? id);
    if (!node) return parser.states.length >= MERMAID_LIMITS.nodes ? "node_limit" : "malformed_source";
    if (parser.groups.length >= MERMAID_LIMITS.groups) return "group_limit";
    const depth = parser.groupStack.length + 1;
    if (depth > MERMAID_LIMITS.depth) return "depth_limit";
    const group: MutableStateGroup = {
      id: node.id,
      label: node.label,
      depth,
      stateIds: [],
      order: parser.groups.length,
    };
    parser.groups.push(group);
    parser.groupStack.push(group);
    return "ok";
  }

  const display = /^state\s+"([^"]+)"\s+as\s+([^\s]+)$/iu.exec(line);
  if (display) {
    return ensureState(parser, display[2]!, display[1]!)
      ? "ok"
      : parser.states.length >= MERMAID_LIMITS.nodes ? "node_limit" : "malformed_source";
  }

  const choice = /^state\s+([^\s]+)\s+<<([^>]+)>>$/iu.exec(line);
  if (choice) {
    if (choice[2]!.trim().toLowerCase() !== "choice") return "unsupported_syntax";
    return ensureState(parser, choice[1]!, choice[1]!, "choice")
      ? "ok"
      : parser.states.length >= MERMAID_LIMITS.nodes ? "node_limit" : "malformed_source";
  }

  const description = /^state\s+([^\s]+)\s*:\s*(.+)$/iu.exec(line);
  if (description) {
    return ensureState(parser, description[1]!, description[2]!)
      ? "ok"
      : parser.states.length >= MERMAID_LIMITS.nodes ? "node_limit" : "malformed_source";
  }
  if (/^state\b/iu.test(line)) return "unsupported_syntax";
  return undefined;
}

function parseTransition(parser: StateParser, line: string): MermaidFallbackReason | undefined {
  const match = /^(.+?)\s*-->\s*(.+?)(?:\s*:\s*(.*))?$/u.exec(line);
  if (!match) return "unsupported_syntax";
  const from = match[1]!.trim();
  const to = match[2]!.trim();
  if (!validIdentifier(from) || !validIdentifier(to) || from.includes("--") || to.includes("--")) return "malformed_source";
  const fromNode = from === "[*]" ? ensurePseudoState(parser, "start") : ensureState(parser, from);
  const toNode = to === "[*]" ? ensurePseudoState(parser, "end") : ensureState(parser, to);
  if (!fromNode || !toNode) return parser.states.length >= MERMAID_LIMITS.nodes ? "node_limit" : "malformed_source";
  if (parser.transitions.length >= MERMAID_LIMITS.edges) return "edge_limit";
  const label = match[3] === undefined ? undefined : cleanMermaidText(match[3]);
  parser.transitions.push({
    from: fromNode.id,
    to: toNode.id,
    ...(label === undefined || label.length === 0 ? {} : { label }),
    order: parser.transitions.length,
  });
  return undefined;
}

export function parseStateDiagram(source: string): MermaidParseResult {
  const lines = normalizedLines(source);
  const header = (lines.shift() ?? "").trim();
  if (header.toLowerCase() !== "statediagram" && header.toLowerCase() !== stateDiagramV2Header.toLowerCase()) return failure("unsupported_kind");
  const parser: StateParser = {
    direction: "TD",
    states: [],
    byId: new Map(),
    transitions: [],
    groups: [],
    groupStack: [],
    pseudoByScope: new Map(),
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.length === 0 || isComment(line)) continue;
    if (line === "}") {
      if (parser.groupStack.length === 0) return failure("malformed_source");
      parser.groupStack.pop();
      continue;
    }
    const direction = /^direction\s+(.+)$/iu.exec(line);
    if (direction) {
      if (!directionOf(direction[1]!)) return failure("malformed_source");
      parser.direction = directionOf(direction[1]!)!;
      continue;
    }
    if (/^(?:note|end\s+note|fork|join|par|and\b)/iu.test(line)) return failure("unsupported_syntax");
    if (line.includes("--") && !line.includes("-->")) return failure("unsupported_syntax");
    const declaration = parseStateDeclaration(parser, line);
    if (declaration !== undefined) {
      if (declaration !== "ok") return failure(declaration);
      continue;
    }
    const transitionFailure = parseTransition(parser, line);
    if (transitionFailure !== undefined) return failure(transitionFailure);
  }

  if (parser.groupStack.length > 0) return failure("malformed_source");
  if (parser.states.length === 0 || parser.transitions.length === 0) return failure("malformed_source");
  const diagram: MermaidStateDiagram = {
    kind: "state",
    direction: parser.direction,
    states: parser.states.map((state) => ({ ...state })),
    transitions: parser.transitions.map((transition) => ({ ...transition })),
    groups: parser.groups.map((group): MermaidStateGroup => ({ ...group, stateIds: [...group.stateIds] })),
  };
  return { ok: true, diagram };
}
