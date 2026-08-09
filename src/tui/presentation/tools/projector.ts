/**
 * Safe tool projector：runtime tool receipt -> SafeToolPresentation。
 *
 * 只接收 Runtime 已提供的安全 receipt/details；raw args、credential、
 * base64、完整文件正文一律不进 presentation——body 只含有界文本，
 * input metadata 只含路径/命令标签。shell exit code 与 lifecycle status
 * 分离；unknown usage 不归零。
 */

import type {
	SafeBoundedText,
	SafeCount,
	SafeDiffDocument,
	SafeDiffHunk,
	SafeDiffLine,
	SafeShellChunk,
	SafeToolChip,
	SafeToolInputMetadata,
	SafeToolPresentation,
	SafeToolRenderer,
	SafeToolResultMetadata,
	SafeToolUsageView,
} from "./types.ts";

/** 工具正文/标签的显示上界；超出截断并标记 truncated。 */
export const TOOL_TEXT_BOUND_BYTES = 64 * 1024;
const LABEL_BOUND_BYTES = 120;
const CHUNK_BOUND_BYTES = 16 * 1024;
const DIFF_LINE_BOUND_BYTES = 4 * 1024;
const DIFF_MAX_LINES = 400;
const SHELL_TAIL_LINES_PER_CHANNEL = 100;

/** 把任意值做成有界文本：strip ANSI、UTF-8 字节截断。 */
export function boundedToolText(value: unknown, maxBytes = TOOL_TEXT_BOUND_BYTES): SafeBoundedText {
	const raw = typeof value === "string" ? value : "";
	const stripped = raw.replace(/\x1b\[[0-9;?]*[a-zA-Z]/gu, "").replace(/\x1b\][^\x07]*\x07/gu, "");
	const bytes = new TextEncoder().encode(stripped);
	if (bytes.byteLength <= maxBytes) {
		return { text: stripped, truncated: false, byteLength: bytes.byteLength };
	}
	const cut = bytes.subarray(0, maxBytes);
	const text = new TextDecoder("utf-8", { fatal: false }).decode(cut);
	return {
		text: `${text.replace(/\uFFFD$/u, "")}…`,
		truncated: true,
		byteLength: maxBytes + 3,
	};
}

function safeCount(value: unknown): SafeCount {
	return typeof value === "number" && Number.isSafeInteger(value)
		? { state: "known", value }
		: { state: "unknown", reason: "not-reported" };
}

function safeBytes(value: unknown): SafeCount {
	return typeof value === "number" && Number.isFinite(value)
		? { state: "known", value: Math.max(0, Math.floor(value)) }
		: { state: "unknown", reason: "not-reported" };
}

/** 工具名 -> 安全 renderer（unknown 工具归 generic，不做路由）。 */
export function rendererForTool(toolName: string): SafeToolRenderer {
	switch (toolName) {
		case "bash":
		case "sh":
			return "shell";
		case "write":
			return "write";
		case "edit":
		case "MultiEdit":
		case "multi-edit":
			return "edit";
		case "read":
			return "read";
		case "grep":
			return "grep";
		case "goal":
			return "goal";
		default:
			return "generic";
	}
}

/** 从 runtime args 提炼有界 input metadata；raw args 本身不进 presentation。 */
export function projectInputMetadata(toolName: string, args: unknown): SafeToolInputMetadata {
	if (!isRecord(args)) return { kind: "generic" };
	const path = (): SafeBoundedText | undefined => {
		for (const key of ["path", "filePath", "file_path"]) {
			const value = args[key];
			if (typeof value === "string" && value.length > 0) {
				return boundedToolText(value, LABEL_BOUND_BYTES);
			}
		}
		return undefined;
	};
	switch (rendererForTool(toolName)) {
		case "shell": {
			const command = typeof args.command === "string" ? args.command : typeof args.cmd === "string" ? args.cmd : "";
			return {
				kind: "shell",
				commandLabel: boundedToolText(command, LABEL_BOUND_BYTES),
				background: args.run_in_background === true,
			};
		}
		case "edit": {
			const editCount = Array.isArray(args.edits) ? safeCount(args.edits.length) : safeCount(args.editCount);
			return { kind: "edit", path: path() ?? boundedToolText("<path>"), editCount };
		}
		case "write":
			return {
				kind: "write",
				path: path() ?? boundedToolText("<path>"),
				lineCount: safeCount(args.lineCount),
				byteCount: safeBytes(args.byteCount),
			};
		case "read":
			return {
				kind: "read",
				path: path() ?? boundedToolText("<path>"),
				offset: safeCount(args.offset),
				limit: safeCount(args.limit),
			};
		case "grep":
			return { kind: "grep", path: path() ?? boundedToolText("<pattern>") };
		default:
			return { kind: "generic" };
	}
}

/** 工具调用开始：title/chips/body 全有界；raw args 不进 body。 */
export function projectToolStart(toolName: string, args: unknown, startedAt: string): SafeToolPresentation {
	const title = boundedToolText(toolName, LABEL_BOUND_BYTES);
	const input = projectInputMetadata(toolName, args);
	const chips: SafeToolChip[] = [
		{ label: { text: "running", truncated: false, byteLength: 7 }, tone: "neutral" },
	];
	if (input.kind === "shell") {
		chips.push({ label: { text: "shell", truncated: false, byteLength: 5 }, tone: "neutral" });
	}
		return {
			renderer: rendererForTool(toolName),
			title,
			input,
			chips,
		body: [],
		timestamps: { startedAt },
	};
}

/** shell stdout/stderr chunk -> 有界 chunk；无界正文截断并标记。 */
export function projectShellChunk(channel: "stdout" | "stderr", text: unknown): SafeShellChunk {
	return { channel, text: boundedToolText(text, CHUNK_BOUND_BYTES) };
}

/** 把 shell 输出压成每通道最后 100 行，保持 stdout/stderr 标签且不保存无界日志。 */
export function appendShellPresentationChunk(
	presentation: SafeToolPresentation,
	chunk: SafeShellChunk,
): SafeToolPresentation {
	const previous = presentation.result?.kind === "shell" ? presentation.result : undefined;
	const chunks = boundShellChunks([...(previous?.chunks ?? []), chunk]);
	return {
		...presentation,
		result: {
			kind: "shell",
			chunks,
			truncated: previous?.truncated === true || chunk.text.truncated || chunks.truncated,
			exitCode: previous?.exitCode ?? safeCount(undefined),
			durationMs: previous?.durationMs ?? safeCount(undefined),
			background: previous?.background === true || presentation.input?.kind === "shell" && presentation.input.background === true,
		},
	};
}

/** 工具执行结束：exitCode/duration 来自 details（unknown 不归零），lifecycle 由调用方定 status。 */
export function projectToolEnd(
	presentation: SafeToolPresentation,
	result: { readonly content: unknown; readonly details: unknown; readonly isError: boolean },
	endedAt: string,
): SafeToolPresentation {
	const details = isRecord(result.details) ? result.details : {};
	const exitCode = typeof details.exitCode === "number" ? details.exitCode : undefined;
	const durationMs = typeof details.durationMs === "number" ? details.durationMs : undefined;
	const chips = presentation.chips.filter((chip) => !["pending", "running", "ok", "error"].includes(chip.label.text));
	if (exitCode !== undefined) {
		chips.push({ label: boundedToolText(`exit ${exitCode}`, LABEL_BOUND_BYTES), tone: exitCode === 0 ? "positive" : "error" });
	}
	if (durationMs !== undefined) {
		chips.push({ label: boundedToolText(`${Math.round(durationMs)}ms`, LABEL_BOUND_BYTES), tone: "neutral" });
	}
	chips.push({
		label: boundedToolText(result.isError ? "error" : "ok", LABEL_BOUND_BYTES),
		tone: result.isError ? "error" : "positive",
	});
	const resultText = toolResultText(result.content);
	const body = [...presentation.body];
	if (presentation.renderer !== "shell" && resultText.length > 0 && !body.some((block) => block.kind === "text" && block.content.text === resultText)) {
		body.push({ kind: "text", content: boundedToolText(resultText, TOOL_TEXT_BOUND_BYTES) });
	}
	let metadata = projectToolResultMetadata({ toolName: presentation.title.text, details: result.details, content: result.content });
	if (metadata.kind === "shell") {
		const previous = presentation.result?.kind === "shell" ? presentation.result : undefined;
		const bounded = boundShellChunks([...(previous?.chunks ?? []), ...metadata.chunks]);
		metadata = {
			...metadata,
			chunks: bounded,
			truncated: metadata.truncated || previous?.truncated === true || bounded.truncated,
			background: metadata.background || previous?.background === true || presentation.input?.kind === "shell" && presentation.input.background === true,
		};
	}
	if (presentation.renderer === "edit" && isRecord(result.details) && typeof result.details.diff === "string") {
		const path = presentation.input?.kind === "edit" ? presentation.input.path : boundedToolText("<path>", LABEL_BOUND_BYTES);
		const document = projectDiffDocument(path, result.details.diff);
		metadata = { kind: "edit", document, addedLines: document.addedLines, removedLines: document.removedLines };
		body.push({ kind: "diff", document });
	}
	return {
		...presentation,
		chips,
		body,
		result: metadata,
		error: result.isError ? boundedToolText(resultText, TOOL_TEXT_BOUND_BYTES) : undefined,
		timestamps: { ...presentation.timestamps, endedAt },
	};
}

/** ToolResultContent -> 有界 result metadata；只提取结构化已知字段。 */
export function projectToolResultMetadata(result: { readonly toolName: string; readonly details: unknown; readonly content: unknown }): SafeToolResultMetadata {
	const details = isRecord(result.details) ? result.details : {};
	switch (rendererForTool(result.toolName)) {
		case "shell": {
			const chunks: SafeShellChunk[] = [];
			if (typeof details.stdoutChunk === "string" && details.stdoutChunk.length > 0) {
				chunks.push(projectShellChunk("stdout", details.stdoutChunk));
			}
			if (typeof details.stderrChunk === "string" && details.stderrChunk.length > 0) {
				chunks.push(projectShellChunk("stderr", details.stderrChunk));
			}
			return {
				kind: "shell",
				chunks,
				truncated: chunks.some((chunk) => chunk.text.truncated),
				exitCode: safeCount(details.exitCode),
				durationMs: safeCount(details.durationMs),
				background: details.run_in_background === true || isRecord(details.background),
			};
		}
		case "read":
			return {
				kind: "read",
				lineCount: safeCount(details.lineCount),
				truncated: details.truncated === true,
			};
		case "grep":
			return {
				kind: "grep",
				matchCount: safeCount(details.matchCount),
				fileCount: safeCount(details.fileCount),
				samples: [],
				truncated: details.truncated === true,
			};
		default:
			return { kind: "generic" };
	}
}

/** 解析 runtime edit 的 unified diff；只保留有界 patch 行，不接收完整 before/after。 */
export function projectDiffDocument(path: SafeBoundedText, diff: unknown): SafeDiffDocument {
	if (typeof diff !== "string" || diff.length === 0) {
		return {
			kind: "document",
			path,
			hunks: [],
			addedLines: safeCount(0),
			removedLines: safeCount(0),
			truncated: false,
			diagnostic: "unavailable",
		};
	}
	const sourceLines = diff.split(/\r?\n/u);
	const truncated = sourceLines.length > DIFF_MAX_LINES;
	const lines = sourceLines.slice(0, DIFF_MAX_LINES);
	const hunks: SafeDiffHunk[] = [];
	let current: { oldLine: number; newLine: number; lines: SafeDiffLine[] } | undefined;
	let invalid = false;
	let added = 0;
	let removed = 0;
	for (const line of lines) {
		const header = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/u);
		if (header !== null) {
			if (current !== undefined) hunks.push({ oldStart: current.oldLine, newStart: current.newLine, lines: current.lines });
			current = { oldLine: Number(header[1]), newLine: Number(header[2]), lines: [] };
			continue;
		}
		if (current === undefined) {
			invalid = true;
			continue;
		}
		const content = boundedToolText(line.slice(1), DIFF_LINE_BOUND_BYTES);
		if (line.startsWith("+")) {
			current.lines.push({ kind: "add", newLine: current.newLine, text: content });
			current.newLine += 1;
			added += 1;
		} else if (line.startsWith("-")) {
			current.lines.push({ kind: "delete", oldLine: current.oldLine, text: content });
			current.oldLine += 1;
			removed += 1;
		} else if (line.startsWith(" ")) {
			current.lines.push({ kind: "context", oldLine: current.oldLine, newLine: current.newLine, text: content });
			current.oldLine += 1;
			current.newLine += 1;
		} else {
			invalid = true;
		}
	}
	if (current !== undefined) hunks.push({ oldStart: current.oldLine - current.lines.filter((line) => line.kind !== "add").length, newStart: current.newLine - current.lines.filter((line) => line.kind !== "delete").length, lines: current.lines });
	return {
		kind: "document",
		path,
		hunks,
		addedLines: safeCount(added),
		removedLines: safeCount(removed),
		truncated,
		...(invalid ? { diagnostic: "invalid" as const } : truncated ? { diagnostic: "limit" as const } : {}),
	};
}

function boundShellChunks(input: readonly SafeShellChunk[]): SafeShellChunk[] & { readonly truncated: boolean } {
	const byChannel: Record<SafeShellChunk["channel"], SafeShellChunk[]> = { stdout: [], stderr: [] };
	let truncated = false;
	for (const chunk of input) {
		const lines = chunk.text.text.split(/\r?\n/u);
		if (lines.at(-1) === "") lines.pop();
		for (const line of lines) {
			byChannel[chunk.channel].push({ channel: chunk.channel, text: boundedToolText(line, CHUNK_BOUND_BYTES) });
		}
	}
	for (const channel of ["stdout", "stderr"] as const) {
		if (byChannel[channel].length > SHELL_TAIL_LINES_PER_CHANNEL) {
			byChannel[channel] = byChannel[channel].slice(-SHELL_TAIL_LINES_PER_CHANNEL);
			truncated = true;
		}
	}
	const result = [...byChannel.stdout, ...byChannel.stderr] as SafeShellChunk[] & { truncated: boolean };
	result.truncated = truncated;
	return result;
}

/** usage -> SafeToolUsageView；provider 未报告时 unknown，绝不归零。 */
export function projectToolUsage(input: unknown, output: unknown): SafeToolUsageView {
	const asNumber = (value: unknown): number | undefined =>
		typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
	return {
		input: asNumber(input) !== undefined
			? { state: "exact", value: asNumber(input)! }
			: { state: "unknown", reason: "not-reported" },
		output: asNumber(output) !== undefined
			? { state: "exact", value: asNumber(output)! }
			: { state: "unknown", reason: "not-reported" },
		accounting: "unavailable",
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toolResultText(content: unknown): string {
	if (!Array.isArray(content)) return "";
	return content
		.filter((item): item is { type: string; text: string } =>
			isRecord(item) && item.type === "text" && typeof item.text === "string")
		.map((item) => item.text)
		.join("");
}
