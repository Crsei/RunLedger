/**
 * S6 拆分:transcript 的 block 身份/文本/diff/滚动/窗口纯函数。
 */

import type { PresentationBlock } from "../../presentation.ts";
import { formatSeparatorLabel } from "../block-layout.ts";
import { stripShellLoginWrapper } from "../exec-renderable.ts";
import { plainExecText } from "../exec-renderable.ts";
import { diffPlainText } from "../diff-renderable.ts";
import { planUpdatePlainText } from "../plan-update-renderable.ts";
import { noticePlainText } from "../notice-renderable.ts";
import { settled, type PresentationPart } from "../../timeline/part-stability.ts";
import { statusIndicatorPlainText } from "./footer-editor-runtime.ts";
import type { OpenTuiComponentFrame } from "./types.ts";

export function safeRenderableId(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/gu, "-");
}

export function renderableId(prefix: string, key: string): string {
  return `${prefix}-${safeRenderableId(key)}`;
}

export function blockKey(block: PresentationBlock, index: number): string {
  return block.id ?? `${block.kind}-${index}`;
}

export function blockText(block: PresentationBlock): string {
  if (block.kind === "select") return [block.title, ...block.options.map((option) => option.label)].join("\n");
  if (block.kind === "input") return `${block.title}\n${block.message}\n${block.value}`;
  if (block.kind === "separator") return block.content ?? formatSeparatorLabel(block.label, block.metrics);
  if (block.kind === "command") return `$ ${stripCommandForPlaintext(block.command)}`;
  if (block.kind === "exec") return plainExecText(block);
  if (block.kind === "diff") return `${diffPlainText(block)}\u0000syntax=${block.syntaxHighlight !== false}\u0000streaming=${block.streaming === true}`;
  if (block.kind === "status-line") return block.segments.map((segment) => segment.text).join(" · ");
  if (block.kind === "plan-update") return planUpdatePlainText(block);
  if (block.kind === "notice") return noticePlainText(block);
  return block.content;
}

export function blockSignatureText(block: PresentationBlock): string {
  return block.kind === "markdown" ? block.content : blockText(block);
}

export function presentationPart(block: PresentationBlock): PresentationPart | undefined {
  if (typeof block.entryId !== "string"
    || typeof block.partId !== "string"
    || typeof block.contentGeneration !== "number"
    || typeof block.finalized !== "boolean") return undefined;
  return {
    entryId: block.entryId,
    partId: block.partId,
    contentGeneration: block.contentGeneration,
    finalized: block.finalized,
  };
}

export function isSettledPresentationBlock(block: PresentationBlock): boolean {
  const part = presentationPart(block);
  return part !== undefined && settled(part);
}

export function toPresentationBlock(rawBlock: string | PresentationBlock): PresentationBlock {
  return typeof rawBlock === "string" ? { kind: "text", content: rawBlock } : rawBlock;
}

export function stripCommandForPlaintext(command: string): string {
  return stripShellLoginWrapper(command);
}

export function blockCharacterCount(block: string | PresentationBlock): number {
  if (typeof block === "string") return block.length;
  return block.kind === "select"
    ? block.title.length + block.options.reduce((total, option) => total + option.label.length, 0)
    : block.kind === "input"
    ? block.title.length + block.message.length + block.value.length
    : block.kind === "separator"
    ? (block.content ?? formatSeparatorLabel(block.label, block.metrics)).length
    : block.kind === "command"
    ? block.command.length + 2
    : block.kind === "exec"
    ? plainExecText(block).length
    : block.kind === "diff"
    ? diffPlainText(block).length
    : block.kind === "status-line"
    ? block.segments.reduce((total, segment) => total + segment.text.length, 0)
    : block.kind === "plan-update"
    ? planUpdatePlainText(block).length
    : block.kind === "notice"
    ? noticePlainText(block).length
    : block.content.length;
}

export function frameCharacterCount(frame: OpenTuiComponentFrame): number {
  return frame.body.reduce((total, block) => total + blockCharacterCount(block), 0)
    + frame.editorText.length
    + (frame.statusIndicator === undefined ? 0 : statusIndicatorPlainText(frame.statusIndicator).length)
    + frame.footer.reduce((total, line) => total + (typeof line === "string" ? line.length : line.segments.reduce((sum, segment) => sum + segment.text.length, 0)), 0)
    + (frame.overlay?.reduce((total, block) => total + blockCharacterCount(block), 0) ?? 0);
}

export function isAtBottom(transcript: { scrollHeight: number; scrollTop: number; height: number; viewport?: { height: number } }): boolean {
  // 与 OpenTUI 内部 maxScrollTop（scrollHeight - viewport.height）保持一致，
  // 避免 transcript.height（含 wrapper/scrollbar）与 viewport 高度不一致造成误判。
  const viewportHeight = transcript.viewport?.height ?? transcript.height;
  const maxScrollTop = Math.max(0, transcript.scrollHeight - viewportHeight);
  // 内容未超出视口时 scrollTop 可能为负（OpenTUI 预布局态），此时必然在底部。
  if (maxScrollTop <= 0) return true;
  return transcript.scrollTop >= maxScrollTop - 1;
}
