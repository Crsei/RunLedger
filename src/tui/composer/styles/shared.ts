import { displayWidth, truncateDisplayWidth } from "../../mermaid/display-width.ts";
import type {
	ComposerChromeContext,
	ComposerChromeRow,
	ComposerTextRun,
} from "../types.ts";

export function run(
	context: ComposerChromeContext,
	role: ComposerTextRun["role"],
	text: string,
	options: { readonly foregroundColor?: string; readonly bold?: boolean } = {},
): ComposerTextRun {
	const defaultForeground = role === "chrome"
		? context.borderColor
		: role === "prompt" || role === "status" || role === "scrollbar" ? context.accentColor : "";
	const foregroundColor = options.foregroundColor ?? defaultForeground;
	return Object.freeze({
		text,
		role,
		...(foregroundColor.length === 0 ? {} : { foregroundColor }),
		...(context.surfaceColor.length === 0 ? {} : { backgroundColor: context.surfaceColor }),
		...(options.bold === true ? { bold: true } : {}),
	});
}

export function row(
	kind: ComposerChromeRow["kind"],
	content: string | readonly ComposerTextRun[],
	width: number,
	role: ComposerTextRun["role"] = "chrome",
): ComposerChromeRow {
	const safeWidth = Math.max(0, Math.floor(width));
	const source = typeof content === "string" ? [{ text: content, role }] : content;
	const runs: ComposerTextRun[] = [];
	let remaining = safeWidth;
	for (const sourceRun of source) {
		if (remaining <= 0) break;
		const text = truncateDisplayWidth(sourceRun.text, remaining);
		if (text.length > 0) runs.push(Object.freeze({ ...sourceRun, text }));
		remaining -= displayWidth(text);
	}
	if (remaining > 0) {
		const previous = runs.at(-1);
		runs.push(Object.freeze({
			text: " ".repeat(remaining),
			role: previous?.role ?? role,
			...(previous?.backgroundColor === undefined ? {} : { backgroundColor: previous.backgroundColor }),
		}));
	}
	const frozenRuns = Object.freeze(runs);
	return Object.freeze({
		kind,
		text: frozenRuns.map((item) => item.text).join(""),
		width: safeWidth,
		runs: frozenRuns,
	});
}

export function statusText(context: ComposerChromeContext): string {
	return context.status.identity.trim();
}

export function usageText(context: ComposerChromeContext): string {
	return context.status.usage.trim();
}

export function fullStatusText(context: ComposerChromeContext): string {
	return [statusText(context), usageText(context)].filter((value) => value.length > 0).join(" · ");
}

export function inputRuns(context: ComposerChromeContext, prompt: string): readonly ComposerTextRun[] {
	const input = context.inputRow;
	const padding = " ".repeat(Math.max(0, context.paddingX));
	if (input === undefined) return Object.freeze([run(context, "input", `${padding}${prompt}${padding}`)]);
	const visiblePrompt = input.isFirst ? prompt : " ".repeat(displayWidth(prompt));
	return Object.freeze([
		run(context, "input", padding),
		run(context, "prompt", visiblePrompt, { bold: visiblePrompt.trim().length > 0 }),
		run(context, "input", input.text),
		run(context, "input", padding),
	]);
}

export function fill(width: number, value = " "): string {
	return value.repeat(Math.max(0, Math.floor(width)));
}

export function safeWidth(value: number): number {
	return Math.max(1, Math.floor(Number.isFinite(value) ? value : 1));
}

export function bordered(
	kind: ComposerChromeRow["kind"],
	width: number,
	left: ComposerTextRun,
	right: ComposerTextRun,
	content: readonly ComposerTextRun[],
	context: ComposerChromeContext,
): ComposerChromeRow {
	const safe = safeWidth(width);
	const innerWidth = Math.max(0, safe - displayWidth(left.text) - displayWidth(right.text));
	const clipped: ComposerTextRun[] = [];
	let remaining = innerWidth;
	for (const item of content) {
		if (remaining <= 0) break;
		const text = truncateDisplayWidth(item.text, remaining);
		if (text.length > 0) clipped.push(Object.freeze({ ...item, text }));
		remaining -= displayWidth(text);
	}
	if (remaining > 0) clipped.push(run(context, "chrome", fill(remaining)));
	return row(kind, [left, ...clipped, right], safe);
}
