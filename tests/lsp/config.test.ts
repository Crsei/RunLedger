import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getServerForFile, getServersForFile, hasRootMarkers, loadConfig } from "../../src/lsp/config.ts";

function makeProject(): string {
	const dir = mkdtempSync(path.join(tmpdir(), "lsp-config-"));
	writeFileSync(path.join(dir, "package.json"), "{}");
	mkdirSync(path.join(dir, "node_modules/.bin"), { recursive: true });
	writeFileSync(path.join(dir, "node_modules/.bin/typescript-language-server"), "");
	writeFileSync(path.join(dir, "node_modules/.bin/biome"), "");
	return dir;
}

const made: string[] = [];
function project(): string {
	const dir = makeProject();
	made.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("loadConfig", () => {
	it("自动探测:package.json + 本地 bin 命中 typescript-language-server", () => {
		const cwd = project();
		const config = loadConfig(cwd);
		expect(config.servers["typescript-language-server"]).toBeDefined();
		expect(config.servers["typescript-language-server"]?.resolvedCommand).toContain("node_modules/.bin");
		expect(config.servers.gopls).toBeUndefined();
	});

	it("lsp.json 覆盖内建字段且保留未覆盖字段", () => {
		const cwd = project();
		writeFileSync(path.join(cwd, "lsp.json"), JSON.stringify({
			servers: { "typescript-language-server": { args: ["--stdio", "--log-level", "4"] } },
		}));
		const config = loadConfig(cwd);
		const server = config.servers["typescript-language-server"];
		expect(server?.args).toEqual(["--stdio", "--log-level", "4"]);
		expect(server?.fileTypes).toContain(".ts");
	});

	it("新服务要求三字段齐全,缺失被忽略", () => {
		const cwd = project();
		writeFileSync(path.join(cwd, "lsp.json"), JSON.stringify({
			servers: { broken: { command: "broken-lsp" } },
		}));
		const config = loadConfig(cwd);
		expect(config.servers.broken).toBeUndefined();
		expect(config.servers["typescript-language-server"]).toBeDefined();
	});

	it("disabled 覆盖后不进入结果", () => {
		const cwd = project();
		writeFileSync(path.join(cwd, "lsp.json"), JSON.stringify({
			servers: { "typescript-language-server": { disabled: true } },
		}));
		const config = loadConfig(cwd);
		expect(config.servers["typescript-language-server"]).toBeUndefined();
	});

	it("读取失败(注入 readFile 返回 null)时静默忽略该源", () => {
		const cwd = project();
		const config = loadConfig(cwd, { readFile: () => null });
		expect(config.servers["typescript-language-server"]).toBeDefined();
	});
});

describe("hasRootMarkers", () => {
	it("通配 marker 只匹配直接子项", () => {
		const cwd = project();
		writeFileSync(path.join(cwd, "Cargo.toml"), "");
		expect(hasRootMarkers(cwd, ["*.toml"])).toBe(true);
		expect(hasRootMarkers(cwd, ["go.mod"])).toBe(false);
	});
});

describe("getServersForFile", () => {
	it("扩展名路由,主服务排在 linter 前", () => {
		const cwd = project();
		writeFileSync(path.join(cwd, "biome.json"), "{}");
		const config = loadConfig(cwd);
		const servers = getServersForFile(config, "src/a.ts");
		expect(servers.map(([name]) => name)[0]).toBe("typescript-language-server");
		expect(servers.map(([name]) => name)).toContain("biome");
		expect(getServerForFile(config, "src/a.ts")?.[0]).toBe("typescript-language-server");
	});
});
