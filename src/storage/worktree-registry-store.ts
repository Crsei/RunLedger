/** Worktree registry 的 Node append-only storage adapter。 */

import { appendFile, chmod, lstat, mkdir, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import lockfile from "proper-lockfile";
import {
	isContainedRuntimePath,
	RUNLEDGER_DIRECTORY_MODE,
	RUNLEDGER_FILE_MODE,
	 type RunledgerLayout,
} from "../runtime/contracts/public.ts";
import type {
	JsonlWorktreeRegistryStoreOptions,
	WorktreeRegistryStore,
} from "../worktree/registry.ts";

export class NodeJsonlWorktreeRegistryStore implements WorktreeRegistryStore {
	readonly #home: string;
	readonly #stateDirectory: string;
	readonly #directoryPath: string;
	readonly #filePath: string;
	readonly #lockPath: string;
	readonly #retries: number;
	readonly #retryDelayMs: number;
	readonly #staleMs: number;

	public constructor(layout: RunledgerLayout, options: JsonlWorktreeRegistryStoreOptions = {}) {
		const home = resolve(layout.home);
		const stateDirectory = resolve(layout.state);
		const expectedStateDirectory = resolve(home, "state");
		if (!isAbsolute(layout.home) || stateDirectory !== expectedStateDirectory || !isContainedRuntimePath(home, stateDirectory, runtimePathFlavor())) {
			throw new Error("worktree registry layout must use the injected canonical runledgerHome");
		}
		this.#home = home;
		this.#stateDirectory = stateDirectory;
		this.#directoryPath = join(stateDirectory, "worktrees");
		this.#filePath = join(this.#directoryPath, "registry.jsonl");
		this.#lockPath = `${this.#filePath}.lock`;
		if (!isContainedRuntimePath(this.#home, this.#filePath, runtimePathFlavor())) throw new Error("worktree registry path is outside the injected canonical runledgerHome");
		this.#retries = positiveInteger(options.retries, 100);
		this.#retryDelayMs = nonNegativeInteger(options.retryDelayMs, 50);
		this.#staleMs = Math.max(2_000, positiveInteger(options.staleMs, 10_000));
	}

	public get directoryPath(): string { return this.#directoryPath; }
	public get filePath(): string { return this.#filePath; }
	public get lockPath(): string { return this.#lockPath; }

	public async readLines(): Promise<readonly string[]> {
		await this.#ensureReady();
		const content = await readFile(this.#filePath, "utf8");
		return content.split("\n").filter((line) => line.trim().length > 0);
	}

	public async appendLine(line: string): Promise<void> {
		if (line.includes("\n") || line.includes("\r")) throw new Error("worktree registry event must occupy one JSONL line");
		await this.#ensureReady();
		await appendFile(this.#filePath, `${line}\n`, { encoding: "utf8", mode: RUNLEDGER_FILE_MODE });
		await chmod(this.#filePath, RUNLEDGER_FILE_MODE);
	}

	public async withLock<T>(operation: () => Promise<T>): Promise<T> {
		await this.#ensureReady();
		let release: (() => Promise<void>) | undefined;
		let lastError: unknown;
		for (let attempt = 0; attempt < this.#retries; attempt += 1) {
			try {
				release = await lockfile.lock(this.#filePath, { retries: 0, stale: this.#staleMs, realpath: false, lockfilePath: this.#lockPath });
				break;
			} catch (error) {
				lastError = error;
				if (attempt + 1 < this.#retries) await delay(this.#retryDelayMs);
			}
		}
		if (!release) throw lastError instanceof Error ? lastError : new Error("unable to acquire worktree registry lock");
		try {
			await hardenLockDirectory(this.#lockPath, this.#home);
			return await operation();
		} finally {
			await release();
		}
	}

	async #ensureReady(): Promise<void> {
		await ensureCanonicalDirectory(this.#home, this.#home);
		await mkdir(this.#stateDirectory, { recursive: true, mode: RUNLEDGER_DIRECTORY_MODE });
		await ensureCanonicalDirectory(this.#home, this.#stateDirectory);
		await mkdir(this.#directoryPath, { recursive: true, mode: RUNLEDGER_DIRECTORY_MODE });
		await ensureCanonicalDirectory(this.#home, this.#directoryPath);
		await ensureCanonicalFile(this.#home, this.#filePath);
	}
}

function runtimePathFlavor(): "posix" | "win32" { return process.platform === "win32" ? "win32" : "posix"; }
function positiveInteger(value: number | undefined, fallback: number): number { return value === undefined ? fallback : Number.isSafeInteger(value) && value > 0 ? value : fallback; }
function nonNegativeInteger(value: number | undefined, fallback: number): number { return value === undefined ? fallback : Number.isSafeInteger(value) && value >= 0 ? value : fallback; }

async function ensureCanonicalDirectory(home: string, directory: string): Promise<void> {
	if (!isAbsolute(directory) || !isContainedRuntimePath(home, directory, runtimePathFlavor())) throw new Error("worktree registry directory is outside the injected canonical runledgerHome");
	const info = await lstat(directory);
	if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("worktree registry directory must be a canonical directory");
	const actual = resolve(await realpath(directory));
	if (!isContainedRuntimePath(home, actual, runtimePathFlavor())) throw new Error("worktree registry directory resolves outside the injected canonical runledgerHome");
	await chmod(directory, RUNLEDGER_DIRECTORY_MODE);
}

async function ensureCanonicalFile(home: string, filePath: string): Promise<void> {
	if (!isAbsolute(filePath) || !isContainedRuntimePath(home, filePath, runtimePathFlavor())) throw new Error("worktree registry file is outside the injected canonical runledgerHome");
	try {
		const info = await lstat(filePath);
		if (!info.isFile() || info.isSymbolicLink()) throw new Error("worktree registry file must be a canonical regular file");
	} catch (error) {
		if (!(error instanceof Error) || !isNodeError(error, "ENOENT")) throw error;
		await appendFile(filePath, "", { encoding: "utf8", mode: RUNLEDGER_FILE_MODE });
	}
	const info = await lstat(filePath);
	if (!info.isFile() || info.isSymbolicLink()) throw new Error("worktree registry file must be a canonical regular file");
	await chmod(filePath, RUNLEDGER_FILE_MODE);
}

async function hardenLockDirectory(lockPath: string, home: string): Promise<void> {
	if (!isContainedRuntimePath(home, lockPath, runtimePathFlavor())) throw new Error("worktree registry lock is outside the injected canonical runledgerHome");
	const info = await lstat(lockPath);
	if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("worktree registry lock must be a canonical directory");
	await chmod(lockPath, RUNLEDGER_DIRECTORY_MODE);
}

function isNodeError(error: Error, code: string): boolean { return "code" in error && (error as NodeJS.ErrnoException).code === code; }
function delay(milliseconds: number): Promise<void> { return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds)); }
