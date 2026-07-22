/** Canonical path resolver 与 policy-aware filesystem。所有低层 IO 由 broker 注入。 */

import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { FilesystemAccessOperation, SecurityResult, SecuritySnapshot } from "./types.ts";

export interface BrokerFileStats {
	size: number;
	mtimeMs: number;
	isFile: boolean;
	isDirectory: boolean;
	isSymbolicLink: boolean;
}

export interface FileSystemBrokerPort {
	readFile(path: string): Promise<Buffer>;
	writeFile(path: string, data: string | Buffer): Promise<void>;
	stat(path: string): Promise<BrokerFileStats>;
	lstat(path: string): Promise<BrokerFileStats>;
	realpath(path: string): Promise<string>;
	readdir(path: string): Promise<readonly string[]>;
	mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
	rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;
	rename(from: string, to: string): Promise<void>;
}

export interface CanonicalPathResolution {
	requestedPath: string;
	lexicalPath: string;
	canonicalPath: string;
	existing: boolean;
}

function failure(
	code: "path_escape" | "protected_path" | "invalid_request",
	message: string,
): SecurityResult<never> {
	return { ok: false, error: { code, message, retryable: false } };
}

export function pathWithin(root: string, target: string): boolean {
	const offset = relative(root, target);
	return offset === "" || (!offset.startsWith(`..${sep}`) && offset !== ".." && !isAbsolute(offset));
}

function wildcardPathMatch(pattern: string, target: string): boolean {
	if (!pattern.includes("*")) return pathWithin(pattern, target) || resolve(pattern) === resolve(target);
	const escaped = pattern.replace(/[|\\{}()[\]^$+?.]/g, "\\$&").replaceAll("**", "\u0000").replaceAll("*", `[^${sep === "\\" ? "\\\\" : sep}]*`).replaceAll("\u0000", ".*");
	try {
		return new RegExp(`^${escaped}$`, process.platform === "win32" ? "iu" : "u").test(target);
	} catch {
		return false;
	}
}

export class CanonicalPathResolver {
	readonly #broker: FileSystemBrokerPort;
	readonly #cwd: string;

	public constructor(broker: FileSystemBrokerPort, cwd: string) {
		this.#broker = broker;
		this.#cwd = resolve(cwd);
	}

	public async resolve(requestedPath: string): Promise<SecurityResult<CanonicalPathResolution>> {
		if (!requestedPath || requestedPath.includes("\0")) return failure("invalid_request", "path is empty or contains NUL");
		const lexicalPath = resolve(this.#cwd, requestedPath);
		try {
			const canonicalPath = await this.#broker.realpath(lexicalPath);
			return { ok: true, value: { requestedPath, lexicalPath, canonicalPath: resolve(canonicalPath), existing: true } };
		} catch {
			const suffix: string[] = [];
			let cursor = lexicalPath;
			while (true) {
				const parent = dirname(cursor);
				if (parent === cursor) return failure("invalid_request", "no existing parent could be resolved");
				suffix.unshift(cursor.slice(parent.length).replace(/^[/\\]+/u, ""));
				cursor = parent;
				try {
					const canonicalParent = await this.#broker.realpath(cursor);
					return {
						ok: true,
						value: {
							requestedPath,
							lexicalPath,
							canonicalPath: resolve(canonicalParent, ...suffix),
							existing: false,
						},
					};
				} catch {
					// 继续向上寻找最近存在父目录。
				}
			}
		}
	}
}

export class FileAccessGuard {
	readonly #snapshot: SecuritySnapshot;

	public constructor(snapshot: SecuritySnapshot) {
		this.#snapshot = snapshot;
	}

	public check(operation: FilesystemAccessOperation, path: CanonicalPathResolution): SecurityResult<void> {
		const target = path.canonicalPath;
		if (this.#snapshot.filesystem.protectedPaths.some((entry) => wildcardPathMatch(entry, target))) {
			return failure("protected_path", "filesystem target is protected runtime metadata");
		}
		const denied = operation === "read" ? this.#snapshot.filesystem.denyRead : this.#snapshot.filesystem.denyWrite;
		if (denied.some((entry) => wildcardPathMatch(entry, target))) return failure("protected_path", "filesystem target matches a deny rule");
		if (this.#snapshot.profile.filesystemMode === "unrestricted") return { ok: true, value: undefined };
		const roots = operation === "read" ? this.#snapshot.filesystem.readRoots : this.#snapshot.filesystem.writeRoots;
		if (!roots.some((root) => pathWithin(root, target))) return failure("path_escape", "filesystem target escapes the allowed roots");
		return { ok: true, value: undefined };
	}
}

export class PolicyFileSystem {
	readonly #broker: FileSystemBrokerPort;
	readonly #resolver: CanonicalPathResolver;
	readonly #guard: FileAccessGuard;

	public constructor(broker: FileSystemBrokerPort, cwd: string, snapshot: SecuritySnapshot) {
		this.#broker = broker;
		this.#resolver = new CanonicalPathResolver(broker, cwd);
		this.#guard = new FileAccessGuard(snapshot);
	}

	async #path(operation: FilesystemAccessOperation, requestedPath: string): Promise<SecurityResult<CanonicalPathResolution>> {
		const first = await this.#resolver.resolve(requestedPath);
		if (!first.ok) return first;
		const allowed = this.#guard.check(operation, first.value);
		return allowed.ok ? first : allowed;
	}

	public async readFile(path: string): Promise<SecurityResult<Buffer>> {
		const checked = await this.#path("read", path);
		if (!checked.ok) return checked;
		try {
			const repeated = await this.#path("read", path);
			if (!repeated.ok || repeated.value.canonicalPath !== checked.value.canonicalPath) return failure("path_escape", "filesystem target changed before execution");
			return { ok: true, value: await this.#broker.readFile(repeated.value.canonicalPath) };
		} catch {
			return failure("invalid_request", "filesystem read failed");
		}
	}

	public async writeFile(path: string, data: string | Buffer): Promise<SecurityResult<void>> {
		const checked = await this.#path("write", path);
		if (!checked.ok) return checked;
		try {
			const repeated = await this.#path("write", path);
			if (!repeated.ok || repeated.value.canonicalPath !== checked.value.canonicalPath) return failure("path_escape", "filesystem target changed before execution");
			await this.#broker.writeFile(repeated.value.canonicalPath, data);
			return { ok: true, value: undefined };
		} catch {
			return failure("invalid_request", "filesystem write failed");
		}
	}

	public async stat(path: string): Promise<SecurityResult<BrokerFileStats>> {
		const checked = await this.#path("read", path);
		if (!checked.ok) return checked;
		try {
			return { ok: true, value: await this.#broker.stat(checked.value.canonicalPath) };
		} catch {
			return failure("invalid_request", "filesystem stat failed");
		}
	}

	public async readdir(path: string): Promise<SecurityResult<readonly string[]>> {
		const checked = await this.#path("read", path);
		if (!checked.ok) return checked;
		try {
			return { ok: true, value: await this.#broker.readdir(checked.value.canonicalPath) };
		} catch {
			return failure("invalid_request", "filesystem readdir failed");
		}
	}

	public async mkdir(path: string, options?: { recursive?: boolean }): Promise<SecurityResult<void>> {
		const checked = await this.#path("write", path);
		if (!checked.ok) return checked;
		try {
			await this.#broker.mkdir(checked.value.canonicalPath, options);
			return { ok: true, value: undefined };
		} catch {
			return failure("invalid_request", "filesystem mkdir failed");
		}
	}

	public async rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<SecurityResult<void>> {
		const checked = await this.#path("delete", path);
		if (!checked.ok) return checked;
		try {
			await this.#broker.rm(checked.value.canonicalPath, options);
			return { ok: true, value: undefined };
		} catch {
			return failure("invalid_request", "filesystem removal failed");
		}
	}

	public async rename(from: string, to: string): Promise<SecurityResult<void>> {
		const source = await this.#path("delete", from);
		if (!source.ok) return source;
		const target = await this.#path("write", to);
		if (!target.ok) return target;
		try {
			await this.#broker.rename(source.value.canonicalPath, target.value.canonicalPath);
			return { ok: true, value: undefined };
		} catch {
			return failure("invalid_request", "filesystem rename failed");
		}
	}
}
