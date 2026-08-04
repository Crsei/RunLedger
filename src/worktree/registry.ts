/** Worktree append-only registry；所有并发变更在 store lock 内 replay + append。 */

import { appendFile, chmod, lstat, mkdir, readFile, realpath } from "fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import lockfile from "proper-lockfile";
import {
	isCanonicalUtcTimestamp,
	isContainedRuntimePath,
	isRuntimeDigest,
	RUNLEDGER_DIRECTORY_MODE,
	RUNLEDGER_FILE_MODE,
} from "../runtime/contracts/public.ts";
import { isRuntimeId, type RuntimeInstanceId, type SessionId, type WorkspaceId, type RunledgerLayout } from "../runtime/contracts/public.ts";
import type { WorkspaceLeaseRef } from "../runtime/contracts/public.ts";
import { runtimeDigest } from "../runtime/contracts/public.ts";
import type { WorktreeErrorCode, WorktreeLeaseRecord, WorktreeRecord, WorktreeResult, WorktreeState } from "./types.ts";

export interface WorktreeRegistryStore {
	readLines(): Promise<readonly string[]>;
	appendLine(line: string): Promise<void>;
	withLock<T>(operation: () => Promise<T>): Promise<T>;
}

export class MemoryWorktreeRegistryStore implements WorktreeRegistryStore {
	#lines: string[] = [];
	#tail: Promise<void> = Promise.resolve();

	public async readLines(): Promise<readonly string[]> {
		return [...this.#lines];
	}

	public async appendLine(line: string): Promise<void> {
		this.#lines.push(line);
	}

	public async withLock<T>(operation: () => Promise<T>): Promise<T> {
		const previous = this.#tail;
		let release!: () => void;
		this.#tail = new Promise<void>((resolve) => { release = resolve; });
		await previous;
		try {
			return await operation();
		} finally {
			release();
		}
	}
}

export interface JsonlWorktreeRegistryStoreOptions {
	readonly retries?: number;
	readonly retryDelayMs?: number;
	readonly staleMs?: number;
}

/** 真实 append-only registry store；home/layout 由 composition root 注入。 */
export class JsonlWorktreeRegistryStore implements WorktreeRegistryStore {
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
		if (!isContainedRuntimePath(this.#home, this.#filePath, runtimePathFlavor())) {
			throw new Error("worktree registry path is outside the injected canonical runledgerHome");
		}
		this.#retries = positiveInteger(options.retries, 100);
		this.#retryDelayMs = nonNegativeInteger(options.retryDelayMs, 50);
		this.#staleMs = Math.max(2_000, positiveInteger(options.staleMs, 10_000));
	}

	public get directoryPath(): string {
		return this.#directoryPath;
	}

	public get filePath(): string {
		return this.#filePath;
	}

	public get lockPath(): string {
		return this.#lockPath;
	}

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
				release = await lockfile.lock(this.#filePath, {
					retries: 0,
					stale: this.#staleMs,
					realpath: false,
					lockfilePath: this.#lockPath,
				});
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
		await ensureCanonicalDirectory(this.#home, this.#home, false);
		await mkdir(this.#stateDirectory, { recursive: true, mode: RUNLEDGER_DIRECTORY_MODE });
		await ensureCanonicalDirectory(this.#home, this.#stateDirectory, false);
		await mkdir(this.#directoryPath, { recursive: true, mode: RUNLEDGER_DIRECTORY_MODE });
		await ensureCanonicalDirectory(this.#home, this.#directoryPath, false);
		await ensureCanonicalFile(this.#home, this.#filePath);
	}
}

function runtimePathFlavor(): "posix" | "win32" {
	return process.platform === "win32" ? "win32" : "posix";
}

function positiveInteger(value: number | undefined, fallback: number): number {
	return value === undefined ? fallback : Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function nonNegativeInteger(value: number | undefined, fallback: number): number {
	return value === undefined ? fallback : Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

async function ensureCanonicalDirectory(home: string, directory: string, create: boolean): Promise<void> {
	if (!isAbsolute(directory) || !isContainedRuntimePath(home, directory, runtimePathFlavor())) throw new Error("worktree registry directory is outside the injected canonical runledgerHome");
	if (create) await mkdir(directory, { recursive: true, mode: RUNLEDGER_DIRECTORY_MODE });
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

function isNodeError(error: Error, code: string): boolean {
	return "code" in error && (error as NodeJS.ErrnoException).code === code;
}

function delay(milliseconds: number): Promise<void> {
	return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

export type WorktreeRegistryEvent =
	| { readonly sequence: number; readonly type: "worktree.created"; readonly record: WorktreeRecord }
	| { readonly sequence: number; readonly type: "worktree.state"; readonly worktreeId: string; readonly state: WorktreeState; readonly at: number; readonly error?: string }
	| { readonly sequence: number; readonly type: "worktree.touched"; readonly worktreeId: string; readonly at: number }
	| { readonly sequence: number; readonly type: "lease.changed"; readonly lease: WorktreeLeaseRecord };

type WithoutSequence<T> = T extends { readonly sequence: number } ? Omit<T, "sequence"> : never;
type WorktreeRegistryEventInput = WithoutSequence<WorktreeRegistryEvent>;

export interface WorktreeRegistrySnapshot {
	readonly sequence: number;
	readonly records: readonly WorktreeRecord[];
	readonly leases: readonly WorktreeLeaseRecord[];
}

interface RegistryState {
	sequence: number;
	records: Map<string, WorktreeRecord>;
	leases: Map<string, WorktreeLeaseRecord>;
}

interface RegistryTransaction {
	readonly snapshot: WorktreeRegistrySnapshot;
	readonly append: (event: WorktreeRegistryEventInput) => Promise<void>;
}

function failure<T>(code: WorktreeErrorCode, message: string, retryable = false): WorktreeResult<T> {
	return { ok: false, error: { code, message, retryable } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isWorktreeState(value: unknown): value is WorktreeState {
	return ["creating", "ready", "active", "retained", "removing", "removed", "failed"].includes(value as string);
}

function isWorktreeRecord(value: unknown): value is WorktreeRecord {
	if (!isRecord(value)) return false;
	const repositoryRef = value.sourceRepositoryRef;
	const baseCommit = value.baseCommit;
	const sourceRepositoryPath = value.sourceRepositoryPath;
	const worktreeLocator = value.worktreeLocator;
	return typeof value.id === "string" && value.id.length > 0 && isRuntimeId(value.sessionId, "session") && isRuntimeId(value.workspaceId, "workspace") &&
		isRecord(repositoryRef) && isRuntimeId(repositoryRef.repositoryId, "repository") && isRuntimeDigest(repositoryRef.rootDigest) && typeof repositoryRef.displayName === "string" &&
		typeof sourceRepositoryPath === "string" && isAbsolute(sourceRepositoryPath) && typeof value.sourceSubdir === "string" && typeof worktreeLocator === "string" && isAbsolute(worktreeLocator) && typeof value.effectiveSubdir === "string" &&
		typeof value.baseRef === "string" && typeof baseCommit === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(baseCommit) && typeof value.label === "string" && isWorktreeState(value.state) &&
		typeof value.createdAt === "number" && Number.isSafeInteger(value.createdAt) && value.createdAt >= 0 && typeof value.lastAccessedAt === "number" && Number.isSafeInteger(value.lastAccessedAt) && value.lastAccessedAt >= 0 &&
		(value.branch === undefined || typeof value.branch === "string") && (value.error === undefined || typeof value.error === "string");
}

function isLease(value: unknown): value is WorktreeLeaseRecord {
	if (!isRecord(value)) return false;
	return isRuntimeId(value.workspaceId, "workspace") && isRuntimeId(value.ownerRuntimeId, "runtime") && typeof value.leaseRevision === "number" && Number.isSafeInteger(value.leaseRevision) && value.leaseRevision >= 0 &&
		isRuntimeDigest(value.fencingTokenDigest) && ["requested", "active", "released", "stale", "revoked"].includes(value.state as string) &&
		(value.expiresAt === undefined || isCanonicalUtcTimestamp(value.expiresAt));
}

function emptyState(): RegistryState {
	return { sequence: 0, records: new Map(), leases: new Map() };
}

function cloneSnapshot(state: RegistryState): WorktreeRegistrySnapshot {
	return {
		sequence: state.sequence,
		records: [...state.records.values()].sort((left, right) => left.id.localeCompare(right.id)),
		leases: [...state.leases.values()].sort((left, right) => left.workspaceId.localeCompare(right.workspaceId)),
	};
}

function applyEvent(state: RegistryState, event: WorktreeRegistryEvent): void {
	state.sequence = event.sequence;
	switch (event.type) {
		case "worktree.created":
			state.records.set(event.record.id, event.record);
			return;
		case "worktree.state": {
			const current = state.records.get(event.worktreeId);
			if (!current) return;
			const { error: _error, ...withoutError } = current;
			state.records.set(event.worktreeId, { ...withoutError, state: event.state, lastAccessedAt: Math.max(current.lastAccessedAt, event.at), ...(event.error === undefined ? {} : { error: event.error }) });
			return;
		}
		case "worktree.touched": {
			const current = state.records.get(event.worktreeId);
			if (current) state.records.set(event.worktreeId, { ...current, lastAccessedAt: Math.max(current.lastAccessedAt, event.at) });
			return;
		}
		case "lease.changed":
			state.leases.set(event.lease.workspaceId, event.lease);
	}
}

function parseEvent(value: unknown, expectedSequence: number): WorktreeResult<WorktreeRegistryEvent> {
	if (!isRecord(value) || typeof value.sequence !== "number" || !Number.isSafeInteger(value.sequence) || value.sequence !== expectedSequence || typeof value.type !== "string") {
		return failure("registry_failed", "worktree registry sequence or envelope is invalid");
	}
	if (value.type === "worktree.created" && isWorktreeRecord(value.record)) return { ok: true, value: { sequence: value.sequence, type: value.type, record: value.record } };
	if (value.type === "worktree.state" && typeof value.worktreeId === "string" && isWorktreeState(value.state) && typeof value.at === "number" && Number.isSafeInteger(value.at) && (value.error === undefined || typeof value.error === "string")) {
		return { ok: true, value: { sequence: value.sequence, type: value.type, worktreeId: value.worktreeId, state: value.state, at: value.at, ...(value.error === undefined ? {} : { error: value.error }) } };
	}
	if (value.type === "worktree.touched" && typeof value.worktreeId === "string" && typeof value.at === "number" && Number.isSafeInteger(value.at)) {
		return { ok: true, value: { sequence: value.sequence, type: value.type, worktreeId: value.worktreeId, at: value.at } };
	}
	if (value.type === "lease.changed" && isLease(value.lease)) return { ok: true, value: { sequence: value.sequence, type: value.type, lease: value.lease } };
	return failure("registry_failed", "worktree registry event failed schema validation");
}

export class WorktreeRegistry {
	readonly #store: WorktreeRegistryStore;

	public constructor(store: WorktreeRegistryStore) {
		this.#store = store;
	}

	async #readState(): Promise<WorktreeResult<RegistryState>> {
		try {
			const state = emptyState();
			for (const line of await this.#store.readLines()) {
				if (line.trim().length === 0) continue;
				let parsed: unknown;
				try {
					parsed = JSON.parse(line) as unknown;
				} catch {
					return failure("registry_failed", "worktree registry contains invalid JSON");
				}
				const event = parseEvent(parsed, state.sequence + 1);
				if (!event.ok) return event;
				applyEvent(state, event.value);
			}
			return { ok: true, value: state };
		} catch {
			return failure("registry_failed", "worktree registry is unavailable", true);
		}
	}

	public async list(): Promise<WorktreeResult<readonly WorktreeRecord[]>> {
		const state = await this.#readState();
		return state.ok ? { ok: true, value: cloneSnapshot(state.value).records } : state;
	}

	public async get(worktreeId: string): Promise<WorktreeResult<WorktreeRecord>> {
		const state = await this.#readState();
		if (!state.ok) return state;
		const record = state.value.records.get(worktreeId);
		return record ? { ok: true, value: record } : failure("not_found", `worktree not found: ${worktreeId}`);
	}

	public async transact<T>(operation: (transaction: RegistryTransaction) => Promise<WorktreeResult<T>> | WorktreeResult<T>): Promise<WorktreeResult<T>> {
		try {
			return await this.#store.withLock(async () => {
				const state = await this.#readState();
				if (!state.ok) return state;
				const append = async (input: WorktreeRegistryEventInput): Promise<void> => {
					const event = { sequence: state.value.sequence + 1, ...input } as WorktreeRegistryEvent;
					await this.#store.appendLine(JSON.stringify(event));
					applyEvent(state.value, event);
				};
				return operation({ snapshot: cloneSnapshot(state.value), append });
			});
		} catch {
			return failure("registry_failed", "worktree registry transaction failed", true);
		}
	}

	public async create(record: WorktreeRecord): Promise<WorktreeResult<{ readonly record: WorktreeRecord; readonly inserted: boolean }>> {
		return this.transact<{ readonly record: WorktreeRecord; readonly inserted: boolean }>(async ({ snapshot, append }) => {
			const existing = snapshot.records.find((item) => item.worktreeLocator === record.worktreeLocator && item.state !== "removed");
			if (existing) return { ok: true, value: { record: existing, inserted: false } };
			await append({ type: "worktree.created", record });
			return { ok: true, value: { record, inserted: true } };
		});
	}

	public async state(worktreeId: string, state: WorktreeState, at: number, error?: string): Promise<WorktreeResult<WorktreeRecord>> {
		return this.transact(async ({ snapshot, append }) => {
			const current = snapshot.records.find((item) => item.id === worktreeId);
			if (!current) return failure("not_found", `worktree not found: ${worktreeId}`);
			await append({ type: "worktree.state", worktreeId, state, at, ...(error === undefined ? {} : { error }) });
			const next = { ...current, state, lastAccessedAt: Math.max(current.lastAccessedAt, at), ...(error === undefined ? {} : { error }) };
			return { ok: true, value: next };
		});
	}

	public async touch(worktreeId: string, at: number): Promise<WorktreeResult<WorktreeRecord>> {
		return this.transact(async ({ snapshot, append }) => {
			const current = snapshot.records.find((item) => item.id === worktreeId);
			if (!current) return failure("not_found", `worktree not found: ${worktreeId}`);
			await append({ type: "worktree.touched", worktreeId, at });
			return { ok: true, value: { ...current, lastAccessedAt: Math.max(current.lastAccessedAt, at) } };
		});
	}

	public async lease(workspaceId: WorkspaceId): Promise<WorktreeResult<WorktreeLeaseRecord | undefined>> {
		const state = await this.#readState();
		if (!state.ok) return state;
		return { ok: true, value: state.value.leases.get(workspaceId) };
	}

	public async acquireLease(input: { readonly workspaceId: WorkspaceId; readonly ownerRuntimeId: RuntimeInstanceId; readonly now: string; readonly expiresAt: string }): Promise<WorktreeResult<{ readonly lease: WorktreeLeaseRecord; readonly takenOver: boolean }>> {
		return this.transact(async ({ snapshot, append }) => {
			const current = snapshot.leases.find((item) => item.workspaceId === input.workspaceId);
			const expired = current?.state === "active" && current.expiresAt !== undefined && Date.parse(current.expiresAt) <= Date.parse(input.now);
			if (current?.state === "active" && !expired && current.ownerRuntimeId !== input.ownerRuntimeId) return failure("lease_conflict", "workspace lease is held by another runtime");
			if (current?.state === "active" && !expired && current.ownerRuntimeId === input.ownerRuntimeId) return { ok: true, value: { lease: current, takenOver: false } };
			const lease: WorktreeLeaseRecord = {
				workspaceId: input.workspaceId,
				ownerRuntimeId: input.ownerRuntimeId,
				leaseRevision: (current?.leaseRevision ?? 0) + 1,
				fencingTokenDigest: runtimeDigest({ workspaceId: input.workspaceId, ownerRuntimeId: input.ownerRuntimeId, leaseRevision: (current?.leaseRevision ?? 0) + 1, issuedAt: input.now }),
				state: "active",
				expiresAt: input.expiresAt,
			};
			await append({ type: "lease.changed", lease });
			return { ok: true, value: { lease, takenOver: expired === true } };
		});
	}

	public async releaseLease(input: WorkspaceLeaseRef): Promise<WorktreeResult<WorktreeLeaseRecord>> {
		return this.transact(async ({ snapshot, append }) => {
			const current = snapshot.leases.find((item) => item.workspaceId === input.workspaceId);
			if (!current || current.state !== "active" || current.ownerRuntimeId !== input.ownerRuntimeId || current.leaseRevision !== input.leaseRevision || current.fencingTokenDigest.digest !== input.fencingTokenDigest.digest) return failure("lease_stale", "workspace lease fence is stale");
			const released: WorktreeLeaseRecord = { ...current, state: "released" };
			await append({ type: "lease.changed", lease: released });
			return { ok: true, value: released };
		});
	}
}
