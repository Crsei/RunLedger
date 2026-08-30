/** Overlay 树的唯一 create/update/destroy owner。 */

import { BoxRenderable, InputRenderable, SelectRenderable } from "@opentui/core";
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

  public update(frame: OpenTuiComponentFrame, footerHeight: number, editorHeight: number): void {
    if (!frame.overlay) {
      this.dispose();
      this.port.editor.focus();
      return;
    }
    const { renderer } = this.port;
    const blocks = frame.overlay.map(toPresentationBlock);
    const transcriptVariant = frame.overlayVariant === "transcript";
    const interactive = blocks.some((block) => block.kind === "select" || block.kind === "input");
    const bottomLeft = frame.overlayAnchor === "bottom-left";
    const compact = frame.overlayNonCapturing === true && bottomLeft;
    const modalWidth = transcriptVariant ? renderer.width : Math.max(1, Math.floor(renderer.width * 0.9));
    const contentHeight = blocks.reduce((height, block) => height + overlayBlockHeight(block), 0) + 4;
    const maxHeight = Math.max(1, Math.floor(renderer.height * 0.8));
    const modalHeight = interactive
      ? Math.min(maxHeight, Math.max(Math.max(1, Math.floor(renderer.height * 0.5)), contentHeight))
      : Math.min(maxHeight, contentHeight);
    const overlay = this.ensureOverlay(transcriptVariant);
    overlay.left = transcriptVariant ? 0 : compact ? 0 : bottomLeft ? 1 : Math.max(0, Math.floor((renderer.width - modalWidth) / 2));
    overlay.right = undefined;
    overlay.width = transcriptVariant || compact ? renderer.width : modalWidth;
    overlay.borderStyle = "rounded";
    overlay.border = !compact && !transcriptVariant;
    overlay.padding = compact ? 0 : 1;
    if (transcriptVariant) {
      overlay.backgroundColor = renderer.themeMode === "light" ? "#ffffff" : "#0b0e14";
      overlay.top = 0;
      overlay.bottom = 0;
      overlay.height = renderer.height;
      overlay.maxHeight = renderer.height;
    } else if (compact) {
      overlay.backgroundColor = undefined;
      overlay.top = undefined;
      overlay.bottom = footerHeight + editorHeight + 1;
    } else if (bottomLeft) {
      overlay.backgroundColor = undefined;
      overlay.top = undefined;
      overlay.bottom = 5;
    } else {
      overlay.backgroundColor = undefined;
      overlay.top = Math.max(0, Math.floor((renderer.height - modalHeight) / 2));
      overlay.bottom = undefined;
    }
    if (!transcriptVariant) overlay.height = interactive ? modalHeight : "auto";
    this.reconcileNodes(overlay, blocks);
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

  private reconcileNodes(overlay: BoxRenderable, blocks: ReturnType<typeof toPresentationBlock>[]): void {
    const next = new Map<string, KeyedRenderable<OverlayRenderable>>();
    const desired: OverlayRenderable[] = [];
    let focus: InputRenderable | SelectRenderable | undefined;
    for (const [index, block] of blocks.entries()) {
      const baseKey = block.id ?? String(index);
      if (block.kind === "select") {
        desired.push(getOverlayTextNode(this.port.renderer, this.nodes, next, `title-${baseKey}`, block.title));
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
