import { RGBA, StyledText, TextAttributes, type TextChunk } from "@opentui/core";
import type { HighlightColor } from "./contracts.ts";

export type StatusLineAccent = "model" | "path" | "branch" | "state" | "usage" | "limit" | "metadata" | "mode" | "thread" | "progress";

export interface StatusLineSegment {
	readonly accent: StatusLineAccent;
	readonly text: string;
}

export type StatusScopeResolver = (scopes: readonly string[]) => HighlightColor | undefined;

const scopes: Record<StatusLineAccent, readonly string[]> = {
	model: ["entity.name.type", "support.type", "variable"],
	path: ["string", "markup.underline.link"],
	branch: ["entity.name.function", "entity.name.tag"],
	state: ["keyword.control", "keyword"],
	usage: ["constant.numeric", "constant"],
	limit: ["constant.language", "storage.type"],
	metadata: ["comment", "constant.other"],
	mode: ["storage.modifier", "keyword.operator"],
	thread: ["markup.heading", "entity.name.section"],
	progress: ["markup.inserted", "constant.numeric"],
};

const fallbackIndex: Record<StatusLineAccent, number> = {
	model: 6,
	path: 2,
	branch: 5,
	state: 6,
	usage: 2,
	limit: 5,
	metadata: 6,
	mode: 6,
	thread: 5,
	progress: 2,
};

export function statusLineToStyledText(segments: readonly StatusLineSegment[], resolve: StatusScopeResolver): StyledText {
	const chunks: TextChunk[] = [];
	for (const [index, segment] of segments.entries()) {
		if (index > 0) chunks.push({ __isChunk: true, text: " · ", attributes: TextAttributes.DIM });
		const color = softenStatusColor(resolve(scopes[segment.accent]) ?? { kind: "indexed", index: fallbackIndex[segment.accent] });
		chunks.push({ __isChunk: true, text: segment.text, fg: colorToRgba(color) });
	}
	return new StyledText(chunks);
}

export function softenStatusColor(color: HighlightColor): HighlightColor {
	if (color.kind !== "rgb") return color;
	const luma = Math.floor((77 * color.r + 150 * color.g + 29 * color.b) / 256);
	return {
		kind: "rgb",
		r: softenChannel(color.r, luma),
		g: softenChannel(color.g, luma),
		b: softenChannel(color.b, luma),
	};
}

function softenChannel(channel: number, luma: number): number {
	return Math.floor((channel * 85 + luma * 15 + 50) / 100);
}

function colorToRgba(color: HighlightColor): RGBA {
	if (color.kind === "default") return RGBA.defaultForeground();
	if (color.kind === "indexed") return RGBA.fromIndex(color.index);
	return RGBA.fromInts(color.r, color.g, color.b);
}
