/**
 * read 行选择器 —— 对齐 oh-my-pi `tools/read-selector.ts` + `tools/path-utils.ts`。
 *
 * 支持的语法(内联在 path 尾部,`:` 分隔):
 *   - `:N` / `:N-M` / `:N-`(到文件末尾)/ `:N+K`(从 N 起 K 行)
 *   - `:N..M`(`-` 的宽松别名)
 *   - `:A-B,C-D` 逗号分隔多段;相邻/重叠段合并,open-ended 段吸收其后所有段
 *   - `:-N` 末尾 N 行(需要先知道总行数,由 resolveTailSelector 定型)
 *   - `:raw` 去掉行号前缀;可与范围复合(`:raw:50-100` / `:50-100:raw`)
 *
 * 显式不实现:`:conflicts`(无冲突检测)、`:img`(无光栅化)、sqlite/archive 的
 * 自有冒号语法 —— 这些在该语法下会**报错**而不是被静默忽略,避免 read 悄悄放宽
 * 成一个读全文的调用。
 *
 * 解析失败一律 throw(`.ts` 工具契约:throw 由 agent-loop 转 isError)。
 */

export interface LineRange {
  readonly startLine: number;
  /** undefined = 到文件末尾。 */
  readonly endLine: number | undefined;
}

export type ParsedSelector =
  | { readonly kind: "none" }
  | { readonly kind: "raw" }
  | { readonly kind: "lines"; readonly ranges: readonly LineRange[]; readonly raw?: boolean }
  /** `:-N` 末尾 N 行;定型前无法切片。 */
  | { readonly kind: "tail"; readonly count: number; readonly raw?: boolean };

/** 选择器边界已成型的形态(除 tail 外)。 */
export type ResolvedSelector = Exclude<ParsedSelector, { readonly kind: "tail" }>;

const LINE_RANGE_CHUNK_RE = /^L?(\d+)(?:(\.\.|[-+])L?(\d+)?)?$/i;
const TAIL_SELECTOR_RE = /^-(\d+)$/;

/** 解析单个 `N` / `N-M` / `N-` / `N+K` / `N..M` 片段;不匹配返回 null,边界非法抛错。 */
export function parseLineRangeChunk(sel: string): LineRange | null {
  const match = LINE_RANGE_CHUNK_RE.exec(sel);
  if (!match) return null;
  const rawStart = Number.parseInt(match[1]!, 10);
  if (rawStart < 1) {
    throw new Error("Line selector 0 is invalid; lines are 1-indexed. Use :1.");
  }
  // `..` 是 `-` 的宽松别名(`2724..2727` == `2724-2727`)。
  const sep = match[2] === ".." ? "-" : match[2];
  const rhs = match[3] ? Number.parseInt(match[3], 10) : undefined;
  let rawEnd: number | undefined;
  if (sep === "+") {
    if (rhs === undefined || rhs < 1) {
      throw new Error(`Invalid range ${rawStart}+${rhs ?? 0}: count must be >= 1.`);
    }
    rawEnd = rawStart + rhs - 1;
  } else if (sep === "-" && rhs !== undefined) {
    if (rhs < rawStart) {
      throw new Error(`Invalid range ${rawStart}-${rhs}: end must be >= start.`);
    }
    rawEnd = rhs;
  }
  // `301-`(无 rhs)等价于"从 301 到末尾"。
  return { startLine: rawStart, endLine: rawEnd };
}

/** 解析逗号分隔的行段列表,升序排序并合并相邻/重叠段。 */
export function parseLineRanges(sel: string): readonly LineRange[] | null {
  const parsed: LineRange[] = [];
  for (const chunk of sel.split(",")) {
    const range = parseLineRangeChunk(chunk);
    if (range === null) return null;
    parsed.push(range);
  }
  if (parsed.length === 0) return null;
  parsed.sort((a, b) => a.startLine - b.startLine);
  const merged: LineRange[] = [parsed[0]!];
  for (let index = 1; index < parsed.length; index += 1) {
    const current = parsed[index]!;
    const last = merged[merged.length - 1]!;
    // open-ended 段表示"到末尾",吸收其后所有段。
    if (last.endLine === undefined) continue;
    if (current.startLine <= last.endLine + 1) {
      if (current.endLine === undefined || current.endLine > last.endLine) {
        merged[merged.length - 1] = { startLine: last.startLine, endLine: current.endLine };
      }
      continue;
    }
    merged.push(current);
  }
  return merged;
}

/** 解析 `-N` 末尾段;非 tail 形态返回 null,`-0` 抛错。 */
export function parseTailCount(sel: string): number | null {
  const match = TAIL_SELECTOR_RE.exec(sel);
  if (!match) return null;
  const count = Number.parseInt(match[1]!, 10);
  if (count < 1) throw new Error("Tail selector -0 is invalid; use :-N with N >= 1.");
  return count;
}

function looksReadLike(chunk: string): boolean {
  const lower = chunk.toLowerCase();
  return lower === "raw" || /^-\d+$/.test(chunk) || parseLineRanges(chunk) !== null;
}

function invalidSelector(sel: string): Error {
  return new Error(
    `Invalid selector ':${sel}'. Use :N, :N-M, :N+K, :N- (open-ended), :-N (last N lines), a comma-separated range list, :raw, or a range combined with raw (e.g. :raw:50-100).`,
  );
}

function parseRangeOrTail(chunk: string, raw: boolean): ParsedSelector | null {
  const ranges = parseLineRanges(chunk);
  if (ranges !== null) return raw ? { kind: "lines", ranges, raw } : { kind: "lines", ranges };
  const count = parseTailCount(chunk);
  if (count !== null) return raw ? { kind: "tail", count, raw } : { kind: "tail", count };
  return null;
}

/** RunLedger 未实现的 read 模式;命中即报错,不静默退化。 */
const UNSUPPORTED_SELECTOR_MODES = new Set(["conflicts", "img"]);

export function parseSel(sel: string | undefined): ParsedSelector {
  if (sel === undefined || sel.length === 0) return { kind: "none" };

  if (sel.includes(":")) {
    const chunks = sel.split(":");
    if (chunks.length === 2) {
      const [a, b] = chunks as [string, string];
      const aIsRaw = a.toLowerCase() === "raw";
      const bIsRaw = b.toLowerCase() === "raw";
      const rangeChunk = aIsRaw ? b : bIsRaw ? a : null;
      if (rangeChunk !== null) {
        const parsed = parseRangeOrTail(rangeChunk, true);
        if (parsed !== null) return parsed;
      }
    }
    // 选择器形状但不属于接受集合的复合式:报错而不是当作 "none" 放宽成全量读。
    if (chunks.every(looksReadLike)) throw invalidSelector(sel);
    return { kind: "none" };
  }

  const lower = sel.toLowerCase();
  if (UNSUPPORTED_SELECTOR_MODES.has(lower)) {
    throw new Error(`Selector ':${sel}' is not supported by this runtime; use line ranges, :raw, or a search tool instead.`);
  }
  if (lower === "raw") return { kind: "raw" };
  const parsed = parseRangeOrTail(sel, false);
  if (parsed !== null) return parsed;
  return { kind: "none" };
}

/** 把 `:-N` 按已知总行数定型为绝对行段;其他形态原样返回。 */
export function resolveTailSelector(parsed: ParsedSelector, totalLines: number): ResolvedSelector {
  if (parsed.kind !== "tail") return parsed;
  const startLine = Math.max(1, totalLines - parsed.count + 1);
  return { kind: "lines", ranges: [{ startLine, endLine: Math.max(startLine, totalLines) }], raw: parsed.raw };
}

export function isRawSelector(parsed: ParsedSelector): boolean {
  return parsed.kind === "raw" || ((parsed.kind === "lines" || parsed.kind === "tail") && parsed.raw === true);
}

/**
 * 从 path 尾部拆出选择器。只接受两种形态,且必须整段匹配语法:
 *   - `path:<range|tail|raw|unsupported-mode>`
 *   - `path:raw:<range|tail>` 与 `path:<range|tail>:raw`
 * 不匹配时整串按路径处理 —— 避免误伤 `C:\...` 与含冒号的普通文件名。
 */
export function splitPathAndSel(rawPath: string): { path: string; sel?: string } {
  const lastColon = rawPath.lastIndexOf(":");
  if (lastColon <= 0) return { path: rawPath };
  const tail = rawPath.slice(lastColon + 1);
  const prefix = rawPath.slice(0, lastColon);
  const tailIsRaw = tail.toLowerCase() === "raw";
  const innerColon = prefix.lastIndexOf(":");
  const inner = innerColon > 0 ? prefix.slice(innerColon + 1) : "";
  const outerPrefix = innerColon > 0 ? prefix.slice(0, innerColon) : "";

  // `path:50-100:raw` —— 末段是显示模式,范围在前一段;必须优先于单段形态判定,
  // 否则会把 `path:50-100` 当成完整路径。
  if (tailIsRaw && innerColon > 0 && isRangeOrTailChunk(inner)) {
    return { path: outerPrefix, sel: `${inner}:${tail}` };
  }
  if (isRangeOrTailChunk(tail) && innerColon > 0 && inner.toLowerCase() === "raw") {
    return { path: outerPrefix, sel: `${inner}:${tail}` };
  }
  if (isSelectorChunk(tail)) return { path: prefix, sel: tail };
  return { path: rawPath };
}

function isSelectorChunk(chunk: string): boolean {
  const lower = chunk.toLowerCase();
  return lower === "raw" || UNSUPPORTED_SELECTOR_MODES.has(lower) || isRangeOrTailChunk(chunk);
}

function isRangeOrTailChunk(chunk: string): boolean {
  if (chunk.length === 0) return false;
  if (TAIL_SELECTOR_RE.test(chunk)) return true;
  try {
    return parseLineRanges(chunk) !== null;
  } catch {
    // 形状像范围但边界非法(如 `:0`):交给解析阶段报错,而不是当成路径。
    return /^[L\d]/.test(chunk);
  }
}
