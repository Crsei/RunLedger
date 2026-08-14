import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BiomeClient } from "../../src/lsp/clients/biome-client.ts";
import { clearLinterClientCache, getLinterClient } from "../../src/lsp/clients/index.ts";
import { LspLinterClient } from "../../src/lsp/clients/lsp-linter-client.ts";
import { SwiftLintClient } from "../../src/lsp/clients/swiftlint-client.ts";
import type { ServerConfig } from "../../src/lsp/types.ts";

const made: string[] = [];
afterEach(() => {
	clearLinterClientCache();
	for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const config: ServerConfig = { command: "biome", fileTypes: [".ts"], rootMarkers: [] };

describe("BiomeClient", () => {
	it("把 biome JSON 字节偏移换算为 LSP 位置", async () => {
		const cwd = mkdtempSync(path.join(tmpdir(), "lsp-biome-"));
		made.push(cwd);
		const filePath = path.join(cwd, "a.ts");
		writeFileSync(filePath, "xa\n");
		const client = new BiomeClient(config, cwd, {
			run: async () => ({
				stdout: JSON.stringify({ diagnostics: [{ severity: "error", message: { message: "boom" }, location: { span: [1, 2] } }] }),
				stderr: "", success: false,
			}),
		});
		const diagnostics = await client.lint(filePath);
		expect(diagnostics[0]).toMatchObject({
			range: { start: { line: 0, character: 1 }, end: { line: 0, character: 2 } },
			severity: 1,
			message: "boom",
		});
	});

	it("空输出返回空诊断", async () => {
		const cwd = mkdtempSync(path.join(tmpdir(), "lsp-biome-"));
		made.push(cwd);
		const filePath = path.join(cwd, "a.ts");
		writeFileSync(filePath, "x\n");
		const client = new BiomeClient(config, cwd, { run: async () => ({ stdout: "", stderr: "", success: true }) });
		expect(await client.lint(filePath)).toEqual([]);
	});

	it("按 UTF-8 byte span 换算非 ASCII 位置并读取 description", async () => {
		const cwd = mkdtempSync(path.join(tmpdir(), "lsp-biome-"));
		made.push(cwd);
		const filePath = path.join(cwd, "unicode.ts");
		writeFileSync(filePath, "éa\n");
		const client = new BiomeClient(config, cwd, {
			run: async () => ({
				stdout: JSON.stringify({ diagnostics: [{ severity: "warning", description: "unicode issue", location: { span: [2, 3] } }] }),
				stderr: "", success: false,
			}),
		});
		const diagnostics = await client.lint(filePath);
		expect(diagnostics[0]).toMatchObject({
			range: { start: { line: 0, character: 1 }, end: { line: 0, character: 2 } },
			message: "unicode issue",
		});
	});

	it("把 AbortSignal 传给 runner 且无效 JSON 显式失败", async () => {
		const cwd = mkdtempSync(path.join(tmpdir(), "lsp-biome-"));
		made.push(cwd);
		const filePath = path.join(cwd, "a.ts");
		writeFileSync(filePath, "x\n");
		const controller = new AbortController();
		const client = new BiomeClient(config, cwd, {
			run: async (_args, _cwd, _command, signal) => {
				expect(signal).toBe(controller.signal);
				return { stdout: "not-json", stderr: "parse failed", success: false };
			},
		});
		await expect(client.lint(filePath, controller.signal)).rejects.toThrow(/invalid JSON/);
	});
});

describe("SwiftLintClient", () => {
	it("1 起始行列换算为 0 起始 LSP 位置", async () => {
		const client = new SwiftLintClient(config, "/tmp", {
			run: async () => ({ stdout: JSON.stringify([{ line: 3, character: 5, severity: "Warning", reason: "no" }]), stderr: "", success: true }),
		});
		const diagnostics = await client.lint("/tmp/a.swift");
		expect(diagnostics[0]?.range.start).toEqual({ line: 2, character: 4 });
		expect(diagnostics[0]?.severity).toBe(2);
	});

	it("把 AbortSignal 传给 runner 且启动失败显式报错", async () => {
		const controller = new AbortController();
		const client = new SwiftLintClient(config, "/tmp", {
			run: async (_args, _cwd, _command, signal) => {
				expect(signal).toBe(controller.signal);
				return { stdout: "", stderr: "launch failed", success: false };
			},
		});
		await expect(client.lint("/tmp/a.swift", controller.signal)).rejects.toThrow(/launch failed/);
	});
});

describe("getLinterClient", () => {
	it("无 createClient 时回退 LspLinterClient,并按 name:cwd 缓存", () => {
		const plain: ServerConfig = { ...config, command: "eslint" };
		const first = getLinterClient("eslint", plain, "/tmp");
		const second = getLinterClient("eslint", plain, "/tmp");
		expect(first).toBe(second);
		expect(first instanceof LspLinterClient).toBe(true);
	});

	it("不同 Session scope 不共享 linter client", () => {
		const first = getLinterClient("biome", { ...config, createClient: BiomeClient.create }, "/tmp", "session-a");
		const second = getLinterClient("biome", { ...config, createClient: BiomeClient.create }, "/tmp", "session-b");
		expect(first).not.toBe(second);
	});
});
