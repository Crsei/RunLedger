/** Overlay 树的唯一 create/update/destroy owner。 */

import { BoxRenderable, InputRenderable, SelectRenderable, TextRenderable } from "@opentui/core";
import { blockText, toPresentationBlock } from "./transcript-runtime.ts";
import { getOverlayCommandNode, getOverlayInputNode, getOverlaySelectNode, getOverlayTextNode, overlayBlockHeight } from "./overlay-runtime.ts";
import type { KeyedRenderable, OpenTuiComponentFrame, OverlayRenderable } from "./types.ts";
import type { FrameRuntimePort } from "./frame-runtime.ts";

type OverlayControllerPort = Pick<FrameRuntimePort, "renderer" | "screen" | "editor" | "syntaxHighlightService" | "syntaxThemeController" | "options">;

export class OverlayController {
  private readonly port: OverlayControllerPort;
  private overlay: BoxRenderable | undefined;
  private nodes = new Map<string, KeyedRenderable<OverlayRenderable>>();

  public constructor(port: OverlayControllerPort) {
    this.port = port;
  }

  public update(frame: OpenTuiComponentFrame, footerHeight: number, editorHeight: number, statusIndicatorHeight: number): void {
    if (!frame.overlay) {
      this.dispose();
      this.port.editor.focus();
      return;
    }
    const { renderer } = this.port;
    const blocks = frame.overlay.map(toPresentationBlock);
    const transcriptVariant = (frame.overlayVariant === "transcript" || frame.overlayVariant === "trajectory");
    const interactive = blocks.some((block) => block.kind === "select" || block.kind === "input");
    const bottomLeft = frame.overlayAnchor === "bottom-left";
    const compact = frame.overlayNonCapturing === true && bottomLeft;
    const composerTopOffset = footerHeight + editorHeight + statusIndicatorHeight + 1;
    const modalWidth = transcriptVariant ? renderer.width : Math.max(1, Math.floor(renderer.width * 0.9));
    const chromeHeight = compact ? 0 : bottomLeft ? 2 : 4;
    const contentHeight = blocks.reduce((height, block) => height + overlayBlockHeight(block), 0) + chromeHeight;
    const screenMaxHeight = Math.max(1, Math.floor(renderer.height * 0.8));
    const attachedMaxHeight = bottomLeft ? Math.max(1, renderer.height - composerTopOffset) : screenMaxHeight;
    const maxHeight = Math.min(screenMaxHeight, attachedMaxHeight);
    const modalHeight = interactive && !bottomLeft
      ? Math.min(maxHeight, Math.max(Math.max(1, Math.floor(renderer.height * 0.5)), contentHeight))
      : Math.min(maxHeight, contentHeight);
    const overlay = this.ensureOverlay(transcriptVariant);
    overlay.onMouseScroll = frame.overlayVariant === "trajectory" ? (event) => {
      event.preventDefault(); event.stopPropagation();
      this.port.options.onInput(`trajectory:mouse:${event.scroll?.direction === "up" ? "up" : "down"}:${event.x - overlay.screenX - 1}:${event.y - overlay.screenY - 1}`);
    } : undefined;
    overlay.onMouseDown = frame.overlayVariant === "trajectory" ? (event) => {
      if (event.button !== 0) return;
      event.preventDefault(); event.stopPropagation();
      this.port.options.onInput(`trajectory:mouse:click:${event.x - overlay.screenX - 1}:${event.y - overlay.screenY - 1}`);
    } : undefined;
    overlay.left = transcriptVariant ? 0 : compact ? 0 : bottomLeft ? 1 : Math.max(0, Math.floor((renderer.width - modalWidth) / 2));
    overlay.right = undefined;
    overlay.width = transcriptVariant || compact ? renderer.width : modalWidth;
    overlay.borderStyle = "rounded";
    if (frame.uiTheme) overlay.borderColor = frame.uiTheme.colors.border;
    overlay.border = !compact && !transcriptVariant;
    overlay.padding = compact ? 0 : 1;
    overlay.paddingTop = bottomLeft ? 0 : compact ? 0 : 1;
    overlay.paddingBottom = bottomLeft ? 0 : compact ? 0 : 1;
    if (transcriptVariant) {
      overlay.backgroundColor = frame.uiTheme?.colors.background ?? (renderer.themeMode === "light" ? "#ffffff" : "#0b0e14");
      overlay.top = 0;
      overlay.bottom = 0;
      overlay.height = renderer.height;
      overlay.maxHeight = renderer.height;
    } else if (compact) {
      overlay.backgroundColor = undefined;
      overlay.top = undefined;
      overlay.bottom = composerTopOffset;
    } else if (bottomLeft) {
      overlay.backgroundColor = frame.uiTheme?.colors.background ?? (renderer.themeMode === "light" ? "#ffffff" : "#0b0e14");
      overlay.top = undefined;
      overlay.bottom = composerTopOffset;
    } else {
      overlay.backgroundColor = frame.uiTheme?.colors.background;
      overlay.top = Math.max(0, Math.floor((renderer.height - modalHeight) / 2));
      overlay.bottom = undefined;
    }
    if (!transcriptVariant) overlay.height = interactive ? modalHeight : "auto";
    const fixedBlockHeight = blocks.reduce((height, block) => block.kind === "select"
      ? height + (block.title.length > 0 ? 1 : 0) + (block.query === undefined ? 0 : 1)
      : height + overlayBlockHeight(block), 0);
    const selectCount = blocks.filter((block) => block.kind === "select").length;
    const selectHeightLimit = selectCount === 0
      ? 12
      : Math.max(1, Math.floor((modalHeight - chromeHeight - fixedBlockHeight) / selectCount));
    this.reconcileNodes(overlay, blocks, selectHeightLimit);
    if (frame.uiTheme) {
      const theme = frame.uiTheme.colors;
      for (const node of this.nodes.values()) {
        if (node.renderable instanceof TextRenderable) node.renderable.fg = theme.primary;
        if (node.renderable instanceof SelectRenderable) {
          node.renderable.backgroundColor = theme.background;
          node.renderable.textColor = theme.primary;
          node.renderable.focusedBackgroundColor = theme.background;
          node.renderable.focusedTextColor = theme.primary;
          node.renderable.selectedBackgroundColor = theme.surfaceAlt;
          node.renderable.selectedTextColor = theme.accent;
          node.renderable.descriptionColor = theme.secondary;
          node.renderable.selectedDescriptionColor = theme.secondary;
        }
        if (node.renderable instanceof InputRenderable) {
          node.renderable.backgroundColor = theme.surface;
          node.renderable.textColor = theme.primary;
          node.renderable.placeholderColor = theme.hint;
        }
      }
    }
  }

  public dispose(): void {
    if (!this.overlay) return;
    this.overlay.destroyRecursively();
    this.overlay = undefined;
    this.nodes.clear();
  }

  private ensureOverlay(transcriptVariant: boolean): BoxRenderable {
    if (this.overlay) return this.overlay;
    this.overlay = new BoxRenderable(this.port.renderer, {
      id: "runledger-overlay",
      position: "absolute",
      maxHeight: transcriptVariant ? this.port.renderer.height : "80%",
      zIndex: 100,
    });
    this.port.screen.add(this.overlay);
    return this.overlay;
  }

  private reconcileNodes(overlay: BoxRenderable, blocks: ReturnType<typeof toPresentationBlock>[], selectHeightLimit: number): void {
    const next = new Map<string, KeyedRenderable<OverlayRenderable>>();
    const desired: OverlayRenderable[] = [];
    let focus: InputRenderable | SelectRenderable | undefined;
    for (const [index, block] of blocks.entries()) {
      const baseKey = block.id ?? String(index);
      if (block.kind === "select") {
        if (block.title.length > 0) desired.push(getOverlayTextNode(this.port.renderer, this.nodes, next, `title-${baseKey}`, block.title));
        if (block.query !== undefined) {
          const query = getOverlayInputNode(this.port.renderer, this.nodes, next, `query-${baseKey}`, block.query, "Filter…");
          desired.push(query);
          focus = query;
        }
        const select = getOverlaySelectNode(
          this.port.renderer,
          this.nodes,
          next,
          `select-${baseKey}`,
          block.options.map((option) => ({ name: option.label, description: option.description ?? "", value: option.value })),
          block.selectedIndex,
          this.port.options.onInput,
          selectHeightLimit,
        );
        desired.push(select);
        focus ??= select;
      } else if (block.kind === "input") {
        desired.push(getOverlayTextNode(this.port.renderer, this.nodes, next, `title-${baseKey}`, block.title));
        desired.push(getOverlayTextNode(this.port.renderer, this.nodes, next, `message-${baseKey}`, block.message));
        const input = getOverlayInputNode(this.port.renderer, this.nodes, next, `input-${baseKey}`, block.value, block.placeholder ?? "");
        desired.push(input);
        focus = input;
      } else if (block.kind === "command") {
        desired.push(getOverlayCommandNode(this.port.renderer, this.nodes, next, `command-${baseKey}`, block, this.port.syntaxHighlightService, this.port.syntaxThemeController));
      } else {
        desired.push(getOverlayTextNode(this.port.renderer, this.nodes, next, `content-${baseKey}`, blockText(block)));
      }
    }
    for (const [key, node] of this.nodes) {
      if (next.has(key)) continue;
      overlay.remove(node.renderable);
      node.renderable.destroyRecursively();
    }
    for (const [index, node] of desired.entries()) {
      if (overlay.getChildren()[index] === node) continue;
      if (node.parent === overlay) overlay.remove(node);
      overlay.add(node, index);
    }
    this.nodes = next;
    focus?.focus();
  }
}
