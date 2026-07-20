/**
 * find 工具:按 glob pattern 找文件。
 *
 * 对齐 pi core/tools/find.ts,简化为:
 *   - 优先 fd,fallback find -name
 *   - pattern 示例: *.ts, src/STAR-STAR/test.ts (避免在注释里写 STAR-STAR/ 触发提前闭)
 *   - 不引第三方 glob 库
 *
 * Schema:
 *   { pattern: string; path?: string; limit?: number }
 */

import { Type } from "typebox";
import type { Static } from "typebox";
import { localExecutionEnv, type Shell } from "../execution-env.ts";
import type { AgentTool, AgentToolResult } from "../types.ts";
import {
  resolveToCwd,
  truncateHead,
  DEFAULT_MAX_BYTES,
  type TruncationResult,
} from "./tool-support.ts";

const findSchema = Type.Object({
  pattern: Type.String({ description: "glob pattern, e.g. *.ts or src/**/test.ts" }),
  path: Type.Optional(Type.String({ description: "搜索根目录; 默认 cwd" })),
  limit: Type.Optional(Type.Number({ description: "最大结果数, 默认 1000" })),
});

export type FindToolInput = Static<typeof findSchema>;

export interface FindToolDetails {
  truncation?: TruncationResult;
  resultLimitReached?: number;
}

export interface FindToolOptions {
  shell?: Shell;
}

const DEFAULT_LIMIT = 1000;

export function createFindTool(
  cwd: string,
  options: FindToolOptions = {},
): AgentTool<typeof findSchema, FindToolDetails> {
  const shell = options.shell ?? localExecutionEnv(cwd).shell;
  return {
    name: "find",
    label: "find",
    description: "按 glob pattern 查找文件。默认上限 1000 个。优先 fd, 失败回退 find。",
    parameters: findSchema,
    async execute(_toolCallId, params, signal?): Promise<AgentToolResult<FindToolDetails>> {
      const searchPath = resolveToCwd(params.path, cwd);
      const limit = params.limit ?? DEFAULT_LIMIT;
      const pattern = params.pattern;

      // 探测 fd 是否可用;失败即直接走 find fallback
      const probe = await shell.exec("fd --version", { cwd, maxOutputChars: 1024, timeoutMs: 5_000, signal });
      const hasFd = probe.exitCode === 0;

      let r;
      let isError: boolean;
      if (hasFd) {
        const fdCmd = "fd --glob --hidden --color=never --max-results " + limit + " -- " + quote(pattern) + " " + quote(toPosixPath(searchPath));
        r = await shell.exec(fdCmd, { cwd, maxOutputChars: DEFAULT_MAX_BYTES, signal, timeoutMs: 30_000 });
        isError = r.exitCode !== 0;
      } else {
        // 降级 find -name;pattern 形如 `src/*/.ts` 不归一为 simple glob
        const simpleGlob = pattern.replace(/^\*\*\//, "").replace(/\/.*$/, "");
        const effective = simpleGlob === "" ? pattern : simpleGlob;
        const findCmd = "find " + quote(toPosixPath(searchPath)) + " -name " + quote(effective) + " -print | head -n " + limit;
        r = await shell.exec(findCmd, { cwd, maxOutputChars: DEFAULT_MAX_BYTES, signal, timeoutMs: 60_000 });
        isError = r.exitCode !== 0;
      }

      const { text, truncation } = truncateHead(r.stdout, {
        maxLines: Number.MAX_SAFE_INTEGER,
        maxBytes: DEFAULT_MAX_BYTES,
      });
      const details: FindToolDetails = {};
      if (truncation.truncated) details.truncation = truncation;
      const lines = r.stdout.split("\n").filter((l) => l.length > 0).length;
      if (lines >= limit) details.resultLimitReached = limit;

      return {
        content: [{ type: "text", text: isError ? r.stderr + "\n" + text : text }],
        details,
        terminate: false,
      };
    },
  };
}

function quote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

function toPosixPath(p: string): string {
  return p.split("\\").join("/");
}
