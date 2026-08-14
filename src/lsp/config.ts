/**
 * LSP 配置层 —— 从 pi coding-agent `src/lsp/config.ts` 适配。
 *
 * 当前版本权威裁剪:
 *   - 只读 `<cwd>/lsp.json` 与 `<cwd>/.lsp.json`(JSON only),无 YAML/用户级/插件级;
 *   - 覆盖为浅合并:同名服务的高层字段整体替换(settings/initOptions 替换而非深合并);
 *   - 自动探测按 rootMarkers + 二进制解析从 defaults 筛选;合并结果再筛 rootMarkers、二进制与 disabled。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import defaults from "./defaults.json" with { type: "json" };
import { BiomeClient } from "./clients/biome-client.ts";
import { SwiftLintClient } from "./clients/swiftlint-client.ts";
import type { LinterClientFactory, ServerCapabilities, ServerConfig, LspConfig, WorkspaceReadyTimings } from "./types.ts";

export interface LspConfigLoadOptions {
	/** 测试注入:返回文件文本;缺省读 node:fs。 */
	readFile?: (filePath: string) => string | null;
	linterFactories?: Partial<Record<"biome" | "swiftlint", LinterClientFactory>>;
}

const LOCAL_BIN_PATHS: Array<{ markers: string[]; binDir: string }> = [
	{ markers: ["package.json"], binDir: "node_modules/.bin" },
	{ markers: ["pyproject.toml", "requirements.txt"], binDir: ".venv/bin" },
	{ markers: ["pyproject.toml", "requirements.txt"], binDir: "venv/bin" },
	{ markers: ["go.mod"], binDir: "bin" },
];

type ServerConfigPatch = Partial<ServerConfig>;

interface NormalizedConfig {
	servers: Record<string, ServerConfigPatch>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toStringArray(value: unknown): string[] | null {
	if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) return null;
	return value.map((item) => String(item));
}

function toCapabilities(value: unknown): ServerCapabilities | undefined {
	if (!isRecord(value)) return undefined;
	const capabilities: ServerCapabilities = {};
	for (const key of ["flycheck", "ssr", "expandMacro", "runnables", "relatedTests"] as const) {
		if (typeof value[key] === "boolean") capabilities[key] = value[key];
	}
	return capabilities;
}

function toWorkspaceReadyTimings(value: unknown): WorkspaceReadyTimings | undefined {
	if (!isRecord(value)) return undefined;
	const timings: WorkspaceReadyTimings = {};
	for (const key of ["timeoutMs", "pollMs", "settleMs", "statusRequestTimeoutMs"] as const) {
		if (typeof value[key] === "number" && Number.isFinite(value[key])) timings[key] = value[key];
	}
	return timings;
}

/** 只保留已知字段;部分 patch 允许覆盖内建服务,完整性在最终合并后验证。 */
function normalizeServerPatch(name: string, raw: Record<string, unknown>): ServerConfigPatch | null {
	const patch: ServerConfigPatch = {};
	if (raw.command !== undefined) {
		if (typeof raw.command !== "string" || raw.command.length === 0) return null;
		patch.command = raw.command;
	}
	for (const key of ["fileTypes", "rootMarkers"] as const) {
		if (raw[key] === undefined) continue;
		const values = toStringArray(raw[key]);
		if (values === null) return null;
		patch[key] = values;
	}
	if (raw.args !== undefined) {
		const values = toStringArray(raw.args);
		if (values === null) return null;
		patch.args = values;
	}
	if (raw.languageId !== undefined) {
		if (typeof raw.languageId !== "string") return null;
		patch.languageId = raw.languageId;
	}
	if (raw.initOptions !== undefined) {
		if (!isRecord(raw.initOptions)) return null;
		patch.initOptions = raw.initOptions;
	}
	if (raw.settings !== undefined) {
		if (!isRecord(raw.settings)) return null;
		patch.settings = raw.settings;
	}
	if (raw.disabled !== undefined) {
		if (typeof raw.disabled !== "boolean") return null;
		patch.disabled = raw.disabled;
	}
	if (raw.warmupTimeoutMs !== undefined) {
		if (typeof raw.warmupTimeoutMs !== "number" || !Number.isFinite(raw.warmupTimeoutMs)) return null;
		patch.warmupTimeoutMs = raw.warmupTimeoutMs;
	}
	if (raw.workspaceReadyTimings !== undefined) {
		const timings = toWorkspaceReadyTimings(raw.workspaceReadyTimings);
		if (timings === undefined) return null;
		patch.workspaceReadyTimings = timings;
	}
	if (raw.capabilities !== undefined) {
		const capabilities = toCapabilities(raw.capabilities);
		if (capabilities === undefined) return null;
		patch.capabilities = capabilities;
	}
	if (raw.isLinter !== undefined) {
		if (typeof raw.isLinter !== "boolean") return null;
		patch.isLinter = raw.isLinter;
	}
	return patch;
}

function completeServerConfig(name: string, patch: ServerConfigPatch): ServerConfig | null {
	if (typeof patch.command !== "string" || patch.command.length === 0) return null;
	if (!Array.isArray(patch.fileTypes) || !Array.isArray(patch.rootMarkers)) return null;
	const config: ServerConfig = {
		command: patch.command,
		fileTypes: [...patch.fileTypes],
		rootMarkers: [...patch.rootMarkers],
	};
	if (patch.args !== undefined) config.args = [...patch.args];
	if (patch.languageId !== undefined) config.languageId = patch.languageId;
	if (patch.initOptions !== undefined) config.initOptions = patch.initOptions;
	if (patch.settings !== undefined) config.settings = patch.settings;
	if (patch.disabled !== undefined) config.disabled = patch.disabled;
	if (patch.warmupTimeoutMs !== undefined) config.warmupTimeoutMs = patch.warmupTimeoutMs;
	if (patch.workspaceReadyTimings !== undefined) config.workspaceReadyTimings = patch.workspaceReadyTimings;
	if (patch.capabilities !== undefined) config.capabilities = patch.capabilities;
	if (patch.isLinter !== undefined) config.isLinter = patch.isLinter;
	return config;
}

export function hasRootMarkers(cwd: string, markers: string[]): boolean {
	let entries: string[] | undefined;
	for (const marker of markers) {
		if (marker.startsWith("*.")) {
			entries ??= (() => {
				try { return fs.readdirSync(cwd); } catch { return []; }
			})();
			if (entries.some((entry) => entry.endsWith(marker.slice(1)))) return true;
			continue;
		}
		if (fs.existsSync(path.join(cwd, marker))) return true;
	}
	return false;
}

export function resolveCommand(command: string, cwd: string): string | null {
	if (command.includes(path.sep) && fs.existsSync(command)) return path.resolve(command);
	for (const { markers, binDir } of LOCAL_BIN_PATHS) {
		if (!hasRootMarkers(cwd, markers)) continue;
		const candidate = path.join(cwd, binDir, command);
		if (fs.existsSync(candidate)) return candidate;
	}
	const pathDirs = (process.env.PATH ?? "").split(path.delimiter).filter((dir) => dir.length > 0);
	for (const dir of pathDirs) {
		const candidate = path.join(dir, command);
		if (fs.existsSync(candidate)) return candidate;
	}
	return null;
}

function parseConfigContent(content: string): NormalizedConfig | null {
	try {
		const parsed: unknown = JSON.parse(content);
		if (!isRecord(parsed)) return null;
		const rawServers = isRecord(parsed.servers) ? parsed.servers : parsed;
		const servers: Record<string, ServerConfigPatch> = {};
		for (const [name, raw] of Object.entries(rawServers)) {
			if (!isRecord(raw)) continue;
			const normalized = normalizeServerPatch(name, raw);
			if (normalized !== null) servers[name] = normalized;
		}
		return { servers };
	} catch {
		return null;
	}
}

/** 浅合并:override 的字段整体替换 base 同名字段。 */
function mergeServers(
	base: Record<string, ServerConfigPatch>,
	overrides: Record<string, ServerConfigPatch>,
): Record<string, ServerConfigPatch> {
	const merged: Record<string, ServerConfigPatch> = { ...base };
	for (const [name, override] of Object.entries(overrides)) {
		merged[name] = { ...merged[name], ...override };
	}
	return merged;
}

function readConfigFiles(cwd: string, readFile: (filePath: string) => string | null): NormalizedConfig[] {
	const configs: NormalizedConfig[] = [];
	for (const fileName of ["lsp.json", ".lsp.json"]) {
		const content = readFile(path.join(cwd, fileName));
		if (content === null) continue;
		const parsed = parseConfigContent(content);
		if (parsed !== null) configs.push(parsed);
	}
	return configs;
}

export function loadConfig(cwd: string, options: LspConfigLoadOptions = {}): LspConfig {
	const readFile = options.readFile ?? ((filePath: string) => {
		try { return fs.readFileSync(filePath, "utf8"); } catch { return null; }
	});
	const overrides = readConfigFiles(cwd, readFile);
	let servers: Record<string, ServerConfigPatch> = {
		...(defaults as Record<string, ServerConfig>),
	};
	for (const override of overrides) servers = mergeServers(servers, override.servers);
	const filtered: Record<string, ServerConfig> = {};
	for (const [name, patch] of Object.entries(servers)) {
		const config = completeServerConfig(name, patch);
		if (config === null || config.disabled === true) continue;
		if (!hasRootMarkers(cwd, config.rootMarkers)) continue;
		const resolved = resolveCommand(config.command, cwd);
		if (resolved === null) continue;
		filtered[name] = { ...config, resolvedCommand: resolved };
	}
	// 运行时工厂注入:CLI 适配客户端不可由配置文件构造。
	if (filtered.biome !== undefined) filtered.biome = { ...filtered.biome, createClient: options.linterFactories?.biome ?? BiomeClient.create };
	if (filtered.swiftlint !== undefined) filtered.swiftlint = { ...filtered.swiftlint, createClient: options.linterFactories?.swiftlint ?? SwiftLintClient.create };
	return { servers: filtered };
}

/** 按扩展名/精确 basename 匹配;主服务排在 linter 之前。 */
export function getServersForFile(config: LspConfig, filePath: string): Array<[string, ServerConfig]> {
	const basename = path.basename(filePath);
	const extension = path.extname(filePath);
	const matches: Array<[string, ServerConfig]> = [];
	for (const [name, server] of Object.entries(config.servers)) {
		if (server.fileTypes.includes(extension) || server.fileTypes.includes(basename)) matches.push([name, server]);
	}
	return matches.sort((left, right) => Number(left[1].isLinter === true) - Number(right[1].isLinter === true));
}

export function getServerForFile(config: LspConfig, filePath: string): [string, ServerConfig] | null {
	return getServersForFile(config, filePath)[0] ?? null;
}

export function hasCapability(config: ServerConfig, capability: keyof NonNullable<ServerConfig["capabilities"]>): boolean {
	return config.capabilities?.[capability] === true;
}
