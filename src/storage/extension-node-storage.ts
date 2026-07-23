/** ExtensionStoragePort 的 production Node adapter；所有路径先经过冻结的 filesystem policy。 */

import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import type { ExtensionStorageEntryKind, ExtensionStoragePort, ExtensionStorageResult, ExtensionStorageStat } from "../extensions/storage-port.ts";
import { CanonicalPathResolver, FileAccessGuard } from "../security/policy-filesystem.ts";
import type { CanonicalPathResolution, FileSystemBrokerPort } from "../security/policy-filesystem.ts";
import type { FilesystemAccessOperation, SecuritySnapshot } from "../security/types.ts";

interface NodeEntryKindLike {
	isFile(): boolean;
	isDirectory(): boolean;
	isSymbolicLink(): boolean;
}

function brokerStats(value: Awaited<ReturnType<typeof stat>>) {
	return {
		size: Number(value.size),
		mtimeMs: Number(value.mtimeMs),
		isFile: value.isFile(),
		isDirectory: value.isDirectory(),
		isSymbolicLink: value.isSymbolicLink(),
	};
}

const nodeBroker: FileSystemBrokerPort = {
	readFile,
	writeFile,
	stat: async (path) => brokerStats(await stat(path)),
	lstat: async (path) => brokerStats(await lstat(path)),
	realpath,
	readdir,
	mkdir: async (path, options) => { await mkdir(path, options); },
	rm,
	rename,
};

function resultError(error: unknown): ExtensionStorageResult<never> {
	const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
	if (code === "ENOENT" || code === "ENOTDIR") return { ok: false, code: "missing", message: "extension storage path is missing" };
	if (code === "EACCES" || code === "EPERM" || code === "ELOOP") return { ok: false, code: "denied", message: "extension storage access was denied" };
	return { ok: false, code: "io", message: "extension storage operation failed" };
}

function denied(message: string): ExtensionStorageResult<never> {
	return { ok: false, code: "denied", message };
}

function kind(value: NodeEntryKindLike): ExtensionStorageEntryKind {
	if (value.isFile()) return "file";
	if (value.isDirectory()) return "directory";
	if (value.isSymbolicLink()) return "symlink";
	return "other";
}

export interface NodePolicyExtensionStorageOptions {
	cwd: string;
	/** 必须来自当前 composition root 的冻结 security policy，不得由 extension 自造批准 receipt。 */
	securitySnapshot: SecuritySnapshot;
}

/**
 * 该 adapter 只执行 filesystem policy 已经允许的读写。
 * trust/state/OAuth metadata 的写根必须由 composition root 明确加入 writeRoots；
 * extension discovery 不能借此扩大普通工具的 workspace 权限。
 */
export class NodePolicyExtensionStorage implements ExtensionStoragePort {
	readonly #cwd: string;
	readonly #resolver: CanonicalPathResolver;
	readonly #guard: FileAccessGuard;

	public constructor(options: NodePolicyExtensionStorageOptions) {
		this.#cwd = resolve(options.cwd);
		this.#resolver = new CanonicalPathResolver(nodeBroker, this.#cwd);
		this.#guard = new FileAccessGuard(options.securitySnapshot);
	}

	async #path(operation: FilesystemAccessOperation, path: string, requireExisting: boolean): Promise<ExtensionStorageResult<CanonicalPathResolution>> {
		const resolved = await this.#resolver.resolve(path);
		if (!resolved.ok) return resolved.error.code === "path_escape" || resolved.error.code === "protected_path" ? denied(resolved.error.message) : resultError(new Error(resolved.error.message));
		if (requireExisting && !resolved.value.existing) return { ok: false, code: "missing", message: "extension storage path is missing" };
		const checked = this.#guard.check(operation, resolved.value);
		if (!checked.ok) return denied(checked.error.message);
		return { ok: true, value: resolved.value };
	}

	async #leafPath(operation: FilesystemAccessOperation, path: string): Promise<ExtensionStorageResult<string>> {
		const lexicalPath = resolve(this.#cwd, path);
		if (dirname(lexicalPath) === lexicalPath) {
			const root = await this.#path(operation, lexicalPath, true);
			return root.ok ? { ok: true, value: root.value.canonicalPath } : root;
		}
		const parent = await this.#path(operation, dirname(lexicalPath), true);
		if (!parent.ok) return parent;
		const canonicalPath = resolve(parent.value.canonicalPath, basename(lexicalPath));
		const resolution: CanonicalPathResolution = { requestedPath: path, lexicalPath, canonicalPath, existing: true };
		const checked = this.#guard.check(operation, resolution);
		return checked.ok ? { ok: true, value: canonicalPath } : denied(checked.error.message);
	}

	async #removeTemporary(path: string): Promise<void> {
		const checked = await this.#path("delete", path, true);
		if (!checked.ok || checked.value.canonicalPath !== path) return;
		await rm(checked.value.canonicalPath, { force: true }).catch(() => undefined);
	}

	public async realpath(path: string): Promise<ExtensionStorageResult<string>> {
		const checked = await this.#path("read", path, true);
		return checked.ok ? { ok: true, value: checked.value.canonicalPath } : checked;
	}

	public async stat(path: string, options?: { followSymlinks?: boolean }): Promise<ExtensionStorageResult<ExtensionStorageStat>> {
		try {
			if (options?.followSymlinks === false) {
				const checked = await this.#leafPath("read", path);
				if (!checked.ok) return checked;
				const value = await lstat(checked.value);
				if (!value.isSymbolicLink()) {
					const canonical = await this.#path("read", path, true);
					if (!canonical.ok || canonical.value.canonicalPath !== checked.value) return denied("extension storage target changed before stat");
				}
				return { ok: true, value: { kind: kind(value), size: value.size } };
			}
			const checked = await this.#path("read", path, true);
			if (!checked.ok) return checked;
			const value = await stat(checked.value.canonicalPath);
			return { ok: true, value: { kind: kind(value), size: value.size } };
		} catch (error) {
			return resultError(error);
		}
	}

	public async readDirectory(path: string) {
		try {
			const checked = await this.#path("read", path, true);
			if (!checked.ok) return checked;
			const entries = await readdir(checked.value.canonicalPath, { withFileTypes: true });
			const repeated = await this.#path("read", path, true);
			if (!repeated.ok || repeated.value.canonicalPath !== checked.value.canonicalPath) return denied("extension storage directory changed before read completed");
			return { ok: true as const, value: entries.map((entry) => ({ name: entry.name, kind: kind(entry) })) };
		} catch (error) {
			return resultError(error);
		}
	}

	public async readFile(path: string, maxBytes: number) {
		if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) return { ok: false as const, code: "io" as const, message: "extension read byte bound is invalid" };
		let handle: Awaited<ReturnType<typeof open>> | undefined;
		try {
			const checked = await this.#path("read", path, true);
			if (!checked.ok) return checked;
			const before = await stat(checked.value.canonicalPath);
			if (!before.isFile()) return { ok: false as const, code: "io" as const, message: "extension read target is not a file" };
			if (before.size > maxBytes) return { ok: false as const, code: "oversize" as const, message: "extension file exceeds byte bound" };
			handle = await open(checked.value.canonicalPath, constants.O_RDONLY | constants.O_NOFOLLOW);
			const opened = await handle.stat();
			if (!opened.isFile() || opened.size > maxBytes) return { ok: false as const, code: opened.size > maxBytes ? "oversize" as const : "io" as const, message: "extension file changed or exceeds byte bound" };
			const repeated = await this.#path("read", path, true);
			if (!repeated.ok || repeated.value.canonicalPath !== checked.value.canonicalPath) return denied("extension storage target changed before read");
			const value = await handle.readFile();
			if (value.byteLength > maxBytes) return { ok: false as const, code: "oversize" as const, message: "extension file exceeds byte bound" };
			return { ok: true as const, value };
		} catch (error) {
			return resultError(error);
		} finally {
			await handle?.close().catch(() => undefined);
		}
	}

	public async writeFileAtomic(path: string, bytes: Uint8Array, options: { fileMode: 0o600; directoryMode: 0o700 }) {
		if (options.fileMode !== 0o600 || options.directoryMode !== 0o700) return denied("extension metadata requires file mode 0600 and directory mode 0700");
		let temporaryPath: string | undefined;
		let handle: Awaited<ReturnType<typeof open>> | undefined;
		try {
			const target = await this.#path("write", path, false);
			if (!target.ok) return target;
			const leaf = await this.#leafPath("write", path);
			const targetPath = leaf.ok ? leaf.value : target.value.canonicalPath;
			const parentPath = dirname(targetPath);
			const created = await mkdir(parentPath, { recursive: true, mode: options.directoryMode });
			if (created) await chmod(parentPath, options.directoryMode);
			const parent = await this.#path("write", parentPath, true);
			if (!parent.ok || parent.value.canonicalPath !== parentPath) return denied("extension storage parent changed before atomic write");
			const repeatedLeaf = await this.#leafPath("write", path);
			if (!repeatedLeaf.ok || repeatedLeaf.value !== targetPath) return denied("extension metadata target changed before atomic write");
			try {
				const existing = await lstat(targetPath);
				if (existing.isSymbolicLink() || !existing.isFile()) return denied("extension metadata target must be a regular file");
			} catch (error) {
				const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
				if (code !== "ENOENT") return resultError(error);
			}
			temporaryPath = resolve(parentPath, `.${basename(targetPath)}.tmp-${randomUUID()}`);
			const temporary = await this.#path("write", temporaryPath, false);
			if (!temporary.ok || temporary.value.canonicalPath !== temporaryPath) return denied("extension temporary path escaped its write root");
			handle = await open(temporaryPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, options.fileMode);
			await handle.writeFile(bytes);
			await handle.sync();
			await handle.close();
			handle = undefined;
			const repeatedParent = await this.#path("write", parentPath, true);
			if (!repeatedParent.ok || repeatedParent.value.canonicalPath !== parentPath) return denied("extension storage parent changed before atomic rename");
			await rename(temporaryPath, targetPath);
			temporaryPath = undefined;
			await chmod(targetPath, options.fileMode);
			const directoryHandle = await open(parentPath, constants.O_RDONLY);
			await directoryHandle.sync().catch(() => undefined);
			await directoryHandle.close();
			return { ok: true as const, value: undefined };
		} catch (error) {
			return resultError(error);
		} finally {
			await handle?.close().catch(() => undefined);
			if (temporaryPath) await this.#removeTemporary(temporaryPath);
		}
	}
}
