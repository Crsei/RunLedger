/**
 * edit 工具 —— 在已存在文件内做多块 oldText→ newText 替换。
 *
 * 对齐 pi `core/tools/edit.ts`,但用最简 diff 算法:
 *   - 老文本必须是文件原内容子串,严格匹配(`indexOf === -1` 视为失败)
 *   - 不引 fuzzy / line-ending 自动归一化(BOM 标签去除保留,LF 归一仅做 NL 检测)
 *   - diff details 输出 unified patch,以便审计 / UI 后续渲染
 *
 * Schema:
 *   { path: string; edits: Array<{ oldText: string; newText: string }> }
 *
 * 兼容:prepareArguments 把"顶层 oldText/newText"也归一为 edits[0]。
 */

import { Type } from "typebox";
import type { Static } from "typebox";
import * as path from "node:path";
import type { AgentTool, AgentToolResult } from "../types.ts";
import { localExecutionEnv } from "../execution-env.ts";
import { resolveToCwd } from "./tool-support.ts";

const editItemSchema = Type.Object({
  oldText: Type.String({ description: "原文(必须是文件内容子串,精确匹配)" }),
  newText: Type.String({ description: "替换为新文本" }),
  replaceAll: Type.Optional(
    Type.Boolean({
      description: "是否替换所有出现;缺省 false(只替换第一个)。当 oldText 在文件内 >1 次出现且未设 true,会抛错以便 LLM 改用更精确上下文。",
    }),
  ),
  findActualString: Type.Optional(
    Type.Boolean({
      description: "放宽匹配:headers/footers 周围空白允许误差。对齐 pi core/tools/edit.ts 的 find_actual_string 模式。缺省 false。",
    }),
  ),
});

export const editSchema = Type.Object({
  path: Type.String({ description: "要修改的文件路径(相对或绝对)" }),
  edits: Type.Array(editItemSchema, { description: "一系列 oldText → newText 替换块" }),
});

export type EditToolInput = Static<typeof editSchema>;

export interface EditToolDetails {
  diff: string;
  patch: string;
  firstChangedLine?: number;
}

export interface EditOperations {
  readFile: (absolutePath: string) => Promise<Buffer>;
  writeFile: (absolutePath: string, content: string) => Promise<void>;
  access: (absolutePath: string) => Promise<void>;
}

const defaultEditOperations: EditOperations = {
  readFile: (p) => localExecutionEnv().fs.readFile(p),
  writeFile: (p, content) => localExecutionEnv().fs.writeFile(p, content),
  access: async (p) => { await localExecutionEnv().fs.stat(p); },
};

export interface EditToolOptions {
  operations?: EditOperations;
}

/** prepareArguments:兼容顶层 oldText/newText、edits 为 JSON 字符串。 */
function prepareEditArgs(args: unknown): EditToolInput {
  if (!args || typeof args !== "object") {
    throw new Error("edit: invalid arguments");
  }
  const obj = args as Record<string, unknown>;
  let editsRaw = obj["edits"];

  // 顶层 oldText / newText 兼容
  if (!editsRaw && typeof obj["oldText"] === "string" && typeof obj["newText"] === "string") {
    editsRaw = [{ oldText: obj["oldText"], newText: obj["newText"] }];
  }

  // edits 可能被 LLM 编码成 JSON 字符串
  if (typeof editsRaw === "string") {
    try {
      editsRaw = JSON.parse(editsRaw);
    } catch {
      throw new Error("edit: edits 字段解析为 JSON 失败");
    }
  }

  if (!Array.isArray(editsRaw) || editsRaw.length === 0) {
    throw new Error("edit: edits 必须为非空数组");
  }

  const edits = editsRaw.map((e, i) => {
    if (!e || typeof e !== "object") throw new Error(`edit: edits[${i}] 不是对象`);
    const eo = e as Record<string, unknown>;
    if (typeof eo["oldText"] !== "string" || typeof eo["newText"] !== "string") {
      throw new Error(`edit: edits[${i}].oldText/newText 必须是字符串`);
    }
    return {
      oldText: eo["oldText"] as string,
      newText: eo["newText"] as string,
      replaceAll: eo["replaceAll"] === true,
      findActualString: eo["findActualString"] === true,
    };
  });

  const p = obj["path"];
  if (typeof p !== "string" || p === "") throw new Error("edit: path 必须是非空字符串");
  return { path: p, edits };
}

export function createEditTool(
  cwd: string,
  options: EditToolOptions = {},
): AgentTool<typeof editSchema, EditToolDetails> {
  const ops = options.operations ?? defaultEditOperations;
  return {
    name: "edit",
    label: "edit",
    description: "在已有文件内做多块 oldText → newText 替换;oldText 必须严格匹配文件原内容子串。",
    parameters: editSchema,
    isDestructive: () => true,
    prepareArguments: prepareEditArgs as unknown as (args: unknown) => EditToolInput,
    async execute(_toolCallId, params, signal?): Promise<AgentToolResult<EditToolDetails>> {
      const absolutePath = resolveToCwd(params.path, cwd);
      await ops.access(absolutePath);
      const buf = await ops.readFile(absolutePath);
      let original = buf.toString("utf8");

      // 拆 BOM(LF 归一本期不严格做,因为 my workspace 跨 EOL 不大)
      const hasBom = original.charCodeAt(0) === 0xfeff;
      if (hasBom) original = original.slice(1);

      // 多块依次替换;每块匹配失败立即抛错(整个事务回滚:不写入)
      let current = original;
      let firstChangedLine: number | undefined;
      for (const e of params.edits) {
        if (signal?.aborted) throw new Error("Operation aborted");
        if (e.oldText === "") throw new Error("edit: oldText 不能为空");
        const replaceAll = e.replaceAll === true;
        const findActual = e.findActualString === true;

        // 匹配方式
        // - findActualString:true → 用 trim 之后的 oldText 在 trim-each-line 文件里找 anchor
        //   再用 trim-each-line 视图的 start/end 还原到原文件下标区间(不真正改行内空白)。
        //   实现策略:逐行扫描,取每行 trim,拼回带 "\n",再 indexOf 匹配;命中后向原 current
        //   还原区间。
        // - 普通:直接 current.indexOf(e.oldText)
        const match = findActual
          ? findActualMatchRange(current, e.oldText)
          : simpleMatchRange(current, e.oldText, replaceAll);

        if (match === null) {
          // 给一个简短上下文 pitch 帮 LLM 自纠正
          const sampleCurrent = current.slice(0, 200);
          throw new Error(
            `edit: oldText 未在文件内找到。文件起始片段:\n${sampleCurrent}\n...`,
          );
        }
        if (match === "ambiguous" && !replaceAll) {
          throw new Error(
            `edit: oldText 在文件内出现 >1 次;请提供更长上下文或显式 set replaceAll=true。`,
          );
        }
        if (match === "zeroMatches") {
          const sampleCurrent = current.slice(0, 200);
          throw new Error(
            `edit: oldText 未在文件内找到。文件起始片段:\n${sampleCurrent}\n...`,
          );
        }

        // match 必为 MatchRanges
        const ranges = match as MatchRanges;
        if (firstChangedLine === undefined && ranges.length > 0) {
          firstChangedLine = current.slice(0, ranges[0]!.start).split("\n").length;
        }
        // 替换:从后往前替换以避免下标漂移
        let next = current;
        for (let i = ranges.length - 1; i >= 0; i--) {
          const r = ranges[i]!;
          next = next.slice(0, r.start) + e.newText + next.slice(r.end);
        }
        current = next;
      }

      // 计算 diff(以文件原内容 vs 新内容做 unified patch)
      const { patch, diff } = makeUnifiedDiff(original.split("\n"), current.split("\n"));

      // 写回(复原 BOM)
      const finalContent = hasBom ? `\uFEFF${current}` : current;
      await ops.writeFile(absolutePath, finalContent);

      return {
        content: [{ type: "text", text: `Successfully edited ${absolutePath}` }],
        details: {
          diff,
          patch,
          firstChangedLine,
        },
      };
    },
  };
}

/**
 * 简化 LCS-based unified diff。
 * 单文件、行级;pi 用的 diff 库更复杂,本期只求审计可见即可。
 */
function makeUnifiedDiff(oldLines: string[], newLines: string[]): { patch: string; diff: string } {
  // 不做严格 LCS,直接简单逐行比对:同序 prefix / suffix
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) {
    prefix++;
  }
  let suffix = 0;
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix++;
  }

  const removed = oldLines.slice(prefix, oldLines.length - suffix);
  const added = newLines.slice(prefix, newLines.length - suffix);
  const hunkStart = Math.max(1, prefix - 2);
  const context = 2;

  const out: string[] = [];
  out.push(`@@ -${hunkStart},${Math.max(1, removed.length + context)} +${hunkStart},${Math.max(1, added.length + context)} @@`);
  for (let i = hunkStart - 1; i < prefix; i++) out.push(` ${oldLines[i] ?? ""}`);
  for (const l of removed) out.push(`-${l}`);
  for (const l of added) out.push(`+${l}`);
  for (let i = 0; i < context; i++) {
    const idx = oldLines.length - suffix + i;
    if (idx < oldLines.length) out.push(` ${oldLines[idx] ?? ""}`);
  }

  return {
    patch: out.join("\n"),
    diff: removed.length === 0 && added.length === 0 ? "" : out.join("\n"),
  };
}

void path;

// ===== 匹配辅助 =====

interface Range {
  start: number;
  end: number;
}
type MatchRanges = Range[];
type MatchResult = MatchRanges | "ambiguous" | "zeroMatches";

/** 普通匹配:replaceAll=false 时,出现 >1 次返回 "ambiguous" 让调用方提示。 */
function simpleMatchRange(content: string, oldText: string, replaceAll: boolean): MatchResult {
  if (replaceAll) {
    // 收集所有非重叠出现
    const ranges: Range[] = [];
    let i = 0;
    while (true) {
      const idx = content.indexOf(oldText, i);
      if (idx === -1) break;
      ranges.push({ start: idx, end: idx + oldText.length });
      i = idx + oldText.length;
    }
    if (ranges.length === 0) return "zeroMatches";
    return ranges;
  }
  const idx = content.indexOf(oldText);
  if (idx === -1) return "zeroMatches";
  // 检查是否 >1 次出现,提示 ambiguity
  const idx2 = content.indexOf(oldText, idx + oldText.length);
  if (idx2 !== -1) return "ambiguous";
  return [{ start: idx, end: idx + oldText.length }];
}

/**
 * findActualString:true 的"非严格"匹配:
 * 把每行 trim 之后拼回,在 trim-视图里 indexOf,再向原 content 的行边界还原。
 * 实现用:逐行扫描每行 trim 与 trim 后 oldText 的每行做匹配,先匹配上首行后,再用行级
 * cool-form 检查后续行 trim 也相等。返回原 content 的字节区间。
 *
 * 简化:只支持"行级整体匹配"(意思是 oldText 内不能跨行的"半行"片段,但 trimmed 头/尾必
 * 须匹配整行)。这种"按行 trimmed"是 AGENTS.md §"注意事项"中"headers/footer 允许误差"
 * 的常见用法。
 */
function findActualMatchRange(content: string, oldText: string): MatchResult {
  // trim 每一行后 join("\n"),记录原列起点/结束位置
  const contentLines = content.split("\n");
  const oldTextLines = oldText.split("\n");
  if (oldTextLines.length === 0) return "zeroMatches";
  const contentTrimmed = contentLines.map((l) => l.trim());
  const oldTextTrimmed = oldTextLines.map((l) => l.trim());
  // 在 trimmed 视图里找
  const trimmedHaystack = contentTrimmed.join("\n");
  const trimmedNeedle = oldTextTrimmed.join("\n");
  const trIdx = trimmedHaystack.indexOf(trimmedNeedle);
  if (trIdx === -1) return "zeroMatches";
  // 找 trimmed 视图行起点
  // 起始行 = trIdx 之前的 "\n" 个数
  let startLine = 0;
  let consumed = 0;
  while (consumed + contentTrimmed[startLine]!.length < trIdx) {
    consumed += contentTrimmed[startLine]!.length + 1; // +1 for \n
    startLine++;
  }
  const endLine = startLine + oldTextTrimmed.length - 1;

  // 字节区间:在原 content 中,从行 startLine 起点到 endLine 末尾(不含 下一个 \n)
  let byteStart = 0;
  for (let i = 0; i < startLine; i++) byteStart += contentLines[i]!.length + 1;
  let byteEnd = byteStart;
  for (let i = startLine; i <= endLine; i++) byteEnd += contentLines[i]!.length + 1;
  byteEnd -= 1; // 不含 trailing \n

  // 找 trimmed needle 在 trimmed haystack 中的下一次出现,提示 ambiguity
  const trIdx2 = trimmedHaystack.indexOf(trimmedNeedle, trIdx + trimmedNeedle.length);
  if (trIdx2 !== -1) return "ambiguous";

  return [{ start: byteStart, end: byteEnd }];
}
