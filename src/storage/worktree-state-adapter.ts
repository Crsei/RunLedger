/** Worktree registry 与 lease secret 的原子文件存储；损坏或跨 scope 状态一律拒绝。 */

import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
	lstat,
	mkdir,
	open,
	realpath,
	rename,
	rm,
} from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import lockfile from "proper-lockfile";
import { canonicalDigest } from "../runtime/protocol/v3/canonical-json.ts";
import {
	isRuntimeId,
	parseRuntimeId,
	type AuthorityId,
	type CommandId,
	type TenantId,
	type WorkspaceId,
} from "../runtime/protocol/v3/ids.ts";
import {
	isWorkspaceCheckpointDescriptor,
	isWorkspaceLeaseRef,
	isWorkspaceReleaseReceiptRef,
	parseWorktreeId,
} from "../runtime/protocol/v3/workspace.ts";
import type {
	WorkspaceLeaseMutationPort,
	WorkspaceLeaseSecret,
	WorktreeReleaseIntent,
	WorktreeReleaseJournalPort,
	WorktreeReleaseJournalRecord,
	WorktreeRegistryMutationPort,
} from "../worktree/ports.ts";
import { pathWithin } from "../worktree/paths.ts";
import {
	isValidWorktreeReleaseJournalRecord,
	WorktreeReleaseJournalCorruptionError,
} from "../worktree/release-journal.ts";
import type { WorktreeRecord, WorktreeRegistryEntry } from "../worktree/types.ts";

export interface DurableWorktreeScope {
	authorityId: AuthorityId;
	tenantId: TenantId;
}

interface WorktreeRegistryStateBody {
	schemaVersion: 1;
	kind: "worktree_registry";
	scope: DurableWorktreeScope;
	entries: readonly WorktreeRegistryEntry[];
}

interface WorktreeRegistryState extends WorktreeRegistryStateBody {
	stateDigest: string;
}

interface StoredWorkspaceLease {
	workspaceId: WorkspaceId;
	secret: WorkspaceLeaseSecret;
	secretDigest: string;
}

interface WorkspaceLeaseStateBody {
	schemaVersion: 1;
	kind: "workspace_leases";
	scope: DurableWorktreeScope;
	leases: readonly StoredWorkspaceLease[];
}

interface WorkspaceLeaseState extends WorkspaceLeaseStateBody {
	stateDigest: string;
}

interface WorktreeReleaseJournalStateBody {
	schemaVersion: 1;
	kind: "worktree_release_journal";
	scope: DurableWorktreeScope;
	records: readonly WorktreeReleaseJournalRecord[];
}

interface WorktreeReleaseJournalState extends WorktreeReleaseJournalStateBody {
	stateDigest: string;
}

type AtomicMutation<T, R> = (state: T) => Promise<{ value: R; next?: T }>;

const timestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;
const digestPattern = /^[a-f0-9]{64}$/u;
const bindingKinds = new Set(["source", "managed_worktree", "readonly_checkout"]);
const worktreeStates = new Set(["creating", "ready", "active", "retained", "removing", "removed", "stale", "failed"]);

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
	const keys = Object.keys(value);
	const allowed = new Set([...required, ...optional]);
	return required.every((key) => Object.hasOwn(value, key)) && keys.every((key) => allowed.has(key));
}

function isTimestamp(value: unknown): value is string {
	return typeof value === "string" && timestampPattern.test(value) && Number.isFinite(Date.parse(value));
}

function isDigest(value: unknown): value is string {
	return typeof value === "string" && digestPattern.test(value);
}

function isCanonicalPath(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= 4096 && !value.includes("\0") &&
		isAbsolute(value) && resolve(value) === value;
}

function isScope(value: unknown): value is DurableWorktreeScope {
	return isObject(value) && exactKeys(value, ["authorityId", "tenantId"]) &&
		isRuntimeId(value.authorityId, "authority") && isRuntimeId(value.tenantId, "tenant");
}

function sameScope(left: DurableWorktreeScope, right: DurableWorktreeScope): boolean {
	return left.authorityId === right.authorityId && left.tenantId === right.tenantId;
}

function isWorktreeRecord(value: unknown): value is WorktreeRecord {
	if (!isObject(value) || !exactKeys(value, [
		"authorityId", "tenantId", "principalId", "workspaceId", "repositoryId", "sessionId", "createRequestId", "createRequestDigest",
		"bindingKind", "sourceRepo", "sourceCwd", "worktreePath", "effectiveCwd", "subdirOffset", "label",
		"baseRef", "baseCommit", "headCommit", "branch", "state", "createdAt", "lastAccessedAt",
		"ownerRuntimeId", "leaseRevision",
	], ["worktreeId", "lease", "lastCheckpoint", "errorDigest"])) return false;
	if (
		!isRuntimeId(value.authorityId, "authority") || !isRuntimeId(value.tenantId, "tenant") ||
		!isRuntimeId(value.principalId, "principal") || !isRuntimeId(value.workspaceId, "workspace") ||
		!isRuntimeId(value.repositoryId, "repository") || !isRuntimeId(value.sessionId, "session") ||
		!isRuntimeId(value.createRequestId, "command") || !isRuntimeId(value.ownerRuntimeId, "runtime") ||
		!isDigest(value.createRequestDigest) ||
		typeof value.bindingKind !== "string" || !bindingKinds.has(value.bindingKind) ||
		typeof value.state !== "string" || !worktreeStates.has(value.state) ||
		!isCanonicalPath(value.sourceRepo) || !isCanonicalPath(value.sourceCwd) ||
		!isCanonicalPath(value.worktreePath) || !isCanonicalPath(value.effectiveCwd) ||
		!pathWithin(value.sourceRepo, value.sourceCwd) || !pathWithin(value.worktreePath, value.effectiveCwd) ||
		typeof value.subdirOffset !== "string" || value.subdirOffset.length === 0 || value.subdirOffset.includes("\0") ||
		typeof value.label !== "string" || value.label.length === 0 || value.label.length > 128 ||
		typeof value.baseRef !== "string" || value.baseRef.length === 0 || value.baseRef.length > 512 ||
		typeof value.baseCommit !== "string" || value.baseCommit.length === 0 || value.baseCommit.length > 128 ||
		typeof value.headCommit !== "string" || value.headCommit.length === 0 || value.headCommit.length > 128 ||
		typeof value.branch !== "string" || value.branch.length === 0 || value.branch.length > 512 ||
		!isTimestamp(value.createdAt) || !isTimestamp(value.lastAccessedAt) ||
		!Number.isSafeInteger(value.leaseRevision) || Number(value.leaseRevision) < 0
	) return false;
	if (value.worktreeId !== undefined && (typeof value.worktreeId !== "string" || !parseWorktreeId(value.worktreeId))) return false;
	if (value.bindingKind === "source") {
		if (value.worktreeId !== undefined || value.worktreePath !== value.sourceRepo) return false;
	} else if (value.worktreeId === undefined) return false;
	if (value.lease !== undefined) {
		if (!isWorkspaceLeaseRef(value.lease) || value.lease.authorityId !== value.authorityId ||
			value.lease.tenantId !== value.tenantId || value.lease.principalId !== value.principalId ||
			value.lease.workspaceId !== value.workspaceId || value.lease.ownerRuntimeId !== value.ownerRuntimeId ||
			value.lease.leaseRevision !== value.leaseRevision) return false;
	}
	if (value.lastCheckpoint !== undefined) {
		if (!isWorkspaceCheckpointDescriptor(value.lastCheckpoint) || value.lastCheckpoint.authorityId !== value.authorityId ||
			value.lastCheckpoint.tenantId !== value.tenantId || value.lastCheckpoint.workspaceId !== value.workspaceId) return false;
	}
	return value.errorDigest === undefined || isDigest(value.errorDigest);
}

function registryEntryBody(entry: WorktreeRegistryEntry): Omit<WorktreeRegistryEntry, "entryDigest"> {
	return { revision: entry.revision, operation: entry.operation, record: entry.record };
}

function isRegistryEntry(value: unknown, scope: DurableWorktreeScope, expectedRevision: number): value is WorktreeRegistryEntry {
	if (!isObject(value) || !exactKeys(value, ["revision", "operation", "record", "entryDigest"]) ||
		!Number.isSafeInteger(value.revision) || value.revision !== expectedRevision ||
		(value.operation !== "upsert" && value.operation !== "remove") ||
		!isWorktreeRecord(value.record) || !isDigest(value.entryDigest)) return false;
	const entry = value as unknown as WorktreeRegistryEntry;
	return entry.record.authorityId === scope.authorityId && entry.record.tenantId === scope.tenantId &&
		entry.entryDigest === canonicalDigest(registryEntryBody(entry));
}

function registryState(scope: DurableWorktreeScope, entries: readonly WorktreeRegistryEntry[]): WorktreeRegistryState {
	const body: WorktreeRegistryStateBody = { schemaVersion: 1, kind: "worktree_registry", scope, entries };
	return { ...body, stateDigest: canonicalDigest(body) };
}

function parseRegistryState(raw: string, expectedScope: DurableWorktreeScope): WorktreeRegistryState {
	let value: unknown;
	try {
		value = JSON.parse(raw) as unknown;
	} catch {
		throw new Error("worktree registry JSON is corrupted");
	}
	if (!isObject(value) || !exactKeys(value, ["schemaVersion", "kind", "scope", "entries", "stateDigest"]) ||
		value.schemaVersion !== 1 || value.kind !== "worktree_registry" || !isScope(value.scope) ||
		!sameScope(value.scope, expectedScope) || !Array.isArray(value.entries) || !isDigest(value.stateDigest)) {
		throw new Error("worktree registry schema or scope is corrupted");
	}
	const entries: WorktreeRegistryEntry[] = [];
	for (let index = 0; index < value.entries.length; index += 1) {
		const entry = value.entries[index];
		if (!isRegistryEntry(entry, expectedScope, index + 1)) throw new Error("worktree registry entry sequence, scope, or digest is corrupted");
		entries.push(entry);
	}
	const parsed = registryState(expectedScope, entries);
	if (parsed.stateDigest !== value.stateDigest) throw new Error("worktree registry state digest is corrupted");
	return parsed;
}

function isLeaseSecret(value: unknown, scope: DurableWorktreeScope): value is WorkspaceLeaseSecret {
	if (!isObject(value) || !exactKeys(value, ["record", "fencingToken", "issuedAt", "lastRenewedAt"]) ||
		!isWorkspaceLeaseRef(value.record) || typeof value.fencingToken !== "string" ||
		value.fencingToken.length === 0 || value.fencingToken.length > 512 ||
		!isTimestamp(value.issuedAt) || !isTimestamp(value.lastRenewedAt)) return false;
	return value.record.authorityId === scope.authorityId && value.record.tenantId === scope.tenantId &&
		value.record.fencingTokenDigest === canonicalDigest(value.fencingToken) &&
		Date.parse(value.issuedAt) <= Date.parse(value.lastRenewedAt);
}

function storedLease(secret: WorkspaceLeaseSecret): StoredWorkspaceLease {
	return {
		workspaceId: secret.record.workspaceId,
		secret,
		secretDigest: canonicalDigest(secret),
	};
}

function leaseState(scope: DurableWorktreeScope, leases: readonly StoredWorkspaceLease[]): WorkspaceLeaseState {
	const ordered = [...leases].sort((left, right) => left.workspaceId.localeCompare(right.workspaceId));
	const body: WorkspaceLeaseStateBody = { schemaVersion: 1, kind: "workspace_leases", scope, leases: ordered };
	return { ...body, stateDigest: canonicalDigest(body) };
}

function parseLeaseState(raw: string, expectedScope: DurableWorktreeScope): WorkspaceLeaseState {
	let value: unknown;
	try {
		value = JSON.parse(raw) as unknown;
	} catch {
		throw new Error("workspace lease JSON is corrupted");
	}
	if (!isObject(value) || !exactKeys(value, ["schemaVersion", "kind", "scope", "leases", "stateDigest"]) ||
		value.schemaVersion !== 1 || value.kind !== "workspace_leases" || !isScope(value.scope) ||
		!sameScope(value.scope, expectedScope) || !Array.isArray(value.leases) || !isDigest(value.stateDigest)) {
		throw new Error("workspace lease schema or scope is corrupted");
	}
	const leases: StoredWorkspaceLease[] = [];
	let previous: string | undefined;
	for (const candidate of value.leases) {
		if (!isObject(candidate) || !exactKeys(candidate, ["workspaceId", "secret", "secretDigest"]) ||
			!isRuntimeId(candidate.workspaceId, "workspace") || !isLeaseSecret(candidate.secret, expectedScope) ||
			candidate.secret.record.workspaceId !== candidate.workspaceId || !isDigest(candidate.secretDigest) ||
			candidate.secretDigest !== canonicalDigest(candidate.secret) ||
			(previous !== undefined && previous.localeCompare(candidate.workspaceId) >= 0)) {
			throw new Error("workspace lease record, order, scope, or digest is corrupted");
		}
		leases.push(candidate as unknown as StoredWorkspaceLease);
		previous = candidate.workspaceId;
	}
	const parsed = leaseState(expectedScope, leases);
	if (parsed.stateDigest !== value.stateDigest) throw new Error("workspace lease state digest is corrupted");
	return parsed;
}

function isReleaseJournalRecord(
	value: unknown,
	scope: DurableWorktreeScope,
): value is WorktreeReleaseJournalRecord {
	if (
		!isObject(value) ||
		!exactKeys(value, ["schemaVersion", "kind", "intent", "recordDigest"], ["receipt"]) ||
		value.schemaVersion !== 1 ||
		value.kind !== "worktree_release_journal_record" ||
		!isDigest(value.recordDigest) ||
		!isObject(value.intent)
	) return false;
	const intent = value.intent;
	const operationId = typeof intent.operationId === "string"
		? parseRuntimeId("command", intent.operationId)
		: undefined;
	const requestId = typeof intent.requestId === "string"
		? parseRuntimeId("command", intent.requestId)
		: undefined;
	const authorityId = typeof intent.authorityId === "string"
		? parseRuntimeId("authority", intent.authorityId)
		: undefined;
	const tenantId = typeof intent.tenantId === "string"
		? parseRuntimeId("tenant", intent.tenantId)
		: undefined;
	const principalId = typeof intent.principalId === "string"
		? parseRuntimeId("principal", intent.principalId)
		: undefined;
	const sessionId = typeof intent.sessionId === "string"
		? parseRuntimeId("session", intent.sessionId)
		: undefined;
	const agentId = typeof intent.agentId === "string"
		? parseRuntimeId("agent", intent.agentId)
		: undefined;
	const workspaceId = typeof intent.workspaceId === "string"
		? parseRuntimeId("workspace", intent.workspaceId)
		: undefined;
	const repositoryId = typeof intent.repositoryId === "string"
		? parseRuntimeId("repository", intent.repositoryId)
		: undefined;
	const leaseId = typeof intent.leaseId === "string"
		? parseRuntimeId("lease", intent.leaseId)
		: undefined;
	const receiptId = typeof intent.receiptId === "string"
		? parseRuntimeId("receipt", intent.receiptId)
		: undefined;
	const checkpoint = intent.checkpoint;
	const receipt = value.receipt;
	if (
		!exactKeys(intent, [
			"schemaVersion", "kind", "operationId", "requestId", "requestDigest",
			"callerRequestDigest",
			"authorityId", "tenantId", "principalId", "sessionId", "agentId",
			"workspaceId", "repositoryId", "envelopeDigest", "leaseId", "leaseRevision",
			"releasedAt", "releasedLease", "releasedLeaseDigest", "retainedRecord",
			"retainedRecordDigest", "receiptId", "intentDigest",
		], ["checkpoint"]) ||
		intent.schemaVersion !== 1 ||
		intent.kind !== "worktree_release_intent" ||
		operationId === undefined ||
		requestId === undefined ||
		!isDigest(intent.requestDigest) ||
		!isDigest(intent.callerRequestDigest) ||
		authorityId === undefined ||
		tenantId === undefined ||
		principalId === undefined ||
		sessionId === undefined ||
		agentId === undefined ||
		workspaceId === undefined ||
		repositoryId === undefined ||
		!isDigest(intent.envelopeDigest) ||
		leaseId === undefined ||
		typeof intent.leaseRevision !== "number" ||
		!Number.isSafeInteger(intent.leaseRevision) ||
		intent.leaseRevision < 0 ||
		!isTimestamp(intent.releasedAt) ||
		!isWorkspaceLeaseRef(intent.releasedLease) ||
		!isDigest(intent.releasedLeaseDigest) ||
		!isWorktreeRecord(intent.retainedRecord) ||
		!isDigest(intent.retainedRecordDigest) ||
		receiptId === undefined ||
		!isDigest(intent.intentDigest) ||
		(checkpoint !== undefined && !isWorkspaceCheckpointDescriptor(checkpoint)) ||
		(receipt !== undefined && !isWorkspaceReleaseReceiptRef(receipt))
	) return false;
	const parsedIntent: WorktreeReleaseIntent = {
		schemaVersion: 1,
		kind: "worktree_release_intent",
		operationId,
		requestId,
		requestDigest: intent.requestDigest,
		callerRequestDigest: intent.callerRequestDigest,
		authorityId,
		tenantId,
		principalId,
		sessionId,
		agentId,
		workspaceId,
		repositoryId,
		envelopeDigest: intent.envelopeDigest,
		leaseId,
		leaseRevision: intent.leaseRevision,
		releasedAt: intent.releasedAt,
		releasedLease: intent.releasedLease,
		releasedLeaseDigest: intent.releasedLeaseDigest,
		retainedRecord: intent.retainedRecord,
		retainedRecordDigest: intent.retainedRecordDigest,
		receiptId,
		...(checkpoint === undefined ? {} : { checkpoint }),
		intentDigest: intent.intentDigest,
	};
	const candidate: WorktreeReleaseJournalRecord = {
		schemaVersion: 1,
		kind: "worktree_release_journal_record",
		intent: parsedIntent,
		...(receipt === undefined ? {} : { receipt }),
		recordDigest: value.recordDigest,
	};
	return (
		candidate.intent.authorityId === scope.authorityId &&
		candidate.intent.tenantId === scope.tenantId &&
		isValidWorktreeReleaseJournalRecord(candidate)
	);
}

function releaseJournalState(
	scope: DurableWorktreeScope,
	records: readonly WorktreeReleaseJournalRecord[],
): WorktreeReleaseJournalState {
	const ordered = [...records].sort((left, right) =>
		left.intent.operationId.localeCompare(right.intent.operationId));
	const body: WorktreeReleaseJournalStateBody = {
		schemaVersion: 1,
		kind: "worktree_release_journal",
		scope,
		records: ordered,
	};
	return { ...body, stateDigest: canonicalDigest(body) };
}

function parseReleaseJournalState(
	raw: string,
	expectedScope: DurableWorktreeScope,
): WorktreeReleaseJournalState {
	let value: unknown;
	try {
		value = JSON.parse(raw) as unknown;
	} catch {
		throw new WorktreeReleaseJournalCorruptionError("worktree release journal JSON is corrupted");
	}
	if (
		!isObject(value) ||
		!exactKeys(value, ["schemaVersion", "kind", "scope", "records", "stateDigest"]) ||
		value.schemaVersion !== 1 ||
		value.kind !== "worktree_release_journal" ||
		!isScope(value.scope) ||
		!sameScope(value.scope, expectedScope) ||
		!Array.isArray(value.records) ||
		!isDigest(value.stateDigest)
	) {
		throw new WorktreeReleaseJournalCorruptionError("worktree release journal schema or scope is corrupted");
	}
	const records: WorktreeReleaseJournalRecord[] = [];
	let previous: string | undefined;
	const requestIds = new Set<CommandId>();
	for (const candidate of value.records) {
		if (
			!isReleaseJournalRecord(candidate, expectedScope) ||
			requestIds.has(candidate.intent.requestId) ||
			(previous !== undefined && previous.localeCompare(candidate.intent.operationId) >= 0)
		) {
			throw new WorktreeReleaseJournalCorruptionError("worktree release journal record, order, scope, or digest is corrupted");
		}
		records.push(candidate);
		requestIds.add(candidate.intent.requestId);
		previous = candidate.intent.operationId;
	}
	const parsed = releaseJournalState(expectedScope, records);
	if (parsed.stateDigest !== value.stateDigest) {
		throw new WorktreeReleaseJournalCorruptionError("worktree release journal state digest is corrupted");
	}
	return parsed;
}

function errnoCode(cause: unknown): string | undefined {
	return cause instanceof Error && "code" in cause ? String(cause.code) : undefined;
}

async function syncDirectory(path: string): Promise<void> {
	const handle = await open(path, constants.O_RDONLY);
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}

async function writeExclusive(path: string, content: string): Promise<void> {
	const handle = await open(
		path,
		constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
		0o600,
	);
	try {
		await handle.writeFile(content);
		await handle.sync();
	} finally {
		await handle.close();
	}
}

class AtomicScopedStateFile<T> {
	readonly #filePath: string;
	readonly #initial: T;
	readonly #parse: (raw: string) => T;

	public constructor(filePath: string, initial: T, parse: (raw: string) => T) {
		this.#filePath = resolve(filePath);
		this.#initial = initial;
		this.#parse = parse;
	}

	async #ensure(): Promise<void> {
		const parent = dirname(this.#filePath);
		await mkdir(parent, { recursive: true, mode: 0o700 });
		const canonicalParent = resolve(await realpath(parent));
		const parentStats = await lstat(parent);
		if (canonicalParent !== parent || !parentStats.isDirectory() || parentStats.isSymbolicLink() || (parentStats.mode & 0o077) !== 0) {
			throw new Error("worktree durable state parent is not a private canonical directory");
		}
		try {
			const stats = await lstat(this.#filePath);
			if (!stats.isFile() || stats.isSymbolicLink() || (stats.mode & 0o077) !== 0 || resolve(await realpath(this.#filePath)) !== this.#filePath) {
				throw new Error("worktree durable state file is not a private canonical file");
			}
			return;
		} catch (cause) {
			if (errnoCode(cause) !== "ENOENT") throw cause;
		}
		try {
			await writeExclusive(this.#filePath, JSON.stringify(this.#initial));
			await syncDirectory(parent);
		} catch (cause) {
			if (errnoCode(cause) !== "EEXIST") throw cause;
		}
	}

	async #read(): Promise<T> {
		const stats = await lstat(this.#filePath);
		if (!stats.isFile() || stats.isSymbolicLink() || (stats.mode & 0o077) !== 0 || resolve(await realpath(this.#filePath)) !== this.#filePath) {
			throw new Error("worktree durable state file identity or mode changed");
		}
		const handle = await open(this.#filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
		try {
			return this.#parse(await handle.readFile("utf8"));
		} finally {
			await handle.close();
		}
	}

	async #replace(next: T): Promise<void> {
		const parent = dirname(this.#filePath);
		const temporary = join(parent, `.${randomUUID()}.worktree-state.partial`);
		try {
			await writeExclusive(temporary, JSON.stringify(next));
			await rename(temporary, this.#filePath);
			await syncDirectory(parent);
		} catch (cause) {
			await rm(temporary, { force: true }).catch(() => undefined);
			throw cause;
		}
	}

	public async mutate<R>(operation: AtomicMutation<T, R>): Promise<R> {
		await this.#ensure();
		const release = await lockfile.lock(this.#filePath, {
			realpath: false,
			retries: { retries: 8, minTimeout: 20, maxTimeout: 250 },
		});
		try {
			const current = await this.#read();
			const result = await operation(current);
			if (result.next !== undefined) await this.#replace(result.next);
			return result.value;
		} finally {
			await release();
		}
	}
}

export class FileWorktreeRegistryMutationPort implements WorktreeRegistryMutationPort {
	readonly #scope: DurableWorktreeScope;
	readonly #state: AtomicScopedStateFile<WorktreeRegistryState>;

	public constructor(filePath: string, scope: DurableWorktreeScope) {
		this.#scope = structuredClone(scope);
		this.#state = new AtomicScopedStateFile(
			filePath,
			registryState(this.#scope, []),
			(raw) => parseRegistryState(raw, this.#scope),
		);
	}

	public async verify(): Promise<void> {
		await this.#state.mutate(async (state) => ({ value: state }));
	}

	public read(): Promise<readonly WorktreeRegistryEntry[]> {
		return this.#state.mutate(async (state) => ({ value: structuredClone(state.entries) }));
	}

	public append(entry: WorktreeRegistryEntry, expectedRevision: number): Promise<"applied" | "conflict"> {
		return this.#state.mutate(async (state) => {
			if (!isRegistryEntry(entry, this.#scope, expectedRevision + 1)) {
				throw new Error("worktree registry append entry is invalid or outside the configured scope");
			}
			if (state.entries.length !== expectedRevision) return { value: "conflict" as const };
			return {
				value: "applied" as const,
				next: registryState(this.#scope, [...state.entries, structuredClone(entry)]),
			};
		});
	}
}

export class FileWorkspaceLeaseMutationPort implements WorkspaceLeaseMutationPort {
	readonly #scope: DurableWorktreeScope;
	readonly #state: AtomicScopedStateFile<WorkspaceLeaseState>;

	public constructor(filePath: string, scope: DurableWorktreeScope) {
		this.#scope = structuredClone(scope);
		this.#state = new AtomicScopedStateFile(
			filePath,
			leaseState(this.#scope, []),
			(raw) => parseLeaseState(raw, this.#scope),
		);
	}

	public async verify(): Promise<void> {
		await this.#state.mutate(async (state) => ({ value: state }));
	}

	public read(workspaceId: WorkspaceId): Promise<WorkspaceLeaseSecret | undefined> {
		return this.#state.mutate(async (state) => ({
			value: structuredClone(state.leases.find((entry) => entry.workspaceId === workspaceId)?.secret),
		}));
	}

	public create(secret: WorkspaceLeaseSecret): Promise<"applied" | "conflict"> {
		return this.#state.mutate(async (state) => {
			if (!isLeaseSecret(secret, this.#scope)) throw new Error("workspace lease secret is invalid or outside the configured scope");
			if (state.leases.some((entry) => entry.workspaceId === secret.record.workspaceId)) return { value: "conflict" as const };
			return {
				value: "applied" as const,
				next: leaseState(this.#scope, [...state.leases, storedLease(structuredClone(secret))]),
			};
		});
	}

	public compareAndSwap(
		workspaceId: WorkspaceId,
		expectedRevision: number,
		expectedSecretDigest: string,
		next: WorkspaceLeaseSecret,
	): Promise<"applied" | "conflict"> {
		return this.#state.mutate(async (state) => {
			if (!isLeaseSecret(next, this.#scope) || next.record.workspaceId !== workspaceId) {
				throw new Error("workspace lease CAS replacement is invalid or outside the configured scope");
			}
			const index = state.leases.findIndex((entry) => entry.workspaceId === workspaceId);
			if (
				index < 0 ||
				state.leases[index]!.secret.record.leaseRevision !== expectedRevision ||
				state.leases[index]!.secretDigest !== expectedSecretDigest
			) return { value: "conflict" as const };
			const current = state.leases[index]!.secret;
			if (
				next.record.authorityId !== current.record.authorityId ||
				next.record.tenantId !== current.record.tenantId ||
				next.record.principalId !== current.record.principalId ||
				next.record.leaseId !== current.record.leaseId ||
				next.record.leaseRevision < expectedRevision ||
				next.record.leaseRevision > expectedRevision + 1 ||
				(next.record.leaseRevision === expectedRevision && (
					next.record.ownerRuntimeId !== current.record.ownerRuntimeId ||
					next.fencingToken !== current.fencingToken ||
					next.issuedAt !== current.issuedAt
				)) ||
				(next.record.leaseRevision === expectedRevision + 1 && (
					next.record.state !== "active" || next.record.fencingTokenDigest === current.record.fencingTokenDigest
				))
			) throw new Error("workspace lease CAS attempted to change immutable identity or skip a fencing revision");
			const leases = [...state.leases];
			leases[index] = storedLease(structuredClone(next));
			return { value: "applied" as const, next: leaseState(this.#scope, leases) };
		});
	}

	public remove(
		workspaceId: WorkspaceId,
		expectedRevision: number,
		expectedSecretDigest: string,
	): Promise<"applied" | "conflict" | "not_found"> {
		return this.#state.mutate(async (state) => {
			const index = state.leases.findIndex((entry) => entry.workspaceId === workspaceId);
			if (index < 0) return { value: "not_found" as const };
			if (
				state.leases[index]!.secret.record.leaseRevision !== expectedRevision ||
				state.leases[index]!.secretDigest !== expectedSecretDigest
			) return { value: "conflict" as const };
			return {
				value: "applied" as const,
				next: leaseState(this.#scope, state.leases.filter((_, candidate) => candidate !== index)),
			};
		});
	}
}

export class FileWorktreeReleaseJournalPort implements WorktreeReleaseJournalPort {
	readonly #scope: DurableWorktreeScope;
	readonly #state: AtomicScopedStateFile<WorktreeReleaseJournalState>;

	public constructor(filePath: string, scope: DurableWorktreeScope) {
		this.#scope = structuredClone(scope);
		this.#state = new AtomicScopedStateFile(
			filePath,
			releaseJournalState(this.#scope, []),
			(raw) => parseReleaseJournalState(raw, this.#scope),
		);
	}

	async #mutate<R>(operation: AtomicMutation<WorktreeReleaseJournalState, R>): Promise<R> {
		try {
			return await this.#state.mutate(operation);
		} catch (cause) {
			if (cause instanceof WorktreeReleaseJournalCorruptionError) throw cause;
			const message = cause instanceof Error ? cause.message : "";
			if (/corrupt|scope|private canonical|identity or mode/u.test(message)) {
				throw new WorktreeReleaseJournalCorruptionError(
					message || "worktree release journal durable identity is corrupted",
				);
			}
			throw cause;
		}
	}

	public async verify(): Promise<void> {
		await this.#mutate(async (state) => ({ value: state }));
	}

	public read(operationId: CommandId): Promise<WorktreeReleaseJournalRecord | undefined> {
		return this.#mutate(async (state) => ({
			value: structuredClone(
				state.records.find((record) => record.intent.operationId === operationId),
			),
		}));
	}

	public begin(
		record: WorktreeReleaseJournalRecord,
	): Promise<"applied" | "replay" | "conflict"> {
		return this.#mutate(async (state) => {
			if (!isReleaseJournalRecord(record, this.#scope) || record.receipt !== undefined) {
				throw new Error("worktree release journal begin record is invalid or outside the configured scope");
			}
			const current = state.records.find((candidate) =>
				candidate.intent.operationId === record.intent.operationId);
			if (current) {
				return {
					value: current.intent.requestId === record.intent.requestId &&
						current.intent.requestDigest === record.intent.requestDigest
						? "replay" as const
						: "conflict" as const,
				};
			}
			if (state.records.some((candidate) =>
				candidate.intent.requestId === record.intent.requestId)) {
				return { value: "conflict" as const };
			}
			return {
				value: "applied" as const,
				next: releaseJournalState(this.#scope, [...state.records, structuredClone(record)]),
			};
		});
	}

	public complete(
		operationId: CommandId,
		expectedRequestDigest: string,
		record: WorktreeReleaseJournalRecord,
	): Promise<"applied" | "replay" | "conflict"> {
		return this.#mutate(async (state) => {
			if (
				!isReleaseJournalRecord(record, this.#scope) ||
				record.receipt === undefined ||
				record.intent.operationId !== operationId ||
				record.intent.requestDigest !== expectedRequestDigest
			) {
				throw new Error("worktree release journal completion record is invalid or outside the configured scope");
			}
			const index = state.records.findIndex((candidate) =>
				candidate.intent.operationId === operationId);
			if (index < 0) return { value: "conflict" as const };
			const current = state.records[index]!;
			if (
				current.intent.requestDigest !== expectedRequestDigest ||
				current.intent.intentDigest !== record.intent.intentDigest
			) return { value: "conflict" as const };
			if (current.receipt) {
				return {
					value: current.recordDigest === record.recordDigest
						? "replay" as const
						: "conflict" as const,
				};
			}
			const records = [...state.records];
			records[index] = structuredClone(record);
			return {
				value: "applied" as const,
				next: releaseJournalState(this.#scope, records),
			};
		});
	}
}
