/**
 * S6 拆分:settled markdown/highlight admission 预算。
 */

import { CodeRenderable, type Renderable, type ScrollBoxRenderable } from "@opentui/core";
import { MermaidBlockRenderable, type MermaidThemeMode } from "../mermaid-block-renderable.ts";
import { SyntectCodeBlockRenderable, type HighlightAdmission } from "../syntect-code-block-renderable.ts";
import { ExecRenderable } from "../exec-renderable.ts";
import { DiffRenderable } from "../diff-renderable.ts";
import { freezeStreamPrefix, type SettledSpan } from "../settled-prefix.ts";
import { splitClosedStreamingTable } from "../streaming-table-split.ts";
import type { BodyRenderable, KeyedRenderable, SettledMarkdownState } from "./types.ts";

export function chooseSettledMarkdownSpan(
	text: string,
	previous: SettledSpan | undefined,
	tableSplit: ReturnType<typeof splitClosedStreamingTable>,
): SettledSpan | undefined {
	const regular = freezeStreamPrefix(text, previous);
	if (tableSplit === undefined) return regular;
	if (previous !== undefined && !tableSplit.prefixText.startsWith(previous.prefixText)) return regular;
	if (previous !== undefined && tableSplit.prefixEnd <= previous.end) return regular;
	const tableSpan: SettledSpan = {
		start: 0,
		end: tableSplit.prefixEnd,
		prefixText: tableSplit.prefixText,
		lineCount: countNewlines(tableSplit.prefixText),
	};
	return regular === undefined || tableSpan.end > regular.end ? tableSpan : regular;
}

function countNewlines(text: string): number {
	let count = 0;
	for (const character of text) if (character === "\n") count += 1;
	return count;
}

export function updateMermaidTheme(renderable: Renderable, mode: MermaidThemeMode): void {
  if (renderable instanceof MermaidBlockRenderable) renderable.setThemeMode(mode);
  for (const child of renderable.getChildren()) updateMermaidTheme(child, mode);
}

export function finalizeMarkdownChildren(renderable: Renderable): void {
  for (const child of renderable.getChildren()) {
    if (child instanceof CodeRenderable) {
      child.drawUnstyledText = true;
      child.streaming = false;
    }
    finalizeMarkdownChildren(child);
  }
}

export function updateTranscriptHighlightAdmission(
	transcript: ScrollBoxRenderable,
	nodes: ReadonlyMap<string, KeyedRenderable<BodyRenderable>>,
	settledMarkdownStates: ReadonlyMap<string, SettledMarkdownState>,
): void {
	const viewportTop = transcript.viewport.screenY;
	const viewportHeight = Math.max(1, transcript.viewport.height);
	const viewportBottom = viewportTop + viewportHeight;
	const updateNode = (renderable: Renderable): void => {
		visitHighlightRenderables(renderable, (highlightable) => {
			const top = highlightable.screenY;
			const bottom = top + Math.max(1, highlightable.height);
			const admission: HighlightAdmission = bottom > viewportTop && top < viewportBottom
				? "visible"
				: bottom > viewportTop - viewportHeight && top < viewportBottom + viewportHeight
					? "overscan"
					: "offscreen";
			highlightable.setHighlightAdmission(admission);
		});
	};
	for (const node of nodes.values()) {
		updateNode(node.renderable);
	}
	for (const state of settledMarkdownStates.values()) updateNode(state.renderable);
}

function visitHighlightRenderables(
	renderable: Renderable,
  visit: (renderable: SyntectCodeBlockRenderable | ExecRenderable | DiffRenderable) => void,
): void {
  if (renderable instanceof SyntectCodeBlockRenderable || renderable instanceof ExecRenderable || renderable instanceof DiffRenderable) visit(renderable);
	for (const child of renderable.getChildren()) visitHighlightRenderables(child, visit);
}
