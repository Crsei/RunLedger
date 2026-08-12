import { MERMAID_LIMITS } from "./limits.ts";
import { parseFlowchart } from "./parser/flowchart.ts";
import { parseClassDiagram } from "./parser/class.ts";
import { parseErDiagram } from "./parser/er.ts";
import { parseStateDiagram } from "./parser/state.ts";
import { parseSequenceDiagram } from "./parser/sequence.ts";
import type { MermaidParseResult } from "./types.ts";

export function parseMermaidSource(source: string): MermaidParseResult {
  if (source.trim().length === 0) return { ok: false, reason: "blank_source" };
  if (new TextEncoder().encode(source).byteLength > MERMAID_LIMITS.sourceBytes) return { ok: false, reason: "source_limit" };
  const firstLine = source.replace(/\r\n?/gu, "\n").split("\n", 1)[0]?.trim().toLowerCase() ?? "";
  if (/^(?:flowchart|graph)\b/u.test(firstLine)) return parseFlowchart(source);
  if (/^statediagram\b/u.test(firstLine)) return parseStateDiagram(source);
  if (/^classdiagram\b/u.test(firstLine)) return parseClassDiagram(source);
  if (/^erdiagram\b/u.test(firstLine)) return parseErDiagram(source);
  if (/^sequencediagram\b/u.test(firstLine)) return parseSequenceDiagram(source);
  return { ok: false, reason: "unsupported_kind" };
}
