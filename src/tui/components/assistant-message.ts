/**
 * AssistantMessageComponent —— 助手流式输出组件,接到 message_update 即增量更新。
 *
 * 对照 development-doc/tui/02-component-spec.md §11 与 04-rendering.md §1。
 *
 * 设计:
 *   - 持有累积文本(textOnly string);
 *   - 接 setPartial 接口由 InteractiveMode 在 message_update 路径调用;
 *   - finalize 在 message_end 路径调用,清理 streaming hint / 状态;
 *   - Markdown 保持 pure presentation，最终由 OpenTUI adapter 投影;
 *   - render(width) 失败兜底:Markdown 抛错时回退纯文本输出,记 stderr,不外抛(对照 02 §1)。
 */

import { Markdown, type Component, visibleWidth, wrapTextWithAnsi } from "../index.ts";
import type { AssistantMessage, TextContent, ThinkingContent, ToolCall } from "../../types.ts";
import type { Theme } from "../theme/theme.ts";
import { makeMarkdownTheme } from "../theme/factories.ts";
import { fitLinesToWidth, fitToWidth } from "./render-width.ts";
import type { PresentationBlock } from "../presentation.ts";

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
  private streaming = true;

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
    this.streaming = false;
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
          const indent = "  ";
          const contentWidth = Math.max(1, width - visibleWidth(indent));
          for (const rawLine of thinking.split("\n")) {
            const wrapped = wrapTextWithAnsi(rawLine, contentWidth);
            for (const line of wrapped.length > 0 ? wrapped : [""]) {
              lines.push(fitToWidth(indent + line, width));
            }
          }
        } else {
          const first = thinking.split("\n")[0] ?? "";
          lines.push(fitToWidth(`[thinking] ${first}${thinking.includes("\n") ? " …" : ""}`, width));
        }
      }
      lines.push(...this.markdown.render(width));
      return fitLinesToWidth(lines, width);
    } catch (e) {
      process.stderr.write(`[assistant-message] markdown render failed: ${String(e)}\n`);
      // 兜底:返回纯文本,不抛
      const text = extractText(this.partial);
      return text.length === 0 ? [] : fitLinesToWidth(text.split("\n"), width);
    }
  }

  present(width: number): PresentationBlock[] {
    if (!this.partial) return [];
    const rendered = this.render(width);
    const markdownText = extractText(this.partial);
    const markdownLineCount = this.markdown.render(width).length;
    const thinkingLines = markdownLineCount > 0 ? rendered.slice(0, -markdownLineCount) : rendered;
    const blocks: PresentationBlock[] = [];
    if (thinkingLines.length > 0) blocks.push({ kind: "text", content: thinkingLines.join("\n") });
    if (markdownText.length > 0) blocks.push({ kind: "markdown", content: markdownText, streaming: this.streaming });
    return blocks;
  }
}
