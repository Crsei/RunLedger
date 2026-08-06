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
		chips,
		body: [],
		timestamps: { startedAt },
	};
}

/** shell stdout/stderr chunk -> 有界 chunk；无界正文截断并标记。 */
export function projectShellChunk(channel: "stdout" | "stderr", text: unknown): SafeShellChunk {
	return { channel, text: boundedToolText(text, CHUNK_BOUND_BYTES) };
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
	const chips = [...presentation.chips];
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
	const body = [...presentation.body];
	if (result.isError) {
		const error = toolResultText(result.content);
		if (error.length > 0) body.push({ kind: "text", content: boundedToolText(error, LABEL_BOUND_BYTES) });
	}
	return {
		...presentation,
		chips,
		body,
		error: result.isError ? boundedToolText(toolResultText(result.content), TOOL_TEXT_BOUND_BYTES) : undefined,
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
				background: details.run_in_background === true,
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
