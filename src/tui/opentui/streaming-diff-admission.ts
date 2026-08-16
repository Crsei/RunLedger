import type { SafeDiffDocument, SafeDiffLine } from "../presentation/tools/types.ts";

export interface StreamingDiffLineRef {
	readonly hunkIndex: number;
	readonly lineIndex: number;
	readonly line: SafeDiffLine;
}

export interface StreamingDiffOpenLine {
	readonly hunkIndex: number;
	readonly lineIndex: number;
}

export interface StreamingDiffAdmissionOptions {
	readonly streaming: boolean;
	/** 当前仍可能继续接收 delta 的行；其余已到达行可进入高亮 admission。 */
	readonly openLine?: StreamingDiffOpenLine;
	readonly maxBytes?: number;
	readonly maxLines?: number;
}

export interface StreamingDiffAdmission {
	readonly admitted: readonly StreamingDiffLineRef[];
	readonly tail: readonly StreamingDiffLineRef[];
	readonly closedLineCount: number;
	readonly fallback: "none" | "budget";
}

const DEFAULT_MAX_BYTES = 512 * 1024;
const DEFAULT_MAX_LINES = 10_000;

/**
 * 把 SafeDiffDocument 的行分成可高亮的 settled 区域与仍可变的 tail。
 * SafeDiffDocument 已经是 projector 的有界结果，本模块只做 presentation
 * admission，不读取文件，也不修改领域 diff。
 */
export function admitStreamingDiff(
	document: SafeDiffDocument,
	options: StreamingDiffAdmissionOptions,
): StreamingDiffAdmission {
	const all = flattenLines(document);
	const maxBytes = boundedLimit(options.maxBytes, DEFAULT_MAX_BYTES);
	const maxLines = boundedLimit(options.maxLines, DEFAULT_MAX_LINES);
	const sourceBytes = all.reduce((total, ref) => total + Buffer.byteLength(ref.line.text.text, "utf8") + 1, 0);
	if (all.length > maxLines || sourceBytes > maxBytes) {
		return {
			admitted: [],
			tail: all,
			closedLineCount: 0,
			fallback: "budget",
		};
	}

	if (!options.streaming) {
		return { admitted: all, tail: [], closedLineCount: all.length, fallback: "none" };
	}

	const openLine = options.openLine ?? lastLinePosition(all);
	const admitted: StreamingDiffLineRef[] = [];
	const tail: StreamingDiffLineRef[] = [];
	for (const ref of all) {
		if (openLine !== undefined && ref.hunkIndex === openLine.hunkIndex && ref.lineIndex === openLine.lineIndex) {
			tail.push(ref);
		} else {
			admitted.push(ref);
		}
	}
	return { admitted, tail, closedLineCount: admitted.length, fallback: "none" };
}

function flattenLines(document: SafeDiffDocument): StreamingDiffLineRef[] {
	const lines: StreamingDiffLineRef[] = [];
	for (const [hunkIndex, hunk] of document.hunks.entries()) {
		for (const [lineIndex, line] of hunk.lines.entries()) lines.push({ hunkIndex, lineIndex, line });
	}
	return lines;
}

function lastLinePosition(lines: readonly StreamingDiffLineRef[]): StreamingDiffOpenLine | undefined {
	const last = lines.at(-1);
	return last === undefined ? undefined : { hunkIndex: last.hunkIndex, lineIndex: last.lineIndex };
}

function boundedLimit(value: number | undefined, fallback: number): number {
	return value === undefined || !Number.isFinite(value) ? fallback : Math.max(1, Math.floor(value));
}
