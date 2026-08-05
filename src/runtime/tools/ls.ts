/**
 * ls 工具 —— 列目录内容,排序后输出;条目行尾加 '/' 标目录。
 *
 * 对齐 pi `core/tools/ls.ts`,简化:不 highlight / TUI 渲染。
 */

import { Type } from "typebox";
import type { Static } from "typebox";
import * as path from "node:path";
import type { AgentTool, AgentToolResult } from "../types.ts";
import { localLsOperations } from "./local-defaults.ts";
import {
  DEFAULT_MAX_BYTES,
  resolveToCwd,
  truncateHead,
  type TruncationResult,
} from "./tool-support.ts";

const lsSchema = Type.Object({
  path: Type.Optional(Type.String({ description: "目录;默认 cwd" })),
  limit: Type.Optional(Type.Number({ description: "条目上限,默认 500" })),
});

export type LsToolInput = Static<typeof lsSchema>;

export interface LsToolDetails {
  truncation?: TruncationResult;
  entryLimitReached?: number;
}

export interface LsOperations {
  exists: (p: string) => Promise<boolean>;
  stat: (p: string) => Promise<{ isDirectory: () => boolean }>;
  readdir: (p: string) => Promise<string[]>;
}

/** ls 默认 ops:本地 fs;生产由 createStdlibTools 注入 governed env。 */
export interface LsToolOptions {
  operations?: LsOperations;
}

const DEFAULT_LIMIT = 500;

export function createLsTool(
  cwd: string,
  options: LsToolOptions = {},
): AgentTool<typeof lsSchema, LsToolDetails> {
  const ops = options.operations ?? localLsOperations();
  return {
    name: "ls",
    label: "ls",
    description: `列目录内容,按字母序排序;目录条目尾部加 '/';默认条目上限 ${DEFAULT_LIMIT}。`,
    parameters: lsSchema,
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    async execute(_toolCallId, params, signal?): Promise<AgentToolResult<LsToolDetails>> {
      const dirPath = resolveToCwd(params.path ?? "", cwd);
      const limit = params.limit ?? DEFAULT_LIMIT;
      if (!(await ops.exists(dirPath))) {
        throw new Error(`Path not found: ${dirPath}`);
      }
      const s = await ops.stat(dirPath);
      if (!s.isDirectory()) {
        throw new Error(`Not a directory: ${dirPath}`);
      }
      let entries = await ops.readdir(dirPath);
      entries.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));

      const lines: string[] = [];
      let entryLimitReached: number | undefined;
      for (let i = 0; i < entries.length; i++) {
        if (signal?.aborted) throw new Error("Operation aborted");
        if (i >= limit) {
          entryLimitReached = limit;
          break;
        }
        const subPath = path.join(dirPath, entries[i]!);
        try {
          const subStat = await ops.stat(subPath);
          lines.push(subStat.isDirectory() ? `${entries[i]}/` : entries[i]!);
        } catch {
          // stat 失败仍原样列出
          lines.push(entries[i]!);
        }
      }

      const rawOutput = lines.length === 0 ? "(empty directory)" : lines.join("\n");
      const { text, truncation } = truncateHead(rawOutput, {
        maxLines: Number.MAX_SAFE_INTEGER,
        maxBytes: DEFAULT_MAX_BYTES,
      });

      const details: LsToolDetails = {};
      if (entryLimitReached !== undefined) details.entryLimitReached = entryLimitReached;
      if (truncation.truncated) details.truncation = truncation;

      const hint =
        entryLimitReached !== undefined ? `\n(后 ${entryLimitReached} 条已截断,请使用 limit=${limit * 2} 或更精确 path)` : "";

      return {
        content: [{ type: "text", text: `${text}${hint}` }],
        details,
        terminate: false,
      };
    },
  };
}
