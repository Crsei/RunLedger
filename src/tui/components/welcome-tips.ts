import { readFileSync } from "node:fs";

import { visibleWidth, wrapTextWithAnsi } from "../primitives.ts";
import type { Theme } from "../theme/theme.ts";
import { wrapFg, wrapItalic } from "../theme/ansi.ts";

const tipsText = readFileSync(new URL("./tips.txt", import.meta.url), "utf8");

/** 每行一条；过滤空行与写给维护者的 meta 行。 */
export function loadTips(text: string): string[] {
	return text
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0 && !line.startsWith("tips.txt"));
}

export const TIPS: readonly string[] = loadTips(tipsText);

/** `sample` 应位于 [0, 1)；越界输入也被限制到现有列表。 */
export function pickTip(tips: readonly string[], sample: number): string {
	if (tips.length === 0) return "";
	const finite = Number.isFinite(sample) ? sample : 0;
	const index = Math.min(tips.length - 1, Math.max(0, Math.floor(finite * tips.length)));
	return tips[index] ?? "";
}

/** 渲染盒下 Tip 行；续行与标签正文起点对齐。 */
export function renderWelcomeTip(tip: string, theme: Theme, boxWidth: number): string[] {
	if (tip.length === 0) return [];
	const label = "Tip: ";
	const labelWidth = visibleWidth(label);
	const bodyBudget = Math.floor(boxWidth) - 1 - labelWidth;
	if (bodyBudget < 8) return [];
	const wrapped = wrapTextWithAnsi(tip, bodyBudget);
	if (wrapped.length === 0) return [];
	const styledLabel = wrapFg(theme.accent)(label);
	return wrapped.map((line, index) => {
		const prefix = index === 0 ? styledLabel : " ".repeat(labelWidth);
		return ` ${wrapItalic(`${prefix}${wrapFg(theme.muted)(line)}`)}`;
	});
}
