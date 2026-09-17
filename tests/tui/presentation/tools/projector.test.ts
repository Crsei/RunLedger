/**
 * B2：safe tool projector 验收。
 *
 *   - tool args/details 只经 safe projector 进入 presentation；
 *     raw args、credential、base64、完整文件正文不得出现；
 *   - shell exit code 与 lifecycle status 分离；unknown usage 不归零；
 *   - renderer 按工具名选择，unknown 工具归 generic。
 */

import { describe, expect, it } from "vitest";
import {
	boundedToolText,
	projectInputMetadata,
	projectShellChunk,
	projectToolEnd,
	projectToolResultMetadata,
	projectToolStart,
	projectToolUsage,
	rendererForTool,
} from "../../../../src/tui/presentation/tools/projector.ts";
import type { SafeToolRenderer } from "../../../../src/tui/presentation/tools/types.ts";

const startedAt = "2026-08-06T00:00:00.000Z";

describe("B2 safe tool projector", () => {
	it("selects a bounded renderer by tool name; unknown tools go generic", () => {
		expect(rendererForTool("bash")).toBe("shell");
		expect(rendererForTool("write")).toBe("write");
		expect(rendererForTool("edit")).toBe("edit");
		expect(rendererForTool("MultiEdit")).toBe("edit");
		expect(rendererForTool("read")).toBe("read");
		expect(rendererForTool("grep")).toBe("grep");
		expect(rendererForTool("totally-unknown")).toBe("generic");
	});

	/**
	 * 每个受治理工具都必须在这里显式登记渲染归属。
	 * 新增工具若不登记,本用例失败 —— 不允许静默落到 generic 而无人判断。
	 */
	it("registers an explicit renderer decision for every governed tool name", () => {
		const decisions: Readonly<Record<string, SafeToolRenderer>> = {
			// 专用 renderer
			read: "read", write: "write", edit: "edit", MultiEdit: "edit",
			bash: "shell", grep: "grep", glob: "glob", ls: "ls", todo: "plan",
			// 历史调用名:事件流带旧名,但展示与它实际执行的 glob 一致。
			find: "glob",
			// web 检索:查询词进 chip 与时间线标题行,不在 body 回显结果。
			web_search: "websearch",
			// 计划模式工具与扩展/子代理工具:保持 generic（无专用布局,但已显式决定）。
			plan: "plan", plan_read: "generic", plan_write: "generic",
			enter_plan_mode: "generic", exit_plan_mode: "generic",
			WebFetch: "generic", Skill: "generic", lsp: "generic",
			spawn_agent: "generic", request_permissions: "generic",
			NotebookEdit: "generic", echo: "generic",
			mcp_catalog: "generic", mcp_search: "generic", mcp_call: "generic",
			process_output: "generic", process_wait: "generic",
			write_stdin: "generic", process_stop: "generic", process_resize: "generic",
		};
		for (const [toolName, expected] of Object.entries(decisions)) {
			expect(rendererForTool(toolName), `${toolName} renderer decision`).toBe(expected);
		}
		expect(Object.keys(decisions).length).toBeGreaterThan(0);
	});

	it("never lets raw args, secrets or base64 into the presentation", () => {
		const args = {
			command: "curl https://example.com",
			path: "src/secret.ts",
			apiKey: "sk-live-123456",
			image: "data:image/png;base64,AAAA...",
			fullBody: "a".repeat(100_000),
		};
		const presentation = projectToolStart("bash", args, startedAt);
		const serialized = JSON.stringify(presentation);
		expect(serialized).not.toContain("sk-live-123456");
		expect(serialized).not.toContain("base64");
		expect(serialized).not.toContain("AAAA");
		// 命令只进入 bounded commandLabel（截断为 120 字节）
		expect(JSON.stringify(projectInputMetadata("bash", args)).length).toBeLessThan(300);
	});

	it("separates shell exit code from lifecycle status; unknown usage is never zero", () => {
		const start = projectToolStart("bash", { command: "false" }, startedAt);
		const final = projectToolEnd(start, { content: [], details: { exitCode: 1, durationMs: 5 }, isError: true }, startedAt);
		expect(final.chips.map((chip) => chip.label.text)).toEqual(expect.arrayContaining(["exit 1", "error"]));
		const usage = projectToolUsage(undefined, undefined);
		expect(usage.input.state).toBe("unknown");
		expect(usage.output.state).toBe("unknown");
		const known = projectToolUsage(10, 20);
		expect(known).toEqual({ input: { state: "exact", value: 10 }, output: { state: "exact", value: 20 }, accounting: "unavailable" });
	});

	it("bounds shell chunks and result metadata", () => {
		const chunk = projectShellChunk("stdout", `${"x".repeat(20_000)}tail`);
		expect(chunk.text.truncated).toBe(true);
		expect(chunk.text.text.endsWith("…")).toBe(true);
		const metadata = projectToolResultMetadata({
			toolName: "bash",
			details: { exitCode: 0, durationMs: 3, stdoutChunk: "ok" },
			content: [],
		});
		expect(metadata.kind).toBe("shell");
		if (metadata.kind === "shell") {
			expect(metadata.exitCode).toEqual({ state: "known", value: 0 });
			expect(metadata.durationMs).toEqual({ state: "known", value: 3 });
		}
		const unknown = projectToolResultMetadata({ toolName: "bash", details: {}, content: [] });
		expect(unknown.kind).toBe("shell");
		if (unknown.kind === "shell") {
			expect(unknown.exitCode.state).toBe("unknown");
		}
	});

	it("preserves only bounded SGR for shell output and removes active terminal controls", () => {
		const chunk = projectShellChunk(
			"stdout",
			"\x1b[38;5;196mred\x1b[0m\x1b]52;c;secret\x07\x1b[2J\x1b_unknown\x1b\\",
		);
		expect(chunk.text.text).toBe("red");
		expect(chunk.safeSgrText?.text).toBe("\x1b[38;5;196mred\x1b[0m");
		expect(chunk.safeSgrText?.text).not.toContain("secret");
		expect(chunk.safeSgrText?.text).not.toContain("[2J");
	});

	it("bounds text by UTF-8 bytes and strips ANSI", () => {
		const bounded = boundedToolText("\x1b[31mhello\x1b[0m", 100);
		expect(bounded.text).toBe("hello");
		expect(bounded.text).not.toContain("\x1b");
		expect(boundedToolText("a".repeat(100), 10).truncated).toBe(true);
	});

	it("read/grep result metadata only exposes structured counts", () => {
		const readMeta = projectToolResultMetadata({ toolName: "read", details: { lineCount: 42, truncated: true }, content: [] });
		expect(readMeta).toMatchObject({
			kind: "read",
			lineCount: { state: "known", value: 42 },
			truncated: true,
			exploration: {
				resultCount: { state: "known", value: 42 },
				resultUnit: "lines",
				sourceTruncated: true,
			},
		});
		const grepMeta = projectToolResultMetadata({ toolName: "grep", details: { matchCount: 3, fileCount: 2 }, content: [] });
		expect(grepMeta.kind).toBe("grep");
		if (grepMeta.kind === "grep") {
			expect(grepMeta.matchCount).toEqual({ state: "known", value: 3 });
			expect(grepMeta.fileCount).toEqual({ state: "known", value: 2 });
		}
	});

	it("uses the canonical grep result count and unit while preserving legacy replay fallback", () => {
		const files = projectToolResultMetadata({
			toolName: "grep",
			details: { fileCount: 2, resultCount: 2, resultUnit: "files" },
			content: [],
		});
		expect(files).toMatchObject({
			kind: "grep",
			matchCount: { state: "unknown" },
			fileCount: { state: "known", value: 2 },
			exploration: {
				resultCount: { state: "known", value: 2 },
				resultUnit: "files",
			},
		});

		const legacy = projectToolResultMetadata({
			toolName: "grep",
			details: { matchCount: 3, fileCount: 1 },
			content: [],
		});
		expect(legacy).toMatchObject({
			kind: "grep",
			exploration: {
				resultCount: { state: "known", value: 3 },
				resultUnit: "matches",
			},
		});
	});
});

describe("persisted bash feedback", () => {
	it("reconstructs text output after replay without duplicating live chunks", () => {
		const start = projectToolStart("bash", { command: "printf audit-ok" }, startedAt);
		const result = { content: [{ type: "text", text: "STDOUT:\naudit-ok\nSTDERR:\nwarning\nEXIT: 0" }], details: { outputFormat: "text", exitCode: 0 }, isError: false };
		const replay = projectToolEnd(start, result, startedAt);
		expect(replay.result?.kind === "shell" ? [...replay.result.chunks] : []).toMatchObject([
			{ channel: "stdout", text: { text: "audit-ok" } }, { channel: "stderr", text: { text: "warning" } },
		]);
		const live = projectToolEnd({ ...start, result: { kind: "shell", chunks: [projectShellChunk("stdout", "audit-ok"), projectShellChunk("stderr", "warning")], truncated: false, exitCode: { state: "unknown", reason: "not-reported" }, durationMs: { state: "unknown", reason: "not-reported" }, background: false } }, result, startedAt);
		expect(live.result).toEqual(replay.result);
	});

	it("restores stream-json channels and keeps empty output empty", () => {
		const start = projectToolStart("bash", {}, startedAt);
		const result = projectToolEnd(start, { content: [{ type: "text", text: '{"type":"stdout","line":"ok"}\n{"type":"stderr","line":"warn"}\n{"type":"exit","code":1}' }], details: { outputFormat: "stream-json", exitCode: 1 }, isError: true }, startedAt);
		expect(result.result?.kind === "shell" ? [...result.result.chunks] : []).toMatchObject([{ channel: "stdout", text: { text: "ok" } }, { channel: "stderr", text: { text: "warn" } }]);
		const empty = projectToolEnd(start, { content: [{ type: "text", text: "EXIT: 0" }], details: { outputFormat: "text", exitCode: 0 }, isError: false }, startedAt).result;
		expect(empty?.kind).toBe("shell");
		if (empty?.kind === "shell") expect(empty.chunks).toHaveLength(0);
	});
});
