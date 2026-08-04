/** 有界、稳定且不跟随逃逸 symlink 的内容摘要。 */

import { createHash } from "node:crypto";
import { isAbsolute, relative, sep } from "node:path";
import { canonicalDigest } from "../../runtime/protocol/canonical-json.ts";
import { DEFAULT_EXTENSION_LIMITS } from "../diagnostics.ts";
import type { ExtensionScanLimits } from "../diagnostics.ts";
import type { ExtensionStoragePort } from "../storage-port.ts";

export interface ExtensionManifestDigest {
	readonly rootDigest: string;
	readonly manifestDigest: string;
	readonly configDigest: string;
	readonly commandDigest: string;
	readonly assetsDigest: string;
	readonly capabilityDigest: string;
	readonly combinedDigest: string;
}

export type ContentDigestResult =
	| { readonly ok: true; readonly digest: string; readonly files: number; readonly bytes: number }
	| { readonly ok: false; readonly code: "missing" | "escape" | "oversize" | "cycle" | "io"; readonly message: string };

export function sha256(value: string | Uint8Array): string {
	return createHash("sha256").update(value).digest("hex");
}

function contained(root: string, candidate: string): boolean {
	const value = relative(root, candidate);
	return value === "" || (!value.startsWith(`..${sep}`) && value !== ".." && !isAbsolute(value));
}

export async function digestFile(
	storage: ExtensionStoragePort,
	path: string,
	maxBytes = DEFAULT_EXTENSION_LIMITS.maxFileBytes,
): Promise<ContentDigestResult> {
	try {
		const info = await storage.stat(path);
		if (!info.ok) return { ok: false, code: "missing", message: info.message };
		if (info.value.kind !== "file") return { ok: false, code: "io", message: "digest target is not a file" };
		if (info.value.size > maxBytes) return { ok: false, code: "oversize", message: "file exceeds digest byte bound" };
		const read = await storage.readFile(path, maxBytes);
		if (!read.ok) return { ok: false, code: read.code === "oversize" ? "oversize" : "io", message: read.message };
		return { ok: true, digest: sha256(read.value), files: 1, bytes: read.value.byteLength };
	} catch {
		return { ok: false, code: "io", message: "file cannot be read" };
	}
}

export async function digestDirectory(
	storage: ExtensionStoragePort,
	root: string,
	limits: Pick<ExtensionScanLimits, "maxDiscoveryDepth" | "maxFiles" | "maxEntries" | "maxFileBytes" | "maxDirectoryBytes"> = DEFAULT_EXTENSION_LIMITS,
): Promise<ContentDigestResult> {
	try {
		const rootResult = await storage.realpath(root);
		if (!rootResult.ok) return { ok: false, code: "missing", message: rootResult.message };
		const canonicalRoot = rootResult.value;
		const rows: Array<{ readonly path: string; readonly kind: string; readonly digest: string; readonly bytes: number }> = [];
		const visitedDirectories = new Set<string>();
		let totalBytes = 0;
		let files = 0;
		let entries = 0;

		const walk = async (lexicalPath: string, logicalPath: string, depth: number): Promise<ContentDigestResult | undefined> => {
			if (depth > limits.maxDiscoveryDepth) return { ok: false, code: "oversize", message: "directory depth exceeds bound" };
			entries += 1;
			if (entries > limits.maxEntries) return { ok: false, code: "oversize", message: "directory entry bound reached" };
			const lexicalInfo = await storage.stat(lexicalPath, { followSymlinks: false });
			if (!lexicalInfo.ok) return { ok: false, code: "io", message: lexicalInfo.message };
			let canonical = lexicalPath;
			let kind = lexicalInfo.value.kind;
			if (kind === "symlink") {
				const target = await storage.realpath(lexicalPath);
				if (!target.ok) return { ok: false, code: "io", message: target.message };
				if (!contained(canonicalRoot, target.value)) return { ok: false, code: "escape", message: "symlink escapes digest root" };
				canonical = target.value;
				const targetInfo = await storage.stat(canonical);
				if (!targetInfo.ok) return { ok: false, code: "io", message: targetInfo.message };
				kind = targetInfo.value.kind;
				if (kind === "directory") {
					if (visitedDirectories.has(canonical)) return { ok: false, code: "cycle", message: "symlink directory cycle detected" };
					const child = await walk(canonical, logicalPath, depth);
					return child;
				}
				if (kind !== "file") return { ok: false, code: "io", message: "symlink target is not a regular file" };
			}
			if (kind === "directory") {
				if (visitedDirectories.has(canonical)) return { ok: false, code: "cycle", message: "directory cycle detected" };
				visitedDirectories.add(canonical);
				const listed = await storage.readDirectory(canonical);
				if (!listed.ok) return { ok: false, code: "io", message: listed.message };
				const children = [...listed.value].sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
				for (const child of children) {
					const result = await walk(`${canonical}/${child.name}`, logicalPath === "." ? child.name : `${logicalPath}/${child.name}`, depth + 1);
					if (result) return result;
				}
				rows.push({ path: logicalPath, kind: "directory", digest: canonicalDigest(children), bytes: 0 });
				return undefined;
			}
			if (kind !== "file") return { ok: false, code: "io", message: "digest tree contains a non-regular entry" };
			files += 1;
			if (files > limits.maxFiles) return { ok: false, code: "oversize", message: "directory file bound reached" };
			const file = await digestFile(storage, canonical, limits.maxFileBytes);
			if (!file.ok) return file;
			totalBytes += file.bytes;
			if (totalBytes > limits.maxDirectoryBytes) return { ok: false, code: "oversize", message: "directory byte bound reached" };
			rows.push({ path: logicalPath, kind: lexicalInfo.value.kind === "symlink" ? "symlink-file" : "file", digest: file.digest, bytes: file.bytes });
			return undefined;
		};

		const failure = await walk(canonicalRoot, ".", 0);
		if (failure) return failure;
		return { ok: true, digest: canonicalDigest(rows.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)), files, bytes: totalBytes };
	} catch {
		return { ok: false, code: "io", message: "directory cannot be digested" };
	}
}

export function buildResourceManifestDigest(input: {
	readonly rootDigest: string;
	readonly manifestDigest?: string;
	readonly configDigest?: string;
	readonly commandDigest?: string;
	readonly assetsDigest?: string;
	readonly capabilityDigest?: string;
}): ExtensionManifestDigest {
	const empty = sha256("");
	const binding = {
		rootDigest: input.rootDigest,
		manifestDigest: input.manifestDigest ?? empty,
		configDigest: input.configDigest ?? input.manifestDigest ?? empty,
		commandDigest: input.commandDigest ?? empty,
		assetsDigest: input.assetsDigest ?? empty,
		capabilityDigest: input.capabilityDigest ?? empty,
	};
	return { ...binding, combinedDigest: canonicalDigest(binding) };
}
