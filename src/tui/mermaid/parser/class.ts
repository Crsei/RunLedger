import { MERMAID_LIMITS } from "../limits.ts";
import { cleanMermaidText, isComment, normalizedLines, unquote, validIdentifier } from "./shared.ts";
import type {
  MermaidClassDiagram,
  MermaidClassMember,
  MermaidClassMemberKind,
  MermaidClassMemberVisibility,
  MermaidClassNode,
  MermaidClassRelation,
  MermaidClassRelationType,
  MermaidFallbackReason,
  MermaidParseResult,
} from "../types.ts";

interface MutableClassNode {
  id: string;
  label: string;
  generic?: string;
  members: MermaidClassMember[];
  order: number;
}

interface ClassParser {
  classes: MutableClassNode[];
  byId: Map<string, MutableClassNode>;
  relations: MermaidClassRelation[];
  activeClass?: MutableClassNode;
}

function failure(reason: MermaidFallbackReason): MermaidParseResult {
  return { ok: false, reason };
}

function parseClassReference(raw: string): { readonly id: string; readonly label: string; readonly generic?: string } | undefined {
  const value = raw.trim();
  const match = /^([^\s~]+)(?:~([^~]+)~)?$/u.exec(value) ?? /^([^\s<]+)(?:<([^>]+)>)?$/u.exec(value);
  if (!match || !validIdentifier(match[1]!)) return undefined;
  const generic = match[2]?.trim();
  return {
    id: match[1]!,
    label: generic === undefined ? match[1]! : `${match[1]}<${generic}>`,
    ...(generic === undefined ? {} : { generic }),
  };
}

function ensureClass(parser: ClassParser, raw: string): MutableClassNode | undefined {
  const reference = parseClassReference(raw);
  if (!reference) return undefined;
  const existing = parser.byId.get(reference.id);
  if (existing) {
    if (existing.label !== reference.label && existing.label !== existing.id) return undefined;
    if (existing.label === existing.id && reference.label !== existing.id) existing.label = reference.label;
    if (existing.generic === undefined && reference.generic !== undefined) existing.generic = reference.generic;
    return existing;
  }
  if (parser.classes.length >= MERMAID_LIMITS.nodes) return undefined;
  const node: MutableClassNode = { ...reference, members: [], order: parser.classes.length };
  parser.classes.push(node);
  parser.byId.set(node.id, node);
  return node;
}

function parseMember(line: string): MermaidClassMember | undefined {
  const match = /^([+\-#~])\s*(.+)$/u.exec(line);
  if (!match) return undefined;
  const visibility = match[1] as MermaidClassMemberVisibility;
  const display = `${visibility}${match[2]!.trim()}`;
  const body = match[2]!.trim();
  const method = /^([^\s(]+)\s*\(([^)]*)\)\s*(.*)$/u.exec(body);
  if (method) {
    const suffix = method[3]!.trim();
    return {
      visibility,
      kind: "method" satisfies MermaidClassMemberKind,
      name: method[1]!,
      ...(suffix.length > 0 ? { type: suffix } : {}),
      display,
      order: 0,
    };
  }
  const field = /^([^\s]+)\s+([^\s]+)$/u.exec(body);
  if (!field) return undefined;
  return {
    visibility,
    kind: "field",
    type: field[1]!,
    name: field[2]!,
    display,
    order: 0,
  };
}

function relationType(operator: string): MermaidClassRelationType | undefined {
  if (operator.includes("|")) return "inheritance";
  if (operator.includes("*")) return "composition";
  if (operator.includes("o")) return "aggregation";
  if (operator.includes("..")) return "dependency";
  if (operator.includes("-")) return "association";
  return undefined;
}

function endpoint(raw: string, side: "left" | "right"): { readonly id: string; readonly reference: string; readonly cardinality?: string } | undefined {
  const value = raw.trim();
  const cardinality = side === "left"
    ? /^(.*?)\s+"([^"]+)"$/u.exec(value)
    : /^"([^"]+)"\s+(.*?)$/u.exec(value);
  const classRaw = cardinality ? side === "left" ? cardinality[1]! : cardinality[2]! : value;
  const reference = parseClassReference(classRaw);
  if (!reference) return undefined;
  return {
    id: reference.id,
    reference: classRaw,
    ...(cardinality ? { cardinality: side === "left" ? cardinality[2]! : cardinality[1]! } : {}),
  };
}

function parseRelation(parser: ClassParser, line: string): MermaidFallbackReason | undefined {
  const match = /^(.+?)\s+(<\|\.\.|<\|--|\*--|o--|\.\.>|<\.\.|-->|<--|\.\.|--)\s+(.+?)(?:\s*:\s*(.*))?$/u.exec(line);
  if (!match) return "unsupported_syntax";
  const left = endpoint(match[1]!, "left");
  const right = endpoint(match[3]!, "right");
  const relation = relationType(match[2]!);
  if (!left || !right || !relation) return "malformed_source";
  const leftClass = ensureClass(parser, left.reference);
  const rightClass = ensureClass(parser, right.reference);
  if (!leftClass || !rightClass) return parser.classes.length >= MERMAID_LIMITS.nodes ? "node_limit" : "malformed_source";
  if (parser.relations.length >= MERMAID_LIMITS.edges) return "edge_limit";
  const label = match[4] === undefined ? undefined : cleanMermaidText(match[4]);
  parser.relations.push({
    from: leftClass.id,
    to: rightClass.id,
    relation,
    operator: match[2]!,
    ...(label === undefined || label.length === 0 ? {} : { label }),
    ...(left.cardinality === undefined ? {} : { leftCardinality: unquote(left.cardinality) }),
    ...(right.cardinality === undefined ? {} : { rightCardinality: unquote(right.cardinality) }),
    order: parser.relations.length,
  });
  return undefined;
}

export function parseClassDiagram(source: string): MermaidParseResult {
  const lines = normalizedLines(source);
  const header = (lines.shift() ?? "").trim();
  if (!/^classDiagram$/iu.test(header)) return failure("unsupported_kind");
  const parser: ClassParser = { classes: [], byId: new Map(), relations: [] };
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.length === 0 || isComment(line)) continue;
    if (parser.activeClass) {
      if (line === "}") {
        parser.activeClass = undefined;
        continue;
      }
      if (/^(?:class|namespace|annotation|namespace)\b/iu.test(line)) return failure("unsupported_syntax");
      if (line.includes("--") || line.includes("..")) return failure("malformed_source");
      const member = parseMember(line);
      if (!member) return failure("unsupported_syntax");
      if (parser.activeClass.members.length >= MERMAID_LIMITS.membersPerEntity) return failure("member_limit");
      parser.activeClass.members.push({ ...member, order: parser.activeClass.members.length });
      continue;
    }
    if (line === "}") return failure("malformed_source");
    if (/^(?:namespace|annotation)\b/iu.test(line)) return failure("unsupported_syntax");
    const classBody = /^class\s+(.+?)\s*\{$/iu.exec(line);
    if (classBody) {
      const node = ensureClass(parser, classBody[1]!);
      if (!node) return parser.classes.length >= MERMAID_LIMITS.nodes ? failure("node_limit") : failure("malformed_source");
      parser.activeClass = node;
      continue;
    }
    const classDeclaration = /^class\s+(.+)$/iu.exec(line);
    if (classDeclaration) {
      if (!ensureClass(parser, classDeclaration[1]!)) return failure("malformed_source");
      continue;
    }
    if (line.includes("--") || line.includes("..")) {
      const relationFailure = parseRelation(parser, line);
      if (relationFailure !== undefined) return failure(relationFailure);
      continue;
    }
    return failure("unsupported_syntax");
  }
  if (parser.activeClass) return failure("malformed_source");
  if (parser.classes.length === 0) return failure("malformed_source");
  const diagram: MermaidClassDiagram = {
    kind: "class",
    classes: parser.classes.map((node) => ({ ...node, members: node.members.map((member) => ({ ...member })) })),
    relations: parser.relations.map((relation) => ({ ...relation })),
  };
  return { ok: true, diagram };
}
