// Adapted registry dispatch from oh-my-pi collab-web; see THIRD_PARTY_NOTICES.md.
import type { ReactNode } from "react";
import type { WebTimelineRow } from "../contracts/index.ts";
export type Tool = NonNullable<WebTimelineRow["tool"]>;
interface Renderer { readonly Summary: (props: { tool: Tool }) => ReactNode; readonly Body: (props: { tool: Tool }) => ReactNode }
const genericRenderer: Renderer = {
  Summary: ({ tool }) => <span>{tool.inputPreview.slice(0, 90)}</span>,
  Body: ({ tool }) => <><label>输入</label><pre>{tool.inputPreview || "未记录"}</pre><label>输出</label><pre>{tool.outputPreview || "尚无结果"}</pre></>,
};
const fileRenderer: Renderer = { ...genericRenderer, Summary: ({ tool }) => <span>文件 · {tool.inputPreview.slice(0, 90)}</span> };
const bashRenderer: Renderer = { ...genericRenderer, Summary: ({ tool }) => <code>$ {tool.inputPreview.slice(0, 90)}</code> };
const searchRenderer: Renderer = { ...genericRenderer, Summary: ({ tool }) => <span>搜索 · {tool.inputPreview.slice(0, 90)}</span> };
// 每个受治理工具都必须显式登记;未登记的名字走 genericRenderer,
// 因此新增工具时这里要同步(见 docs/subsystems/tools.md 的新工具准入清单)。
const RENDERERS: Record<string, Renderer> = {
  bash: bashRenderer,
  read: fileRenderer,
  write: fileRenderer,
  edit: fileRenderer,
  MultiEdit: fileRenderer,
  grep: searchRenderer,
  glob: searchRenderer,
  // find 是 glob 的历史调用名;事件流仍可能带旧名。
  find: searchRenderer,
};
export function resolveToolRenderer(name: string): Renderer { return RENDERERS[name] ?? genericRenderer; }
