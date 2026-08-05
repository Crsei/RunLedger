/**
 * write 工具 —— 写文件内容;目录不存在则递归创建。
 *
 * 对齐 pi `core/tools/write.ts`,简化:
 *   - 不处理 BOM / highlight 渲染
 *   - 不处理 mutation queue(本工具自身串行 await 即可保证无并发)
 *
 * 行为:resolveToCwd → mkdir(dirname, recursive) → writeFile(path, content, "utf-8") →
 *      返回 `Successfully wrote <N> bytes to <path>` 文本。
 */

import { Type } from "typebox";
import type { Static } from "typebox";
import * as path from "node:path";
import type { AgentTool, AgentToolResult } from "../types.ts";
import { localWriteOperations } from "./local-defaults.ts";
import { resolveToCwd } from "./tool-support.ts";

export const writeSchema = Type.Object({
  path: Type.String({ description: "要写入的文件路径(相对或绝对)" }),
  content: Type.String({ description: "文件内容" }),
});

export type WriteToolInput = Static<typeof writeSchema>;

/** write details:pi 同款为 undefined;content 仅一条"Successfully wrote" 文本。 */
export type WriteToolDetails = undefined;

export interface WriteOperations {
  writeFile: (absolutePath: string, content: string) => Promise<void>;
  mkdir: (dir: string) => Promise<void>;
}

/** write 默认 ops:本地 fs;生产由 createStdlibTools 注入 governed env。 */
export interface WriteToolOptions {
  operations?: WriteOperations;
}

export function createWriteTool(
  cwd: string,
  options: WriteToolOptions = {},
): AgentTool<typeof writeSchema, WriteToolDetails> {
  const ops = options.operations ?? localWriteOperations();
  return {
    name: "write",
    label: "write",
    description: "写入文件;目录不存在会递归创建。会覆盖已有文件。",
    parameters: writeSchema,
    isDestructive: () => true,
    async execute(_toolCallId, params, signal?): Promise<AgentToolResult<WriteToolDetails>> {
      const { path: rawPath, content } = params;
      const absolutePath = resolveToCwd(rawPath, cwd);
      const dir = path.dirname(absolutePath);
      await ops.mkdir(dir);
      if (signal?.aborted) throw new Error("Operation aborted");
      await ops.writeFile(absolutePath, content);
      const bytes = Buffer.byteLength(content, "utf8");
      return {
        content: [{ type: "text", text: `Successfully wrote ${bytes} bytes to ${absolutePath}` }],
        details: undefined,
      };
    },
  };
}
