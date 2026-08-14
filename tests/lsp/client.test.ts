import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CLIENT_CAPABILITIES, getActiveClients, getOrCreateClient, sendRequest, shutdownAll, waitForProjectLoaded } from "../../src/lsp/client.ts";
import type { ServerConfig } from "../../src/lsp/types.ts";
import { FakeTransport } from "./fake-transport.ts";

const config: ServerConfig = {
	command: "fake-lsp",
	fileTypes: [".ts"],
	rootMarkers: ["package.json"],
};

const made: string[] = [];
function project(): string {
	const dir = mkdtempSync(path.join(tmpdir(), "lsp-client-"));
	made.push(dir);
	return dir;
}

afterEach(async () => {
	await shutdownAll();
	for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fakeSpawner(transport: FakeTransport) {
	return {
		spawn: async () => transport,
	};
}

describe("getOrCreateClient", () => {
	it("完成 initialize 握手后 status=ready,并推送 settings", async () => {
		const transport = new FakeTransport();
		const cwd = project();
		const clientPromise = getOrCreateClient(config, cwd, { spawn: fakeSpawner(transport) });
		await new Promise((resolve) => setTimeout(resolve, 0));
		const initRequest = transport.lastRequest("initialize");
		expect(initRequest).toBeDefined();
		transport.emitResponse(initRequest!.id, { capabilities: { hoverProvider: true } });
		const client = await clientPromise;
		expect(client.status).toBe("ready");
		expect(client.serverCapabilities?.hoverProvider).toBe(true);
		expect(transport.sent.some((frame) => frame.includes("workspace/didChangeConfiguration"))).toBe(true);
	});

	it("并发创建同一 key 只 spawn 一次", async () => {
		const transport = new FakeTransport();
		const cwd = project();
		let spawns = 0;
		const spawner = { spawn: async () => { spawns += 1; return transport; } };
		const first = getOrCreateClient(config, cwd, { spawn: spawner });
		const second = getOrCreateClient(config, cwd, { spawn: spawner });
		await new Promise((resolve) => setTimeout(resolve, 0));
		const initRequest = transport.lastRequest("initialize");
		expect(initRequest).toBeDefined();
		transport.emitResponse(initRequest!.id, { capabilities: {} });
		const [a, b] = await Promise.all([first, second]);
		expect(a).toBe(b);
		expect(spawns).toBe(1);
	});

	it("不同 Session scope 不共享 client，关闭一个 scope 不影响另一个", async () => {
		const firstTransport = new FakeTransport();
		const secondTransport = new FakeTransport();
		const cwd = project();
		const first = getOrCreateClient(config, cwd, { spawn: fakeSpawner(firstTransport), scope: "session-a" });
		const second = getOrCreateClient(config, cwd, { spawn: fakeSpawner(secondTransport), scope: "session-b" });
		await new Promise((resolve) => setTimeout(resolve, 0));
		const firstInitialize = firstTransport.lastRequest("initialize");
		const secondInitialize = secondTransport.lastRequest("initialize");
		expect(firstInitialize).toBeDefined();
		expect(secondInitialize).toBeDefined();
		if (firstInitialize === undefined || secondInitialize === undefined) return;
		firstTransport.emitResponse(firstInitialize.id, { capabilities: {} });
		secondTransport.emitResponse(secondInitialize.id, { capabilities: {} });
		await Promise.all([first, second]);

		await shutdownAll("session-a");

		expect(firstTransport.isKilled()).toBe(true);
		expect(secondTransport.isKilled()).toBe(false);
		expect(getActiveClients("session-b")).toHaveLength(1);
	});

	it("shutdown scope 会取消仍在 initialize 的客户端", async () => {
		const transport = new FakeTransport();
		const cwd = project();
		const pending = getOrCreateClient(config, cwd, {
			spawn: fakeSpawner(transport),
			scope: "session-connecting",
			initTimeoutMs: 5_000,
		});
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(transport.lastRequest("initialize")).toBeDefined();
		await shutdownAll("session-connecting");
		expect(transport.isKilled()).toBe(true);
		await expect(pending).rejects.toThrow();
	});

	it("initialize 失败负缓存:第二次调用快速失败", async () => {
		const transport = new FakeTransport();
		const cwd = project();
		const init = getOrCreateClient(config, cwd, { spawn: fakeSpawner(transport), initTimeoutMs: 200 });
		transport.emitExit(1);
		await expect(init).rejects.toThrow();
		const retry = getOrCreateClient(config, cwd, { spawn: fakeSpawner(transport), initTimeoutMs: 200 });
		await expect(retry).rejects.toThrow(/failed to initialize recently/);
	});

	it("服务端退出 reject 所有 pending 请求", async () => {
		const transport = new FakeTransport();
		const cwd = project();
		const clientPromise = getOrCreateClient(config, cwd, { spawn: fakeSpawner(transport) });
		await new Promise((resolve) => setTimeout(resolve, 0));
		transport.emitResponse(transport.lastRequest("initialize")!.id, { capabilities: {} });
		const client = await clientPromise;
		const pending = sendRequest(client, "textDocument/hover", {});
		transport.emitExit(9);
		await expect(pending).rejects.toThrow(/exited/);
	});

	it("publishDiagnostics 通知进入诊断缓存", async () => {
		const transport = new FakeTransport();
		const cwd = project();
		const clientPromise = getOrCreateClient(config, cwd, { spawn: fakeSpawner(transport) });
		await new Promise((resolve) => setTimeout(resolve, 0));
		transport.emitResponse(transport.lastRequest("initialize")!.id, { capabilities: {} });
		const client = await clientPromise;
		transport.emitNotification("textDocument/publishDiagnostics", {
			uri: "file:///a.ts",
			diagnostics: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, message: "bad" }],
		});
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(client.diagnostics.get("file:///a.ts")?.diagnostics[0]?.message).toBe("bad");
	});

	it("rust-analyzer 客户端在项目加载后轮询 analyzerStatus 至 ready", async () => {
		const transport = new FakeTransport();
		const cwd = project();
		const rustConfig: ServerConfig = { ...config, command: "rust-analyzer" };
		const clientPromise = getOrCreateClient(rustConfig, cwd, { spawn: fakeSpawner(transport) });
		await new Promise((resolve) => setTimeout(resolve, 0));
		const initialize = transport.lastRequest("initialize");
		expect(initialize).toBeDefined();
		transport.emitResponse(initialize!.id, { capabilities: {} });
		const client = await clientPromise;
		const waiting = waitForProjectLoaded(client);
		transport.emitNotification("$/progress", { token: "t", value: { kind: "end" } });
		const statusRequest = await (async () => {
			for (let i = 0; i < 50; i += 1) {
				const request = transport.lastRequest("rust-analyzer/analyzerStatus");
				if (request !== undefined) return request;
				await new Promise((resolve) => setTimeout(resolve, 0));
			}
			return undefined;
		})();
		expect(statusRequest).toBeDefined();
		transport.emitResponse(statusRequest!.id, { status: "ready" });
		await waiting;
	});

	it("只在 progress end 时标记项目加载完成", async () => {
		const transport = new FakeTransport();
		const cwd = project();
		const clientPromise = getOrCreateClient(config, cwd, { spawn: fakeSpawner(transport) });
		await new Promise((resolve) => setTimeout(resolve, 0));
		transport.emitResponse(transport.lastRequest("initialize")!.id, { capabilities: {} });
		const client = await clientPromise;
		let loaded = false;
		void client.projectLoaded.then(() => { loaded = true; });
		transport.emitNotification("$/progress", { token: "load", value: { kind: "begin" } });
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(loaded).toBe(false);
		transport.emitNotification("$/progress", { token: "load", value: { kind: "end" } });
		await client.projectLoaded;
		expect(loaded).toBe(true);
	});

	it("按 configuration items 返回对齐数组并接受 workDoneProgress/create", async () => {
		const transport = new FakeTransport();
		const cwd = project();
		const configured: ServerConfig = { ...config, settings: { rust: { cargo: { features: "all" } }, plain: true } };
		const clientPromise = getOrCreateClient(configured, cwd, { spawn: fakeSpawner(transport) });
		await new Promise((resolve) => setTimeout(resolve, 0));
		transport.emitResponse(transport.lastRequest("initialize")!.id, { capabilities: {} });
		await clientPromise;
		transport.emitRequest("workspace/configuration", { items: [{ section: "rust.cargo" }, { section: "missing" }, { section: "plain" }] }, "cfg-1");
		transport.emitRequest("window/workDoneProgress/create", { token: "load" }, "progress-1");
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(transport.responseFor("cfg-1")?.result).toEqual([{ features: "all" }, null, true]);
		expect(transport.responseFor("progress-1")?.result).toBeNull();
	});

	it("不宣称未实现的 applyEdit 与事务性 WorkspaceEdit", () => {
		expect(CLIENT_CAPABILITIES.workspace.applyEdit).toBe(false);
		expect(CLIENT_CAPABILITIES.workspace.workspaceEdit).not.toHaveProperty("failureHandling");
	});
});
