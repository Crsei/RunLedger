/**
 * Host cold-replay 的 workspace binding。
 *
 * 绝对路径只留在 canonical home 下的 private state；Runtime public ref 只
 * 暴露 digest 和 identity。读取只接受当前 version=1，不猜测旧形状。
 */

import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { runtimePathFlavor as runtimePlatformPathFlavor } from "../workspace/runtime-platform.ts";
import {
	isContainedRuntimePath,
	isRuntimeDigest,
	isRuntimeId,
	isWorkspaceBindingRef,
	isWorkspaceLeaseRef,
	createRuntimeId,
	canonicalJson,
	runtimeDigest,
	type RepositoryId,
	type RuntimeDigest,
	type RunledgerLayout,
	type WorkspaceBindingRef,
	type WorkspaceId,
	type WorkspaceLeaseRef,
} from "../runtime/contracts/public.ts";
import { encodePrivateLocator, parsePath, validateLocatorForPlatform } from "../workspace/path-adapter.ts";
import { runtimeWorkspacePlatform } from "../workspace/runtime-platform.ts";
import type { PrivateLocatorV1, WorkspacePlatform } from "../workspace/types.ts";
import type { WorktreeRecord } from "./types.ts";
import { NodeWorkspaceBindingStorage } from "../storage/worktree-binding-storage.ts";

export interface PersistedWorkspaceBinding {
	readonly version: 1;
	readonly binding: WorkspaceBindingRef;
	readonly worktreeId: string;
	readonly sourceRepositoryPath: string;
	readonly sourceSubdir: string;
	readonly worktreePath: string;
	/** P5：versioned private locator（ADR D4）；cold replay 只凭它恢复身份，不直接信任字符串。 */
	readonly worktreeLocator: PrivateLocatorV1;
	readonly effectiveCwd: string;
	readonly baseCommit: string;
	readonly headCommit?: string;
	readonly lease: WorkspaceLeaseRef;
	readonly bindingDigest: RuntimeDigest;
}

export interface WorkspaceBindingObservation {
	readonly workspaceId: WorkspaceId;
	readonly repositoryId: RepositoryId;
	readonly worktreeId: string;
	readonly sourceSubdir: string;
	readonly worktreePath: string;
	readonly effectiveCwd: string;
	readonly baseCommit: string;
	readonly headCommit?: string;
}

export type WorkspaceBindingErrorCode =
	| "binding_invalid"
	| "binding_not_found"
	| "binding_stale"
	| "binding_drift"
	| "binding_migration_required";

export interface WorkspaceBindingError {
	readonly code: WorkspaceBindingErrorCode;
	readonly message: string;
	readonly retryable: boolean;
}

export type WorkspaceBindingResult<T> =
	| { readonly ok: true; readonly value: T }
	| { readonly ok: false; readonly error: WorkspaceBindingError };

export interface CreatePersistedWorkspaceBindingInput {
	readonly record: WorktreeRecord;
	readonly lease: WorktreeLeaseRecordLike;
	readonly effectiveCwd?: string;
	readonly headCommit?: string;
	/** 生成 worktreeLocator 的平台；缺省取当前运行时平台。 */
	readonly platform?: WorkspacePlatform;
}

type WorktreeLeaseRecordLike = WorkspaceLeaseRef;

export interface JsonWorkspaceBindingStoreOptions {
	readonly layout: RunledgerLayout;
	readonly workspaceStorageKey: string;
	readonly storage?: WorkspaceBindingStoragePort;
}

export interface WorkspaceBindingStorageEntry {
	readonly name: string;
	readonly isDirectory: boolean;
	readonly isSymbolicLink: boolean;
	readonly isFile?: boolean;
}

/** Canonical-home storage port; Node filesystem details live in src/storage. */
export interface WorkspaceBindingStoragePort {
	read(path: string): Promise<string | undefined>;
	writeAtomic(path: string, content: string, modes: { readonly fileMode: number; readonly directoryMode: number }): Promise<void>;
	remove(path: string): Promise<void>;
	list(path: string): Promise<readonly WorkspaceBindingStorageEntry[] | undefined>;
	inspect(path: string): Promise<WorkspaceBindingStorageEntry | undefined>;
}

export interface DiscoveredWorkspaceBinding {
	readonly workspaceStorageKey: string;
	readonly binding: PersistedWorkspaceBinding;
}

function failure<T>(code: WorkspaceBindingErrorCode, message: string, retryable = false): WorkspaceBindingResult<T> {
	return { ok: false, error: { code, message, retryable } };
}

function sameDigest(left: RuntimeDigest, right: RuntimeDigest): boolean {
	return left.algorithm === right.algorithm && left.digest === right.digest;
}

function canonicalAbsolutePath(value: string): boolean {
	return isAbsolute(value) && resolve(value) === value && !value.includes("\0") && !value.includes("\n") && !value.includes("\r");
}

function relativeSubdir(value: string): boolean {
	if (value === "" || value === ".") return true;
	if (isAbsolute(value) || value.includes("\0") || value.includes("\n") || value.includes("\r")) return false;
	const offset = relative("/", resolve("/", value));
	return offset === value && !offset.split(sep).includes("..");
}

function validCommit(value: string): boolean {
	return /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(value);
}

function effectivePathWithin(worktreePath: string, effectiveCwd: string): boolean {
	const offset = relative(worktreePath, effectiveCwd);
	return offset === "" || (!offset.startsWith(`..${sep}`) && offset !== ".." && !isAbsolute(offset));
}

function bindingBody(binding: Omit<PersistedWorkspaceBinding, "bindingDigest">): Omit<PersistedWorkspaceBinding, "bindingDigest"> {
	return binding;
}

function worktreeRefDigest(input: Pick<PersistedWorkspaceBinding, "worktreeId" | "worktreePath" | "baseCommit">): RuntimeDigest {
	return runtimeDigest({ worktreeId: input.worktreeId, worktreePath: input.worktreePath, baseCommit: input.baseCommit });
}

export function createPersistedWorkspaceBinding(
	input: CreatePersistedWorkspaceBindingInput,
): WorkspaceBindingResult<PersistedWorkspaceBinding> {
	const record = input.record;
	if (record.state !== "ready" && record.state !== "active" && record.state !== "retained") return failure("binding_invalid", "workspace binding requires a ready worktree");
	if (!isWorkspaceLeaseRef(input.lease) || input.lease.workspaceId !== record.workspaceId || input.lease.state !== "active") return failure("binding_invalid", "workspace binding requires an active matching lease");
	if (!canonicalAbsolutePath(record.sourceRepositoryPath) || !canonicalAbsolutePath(record.worktreeLocator)) return failure("binding_invalid", "workspace binding paths are not canonical absolute paths");
	if (!relativeSubdir(record.sourceSubdir) || !relativeSubdir(record.effectiveSubdir)) return failure("binding_invalid", "workspace binding subdir escapes its repository");
	if (!validCommit(record.baseCommit)) return failure("binding_invalid", "workspace binding base commit is invalid");
	const platform = input.platform ?? runtimeWorkspacePlatform();
	const worktreePathIdentity = parsePath(record.worktreeLocator, platform);
	if (!worktreePathIdentity.ok) return failure("binding_invalid", worktreePathIdentity.error.message);
	const worktreeLocator = encodePrivateLocator(worktreePathIdentity.value, platform);
	const effectiveCwd = resolve(input.effectiveCwd ?? join(record.worktreeLocator, record.effectiveSubdir === "." ? "" : record.effectiveSubdir));
	if (input.effectiveCwd !== undefined && !canonicalAbsolutePath(input.effectiveCwd)) return failure("binding_invalid", "workspace binding effective cwd must be a canonical absolute path");
	if (!effectivePathWithin(record.worktreeLocator, effectiveCwd)) return failure("binding_invalid", "workspace binding effective cwd escapes the worktree");
	const headCommit = input.headCommit;
	if (headCommit !== undefined && !validCommit(headCommit)) return failure("binding_invalid", "workspace binding head commit is invalid");
	const base: Omit<PersistedWorkspaceBinding, "bindingDigest"> = {
		version: 1,
		binding: {
			workspaceId: record.workspaceId,
			repositoryId: record.sourceRepositoryRef.repositoryId,
			bindingKind: "managed_worktree",
			effectiveCwdDigest: runtimeDigest(effectiveCwd),
			baseCommit: record.baseCommit,
			...(headCommit === undefined ? {} : { headCommit }),
			worktreeRef: { subjectKind: "receipt", digest: worktreeRefDigest({ worktreeId: record.id, worktreePath: record.worktreeLocator, baseCommit: record.baseCommit }) },
		},
		worktreeId: record.id,
		sourceRepositoryPath: record.sourceRepositoryPath,
		sourceSubdir: record.sourceSubdir,
		worktreePath: record.worktreeLocator,
		worktreeLocator,
		effectiveCwd,
		baseCommit: record.baseCommit,
		...(headCommit === undefined ? {} : { headCommit }),
		lease: input.lease,
	};
	const result: PersistedWorkspaceBinding = { ...base, bindingDigest: runtimeDigest(bindingBody(base)) };
	return validatePersistedWorkspaceBinding(result);
}

export function validatePersistedWorkspaceBinding(value: unknown): WorkspaceBindingResult<PersistedWorkspaceBinding> {
	if (!isRecord(value) || value.version !== 1 || !isRecord(value.binding) || !isWorkspaceBindingRef(value.binding) ||
		!isRecord(value.lease) || !isWorkspaceLeaseRef(value.lease) || typeof value.worktreeId !== "string" || value.worktreeId.length === 0 ||
		typeof value.sourceRepositoryPath !== "string" || typeof value.sourceSubdir !== "string" || typeof value.worktreePath !== "string" ||
		typeof value.effectiveCwd !== "string" || typeof value.baseCommit !== "string" || !isRuntimeDigest(value.bindingDigest)) {
		return failure("binding_migration_required", "workspace binding is a legacy record without the current locator shape; read-only audit required before use");
	}
	if (!isRecord(value.worktreeLocator)) return failure("binding_migration_required", "workspace binding is a legacy record without a versioned worktree locator");
	const candidate = value as unknown as PersistedWorkspaceBinding;
	const locatorChecked = validateLocatorForPlatform(candidate.worktreeLocator, runtimeWorkspacePlatform());
	if (!locatorChecked.ok) return failure("binding_migration_required", `workspace binding locator ${locatorChecked.error.code}: ${locatorChecked.error.message}`);
	const locatorPath = parsePath(candidate.worktreeLocator.path, candidate.worktreeLocator.platform);
	if (!locatorPath.ok || locatorPath.value.displayPath !== candidate.worktreePath) return failure("binding_invalid", "workspace binding locator path does not match its worktree path");
	const expectedRepositoryId = createRuntimeId("repository", runtimeDigest(candidate.sourceRepositoryPath).digest.slice(0, 48));
	if (!isRuntimeId(candidate.worktreeId, "workspace") || !canonicalAbsolutePath(candidate.sourceRepositoryPath) || !canonicalAbsolutePath(candidate.worktreePath) ||
		!canonicalAbsolutePath(candidate.effectiveCwd) || !relativeSubdir(candidate.sourceSubdir) || !validCommit(candidate.baseCommit) ||
		(candidate.headCommit !== undefined && !validCommit(candidate.headCommit)) || candidate.lease.state !== "active" ||
		candidate.lease.workspaceId !== candidate.binding.workspaceId || candidate.binding.baseCommit !== candidate.baseCommit ||
		!sameDigest(candidate.binding.effectiveCwdDigest, runtimeDigest(candidate.effectiveCwd)) ||
		!effectivePathWithin(candidate.worktreePath, candidate.effectiveCwd) || candidate.binding.workspaceId !== candidate.lease.workspaceId ||
		candidate.binding.bindingKind !== "managed_worktree" || candidate.binding.repositoryId !== expectedRepositoryId ||
		(candidate.binding.headCommit !== undefined && candidate.binding.headCommit !== candidate.headCommit) ||
		candidate.binding.worktreeRef?.digest.digest !== worktreeRefDigest(candidate).digest) {
		return failure("binding_invalid", "workspace binding identity, path, lease, or digest is invalid");
	}
	const { bindingDigest: _bindingDigest, ...body } = candidate;
	if (!sameDigest(candidate.bindingDigest, runtimeDigest(body))) return failure("binding_invalid", "workspace binding digest is invalid");
	return { ok: true, value: candidate };
}

export function validateWorkspaceBindingObservation(
	binding: PersistedWorkspaceBinding,
	observation: WorkspaceBindingObservation,
): WorkspaceBindingResult<PersistedWorkspaceBinding> {
	const valid = validatePersistedWorkspaceBinding(binding);
	if (!valid.ok) return valid;
	const fields: readonly [string, string | undefined, string | undefined][] = [
		["workspace identity", observation.workspaceId, binding.binding.workspaceId],
		["repository identity", observation.repositoryId, binding.binding.repositoryId],
		["worktree identity", observation.worktreeId, binding.worktreeId],
		["source subdir", observation.sourceSubdir, binding.sourceSubdir],
		["worktree path", observation.worktreePath, binding.worktreePath],
		["effective cwd digest", runtimeDigest(observation.effectiveCwd).digest, binding.binding.effectiveCwdDigest.digest],
		["base commit", observation.baseCommit, binding.baseCommit],
	];
	for (const [name, actual, expected] of fields) if (actual !== expected) return failure("binding_drift", `workspace binding ${name} drifted`);
	if (observation.headCommit !== undefined && observation.headCommit !== binding.headCommit) return failure("binding_drift", "workspace binding head commit drifted");
	return valid;
}

export class JsonWorkspaceBindingStore {
	readonly #filePath: string;
	readonly #storage: WorkspaceBindingStoragePort;

	public constructor(options: JsonWorkspaceBindingStoreOptions) {
		if (!/^ws-[a-f0-9]{64}$/u.test(options.workspaceStorageKey)) throw new Error("workspace binding storage key is invalid");
		const home = resolve(options.layout.home);
		const filePath = resolve(join(options.layout.state, "hosts", options.workspaceStorageKey, "workspace-binding.json"));
		if (!canonicalAbsolutePath(home) || !isContainedRuntimePath(home, filePath, runtimePlatformPathFlavor())) throw new Error("workspace binding store must remain below canonical runledgerHome");
		this.#filePath = filePath;
		this.#storage = options.storage ?? NodeWorkspaceBindingStorage.fromLayout(options.layout);
	}

	public get filePath(): string {
		return this.#filePath;
	}

	public async read(): Promise<PersistedWorkspaceBinding | undefined> {
		const content = await this.#storage.read(this.#filePath);
		if (content === undefined) return undefined;
		let value: unknown;
		try {
			value = JSON.parse(content) as unknown;
		} catch {
			throw new Error("workspace binding journal is invalid JSON");
		}
		const checked = validatePersistedWorkspaceBinding(value);
		if (!checked.ok) throw new Error(checked.error.message);
		return checked.value;
	}

	public async commit(binding: PersistedWorkspaceBinding, expectedBindingDigest?: RuntimeDigest): Promise<WorkspaceBindingResult<PersistedWorkspaceBinding>> {
		const checked = validatePersistedWorkspaceBinding(binding);
		if (!checked.ok) return checked;
		const current = await this.read();
		if (expectedBindingDigest === undefined ? current !== undefined : current === undefined || !sameDigest(current.bindingDigest, expectedBindingDigest)) return failure("binding_stale", "workspace binding compare-and-set revision is stale");
		await this.#storage.writeAtomic(this.#filePath, `${canonicalJson(binding)}\n`, { fileMode: 0o600, directoryMode: 0o700 });
		return { ok: true, value: checked.value };
	}

	/** Removes one current-format binding only when its digest still matches. */
	public async remove(expectedBindingDigest: RuntimeDigest): Promise<WorkspaceBindingResult<PersistedWorkspaceBinding | undefined>> {
		const current = await this.read();
		if (current === undefined) return { ok: true, value: undefined };
		if (!sameDigest(current.bindingDigest, expectedBindingDigest)) return failure("binding_stale", "workspace binding compare-and-set revision is stale");
		await this.#storage.remove(this.#filePath);
		return { ok: true, value: current };
	}

	public async validate(observation: WorkspaceBindingObservation): Promise<WorkspaceBindingResult<PersistedWorkspaceBinding>> {
		const binding = await this.read();
		return binding === undefined ? failure("binding_not_found", "workspace binding is not persisted") : validateWorkspaceBindingObservation(binding, observation);
	}
}

/**
 * Finds the current exact binding for a worktree cwd without inventing a
 * second index. Host storage keys are derived from the binding identity, but
 * the identity is not knowable until the private binding is read. Discovery
 * therefore scans only canonical host directories and rejects ambiguity or
 * malformed current-format records instead of guessing.
 */
export async function discoverPersistedWorkspaceBinding(options: {
	readonly layout: RunledgerLayout;
	readonly cwd: string;
	readonly storage?: WorkspaceBindingStoragePort;
}): Promise<DiscoveredWorkspaceBinding | undefined> {
	const home = resolve(options.layout.home);
	const hostsRoot = resolve(options.layout.state, "hosts");
	if (!canonicalAbsolutePath(home) || !isContainedRuntimePath(home, hostsRoot, runtimePlatformPathFlavor())) {
		throw new Error("workspace binding discovery must remain below canonical runledgerHome");
	}
	const storage = options.storage ?? NodeWorkspaceBindingStorage.fromLayout(options.layout);
	const entries = await storage.list(hostsRoot);
	if (entries === undefined) return undefined;
	const cwd = resolve(options.cwd);
	const matches: DiscoveredWorkspaceBinding[] = [];
	for (const entry of entries) {
		if (!/^ws-[a-f0-9]{64}$/u.test(entry.name)) continue;
		const directory = resolve(hostsRoot, entry.name);
		if (!entry.isDirectory || entry.isSymbolicLink) throw new Error("workspace binding host directory is not canonical");
		const filePath = join(directory, "workspace-binding.json");
		const fileInfo = await storage.inspect(filePath);
		if (fileInfo === undefined) continue;
		if (fileInfo.isFile !== true || fileInfo.isSymbolicLink) throw new Error("workspace binding file is not canonical");
		const binding = await new JsonWorkspaceBindingStore({ layout: options.layout, workspaceStorageKey: entry.name, storage }).read();
		if (binding === undefined) continue;
		if (resolve(binding.effectiveCwd) !== cwd) continue;
		matches.push({ workspaceStorageKey: entry.name, binding });
	}
	if (matches.length > 1) throw new Error("workspace binding discovery is ambiguous");
	return matches[0];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
