/**
 * NotebookEdit 占位工具 —— 后续能力。
 *
 * 与 claude-code-bun docs/tools/notebook-edit-tool.mdx 区别:
 *   - claude NotebookEdit 是 Jupyter notebook 单元格(cell)级 JSON patch 工具
 *   - 当前暂不做 nbformat 渲染与执行;仅占位返回 "not implementedyet"
 *
 * 设计:
 *   - schema 接收 notebook_path + cell_id + cell_type + new_source
 *   - execute 无论输入怎么都返回 not-implemented text + terminate=false
 *   - 此处占位是因为 docs/tools 列表完整度对齐需要,LLM 主动调用时见到清晰提示。
 */

import { Type } from "typebox";
import type { Static } from "typebox";
import type { AgentTool } from "../types.ts";

export const notebookEditSchema = Type.Object({
  notebook_path: Type.String({ description: "目标 .ipynb 路径(本期不实现)" }),
  cell_id: Type.Optional(Type.String({ description: "目标 cell id(本期不实现)" })),
  cell_type: Type.Optional(
    Type.String({ description: "code / markdown / raw(本期不实现)" }),
  ),
  new_source: Type.String({ description: "新单元 source(本期不实现)" }),
  mode: Type.Optional(
    Type.String({ description: "replace | insert_before | insert_after | delete(本期不实现)" }),
  ),
});

export type NotebookEditInput = Static<typeof notebookEditSchema>;

export interface NotebookEditDetails {
  notImplemented: true;
}

export function createNotebookEditTool(): AgentTool<typeof notebookEditSchema, NotebookEditDetails> {
  return {
    name: "NotebookEdit",
    label: "NotebookEdit",
    description: "(占位)当前不实现 Jupyter notebook 编辑;调用将得到 not-implemented 提示。",
    parameters: notebookEditSchema,
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    async execute(): Promise<{
      content: Array<{ type: "text"; text: string }>;
      details: NotebookEditDetails;
      terminate: false;
    }> {
      return {
        content: [
          {
            type: "text",
            text: "(NotebookEdit 占位)当前不实现 Jupyter notebook 编辑。",
          },
        ],
        details: { notImplemented: true },
        terminate: false,
      };
    },
  };
}
