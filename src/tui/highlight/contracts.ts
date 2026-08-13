import { RGBA, StyledText, TextAttributes, type TextChunk } from "@opentui/core";

export type HighlightColor =
	| { readonly kind: "default" }
	| { readonly kind: "indexed"; readonly index: number }
	| { readonly kind: "rgb"; readonly r: number; readonly g: number; readonly b: number };

export interface HighlightSpan {
	readonly text: string;
	readonly foreground: HighlightColor;
	readonly bold: boolean;
}

export interface HighlightLine {
	readonly spans: readonly HighlightSpan[];
}

export type HighlightFallbackReason =
	| "empty"
	| "unknown_language"
	| "oversize_bytes"
	| "oversize_lines"
	| "native_unavailable"
	| "theme_invalid"
	| "highlight_error"
	| "timeout"
	| "queue_pressure"
	| "stale_generation";

export type HighlightResult =
	| { readonly ok: true; readonly lines: readonly HighlightLine[]; readonly themeRevision: number }
	| { readonly ok: false; readonly reason: HighlightFallbackReason };

const fallbackReasons = new Set<HighlightFallbackReason>([
	"empty",
	"unknown_language",
	"oversize_bytes",
	"oversize_lines",
	"native_unavailable",
	"theme_invalid",
	"highlight_error",
	"timeout",
	"queue_pressure",
	"stale_generation",
]);

export function validateHighlightResult(value: unknown): HighlightResult | undefined {
	if (!isRecordWithExactKeys(value, valueIsSuccess(value) ? ["ok", "lines", "themeRevision"] : ["ok", "reason"])) return undefined;
	if (value.ok === false) {
		return typeof value.reason === "string" && fallbackReasons.has(value.reason as HighlightFallbackReason)
			? { ok: false, reason: value.reason as HighlightFallbackReason }
			: undefined;
	}
	if (value.ok !== true || !Number.isSafeInteger(value.themeRevision) || (value.themeRevision as number) < 0 || !Array.isArray(value.lines)) {
		return undefined;
	}
	const lines: HighlightLine[] = [];
	for (const line of value.lines) {
		if (!isRecordWithExactKeys(line, ["spans"]) || !Array.isArray(line.spans)) return undefined;
		const spans: HighlightSpan[] = [];
		for (const span of line.spans) {
			if (!isRecordWithExactKeys(span, ["text", "foreground", "bold"]) || typeof span.text !== "string" || /[\r\n]/u.test(span.text) || typeof span.bold !== "boolean") {
				return undefined;
			}
			const foreground = validateColor(span.foreground);
			if (!foreground) return undefined;
			spans.push({ text: span.text, foreground, bold: span.bold });
		}
		lines.push({ spans });
	}
	return { ok: true, lines, themeRevision: value.themeRevision as number };
}

export function highlightResultToStyledText(result: HighlightResult): StyledText | undefined {
	if (!result.ok) return undefined;
	const chunks: TextChunk[] = [];
	for (let lineIndex = 0; lineIndex < result.lines.length; lineIndex++) {
		if (lineIndex > 0) chunks.push({ __isChunk: true, text: "\n" });
		for (const span of result.lines[lineIndex]!.spans) {
			chunks.push({
				__isChunk: true,
				text: span.text,
				fg: toRgba(span.foreground),
				...(span.bold ? { attributes: TextAttributes.BOLD } : {}),
			});
		}
	}
	return new StyledText(chunks);
}

function validateColor(value: unknown): HighlightColor | undefined {
	if (!isObject(value) || typeof value.kind !== "string") return undefined;
	if (value.kind === "default" && hasExactKeys(value, ["kind"])) return { kind: "default" };
	if (value.kind === "indexed" && hasExactKeys(value, ["kind", "index"]) && isByte(value.index)) {
		return { kind: "indexed", index: value.index };
	}
	if (value.kind === "rgb" && hasExactKeys(value, ["kind", "r", "g", "b"]) && isByte(value.r) && isByte(value.g) && isByte(value.b)) {
		return { kind: "rgb", r: value.r, g: value.g, b: value.b };
	}
	return undefined;
}

function toRgba(color: HighlightColor): RGBA {
	if (color.kind === "default") return RGBA.defaultForeground();
	if (color.kind === "indexed") return RGBA.fromIndex(color.index);
	return RGBA.fromInts(color.r, color.g, color.b);
}

function valueIsSuccess(value: unknown): boolean {
	return isObject(value) && value.ok === true;
}

function isByte(value: unknown): value is number {
	return Number.isInteger(value) && typeof value === "number" && value >= 0 && value <= 255;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRecordWithExactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
	return isObject(value) && hasExactKeys(value, keys);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
	const actual = Object.keys(value).sort();
	const expected = [...keys].sort();
	return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}
