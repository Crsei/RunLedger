import { MERMAID_LIMITS } from "./limits.ts";
import type { MermaidFenceResult, MermaidFallbackReason } from "./types.ts";

interface OpeningFence {
  readonly marker: "`" | "~";
  readonly markerLength: number;
  readonly language: string;
}

function failure(reason: MermaidFallbackReason): MermaidFenceResult {
  return { ok: false, reason };
}

function parseOpeningLine(line: string): OpeningFence | undefined {
  const match = /^( {0,3})(`{3,}|~{3,})([^\r\n]*)$/.exec(line);
  if (!match) return undefined;
  const markerText = match[2]!;
  const info = match[3]!.trim();
  if (markerText[0] === "`" && info.includes("`")) return undefined;

  const languageToken = info.split(/[\s,{]/u, 1)[0] ?? "";
  return {
    marker: markerText[0] as "`" | "~",
    markerLength: markerText.length,
    language: languageToken.toLowerCase(),
  };
}

function isClosingLine(line: string, opening: OpeningFence): boolean {
  const match = /^( {0,3})(`+|~+)[ \t]*$/.exec(line);
  if (!match) return false;
  const markerText = match[2]!;
  return markerText[0] === opening.marker && markerText.length === opening.markerLength;
}

/**
 * 有界识别 Markdown Mermaid fenced block。
 *
 * 该函数只处理 fence，不尝试理解 Mermaid grammar；失败时返回 typed reason，
 * 由 OpenTUI adapter 决定调用原生 defaultRender 保留完整 source。
 */
export function inspectMermaidFence(raw: string): MermaidFenceResult {
  const lines = raw.replace(/\r\n?/gu, "\n").split("\n");
  const opening = parseOpeningLine(lines[0] ?? "");
  if (!opening || opening.language !== "mermaid") return failure("unsupported_kind");

  const closingIndex = lines.findIndex((line, index) => index > 0 && isClosingLine(line, opening));
  if (closingIndex < 0) return failure("open_fence");

  const trailingLines = lines.slice(closingIndex + 1);
  if (trailingLines.some((line) => line.trim().length > 0)) return failure("malformed_source");

  const source = lines.slice(1, closingIndex).join("\n");
  if (source.trim().length === 0) return failure("blank_source");
  if (new TextEncoder().encode(source).byteLength > MERMAID_LIMITS.sourceBytes) return failure("source_limit");

  return {
    ok: true,
    language: "mermaid",
    marker: opening.marker,
    markerLength: opening.markerLength,
    source,
  };
}
