/**
 * ChatContainer —— 顺序持有的对话 viewport,新增的 user/assistant/自定义消息按时间追加。
 *
 * 对照 development-doc/tui/02-component-spec.md §12 与 04-rendering.md §3。
 *
 * 设计:
 *   - 持有顺序排列的 Component 列表;
 *   - render(width) 把所有 child 的 render 输出按顺序拼接成单 string[];
 *   - 不实现滚动(M2 阶段屏幕滚动由 TUI 整体处理);
 *   - 不接管 child 的 invalidate;各 child 自己管缓存。
 *
 * 边界:
 *   - 不持有 Agent 引用,通过 push(component) 接口被动接收;
 *   - InteractiveMode.handleEvent 在 message_start 路径 push AssistantMessageComponent,
 *     并在 message_update 路径调其 setPartial,流式更新;
 *   - UserMessageComponent 在 Editor.onSubmit 时同步 push 一份。
 */

import type { Component } from "../index.ts";
import type { PresentationBlock } from "../presentation.ts";
import { RenderCache } from "../opentui/render-cache.ts";
import { fitToWidth } from "./render-width.ts";

export class ChatContainer implements Component {
  private readonly children: Array<{ key: string; component: Component }> = [];
  private readonly presentationCache = new RenderCache<PresentationBlock[]>({
    maxEntries: 1024,
    maxBytes: 4 * 1024 * 1024,
  });
  private nextKey = 0;

  invalidate(): void {
    this.presentationCache.clear();
    for (const { component } of this.children) {
      component.invalidate();
    }
  }

  push(component: Component, key?: string): void {
    this.children.push({ key: key ?? `chat-${this.nextKey++}`, component });
  }

  /** M8d/clear 命令:清空 chat viewport。 */
  clear(): void {
    this.children.length = 0;
    this.presentationCache.clear();
  }

  /** 取最末追加的组件,便于 InteractiveMode 调其 setPartial。 */
  last(): Component | undefined {
    return this.children[this.children.length - 1]?.component;
  }

  render(width: number): string[] {
    const lines: string[] = [];
    for (const { component } of this.children) {
      try {
        const sub = component.render(width);
        for (const line of sub) {
          lines.push(fitToWidth(line, width));
        }
      } catch (e) {
        // 不外抛(对照 04 §2 渲染契约表)
        process.stderr.write(`[chat-container] child render failed: ${String(e)}\n`);
        lines.push(fitToWidth("[chat:child-render-error]", width));
      }
    }
    return lines;
  }

  present(width: number): PresentationBlock[] {
    const blocks: PresentationBlock[] = [];
    for (const { key, component } of this.children) {
      try {
        const version = component.getPresentationVersion?.();
        const cacheKey = version === undefined
          ? undefined
          : { entryId: key, width, contentGeneration: version, themeGeneration: 0 };
        const cached = cacheKey ? this.presentationCache.get(cacheKey) : undefined;
        const projected = cached
          ? cached
          : component.present?.(width) ?? [{
            kind: "text" as const,
            content: component.render(width).map((line) => fitToWidth(line, width)).join("\n"),
          }];
        if (cacheKey && !cached) this.presentationCache.set(cacheKey, projected, presentationBytes(projected));
        blocks.push(...projected.map((block, index) => ({
          ...block,
          id: `${key}/${block.id ?? `part-${index}`}`,
        })));
      } catch (error) {
        process.stderr.write(`[chat-container] child projection failed: ${String(error)}\n`);
        blocks.push({
          id: `${key}/error`,
          kind: "text",
          content: fitToWidth("[chat:child-render-error]", width),
        });
      }
    }
    return blocks;
  }
}

function presentationBytes(blocks: readonly PresentationBlock[]): number {
  return blocks.reduce((total, block) => total + JSON.stringify(block).length, 0);
}
