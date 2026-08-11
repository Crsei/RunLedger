/** Codex 等价的 filesystem 条目合同与纯访问解析。 */

import { posix as posixPath, win32 as win32Path } from "node:path";
import type { WorkspacePlatform } from "../../workspace/types.ts";

export type FileSystemAccess = "read" | "write" | "deny";

export type FileSystemSpecialPath =
	| ":root"
	| ":minimal"
	| ":workspace"
	| ":workspace_roots"
	| `:workspace_roots/${string}`
	| ":tmp"
	| ":runledger-temp"
	| ":tmpdir"
	| ":slash_tmp"
	| `:${string}`;

export type FileSystemPathEntry =
	| { readonly kind: "path"; readonly path: string }
	| { readonly kind: "glob"; readonly pattern: string }
	| { readonly kind: "special"; readonly value: FileSystemSpecialPath };

export interface FileSystemPolicyEntry {
	readonly path: FileSystemPathEntry;
	readonly access: FileSystemAccess;
}

export interface CompiledFilesystemPolicy {
	readonly kind: "restricted" | "unrestricted";
	readonly globScanMaxDepth?: number;
	readonly entries: readonly FileSystemPolicyEntry[];
}

export interface ResolveFilesystemAccessInput {
	readonly path: string;
	readonly cwd: string;
	readonly platform: WorkspacePlatform;
	/** 调用方完成路径解析后提供 lexical/canonical 两种候选拼写。 */
	readonly candidatePaths?: readonly string[];
}

const ENTRY_ACCESS_PRECEDENCE: Readonly<Record<FileSystemAccess, number>> = {
	read: 0,
	write: 1,
	deny: 2,
};

const CANDIDATE_RESTRICTION: Readonly<Record<FileSystemAccess, number>> = {
	write: 0,
	read: 1,
	deny: 2,
};

function pathApi(platform: WorkspacePlatform): typeof posixPath | typeof win32Path {
	return platform === "windows" ? win32Path : posixPath;
}

function absoluteCandidate(path: string, cwd: string, platform: WorkspacePlatform): string | undefined {
	if (path.length === 0 || path.includes("\0")) return undefined;
	const api = pathApi(platform);
	if (!api.isAbsolute(cwd)) return undefined;
	return api.normalize(api.isAbsolute(path) ? path : api.resolve(cwd, path));
}

function comparisonKey(path: string, platform: WorkspacePlatform): string {
	return platform === "windows" ? path.toLowerCase() : path;
}

function containsPath(root: string, target: string, platform: WorkspacePlatform): boolean {
	const api = pathApi(platform);
	const offset = api.relative(root, target);
	return offset === "" || (!offset.startsWith(`..${api.sep}`) && offset !== ".." && !api.isAbsolute(offset));
}

function pathSpecificity(path: string, platform: WorkspacePlatform): number {
	return path.split(pathApi(platform).sep).filter((segment) => segment.length > 0).length;
}

function accessForCandidate(
	policy: CompiledFilesystemPolicy,
	target: string,
	platform: WorkspacePlatform,
): FileSystemAccess {
	let selected: { readonly specificity: number; readonly access: FileSystemAccess } | undefined;
	for (const entry of policy.entries) {
		if (entry.path.kind !== "path") continue;
		const normalizedEntry = absoluteCandidate(entry.path.path, entry.path.path, platform);
		if (normalizedEntry === undefined || !containsPath(normalizedEntry, target, platform)) continue;
		const candidate = { specificity: pathSpecificity(normalizedEntry, platform), access: entry.access };
		if (selected === undefined || candidate.specificity > selected.specificity ||
			(candidate.specificity === selected.specificity && ENTRY_ACCESS_PRECEDENCE[candidate.access] >= ENTRY_ACCESS_PRECEDENCE[selected.access])) {
			selected = candidate;
		}
	}
	return selected?.access ?? "deny";
}

/**
 * 最具体路径优先；同一目标按 deny > write > read 决胜。
 * 多个 lexical/canonical 候选按最小权限合并。
 */
export function resolveFilesystemAccess(
	policy: CompiledFilesystemPolicy,
	input: ResolveFilesystemAccessInput,
): FileSystemAccess {
	if (policy.kind === "unrestricted") return "write";
	if (policy.entries.some((entry) => entry.access === "deny" && entry.path.kind === "path" &&
		absoluteCandidate(entry.path.path, entry.path.path, input.platform) === undefined)) return "deny";
	const candidates = [input.path, ...(input.candidatePaths ?? [])]
		.map((path) => absoluteCandidate(path, input.cwd, input.platform))
		.filter((path): path is string => path !== undefined);
	if (candidates.length === 0) return "deny";
	const unique = [...new Map(candidates.map((path) => [comparisonKey(path, input.platform), path])).values()];
	return unique
		.map((path) => accessForCandidate(policy, path, input.platform))
		.reduce((mostRestricted, access) => CANDIDATE_RESTRICTION[access] > CANDIDATE_RESTRICTION[mostRestricted] ? access : mostRestricted, "write");
}
