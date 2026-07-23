/**
 * MultiEdit 工具 —— 单次调用批量做 N 处编辑。
 *
 * 对齐 claude-code-bun docs/tools/multi-edit-tool.mdx:
 *   - 输入 filePath + edits: [{ oldString, newString, replaceAll? }]
 *   - 在内存里依次应用 edits,任一处 fail 则整体 abort(不写文件)
 *   - 返回 edits applied 数 + 整体 diff 统计
 *
 * 复用 edit 工具:lenient whitespace / findActualString 占位语义;
 * 若 oldString 含全角/制表符空白差异,按字面匹配。
 */

import { Type } from "typebox";
import type { Static } from "typebox";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { AgentTool } from "../types.ts";
import { resolveToCwd } from "./tool-support.ts";

export const multiEditSchema = Type.Object({
  filePath: Type.String({ description: "目标文件路径(相对 cwd 或绝对)" }),
  edits: Type.Array(
    Type.Object({
      oldString: Type.String({ description: "原文片段(必须可重定位)" }),
      newString: Type.String({ description: "新文片段" }),
      replaceAll: Type.Optional(
        Type.Boolean({ description: "为 true 则替换所有出现;缺省 false 仅首处" }),
      ),
    }),
    { description: "一次性应用的所有 edits(按数组顺序)" },
  ),
});

export type MultiEditInput = Static<typeof multiEditSchema>;

export interface MultiEditDetails {
  applied: number;
  diffBytes: number;
}

interface MultiEditOperations {
  readFile: (target: string) => Promise<string>;
  mkdir: (directory: string) => Promise<void>;
  writeFile: (target: string, content: string) => Promise<void>;
}

const defaultMultiEditOperations: MultiEditOperations = {
  readFile: (target) => fs.readFile(target, "utf8"),
  mkdir: async (directory) => { await fs.mkdir(directory, { recursive: true }); },
  writeFile: async (target, content) => { await fs.writeFile(target, content, "utf8"); },
};

export function createMultiEditTool(cwd: string): AgentTool<typeof multiEditSchema, MultiEditDetails> {
  return {
    name: "MultiEdit",
    label: "MultiEdit",
    description: "单次调用对同一文件做 N 处编辑;任一处 fail 则整体 abort。",
    parameters: multiEditSchema,
    governedExecution: "tool-context",
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    async execute(_tc, params, signal?, _onUpdate?, context?): Promise<{
      content: Array<{ type: "text"; text: string }>;
      details: MultiEditDetails;
      terminate: false;
    }> {
      const activeCwd = context ? context.cwd : cwd;
      const activeSignal = context ? context.signal : signal;
      const operations: MultiEditOperations = context
        ? {
            readFile: async (target) => (await context.env.fs.readFile(target)).toString("utf8"),
            mkdir: (directory) => context.env.fs.mkdir(directory, { recursive: true }),
            writeFile: (target, content) => context.env.fs.writeFile(target, content),
          }
        : defaultMultiEditOperations;
      const target = resolveToCwd(params.filePath, activeCwd);
      if (activeSignal?.aborted) throw new Error("Operation aborted");
      const original = await operations.readFile(target);
      let cursor = original;
      let applied = 0;
      let diffBytes = 0;
      for (const e of params.edits ?? []) {
        if (activeSignal?.aborted) throw new Error("Operation aborted");
        if (!e || typeof e.oldString !== "string" || typeof e.newString !== "string") {
          throw new Error("MultiEdit: edit 必须含 oldString/newString 字符串");
        }
        if (e.oldString === e.newString) {
          continue; // 无效:no-op
        }
        if (e.replaceAll) {
          if (!cursor.includes(e.oldString)) {
            throw new Error(`MultiEdit: oldString not found in: ${e.oldString.slice(0, 60)}`);
          }
          const before = cursor.length;
          cursor = cursor.split(e.oldString).join(e.newString);
          diffBytes += cursor.length - before;
          applied++;
        } else {
          const idx = cursor.indexOf(e.oldString);
          if (idx < 0) {
            throw new Error(`MultiEdit: oldString not found in: ${e.oldString.slice(0, 60)}`);
          }
          cursor = cursor.slice(0, idx) + e.newString + cursor.slice(idx + e.oldString.length);
          applied++;
          diffBytes += e.newString.length - e.oldString.length;
        }
      }
      if (cursor !== original) {
        await operations.mkdir(path.dirname(target));
        await operations.writeFile(target, cursor);
      }
      return {
        content: [{ type: "text", text: `MultiEdit ok: ${applied} edits applied, ${diffBytes}+${diffBytes >= 0 ? "+" : ""}${diffBytes} bytes` }],
        details: { applied, diffBytes },
        terminate: false,
      };
    },
  };
}
