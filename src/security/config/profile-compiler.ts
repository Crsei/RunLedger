/** Codex 风格 filesystem JSON 条目的纯 permission profile 编译器。 */

import { posix as posixPath, win32 as win32Path } from "node:path";
import type { WorkspacePlatform } from "../../workspace/types.ts";
import type { SecurityResult } from "../types.ts";
import type {
	CompiledFilesystemPolicy,
	FileSystemAccess,
	FileSystemPolicyEntry,
} from "../permission/filesystem-entries.ts";

export interface FilesystemProfileSourceEntry {
	readonly path: string;
	readonly access: FileSystemAccess;
}

export interface FilesystemProfileSource {
	readonly kind: "restricted" | "unrestricted";
	readonly globScanMaxDepth?: number;
	readonly entries: readonly FilesystemProfileSourceEntry[];
}

export interface CompileFilesystemProfileOptions {
	readonly platform: WorkspacePlatform;
	readonly workspaceRoots: readonly string[];
	readonly tempRoot: string;
	readonly minimalRoots: readonly string[];
}

export interface FilesystemProfileCompilation {
	readonly policy: CompiledFilesystemPolicy;
	readonly warnings: readonly string[];
}

function failure(message: string): SecurityResult<never> {
	return { ok: false, error: { code: "invalid_config", message, retryable: false } };
}

function pathApi(platform: WorkspacePlatform): typeof posixPath | typeof win32Path {
	return platform === "windows" ? win32Path : posixPath;
}

function containsGlob(path: string): boolean {
	return /[*?\[\]]/u.test(path);
}

function validRelativeSubpath(path: string, platform: WorkspacePlatform): boolean {
	const api = pathApi(platform);
	if (path.length === 0 || api.isAbsolute(path) || path.includes("\0")) return false;
	return !path.split(/[\\/]/u).some((segment) => segment === "..");
}

function normalizeAbsolute(path: string, platform: WorkspacePlatform): string | undefined {
	const api = pathApi(platform);
	if (path.length === 0 || path.includes("\0") || !api.isAbsolute(path)) return undefined;
	return api.normalize(path);
}

function expandSpecialPath(
	path: string,
	access: FileSystemAccess,
	options: CompileFilesystemProfileOptions,
	warnings: string[],
): SecurityResult<readonly string[]> {
	const api = pathApi(options.platform);
	if (path === ":root") {
		const anchor = options.workspaceRoots[0] ?? options.tempRoot;
		const normalized = normalizeAbsolute(anchor, options.platform);
		return normalized === undefined ? failure(":root requires an absolute workspace or temp root") : { ok: true, value: [api.parse(normalized).root] };
	}
	if (path === ":minimal") {
		if (options.minimalRoots.length === 0) return failure(":minimal requires at least one injected runtime root");
		return { ok: true, value: options.minimalRoots };
	}
	if (path === ":workspace") {
		const workspaceRoot = options.workspaceRoots[0];
		return workspaceRoot === undefined ? failure(":workspace requires an injected workspace root") : { ok: true, value: [workspaceRoot] };
	}
	if (path === ":workspace_roots") {
		return options.workspaceRoots.length === 0 ? failure(":workspace_roots requires at least one injected workspace root") : { ok: true, value: options.workspaceRoots };
	}
	if (path.startsWith(":workspace_roots/")) {
		const subpath = path.slice(":workspace_roots/".length);
		if (!validRelativeSubpath(subpath, options.platform)) return failure(`invalid :workspace_roots subpath: ${subpath}`);
		if (options.workspaceRoots.length === 0) return failure(":workspace_roots requires at least one injected workspace root");
		return { ok: true, value: options.workspaceRoots.map((root) => api.join(root, subpath)) };
	}
	if (path === ":tmp" || path === ":runledger-temp" || path === ":tmpdir") return { ok: true, value: [options.tempRoot] };
	if (path === ":slash_tmp") {
		return options.platform === "linux" ? { ok: true, value: ["/tmp"] } : failure(":slash_tmp is only supported on Linux");
	}
	if (path.startsWith(":")) {
		if (access === "deny") return failure(`unknown deny path token: ${path}`);
		warnings.push(`unknown filesystem path token ignored: ${path}`);
		return { ok: true, value: [] };
	}
	return { ok: true, value: [path] };
}

function compilePath(path: string, access: FileSystemAccess, platform: WorkspacePlatform): SecurityResult<FileSystemPolicyEntry> {
	let candidate = path;
	if (access !== "deny" && candidate.endsWith("/**")) candidate = candidate.slice(0, -3);
	const hasGlob = containsGlob(candidate);
	if (hasGlob && access !== "deny") return failure(`filesystem glob path only supports deny access: ${path}`);
	const normalized = normalizeAbsolute(candidate, platform);
	if (normalized === undefined) return failure(`filesystem path must be absolute after expansion: ${path}`);
	return hasGlob
		? { ok: true, value: { path: { kind: "glob", pattern: normalized }, access } }
		: { ok: true, value: { path: { kind: "path", path: normalized }, access } };
}

export function compileFilesystemProfile(
	source: FilesystemProfileSource,
	options: CompileFilesystemProfileOptions,
): SecurityResult<FilesystemProfileCompilation> {
	if (source.globScanMaxDepth !== undefined && (!Number.isSafeInteger(source.globScanMaxDepth) || source.globScanMaxDepth < 1)) {
		return failure("globScanMaxDepth must be a positive integer");
	}
	const warnings: string[] = [];
	const entries: FileSystemPolicyEntry[] = [];
	for (const sourceEntry of source.entries) {
		const expanded = expandSpecialPath(sourceEntry.path, sourceEntry.access, options, warnings);
		if (!expanded.ok) return expanded;
		for (const path of expanded.value) {
			const compiled = compilePath(path, sourceEntry.access, options.platform);
			if (!compiled.ok) return compiled;
			entries.push(compiled.value);
		}
	}
	const policy: CompiledFilesystemPolicy = source.globScanMaxDepth === undefined
		? { kind: source.kind, entries }
		: { kind: source.kind, globScanMaxDepth: source.globScanMaxDepth, entries };
	return { ok: true, value: { policy, warnings } };
}
