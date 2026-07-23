/** 扩展资源路径、祖先链与 realpath containment。 */

import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import { DEFAULT_EXTENSION_LIMITS } from "./diagnostics.ts";
import type { ExtensionSource, ExtensionSourceRoot } from "./types.ts";
import type { ExtensionStoragePort } from "./storage-port.ts";

export type ContainedPathResult =
	| { ok: true; root: string; path: string; relativePath: string }
	| { ok: false; code: "missing" | "escape" | "invalid"; message: string };

function contained(root: string, candidate: string): boolean {
	const rel = relative(root, candidate);
	return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

export async function resolveContainedPath(storage: ExtensionStoragePort, root: string, candidate: string): Promise<ContainedPathResult> {
	try {
		const rootResult = await storage.realpath(root);
		if (!rootResult.ok) return { ok: false, code: "missing", message: rootResult.message };
		const canonicalRoot = rootResult.value;
		const lexical = resolve(canonicalRoot, candidate);
		if (!contained(canonicalRoot, lexical)) return { ok: false, code: "escape", message: "path escapes resource root" };
		const pathResult = await storage.realpath(lexical);
		if (!pathResult.ok) return { ok: false, code: "missing", message: pathResult.message };
		const canonicalPath = pathResult.value;
		if (!contained(canonicalRoot, canonicalPath)) return { ok: false, code: "escape", message: "realpath escapes resource root" };
		return { ok: true, root: canonicalRoot, path: canonicalPath, relativePath: relative(canonicalRoot, canonicalPath) || "." };
	} catch {
		return { ok: false, code: "missing", message: "resource path is missing or cannot be resolved" };
	}
}

export async function resolveDeclaredPath(storage: ExtensionStoragePort, root: string, declaration: string): Promise<ContainedPathResult> {
	if (!declaration.startsWith("./") || declaration.includes("\0")) {
		return { ok: false, code: "invalid", message: "declared path must begin with ./" };
	}
	return resolveContainedPath(storage, root, declaration);
}

export async function findProjectBoundary(storage: ExtensionStoragePort, cwd: string, maxDepth = DEFAULT_EXTENSION_LIMITS.maxAncestorDepth): Promise<string> {
	const cwdResult = await storage.realpath(cwd);
	if (!cwdResult.ok) throw new Error(cwdResult.message);
	let current = cwdResult.value;
	for (let depth = 0; depth <= maxDepth; depth += 1) {
		const git = await storage.stat(join(current, ".git"));
		if (git.ok) {
			return current;
		}
		const parent = resolve(current, "..");
		if (parent === current) return current;
		current = parent;
	}
	return current;
}

export async function collectProjectAncestors(
	storage: ExtensionStoragePort,
	cwd: string,
	boundary?: string,
	maxDepth = DEFAULT_EXTENSION_LIMITS.maxAncestorDepth,
): Promise<readonly string[]> {
	const cwdResult = await storage.realpath(cwd);
	if (!cwdResult.ok) throw new Error(cwdResult.message);
	const canonicalCwd = cwdResult.value;
	const boundaryResult = boundary ? await storage.realpath(boundary) : undefined;
	if (boundaryResult && !boundaryResult.ok) throw new Error(boundaryResult.message);
	const canonicalBoundary = boundaryResult?.ok ? boundaryResult.value : await findProjectBoundary(storage, canonicalCwd, maxDepth);
	if (!contained(canonicalBoundary, canonicalCwd)) throw new Error("project boundary does not contain cwd");
	const result: string[] = [];
	const seen = new Set<string>();
	let current = canonicalCwd;
	for (let depth = 0; depth <= maxDepth; depth += 1) {
		if (!seen.has(current)) {
			seen.add(current);
			result.push(current);
		}
		if (current === canonicalBoundary) break;
		const parent = resolve(current, "..");
		if (parent === current || !contained(canonicalBoundary, parent)) break;
		current = parent;
	}
	return result;
}

export function sourceKey(source: ExtensionSource, canonicalRoot: string): string {
	const digest = createHash("sha256").update(canonicalRoot).digest("hex").slice(0, 16);
	return `${source}:${digest}`;
}

export async function discoverExtensionRoots(args: {
	storage: ExtensionStoragePort;
	cwd: string;
	userRoot?: string;
	sessionRoots?: readonly string[];
	builtinRoots?: readonly string[];
	maxAncestorDepth?: number;
}): Promise<readonly ExtensionSourceRoot[]> {
	const roots: ExtensionSourceRoot[] = [];
	const seen = new Set<string>();
	const add = async (source: ExtensionSource, path: string, priority: number): Promise<void> => {
		try {
			const resolved = await args.storage.realpath(path);
			if (!resolved.ok) return;
			const canonical = resolved.value;
			const info = await args.storage.stat(canonical);
			if (!info.ok || info.value.kind !== "directory" || seen.has(canonical)) return;
			seen.add(canonical);
			roots.push({ source, sourceKey: sourceKey(source, canonical), rootPath: canonical, priority });
		} catch {
			// 不存在的可选 root 不是错误。
		}
	};
	for (const path of args.builtinRoots ?? []) await add("builtin", path, 0);
	if (args.userRoot) await add("user", args.userRoot, 100);
	const ancestors = await collectProjectAncestors(args.storage, args.cwd, undefined, args.maxAncestorDepth);
	for (let index = ancestors.length - 1; index >= 0; index -= 1) {
		const ancestor = ancestors[index];
		if (ancestor) await add("project", join(ancestor, ".runledger"), 200 + (ancestors.length - index));
	}
	for (let index = 0; index < (args.sessionRoots?.length ?? 0); index += 1) {
		const path = args.sessionRoots?.[index];
		if (path) await add("session", path, 1_000 + index);
	}
	return roots.sort((left, right) => left.priority - right.priority || left.rootPath.localeCompare(right.rootPath));
}
