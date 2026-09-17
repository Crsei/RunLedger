/**
 * ExtensionDistributionPort 的 Node 适配器。
 *
 * 与 `NodeExtensionStorage` 相同的边界纪律：读可以访问显式 discovery root，
 * 但**所有变更**都必须落在 composition root 注入的 runledgerHome 之下，且
 * 每一步都重新校验 containment 与 symlink 目标，避免 `..`、绝对路径或
 * 中间 symlink 把写入引出 canonical home。
 */

import { lstat, mkdir, readFile, readdir, readlink, realpath, rename, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ExtensionStorageEntry, ExtensionStorageResult, ExtensionStorageStat } from "../../extensions/storage-port.ts";
import type { ExtensionCopyTreeResult, ExtensionDistributionPort } from "../../extensions/plugins/distribution-port.ts";

export interface NodeExtensionDistributionOptions {
	readonly runledgerHome: string;
}

function isContained(root: string, target: string): boolean {
	const value = relative(resolve(root), resolve(target));
	return value === "" || (!value.startsWith(`..${sep}`) && value !== ".." && !isAbsolute(value));
}

function isNodeError(error: unknown, code: string): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function failure(error: unknown, fallback: string): ExtensionStorageResult<never> {
	if (isNodeError(error, "ENOENT")) return { ok: false, code: "missing", message: fallback };
	if (isNodeError(error, "EACCES") || isNodeError(error, "EPERM") || isNodeError(error, "EXDEV")) return { ok: false, code: "denied", message: fallback };
	if (isNodeError(error, "ENOSPC")) return { ok: false, code: "oversize", message: fallback };
	return { ok: false, code: "io", message: fallback };
}

export class NodeExtensionDistributionStorage implements ExtensionDistributionPort {
	readonly #runledgerHome: string;

	public constructor(options: NodeExtensionDistributionOptions) {
		if (!isAbsolute(options.runledgerHome)) throw new Error("extension distribution home must be absolute");
		this.#runledgerHome = resolve(options.runledgerHome);
	}

	/** 变更操作统一入口：目标必须落在 canonical home 内。 */
	#mutable(path: string): ExtensionStorageResult<string> {
		const target = resolve(path);
		if (!isContained(this.#runledgerHome, target)) return { ok: false, code: "denied", message: "extension distribution writes must remain under runledgerHome" };
		return { ok: true, value: target };
	}

	public async realpath(path: string): Promise<ExtensionStorageResult<string>> {
		try { return { ok: true, value: await realpath(path) }; }
		catch (error) { return failure(error, "extension path could not be resolved"); }
	}

	public async stat(path: string, options: { readonly followSymlinks?: boolean } = {}): Promise<ExtensionStorageResult<ExtensionStorageStat>> {
		try {
			const value = options.followSymlinks === false ? await lstat(path) : await stat(path);
			const kind = value.isFile() ? "file" : value.isDirectory() ? "directory" : value.isSymbolicLink() ? "symlink" : "other";
			return { ok: true, value: { kind, size: value.size } };
		} catch (error) { return failure(error, "extension path could not be inspected"); }
	}

	public async readDirectory(path: string): Promise<ExtensionStorageResult<readonly ExtensionStorageEntry[]>> {
		try {
			const entries = await readdir(path, { withFileTypes: true });
			return {
				ok: true,
				value: entries.map((entry) => ({
					name: entry.name,
					kind: entry.isFile() ? "file" as const : entry.isDirectory() ? "directory" as const : entry.isSymbolicLink() ? "symlink" as const : "other" as const,
				})),
			};
		} catch (error) { return failure(error, "extension directory could not be read"); }
	}

	public async readFile(path: string, maxBytes: number): Promise<ExtensionStorageResult<Uint8Array>> {
		if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) return { ok: false, code: "io", message: "extension file bound is invalid" };
		try {
			const metadata = await stat(path);
			if (metadata.size > maxBytes) return { ok: false, code: "oversize", message: "extension file exceeds its byte bound" };
			return { ok: true, value: await readFile(path) };
		} catch (error) { return failure(error, "extension file could not be read"); }
	}

	public async writeFileAtomic(path: string, bytes: Uint8Array, options: { readonly fileMode: 0o600; readonly directoryMode: 0o700 }): Promise<ExtensionStorageResult<void>> {
		const target = this.#mutable(path);
		if (!target.ok) return target;
		const parent = dirname(target.value);
		try {
			await mkdir(parent, { recursive: true, mode: options.directoryMode });
			const canonicalParent = await realpath(parent);
			if (!isContained(this.#runledgerHome, canonicalParent)) return { ok: false, code: "denied", message: "extension state parent escapes runledgerHome" };
			const existing = await lstat(target.value).catch(() => undefined);
			if (existing?.isSymbolicLink()) return { ok: false, code: "denied", message: "extension state target may not be a symlink" };
			const temporary = join(parent, `.${target.value.slice(parent.length + 1)}.${randomUUID()}.tmp`);
			await writeFile(temporary, bytes, { flag: "wx", mode: options.fileMode });
			try { await rename(temporary, target.value); }
			finally { await unlink(temporary).catch(() => undefined); }
			return { ok: true, value: undefined };
		} catch (error) { return failure(error, "extension state could not be written"); }
	}

	public async mkdirp(path: string): Promise<ExtensionStorageResult<void>> {
		const target = this.#mutable(path);
		if (!target.ok) return target;
		try {
			await mkdir(target.value, { recursive: true, mode: 0o700 });
			return { ok: true, value: undefined };
		} catch (error) { return failure(error, "extension directory could not be created"); }
	}

	public async rename(from: string, to: string): Promise<ExtensionStorageResult<void>> {
		const source = this.#mutable(from);
		if (!source.ok) return source;
		const target = this.#mutable(to);
		if (!target.ok) return target;
		try {
			// 激活必须是同设备改名：目标父目录的 canonical 路径也要在 home 内。
			await mkdir(dirname(target.value), { recursive: true, mode: 0o700 });
			const canonicalParent = await realpath(dirname(target.value));
			if (!isContained(this.#runledgerHome, canonicalParent)) return { ok: false, code: "denied", message: "extension rename target escapes runledgerHome" };
			await rename(source.value, target.value);
			return { ok: true, value: undefined };
		} catch (error) { return failure(error, "extension directory could not be activated"); }
	}

	public async remove(path: string, options: { readonly recursive: boolean }): Promise<ExtensionStorageResult<void>> {
		const target = this.#mutable(path);
		if (!target.ok) return target;
		try {
			await rm(target.value, { recursive: options.recursive, force: true });
			return { ok: true, value: undefined };
		} catch (error) { return failure(error, "extension path could not be removed"); }
	}

	public async symlink(target: string, path: string): Promise<ExtensionStorageResult<void>> {
		const link = this.#mutable(path);
		if (!link.ok) return link;
		if (!isAbsolute(target)) return { ok: false, code: "denied", message: "extension symlink target must be absolute" };
		try {
			await mkdir(dirname(link.value), { recursive: true, mode: 0o700 });
			await symlink(resolve(target), link.value);
			return { ok: true, value: undefined };
		} catch (error) { return failure(error, "extension symlink could not be created"); }
	}

	public async readlinkPath(path: string): Promise<ExtensionStorageResult<string>> {
		try { return { ok: true, value: await readlink(path) }; }
		catch (error) { return failure(error, "extension symlink could not be read"); }
	}

	public async copyTree(from: string, to: string, limits: { readonly maxEntries: number; readonly maxBytes: number }): Promise<ExtensionStorageResult<ExtensionCopyTreeResult>> {
		const target = this.#mutable(to);
		if (!target.ok) return target;
		const canonicalSource = await this.realpath(from);
		if (!canonicalSource.ok) return canonicalSource;
		let entries = 0;
		let bytes = 0;
		const queue: Array<{ readonly source: string; readonly destination: string; readonly depth: number }> = [
			{ source: canonicalSource.value, destination: target.value, depth: 0 },
		];
		try {
			await mkdir(target.value, { recursive: true, mode: 0o700 });
			while (queue.length > 0) {
				const current = queue.shift();
				if (current === undefined) break;
				if (current.depth > 32) return { ok: false, code: "oversize", message: "extension package nesting exceeds the depth bound" };
				const listing = await readdir(current.source, { withFileTypes: true });
				for (const entry of listing) {
					entries += 1;
					if (entries > limits.maxEntries) return { ok: false, code: "oversize", message: `extension package exceeds ${limits.maxEntries} entries` };
					const sourcePath = join(current.source, entry.name);
					const destinationPath = join(current.destination, entry.name);
					// symlink 不复制目标，只复制链接本身；解包永不解引用。
					if (entry.isSymbolicLink()) {
						const linkTarget = await readlink(sourcePath);
						await symlink(linkTarget, destinationPath);
						continue;
					}
					if (entry.isDirectory()) {
						await mkdir(destinationPath, { recursive: true, mode: 0o700 });
						queue.push({ source: sourcePath, destination: destinationPath, depth: current.depth + 1 });
						continue;
					}
					if (!entry.isFile()) return { ok: false, code: "io", message: "extension package contains a non-regular entry" };
					const info = await stat(sourcePath);
					bytes += info.size;
					if (bytes > limits.maxBytes) return { ok: false, code: "oversize", message: `extension package exceeds ${limits.maxBytes} bytes` };
					await writeFile(destinationPath, await readFile(sourcePath), { mode: 0o600 });
				}
			}
			return { ok: true, value: { entries, bytes } };
		} catch (error) { return failure(error, "extension package could not be copied into staging"); }
	}
}
