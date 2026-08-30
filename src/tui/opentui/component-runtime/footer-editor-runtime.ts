/**
 * S6 拆分:footer/editor/status indicator 的渲染原语。
 */

import stringWidth from "string-width";
import { StyledText, TextareaRenderable } from "@opentui/core";
import { ansiToStyledText } from "../ansi-styled-text.ts";
import type { StatusIndicatorView } from "../../presentation.ts";
import { STATUS_DETAILS_PREFIX } from "../block-layout.ts";
import { statusLineToStyledText } from "../../highlight/status-style.ts";
import type { SyntaxHighlightService } from "../../highlight/service.ts";
import type { SyntaxThemeController } from "../../highlight/theme-controller.ts";
import { displayWidth, graphemes, truncateDisplayWidth, wrapDisplayWidth } from "../../mermaid/display-width.ts";
import type { OpenTuiComponentFrame } from "./types.ts";

export class RunLedgerTextareaRenderable extends TextareaRenderable {
  protected override renderCursor(_buffer: Parameters<TextareaRenderable["render"]>[0]): void {
    if (!this._showCursor || !this.focused) return;
    const visualCursor = this.editorView.getVisualCursor();
    const logicalLine = this.plainText.split("\n")[visualCursor.logicalRow] ?? "";
    const logicalPrefix = logicalLine.slice(0, visualCursor.logicalCol);
    const visualLineStartColumn = this.editorView.getLineInfo().lineStartCols[visualCursor.visualRow] ?? 0;
    const cursorColumn = Math.max(0, stringWidth(logicalPrefix) - visualLineStartColumn);
    this.ctx.setCursorPosition(
      this.screenX + cursorColumn + 1,
      this.screenY + visualCursor.visualRow + 1,
      true,
    );
    this.ctx.setCursorStyle({ ...this._cursorStyle, color: this._cursorColor });
  }
}

export function promptStyledText(hex: string): StyledText {
  const match = /^#?([0-9a-fA-F]{6})$/.exec(hex);
  if (!match) return ansiToStyledText("› ");
  const value = match[1]!;
  const r = Number.parseInt(value.slice(0, 2), 16);
  const g = Number.parseInt(value.slice(2, 4), 16);
  const b = Number.parseInt(value.slice(4, 6), 16);
  return ansiToStyledText(`\x1b[1m\x1b[38;2;${r};${g};${b}m›\x1b[22m\x1b[39m `);
}

export function statusIndicatorPlainText(view: StatusIndicatorView, width?: number): string {
  const interrupt = view.interruptKey === undefined ? "" : ` • ${view.interruptKey} to interrupt`;
  const inline = view.inlineMessage === undefined ? "" : ` ${view.inlineMessage}`;
  const header = `${view.indicator} ${view.header} (${view.elapsed}${interrupt})${inline}`;
  if (width === undefined) {
    return [header, ...(view.details ?? []).map((detail) => `${STATUS_DETAILS_PREFIX}${detail.text}`)].join("\n");
  }
  const safeWidth = Math.max(1, Math.floor(width));
  const detailLines: string[] = [];
  let detailsTruncated = false;
  for (const [detailIndex, detail] of (view.details ?? []).entries()) {
    const firstPrefix = boundedStatusPrefix(STATUS_DETAILS_PREFIX, safeWidth);
    const continuationPrefix = boundedStatusPrefix("    ", safeWidth);
    const contentWidth = Math.max(1, safeWidth - displayWidth(firstPrefix));
    const wrapped = wrapDisplayWidth(detail.text, contentWidth, Math.max(1, graphemes(detail.text).length + 1));
    for (const [lineIndex, line] of wrapped.entries()) {
      if (detailLines.length >= 3) {
        detailsTruncated = true;
        break;
      }
      const prefix = lineIndex === 0 ? firstPrefix : continuationPrefix;
      detailLines.push(truncateDisplayWidth(`${prefix}${line}`, safeWidth));
    }
    if (detailsTruncated) break;
    if (detailIndex < (view.details?.length ?? 0) - 1 && detailLines.length >= 3) detailsTruncated = true;
  }
  if (detailsTruncated && detailLines.length > 0) {
    const lastIndex = detailLines.length - 1;
    detailLines[lastIndex] = truncateDisplayWidth(`${detailLines[lastIndex]}…`, safeWidth, true);
  }
  return [truncateDisplayWidth(header, safeWidth, true), ...detailLines].join("\n");
}

function boundedStatusPrefix(prefix: string, width: number): string {
  return truncateDisplayWidth(prefix, Math.max(0, width - 1));
}

export function styledFooter(
  lines: OpenTuiComponentFrame["footer"],
  service: SyntaxHighlightService,
  themeController: SyntaxThemeController,
): StyledText {
	const chunks = lines.flatMap((line, index) => {
		const styled = typeof line === "string"
			? ansiToStyledText(line)
			: statusLineToStyledText(line.segments, (scopes) =>
				service.foregroundForScopes(themeController.snapshot().activeName, scopes));
		return [
			...(index === 0 ? [] : ansiToStyledText("\n").chunks),
			...ansiToStyledText("  ").chunks,
			...styled.chunks,
		];
	});
	return new StyledText(chunks);
}
