/**
 * read 工具 —— 读文件内容,带行/字节截断。
 *
 * 对齐 pi `core/tools/read.ts`,但只保留文本分支:
 *   - 不处理图片缩放 / MIME 探测(本期 RunLedger 不接 LLM 视觉)
 *   - 不处理 docs/skill/AGENTS.md 紧凑渲染(那是 TUI 关心的事)
 *
 * Path 解析:`{ path: string; offset?: number; limit?: number }` →
 *   resolveToCwd → fs.access(R_OK) → fs.readFile →
 *   按 offset/limit 切片 → truncateHead(maxLines=limit 或 DEFAULT_MAX_LINES)
 *
 * 失败:throw(由 agent-loop 兜底转 isError)。
 */

import { Type } from "typebox";
import type { Static } from "typebox";
import { constants } from "node:fs";
import { access as fsAccess, readFile as fsReadFile } from "node:fs/promises";
import type { AgentTool, AgentToolResult } from "../types.ts";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  resolveReadPathAsync,
  truncateHead,
  type TruncationResult,
} from "./tool-support.ts";

export const readSchema = Type.Object({
  path: Type.String({ description: "要读的文件路径(相对或绝对)" }),
  offset: Type.Optional(Type.Number({ description: "起始行号 (1-indexed)" })),
  limit: Type.Optional(Type.Number({ description: "最多读取行数" })),
});

export type ReadToolInput = Static<typeof readSchema>;

/** read details —— pi 同款:仅承载 truncation 信息。 */
export interface ReadToolDetails {
  truncation?: TruncationResult;
}

/** 可替换 IO;默认走 node:fs。便于测试注入 / 远端代理。 */
export interface ReadOperations {
  readFile: (absolutePath: string) => Promise<Buffer>;
  access: (absolutePath: string) => Promise<void>;
}

const defaultReadOperations: ReadOperations = {
  readFile: (p) => fsReadFile(p),
  access: (p) => fsAccess(p, constants.R_OK),
};

export interface ReadToolOptions {
  operations?: ReadOperations;
}

export function createReadTool(
  cwd: string,
  options: ReadToolOptions = {},
): AgentTool<typeof readSchema, ReadToolDetails> {
  const ops = options.operations ?? defaultReadOperations;
  return {
    name: "read",
    label: "read",
    description: `读取文件内容,按行/字节截断。默认上限 ${DEFAULT_MAX_LINES} 行 / ${DEFAULT_MAX_BYTES} 字节。`,
    parameters: readSchema,
    async execute(_toolCallId, params, _signal?): Promise<AgentToolResult<ReadToolDetails>> {
      const { path: rawPath, offset, limit } = params;
      const absolutePath = await resolveReadPathAsync(rawPath, cwd);
      await ops.access(absolutePath);
      const buf = await ops.readFile(absolutePath);
      const text = buf.toString("utf8");

      const allLines = text === "" ? [] : text.split("\n");
      const startLine = (offset ?? 1) - 1;
      const sliceEnd = limit !== undefined ? startLine + limit : allLines.length;
      const sliced = allLines.slice(Math.max(0, startLine), Math.max(0, sliceEnd));
      const joined = sliced.join("\n");

      const maxLines = limit ?? DEFAULT_MAX_LINES;
      const { text: outText, truncation } = truncateHead(joined, {
        maxLines,
        maxBytes: DEFAULT_MAX_BYTES,
        detectBytesPerLine: true,
      });

      // 截断附 hint
      let displayText = outText;
      const hints: string[] = [];
      if (truncation.truncated) {
        if (truncation.firstLineExceedsLimit) {
          hints.push(
            `Line ${truncation.firstLineExceedsLimit} exceeds byte limit; use \`bash sed -n '${truncation.firstLineExceedsLimit}p' ${absolutePath} | head -c ${DEFAULT_MAX_BYTES}\` to read it.`,
          );
        } else if (truncation.truncatedBy === "bytes" || truncation.truncatedBy === "lines-and-bytes") {
          hints.push(`Use \`offset=${startLine + sliced.length}\` to continue reading.`);
        } else if (truncation.truncatedBy === "lines") {
          hints.push(`Use \`offset=${startLine + sliced.length}\` to continue reading.`);
        }
      }
      if (hints.length > 0) {
        displayText = `${outText}\n\n${hints.join("\n")}`;
      }

      return {
        content: [{ type: "text", text: displayText }],
        details: truncation.truncated ? { truncation } : {},
      };
    },
  };
}
