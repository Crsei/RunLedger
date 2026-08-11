/** exact root 与 deny-only glob 的运行时只读拒绝匹配器。 */

import { posix as posixPath, win32 as win32Path } from "node:path";
import type { WorkspacePlatform } from "../../workspace/types.ts";
import type { SecurityResult } from "../types.ts";
import type { CompiledFilesystemPolicy } from "./filesystem-entries.ts";

export interface ReadDenyMatcherOptions {
	readonly platform: WorkspacePlatform;
}

export interface ReadDenyCheckInput {
	readonly path: string;
	readonly cwd: string;
	readonly candidatePaths?: readonly string[];
}

export interface ReadDenyMatcher {
	isReadDenied(input: ReadDenyCheckInput): boolean;
}

function pathApi(platform: WorkspacePlatform): typeof posixPath | typeof win32Path {
	return platform === "windows" ? win32Path : posixPath;
}

function normalize(path: string, cwd: string, platform: WorkspacePlatform): string | undefined {
	if (path.length === 0 || path.includes("\0")) return undefined;
	const api = pathApi(platform);
	if (!api.isAbsolute(cwd)) return undefined;
	const normalized = api.normalize(api.isAbsolute(path) ? path : api.resolve(cwd, path));
	return platform === "windows" ? normalized.toLowerCase() : normalized;
}

function contains(root: string, target: string, platform: WorkspacePlatform): boolean {
	const api = pathApi(platform);
	const offset = api.relative(root, target);
	return offset === "" || (!offset.startsWith(`..${api.sep}`) && offset !== ".." && !api.isAbsolute(offset));
}

function portable(path: string, platform: WorkspacePlatform): string {
	const value = platform === "windows" ? path.replaceAll("\\", "/").toLowerCase() : path;
	return value.replaceAll(/\/+/gu, "/");
}

function escapeRegex(character: string): string {
	return /[|\\{}()[\]^$+*?.-]/u.test(character) ? `\\${character}` : character;
}

function compileCharacterClass(content: string): string | undefined {
	if (content.length === 0) return undefined;
	const negated = content.startsWith("!") || content.startsWith("^");
	const body = negated ? content.slice(1) : content;
	if (body.length === 0) return undefined;
	for (let index = 1; index < body.length - 1; index += 1) {
		if (body[index] !== "-") continue;
		const start = body.codePointAt(index - 1);
		const end = body.codePointAt(index + 1);
		if (start !== undefined && end !== undefined && start > end) return undefined;
	}
	const escaped = body.replaceAll("\\", "\\\\").replaceAll("]", "\\]");
	return `[${negated ? "^" : ""}${escaped}]`;
}

function compileGlob(pattern: string, platform: WorkspacePlatform): RegExp | undefined {
	const api = pathApi(platform);
	if (!api.isAbsolute(pattern)) return undefined;
	const source = portable(pattern, platform);
	let expression = "^";
	for (let index = 0; index < source.length; index += 1) {
		const character = source[index];
		if (character === "*") {
			if (source[index + 1] === "*") {
				while (source[index + 1] === "*") index += 1;
				if (source[index + 1] === "/") {
					index += 1;
					expression += "(?:[^/]+/)*";
				} else {
					expression += ".*";
				}
			} else {
				expression += "[^/]*";
			}
			continue;
		}
		if (character === "?") {
			expression += "[^/]";
			continue;
		}
		if (character === "[") {
			const closing = source.indexOf("]", index + 1);
			if (closing === -1) {
				expression += "\\[";
				continue;
			}
			const characterClass = compileCharacterClass(source.slice(index + 1, closing));
			if (characterClass === undefined) return undefined;
			expression += characterClass;
			index = closing;
			continue;
		}
		expression += escapeRegex(character);
	}
	try {
		return new RegExp(`${expression}$`, "u");
	} catch {
		return undefined;
	}
}

function failure(message: string): SecurityResult<never> {
	return { ok: false, error: { code: "invalid_config", message, retryable: false } };
}

function buildReadDenyMatcher(
	policy: CompiledFilesystemPolicy,
	options: ReadDenyMatcherOptions,
	invalidGlob: "fail-closed" | "error",
): SecurityResult<ReadDenyMatcher | undefined> {
	const deniedEntries = policy.entries.filter((entry) => entry.access === "deny");
	if (deniedEntries.length === 0) return { ok: true, value: undefined };
	const deniedPathEntries = deniedEntries.filter((entry) => entry.path.kind === "path");
	const deniedRoots = deniedPathEntries
		.map((entry) => entry.path.kind === "path" ? normalize(entry.path.path, entry.path.path, options.platform) : undefined)
		.filter((path): path is string => path !== undefined);
	const globPatterns = deniedEntries
		.filter((entry) => entry.path.kind === "glob")
		.map((entry) => entry.path.kind === "glob" ? entry.path.pattern : "");
	const globMatchers: RegExp[] = [];
	let malformed = deniedRoots.length !== deniedPathEntries.length || deniedEntries.some((entry) => entry.path.kind === "special");
	if (malformed && invalidGlob === "error") return failure("invalid exact deny-read path");
	for (const pattern of globPatterns) {
		const matcher = compileGlob(pattern, options.platform);
		if (matcher === undefined) {
			if (invalidGlob === "error") return failure(`invalid deny-read glob pattern: ${pattern}`);
			malformed = true;
		} else {
			globMatchers.push(matcher);
		}
	}
	return {
		ok: true,
		value: {
			isReadDenied(input): boolean {
				if (malformed) return true;
				const candidates = [input.path, ...(input.candidatePaths ?? [])]
					.map((path) => normalize(path, input.cwd, options.platform))
					.filter((path): path is string => path !== undefined);
				if (deniedRoots.some((deniedRoot) => candidates.some((candidate) => contains(deniedRoot, candidate, options.platform)))) return true;
				return globMatchers.some((matcher) => candidates.some((candidate) => matcher.test(portable(candidate, options.platform))));
			},
		},
	};
}

export function createReadDenyMatcher(
	policy: CompiledFilesystemPolicy,
	options: ReadDenyMatcherOptions,
): ReadDenyMatcher | undefined {
	const built = buildReadDenyMatcher(policy, options, "fail-closed");
	return built.ok ? built.value : undefined;
}

export function tryCreateReadDenyMatcher(
	policy: CompiledFilesystemPolicy,
	options: ReadDenyMatcherOptions,
): SecurityResult<ReadDenyMatcher | undefined> {
	return buildReadDenyMatcher(policy, options, "error");
}
