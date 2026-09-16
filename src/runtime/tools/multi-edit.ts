/**
 * MultiEdit 工具 —— 单次调用批量做 N 处编辑。
 *
 * 对齐 claude-code-bun docs/tools/multi-edit-tool.mdx:
 *   - 输入 filePath + edits: [{ oldText, newText, replaceAll? }]
 *   - 在内存里依次应用 edits,任一处 fail 则整体 abort(不写文件)
 *   - 返回 edits applied 数 + 整体 diff 统计
 *
 * 字段命名与 `edit` 工具统一为 `oldText`/`newText`;prepareArguments 继续接受
 * 历史/外部调用习惯(`oldString`/`newString`、`old_string`/`new_string`、
 * `path`/`file_path` 作为 filePath)。
 * 匹配按字面量;`oldText` 含全角/制表符空白差异时不放宽。
 */

import { Type } from "typebox";
import type { Static } from "typebox";
import * as path from "node:path";
import type { AgentTool } from "../types.ts";
import { localMultiEditFileSystem } from "./local-defaults.ts";
import type { FileSystem } from "../execution-env.ts";
import { resolveToCwd } from "./tool-support.ts";

export const multiEditSchema = Type.Object({
  filePath: Type.String({ description: "目标文件路径(相对 cwd 或绝对)" }),
  edits: Type.Array(
    Type.Object({
      oldText: Type.String({ description: "原文片段(必须是文件内容子串,精确匹配)" }),
      newText: Type.String({ description: "替换为新文本" }),
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

export interface MultiEditToolOptions {
  readonly fileSystem?: FileSystem;
}

/** 归一 filePath 与 edit 字段的历史命名;失败时 throw 交由 agent-loop 转 isError。 */
function prepareMultiEditArgs(args: unknown): MultiEditInput {
  if (!args || typeof args !== "object") throw new Error("MultiEdit: invalid arguments");
  const obj = args as Record<string, unknown>;
  const filePath = obj["filePath"] ?? obj["path"] ?? obj["file_path"];
  if (typeof filePath !== "string" || filePath === "") {
    throw new Error("MultiEdit: filePath 必须是非空字符串");
  }
  let rawEdits = obj["edits"];
  if (typeof rawEdits === "string") {
    try {
      rawEdits = JSON.parse(rawEdits);
    } catch {
      throw new Error("MultiEdit: edits 字段解析为 JSON 失败");
    }
  }
  if (!Array.isArray(rawEdits) || rawEdits.length === 0) {
    throw new Error("MultiEdit: edits 必须为非空数组");
  }
  const edits = rawEdits.map((entry, index) => {
    if (!entry || typeof entry !== "object") throw new Error(`MultiEdit: edits[${index}] 不是对象`);
    const record = entry as Record<string, unknown>;
    const oldText = record["oldText"] ?? record["oldString"] ?? record["old_string"];
    const newText = record["newText"] ?? record["newString"] ?? record["new_string"];
    if (typeof oldText !== "string" || typeof newText !== "string") {
      throw new Error(`MultiEdit: edits[${index}] 需要 oldText/newText(或 oldString/newString)`);
    }
    return {
      oldText,
      newText,
      replaceAll: record["replaceAll"] === true || record["replace_all"] === true,
    };
  });
  return { filePath, edits };
}

export function createMultiEditTool(cwd: string, options: MultiEditToolOptions = {}): AgentTool<typeof multiEditSchema, MultiEditDetails> {
	const fileSystem = options.fileSystem ?? localMultiEditFileSystem(cwd);
  return {
    name: "MultiEdit",
    label: "MultiEdit",
    description: "单次调用对同一文件做 N 处编辑;任一处 fail 则整体 abort。",
    parameters: multiEditSchema,
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    prepareArguments: prepareMultiEditArgs as unknown as (args: unknown) => MultiEditInput,
    async execute(_tc, params): Promise<{
      content: Array<{ type: "text"; text: string }>;
      details: MultiEditDetails;

    }> {
      const target = resolveToCwd(params.filePath, cwd);
      const original = (await fileSystem.readFile(target)).toString("utf8");
      let cursor = original;
      let applied = 0;
      let diffBytes = 0;
      for (const e of params.edits ?? []) {
        if (!e || typeof e.oldText !== "string" || typeof e.newText !== "string") {
          throw new Error("MultiEdit: edit 必须含 oldText/newText 字符串");
        }
        if (e.oldText === e.newText) {
          continue; // 无效:no-op
        }
        if (e.replaceAll) {
          if (!cursor.includes(e.oldText)) {
            throw new Error(`MultiEdit: oldText not found in: ${e.oldText.slice(0, 60)}`);
          }
          const before = cursor.length;
          cursor = cursor.split(e.oldText).join(e.newText);
          diffBytes += cursor.length - before;
          applied++;
        } else {
          const idx = cursor.indexOf(e.oldText);
          if (idx < 0) {
            throw new Error(`MultiEdit: oldText not found in: ${e.oldText.slice(0, 60)}`);
          }
          cursor = cursor.slice(0, idx) + e.newText + cursor.slice(idx + e.oldText.length);
          applied++;
          diffBytes += e.newText.length - e.oldText.length;
        }
      }
      if (cursor !== original) {
        await fileSystem.mkdir(path.dirname(target), { recursive: true });
        await fileSystem.writeFile(target, cursor);
      }
      return {
        content: [{ type: "text", text: `MultiEdit ok: ${applied} edits applied, ${diffBytes}+${diffBytes >= 0 ? "+" : ""}${diffBytes} bytes` }],
        details: { applied, diffBytes },
      };
    },
  };
}
