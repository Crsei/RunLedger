/** 有界、稳定且不跟随逃逸 symlink 的内容摘要。 */

import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { canonicalDigest } from "../../runtime/protocol/v3/canonical-json.ts";
import type { ResourceManifestDigest } from "../../runtime/resources/types.ts";
import { DEFAULT_EXTENSION_LIMITS } from "../diagnostics.ts";
import type { ExtensionLimits } from "../diagnostics.ts";
import type { ExtensionStoragePort } from "../storage-port.ts";

export type ContentDigestResult =
	| { ok: true; digest: string; files: number; bytes: number }
	| { ok: false; code: "missing" | "escape" | "oversize" | "cycle" | "io"; message: string };

export function sha256(value: string | Uint8Array): string {
	return createHash("sha256").update(value).digest("hex");
}

function isContained(root: string, candidate: string): boolean {
	const rel = relative(root, candidate);
	return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

export async function digestFile(storage: ExtensionStoragePort, path: string, maxBytes = DEFAULT_EXTENSION_LIMITS.maxFileBytes): Promise<ContentDigestResult> {
	try {
		const info = await storage.stat(path);
		if (!info.ok) return { ok: false, code: "missing", message: info.message };
		if (info.value.kind !== "file") return { ok: false, code: "io", message: "digest target is not a file" };
		if (info.value.size > maxBytes) return { ok: false, code: "oversize", message: "file exceeds digest byte bound" };
		const read = await storage.readFile(path, maxBytes);
		if (!read.ok) return { ok: false, code: read.code === "oversize" ? "oversize" : "io", message: read.message };
		const bytes = read.value;
		return { ok: true, digest: sha256(bytes), files: 1, bytes: bytes.byteLength };
	} catch {
		return { ok: false, code: "missing", message: "file cannot be read" };
	}
}

export async function digestDirectory(
	storage: ExtensionStoragePort,
	root: string,
	limits: Pick<ExtensionLimits, "maxDiscoveryDepth" | "maxFiles" | "maxFileBytes" | "maxDirectoryBytes"> = DEFAULT_EXTENSION_LIMITS,
): Promise<ContentDigestResult> {
	try {
		const rootResult = await storage.realpath(root);
		if (!rootResult.ok) return { ok: false, code: "missing", message: rootResult.message };
		const canonicalRoot = rootResult.value;
		const rows: Array<{ path: string; kind: string; digest: string; bytes: number }> = [];
		const visited = new Set<string>();
		let totalBytes = 0;
		let files = 0;
		const walk = async (lexicalPath: string, logicalPath: string, depth: number): Promise<ContentDigestResult | undefined> => {
			if (depth > limits.maxDiscoveryDepth) return { ok: false, code: "oversize", message: "directory depth exceeds bound" };
			const lexicalInfo = await storage.stat(lexicalPath, { followSymlinks: false });
			if (!lexicalInfo.ok) return { ok: false, code: "io", message: lexicalInfo.message };
			let canonical = lexicalPath;
			let kind: string = lexicalInfo.value.kind;
			if (lexicalInfo.value.kind === "symlink") {
				const target = await storage.realpath(lexicalPath);
				if (!target.ok) return { ok: false, code: "io", message: target.message };
				canonical = target.value;
				if (!isContained(canonicalRoot, canonical)) return { ok: false, code: "escape", message: "symlink escapes digest root" };
				const targetInfo = await storage.stat(canonical);
				if (!targetInfo.ok) return { ok: false, code: "io", message: targetInfo.message };
				kind = targetInfo.value.kind === "directory" ? "symlink-directory" : "symlink-file";
			}
			const info = await storage.stat(canonical);
			if (!info.ok) return { ok: false, code: "io", message: info.message };
			if (info.value.kind === "directory") {
				if (visited.has(canonical)) return { ok: false, code: "cycle", message: "symlink directory cycle detected" };
				visited.add(canonical);
				const listed = await storage.readDirectory(canonical);
				if (!listed.ok) return { ok: false, code: "io", message: listed.message };
				const children = [...listed.value].sort((left, right) => left.name.localeCompare(right.name));
				for (const child of children) {
					const problem = await walk(resolve(canonical, child.name), logicalPath ? `${logicalPath}/${child.name}` : child.name, depth + 1);
					if (problem) return problem;
				}
				visited.delete(canonical);
				return undefined;
			}
			if (info.value.kind !== "file") return undefined;
			files += 1;
			if (files > limits.maxFiles || info.value.size > limits.maxFileBytes) {
				return { ok: false, code: "oversize", message: "directory file bound exceeded" };
			}
			totalBytes += info.value.size;
			if (totalBytes > limits.maxDirectoryBytes) return { ok: false, code: "oversize", message: "directory byte bound exceeded" };
			const read = await storage.readFile(canonical, limits.maxFileBytes);
			if (!read.ok) return { ok: false, code: read.code === "oversize" ? "oversize" : "io", message: read.message };
			const bytes = read.value;
			rows.push({ path: logicalPath, kind, digest: sha256(bytes), bytes: bytes.byteLength });
			return undefined;
		};
		const problem = await walk(canonicalRoot, "", 0);
		if (problem) return problem;
		return { ok: true, digest: canonicalDigest(rows), files, bytes: totalBytes };
	} catch {
		return { ok: false, code: "io", message: "directory cannot be digested" };
	}
}

export function buildResourceManifestDigest(input: {
	rootDigest: string;
	manifestDigest?: string;
	configDigest?: string;
	commandDigest?: string;
	assetsDigest?: string;
	capabilityDigest?: string;
}): ResourceManifestDigest {
	const empty = sha256("");
	const body = {
		schemaVersion: 2 as const,
		rootDigest: input.rootDigest,
		manifestDigest: input.manifestDigest ?? empty,
		configDigest: input.configDigest ?? empty,
		commandDigest: input.commandDigest ?? empty,
		assetsDigest: input.assetsDigest ?? empty,
		capabilityDigest: input.capabilityDigest ?? empty,
	};
	return { ...body, combinedDigest: canonicalDigest(body) };
}
