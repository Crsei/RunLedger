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
import { constants } from "node:fs";
import { access as fsAccess, readFile as fsReadFile, writeFile as fsWriteFile } from "node:fs/promises";
import * as path from "node:path";
import type { AgentTool, AgentToolResult } from "../types.ts";
import { resolveToCwd } from "./tool-support.ts";

const editItemSchema = Type.Object({
  oldText: Type.String({ description: "原文(必须是文件内容子串,精确匹配)" }),
  newText: Type.String({ description: "替换为新文本" }),
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
  readFile: (p) => fsReadFile(p),
  writeFile: (p, content) => fsWriteFile(p, content, "utf-8"),
  access: (p) => fsAccess(p, constants.R_OK | constants.W_OK),
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
    return { oldText: eo["oldText"] as string, newText: eo["newText"] as string };
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
        const idx = current.indexOf(e.oldText);
        if (idx === -1) {
          // 给一个简短上下文 pitch 帮 LLM 自纠正
          const sampleCurrent = current.slice(0, 200);
          throw new Error(
            `edit: oldText 未在文件内找到。文件起始片段:\n${sampleCurrent}\n...`,
          );
        }
        if (firstChangedLine === undefined) {
          firstChangedLine = current.slice(0, idx).split("\n").length;
        }
        current = current.slice(0, idx) + e.newText + current.slice(idx + e.oldText.length);
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
