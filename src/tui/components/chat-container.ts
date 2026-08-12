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
  private replacement: { readonly key: string; readonly component: Component } | undefined;
  private readonly presentationCache = new RenderCache<PresentationBlock[]>({
    maxEntries: 1024,
    maxBytes: 4 * 1024 * 1024,
  });
  private nextKey = 0;

  // B2:Timeline projection 通道（生产路径）；push() 仅保留给组件级测试。
  private timelineBlocks: readonly PresentationBlock[] | undefined;
  private timelineGeneration = -1;
  private presentCache: { readonly generation: number; readonly width: number; readonly blocks: PresentationBlock[] } | undefined;

  invalidate(): void {
    this.presentationCache.clear();
    this.replacement?.component.invalidate();
    for (const { component } of this.children) {
      component.invalidate();
    }
  }

  /** B2:Timeline projection 一次性替换 chat 内容；block id 必须稳定。 */
  setTimelineBlocks(blocks: readonly PresentationBlock[], generation: number): void {
    this.timelineBlocks = blocks;
    this.timelineGeneration = generation;
    this.presentCache = undefined;
    this.presentationCache.clear();
  }

  getTimelineGeneration(): number {
    return this.timelineGeneration;
  }

  /** 临时工作流（例如 permission）占据 transcript 时隐藏对话，但不破坏 Timeline。 */
  setReplacement(component: Component, key = "chat-replacement"): void {
    this.replacement = { key, component };
    this.presentationCache.clear();
  }

  /** 结束临时工作流并恢复原 Timeline 对话。 */
  clearReplacement(component?: Component): void {
    if (component !== undefined && this.replacement?.component !== component) return;
    this.replacement = undefined;
    this.presentationCache.clear();
  }

  push(component: Component, key?: string): void {
    this.children.push({ key: key ?? `chat-${this.nextKey++}`, component });
  }

  /** M8d/clear 命令:清空 chat viewport。 */
  clear(): void {
    this.children.length = 0;
    this.timelineBlocks = undefined;
    this.presentationCache.clear();
    this.presentCache = undefined;
  }

  /** 取最末追加的组件,便于 InteractiveMode 调其 setPartial。 */
  last(): Component | undefined {
    return this.children[this.children.length - 1]?.component;
  }

  render(width: number): string[] {
    if (this.replacement !== undefined) return this.replacement.component.render(width);
    if (this.timelineBlocks !== undefined) {
      return this.timelineBlocks.map((block) => fitToWidth(("content" in block ? block.content ?? "" : ""), width));
    }
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
    if (this.replacement !== undefined) {
      const { key, component } = this.replacement;
      const projected = component.present?.(width) ?? [{
        kind: "text" as const,
        content: component.render(width).map((line) => fitToWidth(line, width)).join("\n"),
      }];
      return projected.map((block, index) => ({ ...block, id: `${key}/${block.id ?? `part-${index}`}` }));
    }
    if (this.timelineBlocks !== undefined) {
      if (this.presentCache?.generation === this.timelineGeneration && this.presentCache.width === width) {
        return this.presentCache.blocks;
      }
      // Timeline blocks 是交给 OpenTUI Text/Markdown renderable 的结构化正文；
      // 由原生布局按容器宽度换行，不能在这里把整块内容当成单行截断。
      const blocks = this.timelineBlocks.map((block): PresentationBlock => block.kind === "separator"
        ? { ...block, content: separatorLine(block.label, width) }
        : { ...block });
      this.presentCache = { generation: this.timelineGeneration, width, blocks };
      return blocks;
    }
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

function separatorLine(label: string, width: number): string {
  const prefix = `─ ${label} `;
  if (width <= 0) return "";
  if (prefix.length >= width) return fitToWidth(prefix, width);
  return `${prefix}${"─".repeat(width - prefix.length)}`;
}

function presentationBytes(blocks: readonly PresentationBlock[]): number {
  return blocks.reduce((total, block) => total + JSON.stringify(block).length, 0);
}
