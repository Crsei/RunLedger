import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createLspTool } from "../../src/lsp/tool.ts";
import { shutdownAll } from "../../src/lsp/client.ts";
import type { LspConfig } from "../../src/lsp/types.ts";
import { FakeTransport } from "./fake-transport.ts";

const SERVER = "fake-lsp";

function fixtureConfig(): { cwd: string; config: LspConfig } {
	const cwd = mkdtempSync(path.join(tmpdir(), "lsp-tool-"));
	writeFileSync(path.join(cwd, "a.ts"), "const a = 1;\n");
	return {
		cwd,
		config: { servers: { [SERVER]: { command: SERVER, fileTypes: [".ts"], rootMarkers: ["a.ts"], resolvedCommand: SERVER } } },
	};
}

const made: string[] = [];
afterEach(async () => {
	await shutdownAll();
	for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function answerInitialize(transport: FakeTransport): Promise<void> {
	for (let i = 0; i < 50; i += 1) {
		await new Promise((resolve) => setTimeout(resolve, 0));
		const init = transport.lastRequest("initialize");
		if (init) {
			transport.emitResponse(init.id, { capabilities: { hoverProvider: true, definitionProvider: true } });
			transport.emitNotification("$/progress", { token: "ready", value: { kind: "end" } });
			return;
		}
	}
		throw new Error("initialize request was not emitted");
}

async function waitForRequest(transport: FakeTransport, method: string): Promise<ReturnType<FakeTransport["lastRequest"]>> {
	for (let i = 0; i < 50; i += 1) {
		const request = transport.lastRequest(method);
		if (request !== undefined) return request;
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
	throw new Error(`request was not emitted: ${method}`);
}

describe("createLspTool 只读动作", () => {
	it("diagnostics 打开文件并聚合 publishDiagnostics 缓存", async () => {
		const { cwd, config } = fixtureConfig();
		made.push(cwd);
		const transport = new FakeTransport();
		const tool = createLspTool(cwd, { getConfig: () => config, spawn: { spawn: async () => transport } });
		const pending = tool.execute("call-1", { action: "diagnostics", file: "a.ts" });
		await answerInitialize(transport);
		transport.emitNotification("textDocument/publishDiagnostics", {
			uri: new URL(`file://${path.join(cwd, "a.ts")}`).href,
			diagnostics: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, severity: 1, message: "boom" }],
		});
		const result = await pending;
		expect(result.content[0]).toMatchObject({ type: "text" });
		expect((result.content[0] as { text: string }).text).toContain("[error] boom");
	});

	it("diagnostics 等待 refresh 后的新 publishDiagnostics", async () => {
		const { cwd, config } = fixtureConfig();
		made.push(cwd);
		const transport = new FakeTransport();
		const tool = createLspTool(cwd, { getConfig: () => config, spawn: { spawn: async () => transport } });
		const pending = tool.execute("call-fresh-diagnostics", { action: "diagnostics", file: "a.ts" });
		await answerInitialize(transport);
		const uri = new URL(`file://${path.join(cwd, "a.ts")}`).href;
		transport.emitNotification("textDocument/publishDiagnostics", {
			uri,
			diagnostics: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, message: "stale" }],
		});
		for (let index = 0; index < 50 && transport.lastRequest("textDocument/didSave") === undefined; index += 1) {
			await new Promise((resolve) => setTimeout(resolve, 0));
		}
		setTimeout(() => transport.emitNotification("textDocument/publishDiagnostics", {
			uri,
			version: 2,
			diagnostics: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, message: "fresh" }],
		}), 5);
		const result = await pending;
		const text = (result.content[0] as { text: string }).text;
		expect(text).toContain("fresh");
		expect(text).not.toContain("stale");
	});

	it("definition 返回位置列表", async () => {
		const { cwd, config } = fixtureConfig();
		made.push(cwd);
		const transport = new FakeTransport();
		const tool = createLspTool(cwd, { getConfig: () => config, spawn: { spawn: async () => transport } });
		const pending = tool.execute("call-2", { action: "definition", file: "a.ts", line: 1, symbol: "a" });
		await answerInitialize(transport);
		const request = await waitForRequest(transport, "textDocument/definition");
		transport.emitResponse(request.id, [{ uri: "file:///other.ts", range: { start: { line: 2, character: 0 }, end: { line: 2, character: 1 } } }]);
		const result = await pending;
		expect((result.content[0] as { text: string }).text).toContain("Found 1 definition");
	});

	it("definition 的 didOpen 与符号定位都使用 injected governed read", async () => {
		const { cwd, config } = fixtureConfig();
		made.push(cwd);
		rmSync(path.join(cwd, "a.ts"));
		const transport = new FakeTransport();
		let reads = 0;
		const tool = createLspTool(cwd, {
			getConfig: () => config,
			spawn: { spawn: async () => transport },
			writeOperations: {
				readFile: async () => { reads += 1; return "const governed = 1;\n"; },
				writeFile: async () => undefined,
				createDirectory: async () => undefined,
				renameFile: async () => undefined,
				deleteFile: async () => undefined,
			},
		});
		const pending = tool.execute("call-governed-read", { action: "definition", file: "a.ts", line: 1, symbol: "governed" });
		await answerInitialize(transport);
		const request = await waitForRequest(transport, "textDocument/definition");
		expect(request?.params).toMatchObject({ position: { line: 0, character: 6 } });
		transport.emitResponse(request!.id, []);
		await pending;
		expect(reads).toBeGreaterThanOrEqual(2);
	});

	it("definition 给行号不给 symbol 报错", async () => {
		const { cwd, config } = fixtureConfig();
		made.push(cwd);
		const transport = new FakeTransport();
		const tool = createLspTool(cwd, { getConfig: () => config, spawn: { spawn: async () => transport } });
		const pending = tool.execute("call-3", { action: "definition", file: "a.ts", line: 1 });
		await answerInitialize(transport);
		const result = await pending;
		expect((result.content[0] as { text: string }).text).toContain("symbol parameter required");
	});

	it("status 列出配置服务与未启动状态", async () => {
		const { cwd, config } = fixtureConfig();
		made.push(cwd);
		const tool = createLspTool(cwd, { getConfig: () => config, spawn: { spawn: async () => new FakeTransport() } });
		const result = await tool.execute("call-4", { action: "status" });
		expect((result.content[0] as { text: string }).text).toContain("fake-lsp (configured, not started)");
	});

	it("把 Session scope 传给 client cache，避免同 cwd 跨会话复用", async () => {
		const { cwd, config } = fixtureConfig();
		made.push(cwd);
		const firstTransport = new FakeTransport();
		const secondTransport = new FakeTransport();
		const firstTool = createLspTool(cwd, {
			getConfig: () => config,
			spawn: { spawn: async () => firstTransport },
			scope: "session-a",
		});
		const secondTool = createLspTool(cwd, {
			getConfig: () => config,
			spawn: { spawn: async () => secondTransport },
			scope: "session-b",
		});
		const first = firstTool.execute("call-scope-a", { action: "capabilities", file: "a.ts" });
		const second = secondTool.execute("call-scope-b", { action: "capabilities", file: "a.ts" });
		await new Promise((resolve) => setTimeout(resolve, 0));
		const firstInitialize = firstTransport.lastRequest("initialize");
		const secondInitialize = secondTransport.lastRequest("initialize");
		expect(firstInitialize).toBeDefined();
		expect(secondInitialize).toBeDefined();
		if (firstInitialize === undefined || secondInitialize === undefined) return;
		firstTransport.emitResponse(firstInitialize.id, { capabilities: {} });
		secondTransport.emitResponse(secondInitialize.id, { capabilities: {} });
		await Promise.all([first, second]);
	});

	it("无匹配服务时返回错误文本且 details.success=false", async () => {
		const { cwd } = fixtureConfig();
		made.push(cwd);
		const tool = createLspTool(cwd, { getConfig: () => ({ servers: {} }), spawn: { spawn: async () => new FakeTransport() } });
		const result = await tool.execute("call-5", { action: "diagnostics", file: "a.ts" });
		expect(result.details).toMatchObject({ action: "diagnostics", success: false });
	});

	it("diagnostics 聚合配置注入的 LinterClient", async () => {
		const { cwd } = fixtureConfig();
		made.push(cwd);
		const config: LspConfig = {
			servers: {
				biome: {
					command: "biome",
					fileTypes: [".ts"],
					rootMarkers: ["a.ts"],
					createClient: () => ({
						lint: async () => [{
							range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
							severity: 2,
							message: "linted",
						}],
					}),
				},
			},
		};
		const tool = createLspTool(cwd, { getConfig: () => config });
		const result = await tool.execute("call-6", { action: "diagnostics", file: "a.ts" });
		expect((result.content[0] as { text: string }).text).toContain("[warning] linted");
	});

	it("params.timeout 秒数覆盖工具默认 timeout", async () => {
		const { cwd } = fixtureConfig();
		made.push(cwd);
		const config: LspConfig = {
			servers: {
				blocked: {
					command: "blocked",
					fileTypes: [".ts"],
					rootMarkers: [],
					createClient: () => ({
						lint: async (_filePath, signal) => new Promise((_, reject) => {
							const onAbort = () => reject(new Error("timed by action parameter"));
							if (signal?.aborted === true) onAbort();
							else signal?.addEventListener("abort", onAbort, { once: true });
						}),
					}),
				},
			},
		};
		const tool = createLspTool(cwd, { getConfig: () => config, timeoutMs: 5_000 });
		const started = Date.now();
		const result = await tool.execute("call-timeout", { action: "diagnostics", file: "a.ts", timeout: 1 });
		expect(Date.now() - started).toBeLessThan(2_000);
		expect((result.content[0] as { text: string }).text).toContain("timed by action parameter");
	});
});
