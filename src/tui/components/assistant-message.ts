/**
 * AssistantMessageComponent —— 助手流式输出组件,接到 message_update 即增量更新。
 *
 * 对照 development-doc/tui/02-component-spec.md §11 与 04-rendering.md §1。
 *
 * 设计:
 *   - 持有累积文本(textOnly string);
 *   - 接 setPartial 接口由 InteractiveMode 在 message_update 路径调用;
 *   - finalize 在 message_end 路径调用,清理 streaming hint / 状态;
 *   - 渲染委托给 pi-tui Markdown(MarkdownTheme 由 theme factory 提供);
 *   - render(width) 失败兜底:Markdown 抛错时回退纯文本输出,记 stderr,不外抛(对照 02 §1)。
 */

import { Markdown, type Component } from "../index.ts";
import type { AssistantMessage, TextContent, ThinkingContent, ToolCall } from "../../types.ts";
import type { Theme } from "../theme/theme.ts";
import { makeMarkdownTheme } from "../theme/factories.ts";

export interface AssistantMessageComponentProps {
  theme: Theme;
  /** 初始 partial;若 undefined 表示尚未流式开始,render 返回空。 */
  partial?: AssistantMessage;
}

/** 从 partial.message.content 抽出 text 段累积为单字符串。 */
function extractText(partial: AssistantMessage | undefined): string {
  if (!partial) return "";
  return partial.content
    .filter((c): c is TextContent => c.type === "text")
    .map((c) => c.text)
    .join("");
}

/** 从 partial.content 中抽 thinking 段;M2 阶段不渲染,只用于单测断言。 */
function extractThinking(partial: AssistantMessage | undefined): string {
  if (!partial) return "";
  return partial.content
    .filter((c): c is ThinkingContent => c.type === "thinking")
    .map((c) => c.thinking)
    .join("");
}

// 工具:把 toolCalls 抽出供 AssistantMessageComponent 后续(M3)显示
export function extractToolCalls(partial: AssistantMessage | undefined): ToolCall[] {
  if (!partial) return [];
  return partial.content.filter((c): c is ToolCall => c.type === "toolCall");
}

export class AssistantMessageComponent implements Component {
  private partial: AssistantMessage | undefined;
  private readonly markdown: Markdown;
  private readonly theme: Theme;
  private thinkingExpanded = false;

  constructor(props: AssistantMessageComponentProps) {
    this.theme = props.theme;
    this.partial = props.partial;
    this.markdown = new Markdown("", 0, 0, makeMarkdownTheme(this.theme));
  }

  invalidate(): void {
    this.markdown.invalidate();
  }

  /** 更新 partial;由 InteractiveMode 在 message_update / message_start 路径调用。 */
  setPartial(partial: AssistantMessage | undefined): void {
    this.partial = partial;
    this.markdown.setText(extractText(partial));
  }

  /** 流式结束;通知 Markdown 重新计算布局(M2 阶段 noop,Markdown 无独立处理)。 */
  finalize(): void {
    // M2 noop
  }

  toggleThinking(): void {
    this.thinkingExpanded = !this.thinkingExpanded;
  }

  render(width: number): string[] {
    if (!this.partial) return [];
    try {
      const lines: string[] = [];
      const thinking = extractThinking(this.partial);
      if (thinking.length > 0) {
        if (this.thinkingExpanded) {
          lines.push("[thinking]");
          lines.push(...thinking.split("\n").map((line) => `  ${line}`));
        } else {
          const first = thinking.split("\n")[0] ?? "";
          lines.push(`[thinking] ${first}${thinking.includes("\n") ? " …" : ""}`.slice(0, width));
        }
      }
      lines.push(...this.markdown.render(width));
      return lines;
    } catch (e) {
      process.stderr.write(`[assistant-message] markdown render failed: ${String(e)}\n`);
      // 兜底:返回纯文本,不抛
      const text = extractText(this.partial);
      return text.length === 0 ? [] : text.split("\n");
    }
  }
}
