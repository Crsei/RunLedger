/** Worktree binding 的 Node canonical-home storage adapter。 */

import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { RunledgerLayout } from "../runtime/contracts/public.ts";
import type {
	WorkspaceBindingStoragePort,
	WorkspaceBindingStorageEntry,
} from "../worktree/persisted-binding.ts";

export class NodeWorkspaceBindingStorage implements WorkspaceBindingStoragePort {
	readonly #home: string;

	public constructor(home: string) {
		if (!isAbsolute(home)) throw new Error("workspace binding storage home must be absolute");
		this.#home = resolve(home);
	}

	public static fromLayout(layout: RunledgerLayout): NodeWorkspaceBindingStorage {
		return new NodeWorkspaceBindingStorage(layout.home);
	}

	public async read(path: string): Promise<string | undefined> {
		this.#assertContained(path);
		try {
			return await readFile(path, "utf8");
		} catch (error) {
			if (isNodeError(error, "ENOENT")) return undefined;
			throw error;
		}
	}

	public async writeAtomic(path: string, content: string, modes: { readonly fileMode: number; readonly directoryMode: number }): Promise<void> {
		this.#assertContained(path);
		const parent = dirname(resolve(path));
		await mkdir(parent, { recursive: true, mode: modes.directoryMode });
		const parentInfo = await lstat(parent);
		if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink() || !this.#contained(await realpath(parent))) {
			throw new Error("workspace binding storage parent is not canonical");
		}
		const existing = await lstat(path).catch(() => undefined);
		if (existing?.isSymbolicLink()) throw new Error("workspace binding target may not be a symlink");
		const temporary = resolve(parent, `.${resolve(path).slice(parent.length + 1)}.${randomUUID()}.tmp`);
		try {
			await writeFile(temporary, content, { encoding: "utf8", flag: "wx", mode: modes.fileMode });
			await rename(temporary, path);
		} finally {
			await unlink(temporary).catch(() => undefined);
		}
	}

	public async remove(path: string): Promise<void> {
		this.#assertContained(path);
		await unlink(path);
	}

	public async list(path: string): Promise<readonly WorkspaceBindingStorageEntry[] | undefined> {
		this.#assertContained(path);
		try {
			const entries = await readdir(path, { withFileTypes: true });
			return entries.map((entry) => ({ name: entry.name, isDirectory: entry.isDirectory(), isSymbolicLink: entry.isSymbolicLink() }));
		} catch (error) {
			if (isNodeError(error, "ENOENT")) return undefined;
			throw error;
		}
	}

	public async inspect(path: string): Promise<WorkspaceBindingStorageEntry | undefined> {
		this.#assertContained(path);
		try {
			const value = await lstat(path);
			return { name: "", isDirectory: value.isDirectory(), isSymbolicLink: value.isSymbolicLink(), isFile: value.isFile() };
		} catch (error) {
			if (isNodeError(error, "ENOENT")) return undefined;
			throw error;
		}
	}

	#assertContained(path: string): void {
		if (!this.#contained(resolve(path))) throw new Error("workspace binding storage path escapes runledgerHome");
	}

	#contained(path: string): boolean {
		const offset = relative(this.#home, resolve(path));
		return offset === "" || (!offset.startsWith("..") && !isAbsolute(offset));
	}
}

function isNodeError(error: unknown, code: string): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
