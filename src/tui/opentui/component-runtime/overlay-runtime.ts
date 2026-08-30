/**
 * S6 拆分:overlay 节点注册表(text/input/command/select 的 create/update/dispose)。
 */

import {
  InputRenderable,
  SelectRenderable,
  TextRenderable,
  type CliRenderer,
  type MouseEvent,
} from "@opentui/core";
import { ExecRenderable } from "../exec-renderable.ts";
import type { SyntaxHighlightService } from "../../highlight/service.ts";
import type { SyntaxThemeController } from "../../highlight/theme-controller.ts";
import type { PresentationBlock } from "../../presentation.ts";
import { ansiToStyledText } from "../ansi-styled-text.ts";
import { blockText, renderableId } from "./transcript-runtime.ts";
import type { KeyedRenderable, OverlayRenderable } from "./types.ts";

export function overlaySelectHeight(options: readonly { readonly description?: string }[]): number {
  // SelectRenderable 在 showDescription=true 时始终为每项保留两行，哪怕
  // description 为空；按同一布局契约给高度，避免安全决策被裁成单项。
  return Math.max(2, Math.min(12, options.length * 2));
}

export function overlayBlockHeight(block: PresentationBlock): number {
  if (block.kind === "select") {
    return 1 + (block.query === undefined ? 0 : 1) + overlaySelectHeight(block.options);
  }
  if (block.kind === "input") return 3;
  return blockText(block).split("\n").length;
}

export function getOverlayTextNode(
  renderer: CliRenderer,
  previous: Map<string, KeyedRenderable<OverlayRenderable>>,
  next: Map<string, KeyedRenderable<OverlayRenderable>>,
  key: string,
  content: string,
): TextRenderable {
  const old = previous.get(key);
  const node = old?.kind === "text" && old.renderable instanceof TextRenderable
    ? old.renderable
    : createOverlayTextNode(renderer, old, key);
  if (old?.contentKey !== content) {
    node.content = ansiToStyledText(content);
    // 多行内容按行数自适应高度(默认 1 会裁剪 slash popup 的后续行)
    node.height = Math.max(1, content.split("\n").length);
  }
  next.set(key, { kind: "text", renderable: node, contentKey: content });
  return node;
}

export function getOverlayInputNode(
  renderer: CliRenderer,
  previous: Map<string, KeyedRenderable<OverlayRenderable>>,
  next: Map<string, KeyedRenderable<OverlayRenderable>>,
  key: string,
  value: string,
  placeholder: string,
): InputRenderable {
  const old = previous.get(key);
  const node = old?.kind === "input" && old.renderable instanceof InputRenderable
    ? old.renderable
    : createOverlayInputNode(renderer, old, key, value, placeholder);
  if (node.value !== value) node.value = value;
  if (node.placeholder !== placeholder) node.placeholder = placeholder;
  next.set(key, { kind: "input", renderable: node, contentKey: `${value}\u0000${placeholder}` });
  return node;
}

export function getOverlayCommandNode(
  renderer: CliRenderer,
  previous: Map<string, KeyedRenderable<OverlayRenderable>>,
  next: Map<string, KeyedRenderable<OverlayRenderable>>,
  key: string,
  block: Extract<PresentationBlock, { readonly kind: "command" }>,
  service: SyntaxHighlightService,
  themeController: SyntaxThemeController,
): ExecRenderable {
  const old = previous.get(key);
  const node = old?.kind === "command" && old.renderable instanceof ExecRenderable
    ? old.renderable
    : createOverlayCommandNode(renderer, old, key, block, service, themeController);
  if (old?.contentKey !== block.command) node.updateBlock(block);
	node.setHighlightAdmission("visible");
  next.set(key, { kind: "command", renderable: node, contentKey: block.command });
  return node;
}

export function getOverlaySelectNode(
  renderer: CliRenderer,
  previous: Map<string, KeyedRenderable<OverlayRenderable>>,
  next: Map<string, KeyedRenderable<OverlayRenderable>>,
  key: string,
  options: { name: string; description: string; value: string }[],
  selectedIndex: number,
  onInput: (data: string) => void,
): SelectRenderable {
  const old = previous.get(key);
  const node = old?.kind === "select" && old.renderable instanceof SelectRenderable
    ? old.renderable
    : createOverlaySelectNode(renderer, old, key, options, selectedIndex);
  const contentKey = `${JSON.stringify(options)}\u0000${selectedIndex}`;
  if (old?.contentKey !== contentKey) {
    node.options = options;
    node.selectedIndex = selectedIndex;
    node.height = overlaySelectHeight(options);
  }
  node.onMouseDown = (event) => handleOverlaySelectMouseDown(node, event, onInput);
  next.set(key, { kind: "select", renderable: node, contentKey });
  return node;
}

function handleOverlaySelectMouseDown(
  node: SelectRenderable,
  event: MouseEvent,
  onInput: (data: string) => void,
): void {
  if (event.button !== 0) return;
  const localY = event.y - node.screenY;
  if (localY < 0 || localY >= node.height) return;

  const visibleItems = Math.max(1, Math.floor(node.height / 2));
  const maxScrollOffset = Math.max(0, node.options.length - visibleItems);
  const scrollOffset = Math.max(
    0,
    Math.min(
      node.getSelectedIndex() - Math.floor(visibleItems / 2),
      maxScrollOffset,
    ),
  );
  const selectedIndex = scrollOffset + Math.floor(localY / 2);
  if (selectedIndex < 0 || selectedIndex >= node.options.length) return;

  event.preventDefault();
  event.stopPropagation();
  const currentIndex = node.getSelectedIndex();
  node.setSelectedIndex(selectedIndex);
  const direction = selectedIndex >= currentIndex ? "down" : "up";
  for (let index = currentIndex; index !== selectedIndex; index += direction === "down" ? 1 : -1) {
    onInput(direction);
  }
}

function disposeWrongOverlayNode(
  node: KeyedRenderable<OverlayRenderable> | undefined,
  expectedKind: string,
): void {
  if (!node || node.kind === expectedKind) return;
  node.renderable.parent?.remove(node.renderable);
  node.renderable.destroyRecursively();
}

function createOverlayTextNode(
  renderer: CliRenderer,
  old: KeyedRenderable<OverlayRenderable> | undefined,
  key: string,
): TextRenderable {
  disposeWrongOverlayNode(old, "text");
  return new TextRenderable(renderer, {
    id: renderableId("runledger-overlay", key),
    width: "100%",
    height: 1,
    content: "",
  });
}

function createOverlayInputNode(
  renderer: CliRenderer,
  old: KeyedRenderable<OverlayRenderable> | undefined,
  key: string,
  value: string,
  placeholder: string,
): InputRenderable {
  disposeWrongOverlayNode(old, "input");
  return new InputRenderable(renderer, {
    id: renderableId("runledger-overlay", key),
    width: "100%",
    value,
    placeholder,
  });
}

function createOverlayCommandNode(
  renderer: CliRenderer,
  old: KeyedRenderable<OverlayRenderable> | undefined,
  key: string,
  block: Extract<PresentationBlock, { readonly kind: "command" }>,
  service: SyntaxHighlightService,
  themeController: SyntaxThemeController,
): ExecRenderable {
  disposeWrongOverlayNode(old, "command");
  return new ExecRenderable(renderer, {
    id: renderableId("runledger-overlay", key),
    width: "100%",
    height: 1,
    block,
    highlightService: service,
    themeController,
  });
}

function createOverlaySelectNode(
  renderer: CliRenderer,
  old: KeyedRenderable<OverlayRenderable> | undefined,
  key: string,
  options: { name: string; description: string; value: string }[],
  selectedIndex: number,
): SelectRenderable {
  disposeWrongOverlayNode(old, "select");
  return new SelectRenderable(renderer, {
    id: renderableId("runledger-overlay", key),
    width: "100%",
    height: overlaySelectHeight(options),
    options,
    selectedIndex,
    showDescription: true,
    showSelectionIndicator: true,
  });
}
