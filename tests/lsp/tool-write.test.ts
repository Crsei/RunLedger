import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { shutdownAll } from "../../src/lsp/client.ts";
import { createLspTool } from "../../src/lsp/tool.ts";
import type { LspConfig, LspWriteOperations, WorkspaceEdit } from "../../src/lsp/types.ts";
import { FakeTransport } from "./fake-transport.ts";

const made: string[] = [];
afterEach(async () => {
	await shutdownAll();
	for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture(): { cwd: string; config: LspConfig } {
	const cwd = mkdtempSync(path.join(tmpdir(), "lsp-write-"));
	made.push(cwd);
	writeFileSync(path.join(cwd, "a.ts"), "const a = 1;\n");
	return { cwd, config: { servers: { fake: { command: "fake", fileTypes: [".ts"], rootMarkers: ["a.ts"], resolvedCommand: "fake" } } } };
}

function recordingOps(): LspWriteOperations & { log: string[] } {
	const log: string[] = [];
	return {
		log,
		readFile: async (filePath) => {
			if (path.basename(filePath) === "b.ts") throw new Error("not found");
			return "const a = 1;\n";
		},
		writeFile: async (filePath, content) => { log.push(`write ${filePath} ${JSON.stringify(content)}`); },
		createDirectory: async (directory) => { log.push(`mkdir ${directory}`); },
		renameFile: async (oldPath, newPath) => { log.push(`rename ${oldPath} ${newPath}`); },
		deleteFile: async (filePath) => { log.push(`rm ${filePath}`); },
	};
}

async function answerInitialize(transport: FakeTransport): Promise<void> {
	for (let i = 0; i < 50; i += 1) {
		await new Promise((resolve) => setTimeout(resolve, 0));
		const init = transport.lastRequest("initialize");
		if (init !== undefined) {
			transport.emitResponse(init.id, { capabilities: { renameProvider: true, codeActionProvider: true } });
			transport.emitNotification("$/progress", { token: "ready", value: { kind: "end" } });
			return;
		}
	}
	throw new Error("initialize request was not emitted");
}

async function waitForRequest(transport: FakeTransport, method: string): Promise<NonNullable<ReturnType<FakeTransport["lastRequest"]>>> {
	for (let i = 0; i < 50; i += 1) {
		const request = transport.lastRequest(method);
		if (request !== undefined) return request;
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
	throw new Error(`request was not emitted: ${method}`);
}

describe("createLspTool 写动作", () => {
	it("rename apply 经注入 writeOperations 落盘", async () => {
		const { cwd, config } = fixture();
		const transport = new FakeTransport();
		const ops = recordingOps();
		const tool = createLspTool(cwd, { getConfig: () => config, spawn: { spawn: async () => transport }, writeOperations: ops });
		const pending = tool.execute("call-1", { action: "rename", file: "a.ts", line: 1, symbol: "a", new_name: "b" });
		await answerInitialize(transport);
		const request = await waitForRequest(transport, "textDocument/rename");
		const edit: WorkspaceEdit = { changes: { "file:///a.ts": [{ range: { start: { line: 0, character: 6 }, end: { line: 0, character: 7 } }, newText: "b" }] } };
		transport.emitResponse(request.id, edit);
		const result = await pending;
		expect(ops.log.some((entry) => entry.startsWith("write"))).toBe(true);
		expect((result.content[0] as { text: string }).text).toContain("Applied rename");
	});

	it("rename apply=false 只预览不落盘", async () => {
		const { cwd, config } = fixture();
		const transport = new FakeTransport();
		const ops = recordingOps();
		const tool = createLspTool(cwd, { getConfig: () => config, spawn: { spawn: async () => transport }, writeOperations: ops });
		const pending = tool.execute("call-2", { action: "rename", file: "a.ts", line: 1, symbol: "a", new_name: "b", apply: false });
		await answerInitialize(transport);
		const request = await waitForRequest(transport, "textDocument/rename");
		transport.emitResponse(request.id, { changes: { "file:///a.ts": [] } });
		const result = await pending;
		expect((result.content[0] as { text: string }).text).toContain("Rename preview");
		expect(ops.log).toHaveLength(0);
	});

	it("rename_file 经 ops.renameFile 落盘", async () => {
		const { cwd, config } = fixture();
		const transport = new FakeTransport();
		const ops = recordingOps();
		const tool = createLspTool(cwd, { getConfig: () => config, spawn: { spawn: async () => transport }, writeOperations: ops });
		const pending = tool.execute("call-3", { action: "rename_file", file: "a.ts", new_name: "b.ts" });
		await answerInitialize(transport);
		const result = await pending;
		expect(ops.log).toContain(`rename ${path.join(cwd, "a.ts")} ${path.join(cwd, "b.ts")}`);
		expect((result.content[0] as { text: string }).text).toContain("Renamed");
	});

	it("rename_file 的存在性检查也只使用 governed operations", async () => {
		const { cwd, config } = fixture();
		rmSync(path.join(cwd, "a.ts"));
		const transport = new FakeTransport();
		const log: string[] = [];
		const ops: LspWriteOperations = {
			readFile: async (filePath) => {
				log.push(`read ${filePath}`);
				if (filePath.endsWith("a.ts")) return "const a = 1;\n";
				throw new Error("not found");
			},
			writeFile: async () => undefined,
			createDirectory: async () => undefined,
			renameFile: async (from, to) => { log.push(`rename ${from} ${to}`); },
			deleteFile: async () => undefined,
		};
		const tool = createLspTool(cwd, { getConfig: () => config, spawn: { spawn: async () => transport }, writeOperations: ops });
		const pending = tool.execute("call-governed-rename", { action: "rename_file", file: "a.ts", new_name: "b.ts" });
		await answerInitialize(transport);
		const result = await pending;
		expect((result.content[0] as { text: string }).text).toContain("Renamed");
		expect(log.filter((entry) => entry.startsWith("read"))).toHaveLength(2);
		expect(log.some((entry) => entry.startsWith("rename"))).toBe(true);
	});

	it("code_actions apply 按 query 选择并应用 edit", async () => {
		const { cwd, config } = fixture();
		const transport = new FakeTransport();
		const ops = recordingOps();
		const tool = createLspTool(cwd, { getConfig: () => config, spawn: { spawn: async () => transport }, writeOperations: ops });
		const pending = tool.execute("call-4", { action: "code_actions", file: "a.ts", apply: true, query: "fix" });
		await answerInitialize(transport);
		const request = await waitForRequest(transport, "textDocument/codeAction");
		transport.emitResponse(request.id, [
			{ title: "Fix it", kind: "quickfix", edit: { changes: { "file:///a.ts": [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, newText: "x" }] } } },
		]);
		const result = await pending;
		expect(ops.log.some((entry) => entry.startsWith("write"))).toBe(true);
		expect((result.content[0] as { text: string }).text).toContain("Applied \"Fix it\"");
	});

	it("request 走 query 方法名并透传 payload", async () => {
		const { cwd, config } = fixture();
		const transport = new FakeTransport();
		const tool = createLspTool(cwd, { getConfig: () => config, spawn: { spawn: async () => transport } });
		const pending = tool.execute("call-5", { action: "request", query: "rust-analyzer/analyzerStatus", payload: "{\"textDocument\":null}" });
		await answerInitialize(transport);
		const request = await waitForRequest(transport, "rust-analyzer/analyzerStatus");
		expect(request.params).toEqual({ textDocument: null });
		transport.emitResponse(request.id, { status: "ready" });
		const result = await pending;
		expect((result.content[0] as { text: string }).text).toContain('"status": "ready"');
	});
});
