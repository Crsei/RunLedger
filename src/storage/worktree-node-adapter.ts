/** Worktree 端口的 Node 实现；raw fs/process 只存在于 storage composition 边界。 */

import { spawn } from "node:child_process";
import { constants } from "node:fs";
import {
	chmod,
	lstat,
	mkdir,
	open,
	readFile,
	readlink,
	realpath,
	rename,
	rm,
	symlink,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import lockfile from "proper-lockfile";
import { canonicalDigest } from "../runtime/protocol/v3/canonical-json.ts";
import type { CommandId } from "../runtime/protocol/v3/ids.ts";
import type {
	GitCommandPort,
	GitCommandRequest,
	GitCommandResult,
	WorktreeCheckpointEffectPort,
	WorktreeCheckpointEffectRecord,
	WorktreeContentEntry,
	WorktreeContentPort,
	WorktreeFileSystemPort,
} from "../worktree/ports.ts";
import type { WorktreeResult } from "../worktree/types.ts";

function pathWithin(root: string, target: string): boolean {
	const offset = relative(resolve(root), resolve(target));
	return offset === "" || (!offset.startsWith(`..${sep}`) && offset !== ".." && !isAbsolute(offset));
}

function pathFailure(message: string): WorktreeResult<never> {
	return { ok: false, error: { code: "outside_managed_root", message, retryable: false } };
}

function relativeSegments(value: string): readonly string[] | undefined {
	if (value.length === 0 || value.includes("\0") || isAbsolute(value) || value.includes("\\")) return undefined;
	const segments = value.split("/");
	return segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..")
		? segments
		: undefined;
}

async function canonicalRoot(root: string): Promise<string> {
	const canonical = resolve(await realpath(root));
	const stats = await lstat(canonical);
	if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error("workspace root is not a canonical directory");
	return canonical;
}

async function safeParent(root: string, segments: readonly string[], create: boolean): Promise<string> {
	let current = root;
	for (const segment of segments.slice(0, -1)) {
		const next = join(current, segment);
		try {
			const stats = await lstat(next);
			if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error("workspace path has a non-directory or symlink parent");
		} catch (cause) {
			const code = cause instanceof Error && "code" in cause ? String(cause.code) : undefined;
			if (!create || code !== "ENOENT") throw cause;
			await mkdir(next, { mode: 0o700 });
		}
		const canonical = resolve(await realpath(next));
		if (!pathWithin(root, canonical) || canonical !== resolve(next)) throw new Error("workspace path parent escaped its root");
		current = canonical;
	}
	return current;
}

export class NodeGitCommandPort implements GitCommandPort {
	public run(request: GitCommandRequest, signal?: AbortSignal): Promise<GitCommandResult> {
		return new Promise((resolveResult, reject) => {
			const child = spawn("git", request.arguments, {
				cwd: request.cwd,
				env: { ...process.env, ...(request.environment ?? {}) },
				stdio: ["pipe", "pipe", "pipe"],
			});
			const stdout: Buffer[] = [];
			const stderr: Buffer[] = [];
			let settled = false;
			let timedOut = false;
			const finishError = (cause: Error) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				signal?.removeEventListener("abort", abort);
				reject(cause);
			};
			const abort = () => child.kill("SIGTERM");
			const timer = setTimeout(() => {
				timedOut = true;
				child.kill("SIGKILL");
			}, request.timeoutMs);
			signal?.addEventListener("abort", abort, { once: true });
			child.stdout.on("data", (chunk: Buffer) => stdout.push(Buffer.from(chunk)));
			child.stderr.on("data", (chunk: Buffer) => stderr.push(Buffer.from(chunk)));
			child.stdin.on("error", (cause: NodeJS.ErrnoException) => {
				// Git 可在父进程结束 stdin 前完成只读命令；EPIPE 只表示子进程已不再读取。
				if (cause.code !== "EPIPE") finishError(cause);
			});
			child.once("error", finishError);
			child.once("close", (code, closeSignal) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				signal?.removeEventListener("abort", abort);
				const stdoutBytes = Buffer.concat(stdout);
				resolveResult({
					stdout: stdoutBytes.toString("utf8"),
					stdoutBytes: Uint8Array.from(stdoutBytes),
					stderr: Buffer.concat(stderr).toString("utf8"),
					exitCode: timedOut ? 124 : code ?? 1,
					signaled: timedOut || closeSignal !== null || signal?.aborted === true,
				});
			});
			child.stdin.end(request.stdin ?? "");
		});
	}
}

export const nodeWorktreeFileSystem: WorktreeFileSystemPort = {
	realpath,
	stat: async (path) => {
		try {
			const value = await lstat(path);
			return { exists: true, isDirectory: value.isDirectory(), isSymbolicLink: value.isSymbolicLink() };
		} catch (cause) {
			if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") {
				return { exists: false, isDirectory: false, isSymbolicLink: false };
			}
			throw cause;
		}
	},
	mkdir: async (path) => { await mkdir(path, { recursive: true, mode: 0o700 }); },
	rm: async (path) => { await rm(path, { recursive: true, force: false }); },
};

export class NodeWorktreeContentPort implements WorktreeContentPort {
	public async read(root: string, relativePath: string): Promise<WorktreeResult<WorktreeContentEntry>> {
		const segments = relativeSegments(relativePath);
		if (!segments) return pathFailure("workspace entry path is not a safe relative path");
		try {
			const canonical = await canonicalRoot(root);
			const parent = await safeParent(canonical, segments, false);
			const target = join(parent, segments.at(-1)!);
			if (!pathWithin(canonical, target)) return pathFailure("workspace entry escaped its root");
			const stats = await lstat(target);
			if (stats.isSymbolicLink()) {
				return { ok: true, value: { kind: "symlink", mode: "120000", target: await readlink(target) } };
			}
			if (!stats.isFile()) return pathFailure("workspace entry is not a regular file or symlink");
			const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
			try {
				return {
					ok: true,
					value: {
						kind: "regular",
						mode: (stats.mode & 0o111) === 0 ? "100644" : "100755",
						content: Uint8Array.from(await handle.readFile()),
					},
				};
			} finally {
				await handle.close();
			}
		} catch (cause) {
			return pathFailure(cause instanceof Error ? cause.message : "workspace entry could not be read safely");
		}
	}

	public async replace(root: string, relativePath: string, entry: WorktreeContentEntry): Promise<WorktreeResult<void>> {
		const segments = relativeSegments(relativePath);
		if (!segments) return pathFailure("workspace entry path is not a safe relative path");
		let temporary: string | undefined;
		try {
			const canonical = await canonicalRoot(root);
			const parent = await safeParent(canonical, segments, true);
			const target = join(parent, segments.at(-1)!);
			if (!pathWithin(canonical, target)) return pathFailure("workspace entry escaped its root");
			temporary = join(parent, `.${basename(target)}.${randomUUID()}.partial`);
			if (entry.kind === "symlink") {
				await symlink(entry.target, temporary);
			} else {
				const mode = entry.mode === "100755" ? 0o755 : 0o644;
				const handle = await open(
					temporary,
					constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
					mode,
				);
				try {
					await handle.writeFile(entry.content);
					await handle.sync();
				} finally {
					await handle.close();
				}
				await chmod(temporary, mode);
			}
			await rename(temporary, target);
			temporary = undefined;
			return { ok: true, value: undefined };
		} catch (cause) {
			if (temporary) await rm(temporary, { force: true }).catch(() => undefined);
			return pathFailure(cause instanceof Error ? cause.message : "workspace entry could not be replaced safely");
		}
	}
}

interface EffectFileState {
	version: 1;
	records: Readonly<Record<string, WorktreeCheckpointEffectRecord>>;
}

function emptyEffectState(): EffectFileState {
	return { version: 1, records: {} };
}

export class FileWorktreeCheckpointEffectPort implements WorktreeCheckpointEffectPort {
	readonly #filePath: string;

	public constructor(filePath: string) {
		this.#filePath = resolve(filePath);
	}

	async #ensure(): Promise<void> {
		await mkdir(dirname(this.#filePath), { recursive: true, mode: 0o700 });
		try {
			await lstat(this.#filePath);
		} catch (cause) {
			if (!(cause instanceof Error && "code" in cause && cause.code === "ENOENT")) throw cause;
			const handle = await open(this.#filePath, "wx", 0o600);
			try {
				await handle.writeFile(JSON.stringify(emptyEffectState()));
				await handle.sync();
			} finally {
				await handle.close();
			}
		}
	}

	async #withLock<T>(operation: (state: EffectFileState) => Promise<{ value: T; next?: EffectFileState }>): Promise<T> {
		await this.#ensure();
		const release = await lockfile.lock(this.#filePath, { realpath: false, retries: { retries: 5, minTimeout: 20, maxTimeout: 200 } });
		try {
			const parsed = JSON.parse(await readFile(this.#filePath, "utf8")) as unknown;
			if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed) || (parsed as { version?: unknown }).version !== 1) {
				throw new Error("worktree checkpoint effect journal is corrupted");
			}
			const state = parsed as EffectFileState;
			const result = await operation(state);
			if (result.next) {
				const temporary = `${this.#filePath}.${randomUUID()}.partial`;
				const handle = await open(temporary, "wx", 0o600);
				try {
					await handle.writeFile(JSON.stringify(result.next));
					await handle.sync();
				} finally {
					await handle.close();
				}
				await rename(temporary, this.#filePath);
			}
			return result.value;
		} finally {
			await release();
		}
	}

	public read(effectId: CommandId): Promise<WorktreeCheckpointEffectRecord | undefined> {
		return this.#withLock(async (state) => ({ value: state.records[effectId] }));
	}

	public begin(record: WorktreeCheckpointEffectRecord): Promise<"applied" | "replay" | "conflict"> {
		return this.#withLock(async (state) => {
			const existing = state.records[record.intent.effectId];
			if (existing) return { value: existing.recordDigest === record.recordDigest ? "replay" : "conflict" };
			return {
				value: "applied",
				next: { version: 1, records: { ...state.records, [record.intent.effectId]: record } },
			};
		});
	}

	public complete(
		effectId: CommandId,
		expectedRequestDigest: string,
		record: WorktreeCheckpointEffectRecord,
	): Promise<"applied" | "replay" | "conflict"> {
		return this.#withLock(async (state) => {
			const existing = state.records[effectId];
			if (!existing || existing.intent.requestDigest !== expectedRequestDigest) return { value: "conflict" };
			if (existing.receipt) return { value: existing.recordDigest === record.recordDigest ? "replay" : "conflict" };
			if (canonicalDigest(existing.intent) !== canonicalDigest(record.intent)) return { value: "conflict" };
			return {
				value: "applied",
				next: { version: 1, records: { ...state.records, [effectId]: record } },
			};
		});
	}
}
