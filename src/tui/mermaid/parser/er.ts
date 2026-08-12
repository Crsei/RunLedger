import { MERMAID_LIMITS } from "../limits.ts";
import { cleanMermaidText, isComment, normalizedLines, validIdentifier } from "./shared.ts";
import type {
  MermaidErAttribute,
  MermaidErDiagram,
  MermaidErEntity,
  MermaidErKey,
  MermaidErRelation,
  MermaidFallbackReason,
  MermaidParseResult,
} from "../types.ts";

interface MutableEntity {
  id: string;
  label: string;
  attributes: MermaidErAttribute[];
  order: number;
}

interface ErParser {
  entities: MutableEntity[];
  byId: Map<string, MutableEntity>;
  relations: MermaidErRelation[];
  activeEntity?: MutableEntity;
}

const leftCardinalities = new Set(["||", "|o", "}o", "}|", "o|", "o{"]);
const rightCardinalities = new Set(["||", "|o", "}o", "}|", "o|", "o{", "|{", "|}"]);

function failure(reason: MermaidFallbackReason): MermaidParseResult {
  return { ok: false, reason };
}

function ensureEntity(parser: ErParser, rawId: string): MutableEntity | undefined {
  const id = rawId.trim();
  if (!validIdentifier(id) || id === "[*]") return undefined;
  const existing = parser.byId.get(id);
  if (existing) return existing;
  if (parser.entities.length >= MERMAID_LIMITS.nodes) return undefined;
  const entity: MutableEntity = { id, label: id, attributes: [], order: parser.entities.length };
  parser.entities.push(entity);
  parser.byId.set(id, entity);
  return entity;
}

function parseAttribute(line: string): MermaidErAttribute | undefined {
  const match = /^(\S+)\s+(\S+)(?:\s+(.+))?$/u.exec(line);
  if (!match) return undefined;
  const rest = (match[3] ?? "").trim();
  const keys: MermaidErKey[] = [];
  let description: string | undefined;
  for (const token of rest.split(/\s+/u).filter((value) => value.length > 0)) {
    const keyTokens = token.toUpperCase().split(",");
    if (keyTokens.every((key) => key === "PK" || key === "FK" || key === "UK")) {
      for (const key of keyTokens as MermaidErKey[]) if (!keys.includes(key)) keys.push(key);
      continue;
    }
    if (token.startsWith('"') && token.endsWith('"')) {
      description = cleanMermaidText(token);
      continue;
    }
    return undefined;
  }
  return {
    type: match[1]!,
    name: match[2]!,
    keys,
    ...(description === undefined ? {} : { description }),
    order: 0,
  };
}

function parseRelation(parser: ErParser, line: string): MermaidFallbackReason | undefined {
  const match = /^(\S+)\s+([|}o]{2}(?:--|\.\.)[|}o{]{2})\s+(\S+)(?:\s*:\s*(.*))?$/u.exec(line);
  if (!match) return "unsupported_syntax";
  const leftCardinality = match[2]!.slice(0, 2);
  const operator = match[2]!.slice(2, 4);
  const rightCardinality = match[2]!.slice(4);
  if (!leftCardinalities.has(leftCardinality) || !rightCardinalities.has(rightCardinality)) return "unsupported_syntax";
  const from = ensureEntity(parser, match[1]!);
  const to = ensureEntity(parser, match[3]!);
  if (!from || !to) return parser.entities.length >= MERMAID_LIMITS.nodes ? "node_limit" : "malformed_source";
  if (parser.relations.length >= MERMAID_LIMITS.edges) return "edge_limit";
  const label = match[4] === undefined ? undefined : cleanMermaidText(match[4]);
  parser.relations.push({
    from: from.id,
    to: to.id,
    leftCardinality,
    rightCardinality,
    identifying: operator === "--",
    ...(label === undefined || label.length === 0 ? {} : { label }),
    order: parser.relations.length,
  });
  return undefined;
}

export function parseErDiagram(source: string): MermaidParseResult {
  const lines = normalizedLines(source);
  const header = (lines.shift() ?? "").trim();
  if (!/^erDiagram$/iu.test(header)) return failure("unsupported_kind");
  const parser: ErParser = { entities: [], byId: new Map(), relations: [] };
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.length === 0 || isComment(line)) continue;
    if (parser.activeEntity) {
      if (line === "}") {
        parser.activeEntity = undefined;
        continue;
      }
      const attribute = parseAttribute(line);
      if (!attribute) return failure("unsupported_syntax");
      if (parser.activeEntity.attributes.length >= MERMAID_LIMITS.membersPerEntity) return failure("member_limit");
      parser.activeEntity.attributes.push({ ...attribute, order: parser.activeEntity.attributes.length });
      continue;
    }
    if (line === "}") return failure("malformed_source");
    if (/^(?:click|style|link)\b/iu.test(line)) return failure("unsupported_syntax");
    const entityBody = /^(\S+)\s*\{$/u.exec(line);
    if (entityBody) {
      const entity = ensureEntity(parser, entityBody[1]!);
      if (!entity) return parser.entities.length >= MERMAID_LIMITS.nodes ? failure("node_limit") : failure("malformed_source");
      parser.activeEntity = entity;
      continue;
    }
    if (line.includes("--") || line.includes("..")) {
      const relationFailure = parseRelation(parser, line);
      if (relationFailure !== undefined) return failure(relationFailure);
      continue;
    }
    return failure("unsupported_syntax");
  }
  if (parser.activeEntity) return failure("malformed_source");
  if (parser.entities.length === 0) return failure("malformed_source");
  const diagram: MermaidErDiagram = {
    kind: "er",
    entities: parser.entities.map((entity) => ({ ...entity, attributes: entity.attributes.map((attribute) => ({ ...attribute, keys: [...attribute.keys] })) })),
    relations: parser.relations.map((relation) => ({ ...relation })),
  };
  return { ok: true, diagram };
}
