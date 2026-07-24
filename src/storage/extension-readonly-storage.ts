/** CLI inspect/list/validate 专用的只读、root-contained Extension storage。 */

import { constants } from "node:fs";
import { lstat, open, readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type {
	ExtensionStorageEntryKind,
	ExtensionStoragePort,
	ExtensionStorageResult,
	ExtensionStorageStat,
} from "../extensions/storage-port.ts";

interface NodeEntryKindLike {
	isFile(): boolean;
	isDirectory(): boolean;
	isSymbolicLink(): boolean;
}

function kind(value: NodeEntryKindLike): ExtensionStorageEntryKind {
	if (value.isFile()) return "file";
	if (value.isDirectory()) return "directory";
	if (value.isSymbolicLink()) return "symlink";
	return "other";
}

function contained(root: string, candidate: string): boolean {
	const value = relative(root, candidate);
	return value === "" || (
		value !== ".." &&
		!value.startsWith(`..${sep}`) &&
		!isAbsolute(value)
	);
}

function failure(error: unknown): ExtensionStorageResult<never> {
	const code = typeof error === "object" && error !== null && "code" in error
		? String(error.code)
		: "";
	if (code === "ENOENT" || code === "ENOTDIR") {
		return { ok: false, code: "missing", message: "extension inspection path is missing" };
	}
	if (code === "EACCES" || code === "EPERM" || code === "ELOOP") {
		return { ok: false, code: "denied", message: "extension inspection access was denied" };
	}
	return { ok: false, code: "io", message: "extension inspection filesystem operation failed" };
}

/**
 * 这个 adapter 不提供任何写能力，也不会把 security snapshot 或 execution
 * receipt 伪造成 inspection 授权。root 自身或任意后代 symlink 逃逸都会拒绝。
 */
export class NodeReadOnlyExtensionStorage implements ExtensionStoragePort {
	readonly #roots: readonly string[];

	public constructor(roots: readonly string[]) {
		const normalized = [...new Set(roots.map((root) => resolve(root)))].sort();
		if (normalized.length === 0) throw new TypeError("read-only extension storage requires at least one root");
		this.#roots = Object.freeze(normalized);
	}

	#lexical(path: string): ExtensionStorageResult<string> {
		const candidate = resolve(path);
		return this.#roots.some((root) => contained(root, candidate))
			? { ok: true, value: candidate }
			: { ok: false, code: "denied", message: "extension inspection path is outside allowed roots" };
	}

	async #canonical(path: string): Promise<ExtensionStorageResult<string>> {
		const lexical = this.#lexical(path);
		if (!lexical.ok) return lexical;
		try {
			const canonical = await realpath(lexical.value);
			const owner = this.#roots.find((root) => contained(root, lexical.value));
			if (!owner || !contained(owner, canonical)) {
				return { ok: false, code: "denied", message: "extension inspection symlink escapes its root" };
			}
			return { ok: true, value: canonical };
		} catch (error) {
			return failure(error);
		}
	}

	public realpath(path: string): Promise<ExtensionStorageResult<string>> {
		return this.#canonical(path);
	}

	public async stat(
		path: string,
		options?: { followSymlinks?: boolean },
	): Promise<ExtensionStorageResult<ExtensionStorageStat>> {
		try {
			if (options?.followSymlinks === false) {
				const lexical = this.#lexical(path);
				if (!lexical.ok) return lexical;
				const value = await lstat(lexical.value);
				if (value.isSymbolicLink()) {
					return { ok: true, value: { kind: "symlink", size: value.size } };
				}
			}
			const canonical = await this.#canonical(path);
			if (!canonical.ok) return canonical;
			const value = await stat(canonical.value);
			return { ok: true, value: { kind: kind(value), size: value.size } };
		} catch (error) {
			return failure(error);
		}
	}

	public async readDirectory(path: string) {
		try {
			const canonical = await this.#canonical(path);
			if (!canonical.ok) return canonical;
			const entries = await readdir(canonical.value, { withFileTypes: true });
			const repeated = await this.#canonical(path);
			if (!repeated.ok || repeated.value !== canonical.value) {
				return { ok: false as const, code: "denied" as const, message: "extension inspection directory changed during read" };
			}
			return {
				ok: true as const,
				value: entries.map((entry) => ({ name: entry.name, kind: kind(entry) })),
			};
		} catch (error) {
			return failure(error);
		}
	}

	public async readFile(path: string, maxBytes: number) {
		if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
			return { ok: false as const, code: "io" as const, message: "extension inspection byte bound is invalid" };
		}
		let handle: Awaited<ReturnType<typeof open>> | undefined;
		try {
			const canonical = await this.#canonical(path);
			if (!canonical.ok) return canonical;
			const before = await stat(canonical.value);
			if (!before.isFile()) return { ok: false as const, code: "io" as const, message: "extension inspection target is not a file" };
			if (before.size > maxBytes) return { ok: false as const, code: "oversize" as const, message: "extension inspection file exceeds byte bound" };
			handle = await open(canonical.value, constants.O_RDONLY | constants.O_NOFOLLOW);
			const opened = await handle.stat();
			if (!opened.isFile() || opened.size > maxBytes) {
				return { ok: false as const, code: opened.size > maxBytes ? "oversize" as const : "io" as const, message: "extension inspection file changed or exceeds byte bound" };
			}
			const repeated = await this.#canonical(path);
			if (!repeated.ok || repeated.value !== canonical.value) {
				return { ok: false as const, code: "denied" as const, message: "extension inspection target changed during read" };
			}
			return { ok: true as const, value: await handle.readFile() };
		} catch (error) {
			return failure(error);
		} finally {
			await handle?.close().catch(() => undefined);
		}
	}

	public async writeFileAtomic(): Promise<ExtensionStorageResult<void>> {
		return {
			ok: false,
			code: "denied",
			message: "discovery-only extension storage does not permit writes",
		};
	}
}
