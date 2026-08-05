/**
 * ExtensionStoragePort 的 Node 适配器。
 *
 * 读取可以访问显式 discovery root（包括只读仓库输入），但所有写入都
 * 必须落在 composition root 注入的 runledgerHome 下，并通过同目录原子
 * rename 完成。扩展域本身不接触 node:fs。
 */

import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type {
	ExtensionStorageEntry,
	ExtensionStoragePort,
	ExtensionStorageResult,
	ExtensionStorageStat,
} from "../../extensions/storage-port.ts";

export interface NodeExtensionStorageOptions {
	readonly runledgerHome: string;
}

export class NodeExtensionStorage implements ExtensionStoragePort {
	readonly #runledgerHome: string;

	public constructor(options: NodeExtensionStorageOptions) {
		if (!isAbsolute(options.runledgerHome)) throw new Error("extension storage home must be absolute");
		this.#runledgerHome = resolve(options.runledgerHome);
	}

	public async realpath(path: string): Promise<ExtensionStorageResult<string>> {
		try {
			return { ok: true, value: await realpath(path) };
		} catch (error) {
			return failure(error, "extension path could not be resolved");
		}
	}

	public async stat(path: string, options: { readonly followSymlinks?: boolean } = {}): Promise<ExtensionStorageResult<ExtensionStorageStat>> {
		try {
			const value = options.followSymlinks === false ? await lstat(path) : await stat(path);
			const kind = value.isFile() ? "file" : value.isDirectory() ? "directory" : value.isSymbolicLink() ? "symlink" : "other";
			return { ok: true, value: { kind, size: value.size } };
		} catch (error) {
			return failure(error, "extension path could not be inspected");
		}
	}

	public async readDirectory(path: string): Promise<ExtensionStorageResult<readonly ExtensionStorageEntry[]>> {
		try {
			const entries = await readdir(path, { withFileTypes: true });
			const value: ExtensionStorageEntry[] = entries.map((entry) => ({ name: entry.name, kind: entry.isFile() ? "file" : entry.isDirectory() ? "directory" : entry.isSymbolicLink() ? "symlink" : "other" }));
			return { ok: true, value };
		} catch (error) {
			return failure(error, "extension directory could not be read");
		}
	}

	public async readFile(path: string, maxBytes: number): Promise<ExtensionStorageResult<Uint8Array>> {
		if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) return { ok: false, code: "io", message: "extension file bound is invalid" };
		try {
			const metadata = await stat(path);
			if (metadata.size > maxBytes) return { ok: false, code: "oversize", message: "extension file exceeds its byte bound" };
			return { ok: true, value: await readFile(path) };
		} catch (error) {
			return failure(error, "extension file could not be read");
		}
	}

	public async writeFileAtomic(
		path: string,
		bytes: Uint8Array,
		options: { readonly fileMode: 0o600; readonly directoryMode: 0o700 },
	): Promise<ExtensionStorageResult<void>> {
		const target = resolve(path);
		if (!isContained(this.#runledgerHome, target)) return { ok: false, code: "denied", message: "extension state must remain under runledgerHome" };
		const parent = dirname(target);
		try {
			await mkdir(parent, { recursive: true, mode: options.directoryMode });
			const canonicalParent = await realpath(parent);
			if (!isContained(this.#runledgerHome, canonicalParent)) return { ok: false, code: "denied", message: "extension state parent escapes runledgerHome" };
			const existing = await lstat(target).catch(() => undefined);
			if (existing?.isSymbolicLink()) return { ok: false, code: "denied", message: "extension state target may not be a symlink" };
			const temporary = resolve(parent, `.${target.slice(parent.length + 1)}.${randomUUID()}.tmp`);
			await writeFile(temporary, bytes, { flag: "wx", mode: options.fileMode });
			try {
				await rename(temporary, target);
			} finally {
				await unlink(temporary).catch(() => undefined);
			}
			return { ok: true, value: undefined };
		} catch (error) {
			return failure(error, "extension state could not be written");
		}
	}
}

function isContained(root: string, target: string): boolean {
	const value = relative(resolve(root), resolve(target));
	return value === "" || (!value.startsWith(`..${sep}`) && value !== ".." && !isAbsolute(value));
}

function failure(error: unknown, fallback: string): ExtensionStorageResult<never> {
	if (isNodeError(error, "ENOENT")) return { ok: false, code: "missing", message: fallback };
	if (isNodeError(error, "EACCES") || isNodeError(error, "EPERM")) return { ok: false, code: "denied", message: fallback };
	return { ok: false, code: "io", message: fallback };
}

function isNodeError(error: unknown, code: string): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
