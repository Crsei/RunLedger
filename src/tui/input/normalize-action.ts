/**
 * Normalized app input -> TuiAction。
 *
 * raw bytes 留在 OpenTUI boundary（KeyEvent/paste 已在边界归一化为回调）；
 * 本模块只做纯映射。不接 renderer、controller、timer 或 storage。
 */

import type { TuiAction } from "../application/action.ts";
import type { SafeBoundedText } from "../presentation/tools/types.ts";

export type NormalizedAppInput =
	| { readonly kind: "submit"; readonly text: string }
	| { readonly kind: "composer-changed"; readonly draft: string }
	| { readonly kind: "overlay-close" }
	| { readonly kind: "paste"; readonly text: string }
	| { readonly kind: "interrupt" }
	| { readonly kind: "request-exit" }
	| { readonly kind: "viewport-clear" }
	| { readonly kind: "focus"; readonly focused: boolean }
	| { readonly kind: "resize"; readonly columns: number; readonly rows: number }
	| { readonly kind: "select"; readonly id: string };

/** OpenTUI/测试终端共用的快捷键语义入口。 */
export function appInputForKeypress(data: string): NormalizedAppInput | undefined {
	if (data === "ctrl+c" || data === "\x03") return { kind: "interrupt" };
	if (data === "ctrl+d" || data === "\x04") return { kind: "request-exit" };
	if (data === "ctrl+l" || data === "\x0c") return { kind: "viewport-clear" };
	return undefined;
}

const COMPOSER_BOUND_BYTES = 256 * 1024;

function boundedDraft(text: string): SafeBoundedText {
	const bytes = new TextEncoder().encode(text);
	if (bytes.byteLength <= COMPOSER_BOUND_BYTES) {
		return { text, truncated: false, byteLength: bytes.byteLength };
	}
	const cut = bytes.subarray(0, COMPOSER_BOUND_BYTES);
	return {
		text: `${new TextDecoder("utf-8", { fatal: false }).decode(cut).replace(/\uFFFD$/u, "")}…`,
		truncated: true,
		byteLength: COMPOSER_BOUND_BYTES + 3,
	};
}

/**
 * 归一化 app 输入 -> actions。
 *  - submit 空文本 / interrupt / request-exit 不产生 state action
 *    （lifecycle authority 仍在 InteractiveMode/Plan 17）；
 *  - paste 与 composer-changed 同路径（有界）；
 *  - viewport-clear / select / overlay-close 为纯状态转换。
 */
export function normalizeAppInput(input: NormalizedAppInput): TuiAction[] {
	switch (input.kind) {
		case "submit": {
			if (input.text.trim().length === 0) return [];
			return [{ type: "composer.changed", draft: { text: "", truncated: false, byteLength: 0 } }];
		}
		case "composer-changed":
			return [{ type: "composer.changed", draft: boundedDraft(input.draft) }];
		case "paste":
			return [{ type: "composer.changed", draft: boundedDraft(input.text) }];
		case "overlay-close":
			return [{ type: "overlay.close" }];
		case "viewport-clear":
			return [{ type: "interaction.viewport-clear" }];
		case "select":
			return input.id.length === 0 ? [] : [{ type: "interaction.select", id: input.id }];
		case "focus":
			return [{ type: "interaction.focus-changed", focused: input.focused }];
		case "resize":
			return Number.isSafeInteger(input.columns) && input.columns > 0 && Number.isSafeInteger(input.rows) && input.rows > 0
				? [{ type: "interaction.viewport-resized", columns: input.columns, rows: input.rows }]
				: [];
		case "interrupt":
		case "request-exit":
			// lifecycle intent：由 InteractiveMode 持有并执行（reducer 不产生退出状态）
			return [];
	}
}
