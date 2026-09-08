import { TextRenderable, type RenderContext, type TextOptions } from "@opentui/core";
import type { PresentationBlock } from "../presentation.ts";
import { truncateToWidth, visibleWidth } from "../text-layout.ts";
import { formatSeparatorLabel } from "./block-layout.ts";

type SeparatorBlock = Extract<PresentationBlock, { kind: "separator" }>;

/** 分隔线按布局后的正文列数生成，避免滚动条占位把末尾折到下一行。 */
export class SeparatorRenderable extends TextRenderable {
  private label = "";

  constructor(ctx: RenderContext, options: Omit<TextOptions, "content"> & { block: SeparatorBlock }) {
    const { block, ...rest } = options;
    super(ctx, { ...rest, content: "", height: 1, wrapMode: "none" });
    this.updateBlock(block);
  }

  updateBlock(block: SeparatorBlock): void {
    this.label = formatSeparatorLabel(block.label, block.metrics);
    this.updateLine();
  }

  protected override onResize(width: number, height: number): void {
    super.onResize(width, height);
    this.updateLine();
  }

  private updateLine(): void {
    const width = Math.max(0, Math.floor(this.width));
    const prefix = this.label ? truncateToWidth(`─ ${this.label} `, width) : "";
    this.content = prefix + "─".repeat(Math.max(0, width - visibleWidth(prefix)));
  }
}
