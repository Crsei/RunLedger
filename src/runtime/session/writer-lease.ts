/** Session writer 的内存/文件 CAS lease、epoch 与 fencing token。 */

import { createHash, randomBytes } from "node:crypto";
import {
	closeSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import lockfile from "proper-lockfile";
import { sameRuntimeEventStream, type RuntimeEventStreamRef } from "../protocol/v3/events.ts";
import { createRuntimeId, isRuntimeId } from "../protocol/v3/ids.ts";
import type {
	AuthorityId,
	LeaseId,
	RuntimeInstanceId,
	TenantId,
} from "../protocol/v3/ids.ts";
import type { SessionKernelErrorCode, SessionResult, WriterFence } from "./types.ts";

export const DEFAULT_WRITER_LEASE_DURATION_MS = 30_000;
export const MAX_WRITER_LEASE_DURATION_MS = 24 * 60 * 60 * 1_000;
export const WRITER_LEASE_STATE_SCHEMA_VERSION = 2;
export const DEFAULT_WRITER_LEASE_LOCK_STALE_MS = 10_000;
export const MAX_WRITER_LEASE_STATE_BYTES = 4 * 1024 * 1024;
const MAX_TOKEN_GENERATION_ATTEMPTS = 64;
const FENCING_TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export interface WriterLeaseScope {
	authorityId: AuthorityId;
	tenantId: TenantId;
	stream: RuntimeEventStreamRef;
}

export interface AcquireWriterLeaseRequest extends WriterLeaseScope {
	ownerRuntimeId: RuntimeInstanceId;
	durationMs?: number;
}

export interface TakeoverWriterLeaseRequest {
	expectedFence: WriterFence;
	ownerRuntimeId: RuntimeInstanceId;
	durationMs?: number;
}

export interface WriterLeaseRecord extends WriterFence {
	fencingTokenDigest: string;
	acquiredAt: string;
	renewedAt: string;
	expiresAt: string;
	releasedAt?: string;
}

export interface MemoryWriterLeaseStoreOptions {
	defaultDurationMs?: number;
	now?: () => Date;
	tokenFactory?: () => string;
	leaseIdFactory?: () => LeaseId;
}

export interface FileWriterLeaseStoreOptions extends MemoryWriterLeaseStoreOptions {
	/** 首次 acquire 前也要绑定的预期 scope；用于防止把 session 指到错误的状态文件。 */
	scope?: WriterLeaseScope;
	/** 只保护一次同步 CAS 更新；runtime lease 的失效仍由 expiresAt 决定。 */
	lockStaleMs?: number;
}

export interface WriterLeaseStore {
	acquire(request: AcquireWriterLeaseRequest): SessionResult<WriterLeaseRecord>;
	heartbeat(fence: WriterFence, durationMs?: number): SessionResult<WriterLeaseRecord>;
	renew(fence: WriterFence, durationMs?: number): SessionResult<WriterLeaseRecord>;
	takeover(request: TakeoverWriterLeaseRequest): SessionResult<WriterLeaseRecord>;
	release(fence: WriterFence): SessionResult<WriterLeaseRecord>;
	validate(fence: WriterFence): SessionResult<WriterLeaseRecord>;
}

type StoredLeaseState = "active" | "released";

interface StoredLease {
	record: WriterLeaseRecord;
	state: StoredLeaseState;
	retiredTokenDigests: Set<string>;
}

interface PersistedWriterLeaseState {
	schemaVersion: typeof WRITER_LEASE_STATE_SCHEMA_VERSION;
	stateRevision: number;
	scope: WriterLeaseScope;
	state: StoredLeaseState;
	record: WriterLeaseRecord;
	retiredTokenDigests: string[];
	stateDigest: string;
}

type PersistedWriterLeaseStateBody = Omit<PersistedWriterLeaseState, "stateDigest">;

type SessionFailure = Extract<SessionResult<never>, { ok: false }>;

function success<T>(value: T): SessionResult<T> {
	return { ok: true, value };
}

function failure(
	code: SessionKernelErrorCode,
	message: string,
	retryable: boolean,
	details?: Readonly<Record<string, string | number | boolean>>,
): SessionFailure {
	return {
		ok: false,
		error: {
			code,
			message,
			retryable,
			...(details ? { details } : {}),
		},
	};
}

function scopeKey(scope: WriterLeaseScope): string {
	return `${scope.authorityId}/${scope.tenantId}/${scope.stream.scope}/${scope.stream.streamId}`;
}

function copyRecord(record: WriterLeaseRecord): WriterLeaseRecord {
	return { ...record, stream: { ...record.stream } };
}

function copyScope(scope: WriterLeaseScope): WriterLeaseScope {
	return {
		authorityId: scope.authorityId,
		tenantId: scope.tenantId,
		stream: { ...scope.stream },
	};
}

function isValidScope(scope: WriterLeaseScope): boolean {
	return (
		isRuntimeId(scope.authorityId, "authority") &&
		isRuntimeId(scope.tenantId, "tenant") &&
		isValidStreamRef(scope.stream)
	);
}

function isValidStreamRef(value: unknown): value is RuntimeEventStreamRef {
	if (!isPlainObject(value) || !isRuntimeId(value.streamId, "eventStream")) return false;
	if (value.scope === "authority_tenant") return hasExactKeys(value, ["scope", "streamId"]);
	return (
		value.scope === "session" &&
		hasExactKeys(value, ["scope", "streamId", "sessionId"]) &&
		isRuntimeId(value.sessionId, "session")
	);
}

function matchesFence(record: WriterLeaseRecord, fence: WriterFence): boolean {
	return (
		record.authorityId === fence.authorityId &&
		record.tenantId === fence.tenantId &&
		sameRuntimeEventStream(record.stream, fence.stream) &&
		record.leaseId === fence.leaseId &&
		record.ownerRuntimeId === fence.ownerRuntimeId &&
		record.writerEpoch === fence.writerEpoch &&
		record.fencingToken === fence.fencingToken
	);
}

function matchesScope(left: WriterLeaseScope, right: WriterLeaseScope): boolean {
	return (
		left.authorityId === right.authorityId &&
		left.tenantId === right.tenantId &&
		sameRuntimeEventStream(left.stream, right.stream)
	);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
	const actual = Object.keys(value).sort();
	const expected = [...keys].sort();
	return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isCanonicalTimestamp(value: unknown): value is string {
	if (typeof value !== "string") return false;
	const timestamp = Date.parse(value);
	return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function isValidRecord(value: unknown): value is WriterLeaseRecord {
	if (!isPlainObject(value)) return false;
	const keys = [
		"authorityId",
		"tenantId",
		"stream",
		"leaseId",
		"ownerRuntimeId",
		"writerEpoch",
		"fencingToken",
		"fencingTokenDigest",
		"acquiredAt",
		"renewedAt",
		"expiresAt",
		...(value.releasedAt === undefined ? [] : ["releasedAt"]),
	];
	if (!hasExactKeys(value, keys)) return false;
	if (
		!isRuntimeId(value.authorityId, "authority") ||
		!isRuntimeId(value.tenantId, "tenant") ||
		!isPlainObject(value.stream) ||
		!isValidScope({ authorityId: value.authorityId as AuthorityId, tenantId: value.tenantId as TenantId, stream: value.stream as unknown as RuntimeEventStreamRef }) ||
		!isRuntimeId(value.leaseId, "lease") ||
		!isRuntimeId(value.ownerRuntimeId, "runtime") ||
		!Number.isSafeInteger(value.writerEpoch) ||
		(value.writerEpoch as number) <= 0 ||
		typeof value.fencingToken !== "string" ||
		!FENCING_TOKEN_PATTERN.test(value.fencingToken) ||
		typeof value.fencingTokenDigest !== "string" ||
		!SHA256_PATTERN.test(value.fencingTokenDigest) ||
		value.fencingTokenDigest !== digestWriterFencingToken(value.fencingToken) ||
		!isCanonicalTimestamp(value.acquiredAt) ||
		!isCanonicalTimestamp(value.renewedAt) ||
		!isCanonicalTimestamp(value.expiresAt) ||
		(value.releasedAt !== undefined && !isCanonicalTimestamp(value.releasedAt))
	) {
		return false;
	}
	const acquiredAt = Date.parse(value.acquiredAt);
	const renewedAt = Date.parse(value.renewedAt);
	const expiresAt = Date.parse(value.expiresAt);
	const releasedAt = value.releasedAt === undefined ? undefined : Date.parse(value.releasedAt);
	return (
		acquiredAt <= renewedAt &&
		renewedAt < expiresAt &&
		(releasedAt === undefined || (renewedAt <= releasedAt && releasedAt < expiresAt))
	);
}

function isValidPersistedState(value: unknown): value is PersistedWriterLeaseState {
	if (!isPlainObject(value)) return false;
	if (
		!hasExactKeys(value, [
			"schemaVersion",
			"stateRevision",
			"scope",
			"state",
			"record",
			"retiredTokenDigests",
			"stateDigest",
		]) ||
		value.schemaVersion !== WRITER_LEASE_STATE_SCHEMA_VERSION ||
		!Number.isSafeInteger(value.stateRevision) ||
		(value.stateRevision as number) <= 0 ||
		!isPlainObject(value.scope) ||
		!hasExactKeys(value.scope, ["authorityId", "tenantId", "stream"]) ||
		!isValidScope(value.scope as unknown as WriterLeaseScope) ||
		(value.state !== "active" && value.state !== "released") ||
		!isValidRecord(value.record) ||
		!Array.isArray(value.retiredTokenDigests) ||
		typeof value.stateDigest !== "string" ||
		!SHA256_PATTERN.test(value.stateDigest)
	) {
		return false;
	}
	if ((value.stateRevision as number) < value.record.writerEpoch) return false;
	if (!matchesScope(value.scope as unknown as WriterLeaseScope, value.record)) return false;
	if (
		(value.state === "active" && value.record.releasedAt !== undefined) ||
		(value.state === "released" && value.record.releasedAt === undefined)
	) {
		return false;
	}
	const retired = value.retiredTokenDigests;
	if (!retired.every((digest): digest is string => typeof digest === "string" && SHA256_PATTERN.test(digest))) {
		return false;
	}
	const uniqueSorted = [...new Set(retired)].sort();
	if (uniqueSorted.length !== retired.length || uniqueSorted.some((digest, index) => digest !== retired[index])) {
		return false;
	}
	const currentRetired = retired.includes(value.record.fencingTokenDigest);
	if (value.state === "released" ? !currentRetired : currentRetired) return false;
	return computePersistedStateDigest(value as unknown as PersistedWriterLeaseState) === value.stateDigest;
}

function persistedStateBody(state: PersistedWriterLeaseStateBody): PersistedWriterLeaseStateBody {
	const record = {
		authorityId: state.record.authorityId,
		tenantId: state.record.tenantId,
		stream: { ...state.record.stream },
		leaseId: state.record.leaseId,
		ownerRuntimeId: state.record.ownerRuntimeId,
		writerEpoch: state.record.writerEpoch,
		fencingToken: state.record.fencingToken,
		fencingTokenDigest: state.record.fencingTokenDigest,
		acquiredAt: state.record.acquiredAt,
		renewedAt: state.record.renewedAt,
		expiresAt: state.record.expiresAt,
		...(state.record.releasedAt === undefined ? {} : { releasedAt: state.record.releasedAt }),
	};
	return {
		schemaVersion: state.schemaVersion,
		stateRevision: state.stateRevision,
		scope: {
			authorityId: state.scope.authorityId,
			tenantId: state.scope.tenantId,
			stream: { ...state.scope.stream },
		},
		state: state.state,
		record,
		retiredTokenDigests: [...state.retiredTokenDigests].sort(),
	};
}

function computePersistedStateDigest(state: PersistedWriterLeaseStateBody): string {
	return createHash("sha256").update(JSON.stringify(persistedStateBody(state)), "utf8").digest("hex");
}

function sealPersistedState(state: PersistedWriterLeaseStateBody): PersistedWriterLeaseState {
	const body = persistedStateBody(state);
	return { ...body, stateDigest: computePersistedStateDigest(body) };
}

function serializePersistedState(state: PersistedWriterLeaseState): string {
	return `${JSON.stringify({ ...persistedStateBody(state), stateDigest: state.stateDigest })}\n`;
}

export function digestWriterFencingToken(token: string): string {
	return createHash("sha256").update(token, "utf8").digest("hex");
}

export class InMemoryWriterLeaseStore implements WriterLeaseStore {
	private readonly leases = new Map<string, StoredLease>();
	private readonly defaultDurationMs: number;
	private readonly nowFactory: () => Date;
	private readonly tokenFactory: () => string;
	private readonly leaseIdFactory: () => LeaseId;

	public constructor(options: MemoryWriterLeaseStoreOptions = {}) {
		this.defaultDurationMs = options.defaultDurationMs ?? DEFAULT_WRITER_LEASE_DURATION_MS;
		this.nowFactory = options.now ?? (() => new Date());
		this.tokenFactory = options.tokenFactory ?? (() => randomBytes(32).toString("base64url"));
		this.leaseIdFactory = options.leaseIdFactory ?? (() => createRuntimeId("lease"));
	}

	public acquire(request: AcquireWriterLeaseRequest): SessionResult<WriterLeaseRecord> {
		const identityFailure = this.validateAcquireIdentity(request);
		if (identityFailure) return identityFailure;
		const duration = this.resolveDuration(request.durationMs);
		if (!duration.ok) return duration;
		const now = this.readNow();
		if (!now.ok) return now;

		const key = scopeKey(request);
		const current = this.leases.get(key);
		if (current?.state === "active") {
			const stale = now.value.getTime() >= Date.parse(current.record.expiresAt);
			return failure(
				"writer_fenced",
				stale ? "writer lease is stale and requires CAS takeover" : "writer lease is already active",
				true,
				{ writerEpoch: current.record.writerEpoch, stale },
			);
		}

		const nextEpoch = (current?.record.writerEpoch ?? 0) + 1;
		if (!Number.isSafeInteger(nextEpoch)) {
			return failure("durable_write_failed", "writer epoch is exhausted", false);
		}
		const issued = this.issueIdentity(current?.retiredTokenDigests ?? new Set<string>());
		if (!issued.ok) return issued;
		const record = this.createRecord(request, request.ownerRuntimeId, nextEpoch, issued.value, now.value, duration.value);
		if (!record.ok) return record;
		this.leases.set(key, {
			record: record.value,
			state: "active",
			retiredTokenDigests: current?.retiredTokenDigests ?? new Set<string>(),
		});
		return success(copyRecord(record.value));
	}

	public heartbeat(fence: WriterFence, durationMs?: number): SessionResult<WriterLeaseRecord> {
		return this.renew(fence, durationMs);
	}

	public renew(fence: WriterFence, durationMs?: number): SessionResult<WriterLeaseRecord> {
		const duration = this.resolveDuration(durationMs);
		if (!duration.ok) return duration;
		const now = this.readNow();
		if (!now.ok) return now;
		const current = this.currentActive(fence, now.value);
		if (!current.ok) return current;

		const renewedAt = now.value.toISOString();
		const record: WriterLeaseRecord = {
			...current.value.record,
			renewedAt,
			expiresAt: new Date(now.value.getTime() + duration.value).toISOString(),
		};
		current.value.record = record;
		return success(copyRecord(record));
	}

	public takeover(request: TakeoverWriterLeaseRequest): SessionResult<WriterLeaseRecord> {
		if (!isRuntimeId(request.ownerRuntimeId, "runtime")) {
			return failure("identity_mismatch", "takeover ownerRuntimeId is invalid", false);
		}
		const expectedIdentity = this.validateFenceIdentity(request.expectedFence);
		if (expectedIdentity) return expectedIdentity;
		const duration = this.resolveDuration(request.durationMs);
		if (!duration.ok) return duration;
		const now = this.readNow();
		if (!now.ok) return now;

		const key = scopeKey(request.expectedFence);
		const current = this.leases.get(key);
		if (!current || current.state !== "active") {
			return failure("writer_fenced", "no active writer lease can be taken over", false);
		}
		if (!matchesFence(current.record, request.expectedFence)) {
			return failure("writer_fenced", "writer lease changed before takeover", false, {
				writerEpoch: current.record.writerEpoch,
			});
		}
		if (now.value.getTime() < Date.parse(current.record.expiresAt)) {
			return failure("writer_fenced", "active writer lease is not stale", true, {
				writerEpoch: current.record.writerEpoch,
			});
		}

		const nextEpoch = current.record.writerEpoch + 1;
		if (!Number.isSafeInteger(nextEpoch)) {
			return failure("durable_write_failed", "writer epoch is exhausted", false);
		}
		const retiredTokenDigests = new Set(current.retiredTokenDigests);
		retiredTokenDigests.add(current.record.fencingTokenDigest);
		const issued = this.issueIdentity(retiredTokenDigests);
		if (!issued.ok) return issued;
		const record = this.createRecord(
			request.expectedFence,
			request.ownerRuntimeId,
			nextEpoch,
			issued.value,
			now.value,
			duration.value,
		);
		if (!record.ok) return record;
		current.record = record.value;
		current.state = "active";
		current.retiredTokenDigests = retiredTokenDigests;
		return success(copyRecord(record.value));
	}

	public release(fence: WriterFence): SessionResult<WriterLeaseRecord> {
		const now = this.readNow();
		if (!now.ok) return now;
		const current = this.currentActive(fence, now.value);
		if (!current.ok) return current;

		const record: WriterLeaseRecord = {
			...current.value.record,
			releasedAt: now.value.toISOString(),
		};
		current.value.record = record;
		current.value.state = "released";
		current.value.retiredTokenDigests.add(record.fencingTokenDigest);
		return success(copyRecord(record));
	}

	public validate(fence: WriterFence): SessionResult<WriterLeaseRecord> {
		const now = this.readNow();
		if (!now.ok) return now;
		const current = this.currentActive(fence, now.value);
		if (!current.ok) return current;
		return success(copyRecord(current.value.record));
	}

	private validateAcquireIdentity(request: AcquireWriterLeaseRequest): SessionFailure | undefined {
		if (!isValidScope(request) || !isRuntimeId(request.ownerRuntimeId, "runtime")) {
			return failure("identity_mismatch", "writer lease scope or ownerRuntimeId is invalid", false);
		}
		return undefined;
	}

	private validateFenceIdentity(fence: WriterFence): SessionFailure | undefined {
		if (
			!isValidScope(fence) ||
			!isRuntimeId(fence.leaseId, "lease") ||
			!isRuntimeId(fence.ownerRuntimeId, "runtime") ||
			!Number.isSafeInteger(fence.writerEpoch) ||
			fence.writerEpoch <= 0 ||
			typeof fence.fencingToken !== "string" ||
			!FENCING_TOKEN_PATTERN.test(fence.fencingToken)
		) {
			return failure("identity_mismatch", "writer fence identity is invalid", false);
		}
		return undefined;
	}

	private resolveDuration(durationMs?: number): SessionResult<number> {
		const value = durationMs ?? this.defaultDurationMs;
		if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_WRITER_LEASE_DURATION_MS) {
			return failure("invalid_event", "writer lease duration is outside the allowed range", false);
		}
		return success(value);
	}

	private readNow(): SessionResult<Date> {
		try {
			const now = this.nowFactory();
			if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
				return failure("durable_write_failed", "writer lease clock returned an invalid timestamp", true);
			}
			return success(new Date(now.getTime()));
		} catch {
			return failure("durable_write_failed", "writer lease clock is unavailable", true);
		}
	}

	private issueIdentity(retiredTokenDigests: ReadonlySet<string>): SessionResult<{ leaseId: LeaseId; token: string }> {
		for (let attempt = 0; attempt < MAX_TOKEN_GENERATION_ATTEMPTS; attempt += 1) {
			try {
				const token = this.tokenFactory();
				if (!FENCING_TOKEN_PATTERN.test(token)) continue;
				const digest = digestWriterFencingToken(token);
				if (retiredTokenDigests.has(digest)) continue;
				const leaseId = this.leaseIdFactory();
				if (!isRuntimeId(leaseId, "lease")) continue;
				return success({ leaseId, token });
			} catch {
				return failure("durable_write_failed", "writer lease identity generation failed", true);
			}
		}
		return failure("durable_write_failed", "writer lease could not generate a unique fencing token", true);
	}

	private createRecord(
		scope: WriterLeaseScope,
		ownerRuntimeId: RuntimeInstanceId,
		writerEpoch: number,
		identity: { leaseId: LeaseId; token: string },
		now: Date,
		durationMs: number,
	): SessionResult<WriterLeaseRecord> {
		try {
			const timestamp = now.toISOString();
			return success({
				authorityId: scope.authorityId,
				tenantId: scope.tenantId,
				stream: { ...scope.stream },
				leaseId: identity.leaseId,
				ownerRuntimeId,
				writerEpoch,
				fencingToken: identity.token,
				fencingTokenDigest: digestWriterFencingToken(identity.token),
				acquiredAt: timestamp,
				renewedAt: timestamp,
				expiresAt: new Date(now.getTime() + durationMs).toISOString(),
			});
		} catch {
			return failure("durable_write_failed", "writer lease record creation failed", true);
		}
	}

	private currentActive(fence: WriterFence, now: Date): SessionResult<StoredLease> {
		const identityFailure = this.validateFenceIdentity(fence);
		if (identityFailure) return identityFailure;
		const current = this.leases.get(scopeKey(fence));
		if (!current || current.state !== "active") {
			return failure("writer_fenced", "writer lease is not active", false);
		}
		const tokenDigest = digestWriterFencingToken(fence.fencingToken);
		if (current.retiredTokenDigests.has(tokenDigest) || !matchesFence(current.record, fence)) {
			return failure("writer_fenced", "writer fence no longer owns the session", false, {
				writerEpoch: current.record.writerEpoch,
			});
		}
		if (now.getTime() >= Date.parse(current.record.expiresAt)) {
			return failure("writer_fenced", "writer lease has expired", false, {
				writerEpoch: current.record.writerEpoch,
			});
		}
		return success(current);
	}
}

/**
 * 单 session 文件型 writer lease。
 *
 * 每个公开操作都在线性化文件锁内完成严格读取与 CAS；canonical state 先写入
 * 同目录临时文件并 fsync，再原子替换目标并 fsync 父目录。状态损坏时绝不把它
 * 当作“尚未 acquire”，避免 epoch 回退或旧 token 复活。
 */
export class FileWriterLeaseStore implements WriterLeaseStore {
	public readonly filePath: string;
	private readonly expectedScope?: WriterLeaseScope;
	private readonly defaultDurationMs: number;
	private readonly lockStaleMs: number;
	private readonly nowFactory: () => Date;
	private readonly tokenFactory: () => string;
	private readonly leaseIdFactory: () => LeaseId;

	public constructor(filePath: string, options: FileWriterLeaseStoreOptions = {}) {
		this.filePath = typeof filePath === "string" && filePath.length > 0 ? resolve(filePath) : "";
		this.expectedScope = options.scope ? copyScope(options.scope) : undefined;
		this.defaultDurationMs = options.defaultDurationMs ?? DEFAULT_WRITER_LEASE_DURATION_MS;
		this.lockStaleMs = options.lockStaleMs ?? DEFAULT_WRITER_LEASE_LOCK_STALE_MS;
		this.nowFactory = options.now ?? (() => new Date());
		this.tokenFactory = options.tokenFactory ?? (() => randomBytes(32).toString("base64url"));
		this.leaseIdFactory = options.leaseIdFactory ?? (() => createRuntimeId("lease"));
	}

	public acquire(request: AcquireWriterLeaseRequest): SessionResult<WriterLeaseRecord> {
		const identityFailure = this.validateAcquireIdentity(request);
		if (identityFailure) return identityFailure;
		const duration = this.resolveDuration(request.durationMs);
		if (!duration.ok) return duration;

		return this.withStateLock(() => {
			const now = this.readNow();
			if (!now.ok) return now;
			const loaded = this.readState();
			if (!loaded.ok) return loaded;
			const current = loaded.value;
			if (current && !matchesScope(current.scope, request)) {
				return failure("identity_mismatch", "writer lease state is bound to another scope", false);
			}
			if (current?.state === "active") {
				const stale = now.value.getTime() >= Date.parse(current.record.expiresAt);
				return failure(
					"writer_fenced",
					stale ? "writer lease is stale and requires CAS takeover" : "writer lease is already active",
					true,
					{ writerEpoch: current.record.writerEpoch, stale },
				);
			}

			const nextEpoch = (current?.record.writerEpoch ?? 0) + 1;
			const nextRevision = (current?.stateRevision ?? 0) + 1;
			if (!Number.isSafeInteger(nextEpoch) || !Number.isSafeInteger(nextRevision)) {
				return failure("durable_write_failed", "writer lease counter is exhausted", false);
			}
			const retiredTokenDigests = new Set(current?.retiredTokenDigests ?? []);
			const issued = this.issueIdentity(retiredTokenDigests);
			if (!issued.ok) return issued;
			const record = this.createRecord(
				request,
				request.ownerRuntimeId,
				nextEpoch,
				issued.value,
				now.value,
				duration.value,
			);
			if (!record.ok) return record;
			const next = sealPersistedState({
				schemaVersion: WRITER_LEASE_STATE_SCHEMA_VERSION,
				stateRevision: nextRevision,
				scope: copyScope(request),
				state: "active",
				record: record.value,
				retiredTokenDigests: [...retiredTokenDigests].sort(),
			});
			const written = this.writeState(next);
			if (!written.ok) return written;
			return success(copyRecord(record.value));
		});
	}

	/** 只读取得当前 active CAS 值，供 startup 对过期 owner 做显式 takeover。 */
	public inspect(scope: WriterLeaseScope): SessionResult<WriterLeaseRecord | undefined> {
		if (!isValidScope(scope)) {
			return failure("identity_mismatch", "writer lease scope is invalid", false);
		}
		const scopeFailure = this.validateExpectedScope(scope);
		if (scopeFailure) return scopeFailure;
		return this.withStateLock(() => {
			const loaded = this.readState();
			if (!loaded.ok) return loaded;
			const current = loaded.value;
			if (!current || current.state !== "active") return success(undefined);
			if (!matchesScope(current.scope, scope)) {
				return failure("identity_mismatch", "writer lease state is bound to another scope", false);
			}
			return success(copyRecord(current.record));
		});
	}

	/**
	 * 只读确认 exact fence 已 durable release。
	 *
	 * release 的 canonical replace 已完成、但调用方没有收到成功返回时，可用此读取
	 * 消除 ack loss。任何 active、已换代或不同 fence 都不会被误判成已释放。
	 */
	public inspectReleased(fence: WriterFence): SessionResult<WriterLeaseRecord | undefined> {
		const identityFailure = this.validateFenceIdentity(fence);
		if (identityFailure) return identityFailure;
		const scopeFailure = this.validateExpectedScope(fence);
		if (scopeFailure) return scopeFailure;

		return this.withStateLock(() => {
			const loaded = this.readState();
			if (!loaded.ok) return loaded;
			const current = loaded.value;
			if (!current) return success(undefined);
			if (!matchesScope(current.scope, fence)) {
				return failure("identity_mismatch", "writer lease state is bound to another scope", false);
			}
			if (current.state !== "released" || !matchesFence(current.record, fence)) {
				return success(undefined);
			}
			return success(copyRecord(current.record));
		});
	}

	public heartbeat(fence: WriterFence, durationMs?: number): SessionResult<WriterLeaseRecord> {
		return this.renew(fence, durationMs);
	}

	public renew(fence: WriterFence, durationMs?: number): SessionResult<WriterLeaseRecord> {
		const identityFailure = this.validateFenceIdentity(fence);
		if (identityFailure) return identityFailure;
		const scopeFailure = this.validateExpectedScope(fence);
		if (scopeFailure) return scopeFailure;
		const duration = this.resolveDuration(durationMs);
		if (!duration.ok) return duration;

		return this.withStateLock(() => {
			const now = this.readNow();
			if (!now.ok) return now;
			const current = this.readCurrentActive(fence, now.value);
			if (!current.ok) return current;
			const nextRevision = current.value.stateRevision + 1;
			if (!Number.isSafeInteger(nextRevision)) {
				return failure("durable_write_failed", "writer lease state revision is exhausted", false);
			}
			const renewedAt = now.value.toISOString();
			const record: WriterLeaseRecord = {
				...current.value.record,
				renewedAt,
				expiresAt: new Date(now.value.getTime() + duration.value).toISOString(),
			};
			const next = sealPersistedState({
				...current.value,
				stateRevision: nextRevision,
				record,
			});
			const written = this.writeState(next);
			if (!written.ok) return written;
			return success(copyRecord(record));
		});
	}

	public takeover(request: TakeoverWriterLeaseRequest): SessionResult<WriterLeaseRecord> {
		if (!isRuntimeId(request.ownerRuntimeId, "runtime")) {
			return failure("identity_mismatch", "takeover ownerRuntimeId is invalid", false);
		}
		const identityFailure = this.validateFenceIdentity(request.expectedFence);
		if (identityFailure) return identityFailure;
		const scopeFailure = this.validateExpectedScope(request.expectedFence);
		if (scopeFailure) return scopeFailure;
		const duration = this.resolveDuration(request.durationMs);
		if (!duration.ok) return duration;

		return this.withStateLock(() => {
			const now = this.readNow();
			if (!now.ok) return now;
			const loaded = this.readState();
			if (!loaded.ok) return loaded;
			const current = loaded.value;
			if (!current || current.state !== "active") {
				return failure("writer_fenced", "no active writer lease can be taken over", false);
			}
			if (!matchesScope(current.scope, request.expectedFence)) {
				return failure("identity_mismatch", "writer lease state is bound to another scope", false);
			}
			if (!matchesFence(current.record, request.expectedFence)) {
				return failure("writer_fenced", "writer lease changed before takeover", false, {
					writerEpoch: current.record.writerEpoch,
				});
			}
			if (now.value.getTime() < Date.parse(current.record.expiresAt)) {
				return failure("writer_fenced", "active writer lease is not stale", true, {
					writerEpoch: current.record.writerEpoch,
				});
			}

			const nextEpoch = current.record.writerEpoch + 1;
			const nextRevision = current.stateRevision + 1;
			if (!Number.isSafeInteger(nextEpoch) || !Number.isSafeInteger(nextRevision)) {
				return failure("durable_write_failed", "writer lease counter is exhausted", false);
			}
			const retiredTokenDigests = new Set(current.retiredTokenDigests);
			retiredTokenDigests.add(current.record.fencingTokenDigest);
			const issued = this.issueIdentity(retiredTokenDigests);
			if (!issued.ok) return issued;
			const record = this.createRecord(
				request.expectedFence,
				request.ownerRuntimeId,
				nextEpoch,
				issued.value,
				now.value,
				duration.value,
			);
			if (!record.ok) return record;
			const next = sealPersistedState({
				...current,
				stateRevision: nextRevision,
				state: "active",
				record: record.value,
				retiredTokenDigests: [...retiredTokenDigests].sort(),
			});
			const written = this.writeState(next);
			if (!written.ok) return written;
			return success(copyRecord(record.value));
		});
	}

	public release(fence: WriterFence): SessionResult<WriterLeaseRecord> {
		const identityFailure = this.validateFenceIdentity(fence);
		if (identityFailure) return identityFailure;
		const scopeFailure = this.validateExpectedScope(fence);
		if (scopeFailure) return scopeFailure;

		return this.withStateLock(() => {
			const now = this.readNow();
			if (!now.ok) return now;
			const current = this.readCurrentActive(fence, now.value);
			if (!current.ok) return current;
			const nextRevision = current.value.stateRevision + 1;
			if (!Number.isSafeInteger(nextRevision)) {
				return failure("durable_write_failed", "writer lease state revision is exhausted", false);
			}
			const record: WriterLeaseRecord = {
				...current.value.record,
				releasedAt: now.value.toISOString(),
			};
			const retiredTokenDigests = new Set(current.value.retiredTokenDigests);
			retiredTokenDigests.add(record.fencingTokenDigest);
			const next = sealPersistedState({
				...current.value,
				stateRevision: nextRevision,
				state: "released",
				record,
				retiredTokenDigests: [...retiredTokenDigests].sort(),
			});
			const written = this.writeState(next);
			if (!written.ok) return written;
			return success(copyRecord(record));
		});
	}

	public validate(fence: WriterFence): SessionResult<WriterLeaseRecord> {
		const identityFailure = this.validateFenceIdentity(fence);
		if (identityFailure) return identityFailure;
		const scopeFailure = this.validateExpectedScope(fence);
		if (scopeFailure) return scopeFailure;

		return this.withStateLock(() => {
			const now = this.readNow();
			if (!now.ok) return now;
			const current = this.readCurrentActive(fence, now.value);
			if (!current.ok) return current;
			return success(copyRecord(current.value.record));
		});
	}

	private validateAcquireIdentity(request: AcquireWriterLeaseRequest): SessionFailure | undefined {
		if (!isValidScope(request) || !isRuntimeId(request.ownerRuntimeId, "runtime")) {
			return failure("identity_mismatch", "writer lease scope or ownerRuntimeId is invalid", false);
		}
		return this.validateExpectedScope(request);
	}

	private validateExpectedScope(scope: WriterLeaseScope): SessionFailure | undefined {
		if (this.expectedScope && (!isValidScope(this.expectedScope) || !matchesScope(this.expectedScope, scope))) {
			return failure("identity_mismatch", "writer lease request does not match the configured scope", false);
		}
		return undefined;
	}

	private validateFenceIdentity(fence: WriterFence): SessionFailure | undefined {
		if (
			!isValidScope(fence) ||
			!isRuntimeId(fence.leaseId, "lease") ||
			!isRuntimeId(fence.ownerRuntimeId, "runtime") ||
			!Number.isSafeInteger(fence.writerEpoch) ||
			fence.writerEpoch <= 0 ||
			typeof fence.fencingToken !== "string" ||
			!FENCING_TOKEN_PATTERN.test(fence.fencingToken)
		) {
			return failure("identity_mismatch", "writer fence identity is invalid", false);
		}
		return undefined;
	}

	private resolveDuration(durationMs?: number): SessionResult<number> {
		const value = durationMs ?? this.defaultDurationMs;
		if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_WRITER_LEASE_DURATION_MS) {
			return failure("invalid_event", "writer lease duration is outside the allowed range", false);
		}
		return success(value);
	}

	private readNow(): SessionResult<Date> {
		try {
			const now = this.nowFactory();
			if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
				return failure("durable_write_failed", "writer lease clock returned an invalid timestamp", true);
			}
			return success(new Date(now.getTime()));
		} catch {
			return failure("durable_write_failed", "writer lease clock is unavailable", true);
		}
	}

	private issueIdentity(retiredTokenDigests: ReadonlySet<string>): SessionResult<{ leaseId: LeaseId; token: string }> {
		for (let attempt = 0; attempt < MAX_TOKEN_GENERATION_ATTEMPTS; attempt += 1) {
			try {
				const token = this.tokenFactory();
				if (!FENCING_TOKEN_PATTERN.test(token)) continue;
				const digest = digestWriterFencingToken(token);
				if (retiredTokenDigests.has(digest)) continue;
				const leaseId = this.leaseIdFactory();
				if (!isRuntimeId(leaseId, "lease")) continue;
				return success({ leaseId, token });
			} catch {
				return failure("durable_write_failed", "writer lease identity generation failed", true);
			}
		}
		return failure("durable_write_failed", "writer lease could not generate a unique fencing token", true);
	}

	private createRecord(
		scope: WriterLeaseScope,
		ownerRuntimeId: RuntimeInstanceId,
		writerEpoch: number,
		identity: { leaseId: LeaseId; token: string },
		now: Date,
		durationMs: number,
	): SessionResult<WriterLeaseRecord> {
		try {
			const timestamp = now.toISOString();
			return success({
				authorityId: scope.authorityId,
				tenantId: scope.tenantId,
				stream: { ...scope.stream },
				leaseId: identity.leaseId,
				ownerRuntimeId,
				writerEpoch,
				fencingToken: identity.token,
				fencingTokenDigest: digestWriterFencingToken(identity.token),
				acquiredAt: timestamp,
				renewedAt: timestamp,
				expiresAt: new Date(now.getTime() + durationMs).toISOString(),
			});
		} catch {
			return failure("durable_write_failed", "writer lease record creation failed", true);
		}
	}

	private readCurrentActive(fence: WriterFence, now: Date): SessionResult<PersistedWriterLeaseState> {
		const loaded = this.readState();
		if (!loaded.ok) return loaded;
		const current = loaded.value;
		if (!current || current.state !== "active") {
			return failure("writer_fenced", "writer lease is not active", false);
		}
		if (!matchesScope(current.scope, fence)) {
			return failure("identity_mismatch", "writer lease state is bound to another scope", false);
		}
		const tokenDigest = digestWriterFencingToken(fence.fencingToken);
		if (current.retiredTokenDigests.includes(tokenDigest) || !matchesFence(current.record, fence)) {
			return failure("writer_fenced", "writer fence no longer owns the session", false, {
				writerEpoch: current.record.writerEpoch,
			});
		}
		if (now.getTime() >= Date.parse(current.record.expiresAt)) {
			return failure("writer_fenced", "writer lease has expired", false, {
				writerEpoch: current.record.writerEpoch,
			});
		}
		return success(current);
	}

	private readState(): SessionResult<PersistedWriterLeaseState | undefined> {
		try {
			const metadata = lstatSync(this.filePath);
			if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size <= 0 || metadata.size > MAX_WRITER_LEASE_STATE_BYTES) {
				return failure("corrupted_log", "writer lease state is invalid", false);
			}
			const source = readFileSync(this.filePath, "utf8");
			let parsed: unknown;
			try {
				parsed = JSON.parse(source);
			} catch {
				return failure("corrupted_log", "writer lease state is invalid", false);
			}
			if (!isValidPersistedState(parsed) || serializePersistedState(parsed) !== source) {
				return failure("corrupted_log", "writer lease state is invalid", false);
			}
			return success(parsed);
		} catch (error) {
			if (isErrnoCode(error, "ENOENT")) return success(undefined);
			return failure("durable_write_failed", "writer lease state cannot be read", true);
		}
	}

	private writeState(state: PersistedWriterLeaseState): SessionResult<undefined> {
		if (!isValidPersistedState(state)) {
			return failure("durable_write_failed", "writer lease state cannot be encoded", false);
		}
		const directory = dirname(this.filePath);
		let temporaryPath = "";
		let descriptor: number | undefined;
		try {
			temporaryPath = `${this.filePath}.${process.pid}.${randomBytes(12).toString("hex")}.tmp`;
			descriptor = openSync(temporaryPath, "wx", 0o600);
			writeFileSync(descriptor, serializePersistedState(state), { encoding: "utf8" });
			fsyncSync(descriptor);
			closeSync(descriptor);
			descriptor = undefined;
			renameSync(temporaryPath, this.filePath);
			temporaryPath = "";
			const directoryDescriptor = openSync(directory, "r");
			try {
				fsyncSync(directoryDescriptor);
			} finally {
				closeSync(directoryDescriptor);
			}
			return success(undefined);
		} catch {
			if (descriptor !== undefined) {
				try {
					closeSync(descriptor);
				} catch {
					// 原始 durable failure 优先，且不泄露底层错误。
				}
			}
			if (temporaryPath.length > 0) {
				try {
					unlinkSync(temporaryPath);
				} catch {
					// 残留临时文件不替代 canonical state，也不改变错误形状。
				}
			}
			return failure("durable_write_failed", "writer lease state cannot be committed", true);
		}
	}

	private withStateLock<T>(operation: () => SessionResult<T>): SessionResult<T> {
		if (
			this.filePath.length === 0 ||
			!Number.isSafeInteger(this.lockStaleMs) ||
			this.lockStaleMs < 2_000
		) {
			return failure("invalid_event", "writer lease state configuration is invalid", false);
		}
		try {
			mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 });
		} catch {
			return failure("durable_write_failed", "writer lease state directory is unavailable", true);
		}

		let release: (() => void) | undefined;
		try {
			release = lockfile.lockSync(this.filePath, {
				realpath: false,
				lockfilePath: `${this.filePath}.lock`,
				retries: 0,
				stale: this.lockStaleMs,
				update: Math.max(1_000, Math.floor(this.lockStaleMs / 2)),
				onCompromised: () => undefined,
			});
		} catch {
			return failure("durable_write_failed", "writer lease state is temporarily unavailable", true);
		}

		let result: SessionResult<T>;
		try {
			result = operation();
		} catch {
			result = failure("durable_write_failed", "writer lease state operation failed", true);
		}
		try {
			release();
		} catch {
			return failure("durable_write_failed", "writer lease state lock could not be released", true);
		}
		return result;
	}
}

function isErrnoCode(error: unknown, code: string): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error as { code?: unknown }).code === code
	);
}
