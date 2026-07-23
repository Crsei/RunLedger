/** Session create/fork 的 durable staging 与原子 publication 记录。 */

import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { canonicalDigest, canonicalJson } from "../protocol/v3/canonical-json.ts";
import { isRuntimeId } from "../protocol/v3/ids.ts";
import type {
	AgentId,
	AuthorityId,
	EventId,
	GoalId,
	SessionId,
	TenantId,
} from "../protocol/v3/ids.ts";
import type { EventCursor } from "../protocol/v3/events.ts";
import type { MutationEffect, SessionResult } from "./types.ts";

export const SESSION_PUBLICATION_SCHEMA_VERSION = 1;
export const SESSION_PUBLICATION_FILE_NAME = "publication.json";

export type SessionPublicationKind = "create" | "fork";
export type SessionPublicationState = "staging" | "published" | "failed";
export type SessionPublicationWritePhase =
	| "before_intent_write"
	| "after_intent_rename_before_sync"
	| "before_publish_write"
	| "after_publish_rename_before_sync"
	| "after_publish_sync"
	| "before_failed_write"
	| "after_failed_rename_before_sync";

export interface SessionPublicationHead {
	sequence: number;
	eventId: EventId;
	eventHash: string;
}

export interface SessionPublicationRecord {
	schemaVersion: typeof SESSION_PUBLICATION_SCHEMA_VERSION;
	state: SessionPublicationState;
	kind: SessionPublicationKind;
	authorityId: AuthorityId;
	tenantId: TenantId;
	sessionId: SessionId;
	fileName: string;
	initialGoalId: GoalId;
	rootAgentId: AgentId;
	createdAt: string;
	publishedAt: string | null;
	writerEpoch: number | null;
	genesis: SessionPublicationHead | null;
	head: SessionPublicationHead | null;
	projectionDigest: string | null;
	failureDigest: string | null;
	recordDigest: string;
}

export interface BeginSessionPublicationOptions {
	stateDirectory: string;
	filePath: string;
	kind: SessionPublicationKind;
	authorityId: AuthorityId;
	tenantId: TenantId;
	sessionId: SessionId;
	initialGoalId: GoalId;
	rootAgentId: AgentId;
	createdAt?: string;
	onWritePhase?: (phase: SessionPublicationWritePhase) => Promise<void> | void;
}

export interface CommitSessionPublicationOptions {
	stateDirectory: string;
	expected: SessionPublicationRecord;
	genesis: EventCursor;
	head: EventCursor;
	writerEpoch: number;
	projectionDigest: string;
	publishedAt?: string;
	onWritePhase?: (phase: SessionPublicationWritePhase) => Promise<void> | void;
}

interface PublicationBody {
	schemaVersion: typeof SESSION_PUBLICATION_SCHEMA_VERSION;
	state: SessionPublicationState;
	kind: SessionPublicationKind;
	authorityId: AuthorityId;
	tenantId: TenantId;
	sessionId: SessionId;
	fileName: string;
	initialGoalId: GoalId;
	rootAgentId: AgentId;
	createdAt: string;
	publishedAt: string | null;
	writerEpoch: number | null;
	genesis: SessionPublicationHead | null;
	head: SessionPublicationHead | null;
	projectionDigest: string | null;
	failureDigest: string | null;
}

function failure<T>(
	message: string,
	effect: MutationEffect,
	error?: unknown,
): SessionResult<T> {
	return {
		ok: false,
		error: {
			code: "durable_write_failed",
			message,
			retryable: false,
			effect,
			...(error === undefined
				? {}
				: { details: { errorName: error instanceof Error ? error.name : "UnknownError" } }),
		},
	};
}

function publicationPath(stateDirectory: string): string {
	return join(stateDirectory, SESSION_PUBLICATION_FILE_NAME);
}

function bodyOf(record: SessionPublicationRecord | PublicationBody): PublicationBody {
	return {
		schemaVersion: record.schemaVersion,
		state: record.state,
		kind: record.kind,
		authorityId: record.authorityId,
		tenantId: record.tenantId,
		sessionId: record.sessionId,
		fileName: record.fileName,
		initialGoalId: record.initialGoalId,
		rootAgentId: record.rootAgentId,
		createdAt: record.createdAt,
		publishedAt: record.publishedAt,
		writerEpoch: record.writerEpoch,
		genesis: record.genesis === null ? null : { ...record.genesis },
		head: record.head === null ? null : { ...record.head },
		projectionDigest: record.projectionDigest,
		failureDigest: record.failureDigest,
	};
}

function seal(body: PublicationBody): SessionPublicationRecord {
	return { ...bodyOf(body), recordDigest: canonicalDigest(bodyOf(body)) };
}

function sameIntent(
	left: SessionPublicationRecord,
	right: SessionPublicationRecord,
): boolean {
	return left.schemaVersion === right.schemaVersion &&
		left.kind === right.kind &&
		left.authorityId === right.authorityId &&
		left.tenantId === right.tenantId &&
		left.sessionId === right.sessionId &&
		left.fileName === right.fileName &&
		left.initialGoalId === right.initialGoalId &&
		left.rootAgentId === right.rootAgentId &&
		left.createdAt === right.createdAt;
}

function canonicalTimestamp(value: unknown): value is string {
	if (typeof value !== "string") return false;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function digest(value: unknown): value is string {
	return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
	const actual = Object.keys(value).sort();
	const expected = [...keys].sort();
	return actual.length === expected.length &&
		actual.every((key, index) => key === expected[index]);
}

function plainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validHead(value: unknown): value is SessionPublicationHead {
	return plainObject(value) &&
		exactKeys(value, ["sequence", "eventId", "eventHash"]) &&
		Number.isSafeInteger(value.sequence) &&
		(value.sequence as number) >= 0 &&
		isRuntimeId(value.eventId, "event") &&
		digest(value.eventHash);
}

function validRecord(value: unknown): value is SessionPublicationRecord {
	if (!plainObject(value) || !exactKeys(value, [
		"schemaVersion",
		"state",
		"kind",
		"authorityId",
		"tenantId",
		"sessionId",
		"fileName",
		"initialGoalId",
		"rootAgentId",
		"createdAt",
		"publishedAt",
		"writerEpoch",
		"genesis",
		"head",
		"projectionDigest",
		"failureDigest",
		"recordDigest",
	])) return false;
	if (
		value.schemaVersion !== SESSION_PUBLICATION_SCHEMA_VERSION ||
		(value.state !== "staging" && value.state !== "published" && value.state !== "failed") ||
		(value.kind !== "create" && value.kind !== "fork") ||
		!isRuntimeId(value.authorityId, "authority") ||
		!isRuntimeId(value.tenantId, "tenant") ||
		!isRuntimeId(value.sessionId, "session") ||
		typeof value.fileName !== "string" ||
		value.fileName.length < 1 ||
		value.fileName !== basename(value.fileName) ||
		!value.fileName.endsWith(`_${value.sessionId}.jsonl`) ||
		!isRuntimeId(value.initialGoalId, "goal") ||
		!isRuntimeId(value.rootAgentId, "agent") ||
		!canonicalTimestamp(value.createdAt) ||
		(value.publishedAt !== null && !canonicalTimestamp(value.publishedAt)) ||
		(value.writerEpoch !== null &&
			(!Number.isSafeInteger(value.writerEpoch) || (value.writerEpoch as number) < 1)) ||
		(value.genesis !== null && !validHead(value.genesis)) ||
		(value.head !== null && !validHead(value.head)) ||
		(value.projectionDigest !== null && !digest(value.projectionDigest)) ||
		(value.failureDigest !== null && !digest(value.failureDigest)) ||
		!digest(value.recordDigest)
	) return false;
	const record = value as unknown as SessionPublicationRecord;
	if (record.recordDigest !== canonicalDigest(bodyOf(record))) return false;
	if (record.state === "staging") {
		return record.publishedAt === null &&
			record.writerEpoch === null &&
			record.genesis === null &&
			record.head === null &&
			record.projectionDigest === null &&
			record.failureDigest === null;
	}
	if (record.state === "failed") {
		return record.publishedAt === null &&
			record.writerEpoch === null &&
			record.genesis === null &&
			record.head === null &&
			record.projectionDigest === null &&
			record.failureDigest !== null;
	}
	return record.publishedAt !== null &&
		record.writerEpoch !== null &&
		record.genesis !== null &&
		record.genesis.sequence === 0 &&
		record.head !== null &&
		record.head.sequence >= record.genesis.sequence &&
		record.projectionDigest !== null &&
		record.failureDigest === null;
}

async function syncDirectory(path: string): Promise<void> {
	const handle = await open(path, "r");
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}

async function ensureStateDirectory(stateDirectory: string): Promise<void> {
	await mkdir(dirname(stateDirectory), { recursive: true, mode: 0o700 });
	let created = false;
	try {
		await mkdir(stateDirectory, { mode: 0o700 });
		created = true;
	} catch (error) {
		if (!plainObject(error) || error.code !== "EEXIST") throw error;
	}
	if (created) await syncDirectory(dirname(stateDirectory));
}

async function writeAtomic(
	stateDirectory: string,
	record: SessionPublicationRecord,
	beforeWritePhase: SessionPublicationWritePhase,
	afterRenamePhase: SessionPublicationWritePhase,
	onWritePhase?: (phase: SessionPublicationWritePhase) => Promise<void> | void,
): Promise<SessionResult<SessionPublicationRecord>> {
	const target = publicationPath(stateDirectory);
	const temporary = `${target}.tmp-${process.pid}-${randomUUID()}`;
	let renamed = false;
	try {
		await ensureStateDirectory(stateDirectory);
		await onWritePhase?.(beforeWritePhase);
		const handle = await open(
			temporary,
			constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
			0o600,
		);
		try {
			await handle.writeFile(`${canonicalJson(record)}\n`, "utf8");
			await handle.sync();
		} finally {
			await handle.close();
		}
		await rename(temporary, target);
		renamed = true;
		await onWritePhase?.(afterRenamePhase);
		await syncDirectory(stateDirectory);
		return { ok: true, value: record };
	} catch (error) {
		await rm(temporary, { force: true }).catch(() => undefined);
		return failure(
			"session publication state could not be durably updated",
			renamed ? "uncertain" : "none",
			error,
		);
	}
}

export async function readSessionPublication(
	stateDirectory: string,
): Promise<SessionResult<SessionPublicationRecord | undefined>> {
	let source: string;
	try {
		source = await readFile(publicationPath(stateDirectory), "utf8");
	} catch (error) {
		if (plainObject(error) && error.code === "ENOENT") {
			return { ok: true, value: undefined };
		}
		return failure("session publication state could not be read", "none", error);
	}
	if (!source.endsWith("\n") || source.indexOf("\n") !== source.length - 1) {
		return failure("session publication state is not one canonical LF record", "none");
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(source.slice(0, -1)) as unknown;
	} catch {
		return failure("session publication state contains malformed JSON", "none");
	}
	if (!validRecord(parsed) || canonicalJson(parsed) !== source.slice(0, -1)) {
		return failure("session publication state is invalid or non-canonical", "none");
	}
	return { ok: true, value: parsed };
}

export async function beginSessionPublication(
	options: BeginSessionPublicationOptions,
): Promise<SessionResult<SessionPublicationRecord>> {
	const existing = await readSessionPublication(options.stateDirectory);
	if (!existing.ok) return existing;
	if (existing.value !== undefined) {
		return failure("session publication target already has durable state", "none");
	}
	const record = seal({
		schemaVersion: SESSION_PUBLICATION_SCHEMA_VERSION,
		state: "staging",
		kind: options.kind,
		authorityId: options.authorityId,
		tenantId: options.tenantId,
		sessionId: options.sessionId,
		fileName: basename(options.filePath),
		initialGoalId: options.initialGoalId,
		rootAgentId: options.rootAgentId,
		createdAt: options.createdAt ?? new Date().toISOString(),
		publishedAt: null,
		writerEpoch: null,
		genesis: null,
		head: null,
		projectionDigest: null,
		failureDigest: null,
	});
	if (!validRecord(record)) {
		return failure("session publication intent is invalid", "none");
	}
	return writeAtomic(
		options.stateDirectory,
		record,
		"before_intent_write",
		"after_intent_rename_before_sync",
		options.onWritePhase,
	);
}

export async function commitSessionPublication(
	options: CommitSessionPublicationOptions,
): Promise<SessionResult<SessionPublicationRecord>> {
	const current = await readSessionPublication(options.stateDirectory);
	if (!current.ok) return current;
	if (
		current.value?.state === "published" &&
		current.value.recordDigest !== options.expected.recordDigest
	) return failure("session publication was committed from another intent", "none");
	if (current.value?.state === "published") {
		return { ok: true, value: current.value };
	}
	if (
		current.value?.state !== "staging" ||
		current.value.recordDigest !== options.expected.recordDigest
	) return failure("session publication intent is missing, failed, or stale", "none");
	if (
		options.genesis.stream.scope !== "session" ||
		options.head.stream.scope !== "session" ||
		options.genesis.stream.sessionId !== current.value.sessionId ||
		options.head.stream.sessionId !== current.value.sessionId ||
		options.genesis.sequence !== 0 ||
		options.head.sequence < options.genesis.sequence
	) return failure("session publication cursors do not bind the staged session", "none");
	const record = seal({
		...bodyOf(current.value),
		state: "published",
		publishedAt: options.publishedAt ?? new Date().toISOString(),
		writerEpoch: options.writerEpoch,
		genesis: {
			sequence: options.genesis.sequence,
			eventId: options.genesis.eventId,
			eventHash: options.genesis.eventHash,
		},
		head: {
			sequence: options.head.sequence,
			eventId: options.head.eventId,
			eventHash: options.head.eventHash,
		},
		projectionDigest: options.projectionDigest,
		failureDigest: null,
	});
	if (!validRecord(record)) {
		return failure("session publication commit is invalid", "none");
	}
	const written = await writeAtomic(
		options.stateDirectory,
		record,
		"before_publish_write",
		"after_publish_rename_before_sync",
		options.onWritePhase,
	);
	if (!written.ok) return written;
	try {
		await options.onWritePhase?.("after_publish_sync");
	} catch (error) {
		const reconciled = await readSessionPublication(options.stateDirectory);
		if (
			reconciled.ok &&
			reconciled.value?.state === "published" &&
			reconciled.value.recordDigest === record.recordDigest
		) {
			return { ok: true, value: reconciled.value };
		}
		return failure("session publication acknowledgement was lost", "uncertain", error);
	}
	return written;
}

export async function failSessionPublication(
	stateDirectory: string,
	expected: SessionPublicationRecord,
	reason: string,
	onWritePhase?: (phase: SessionPublicationWritePhase) => Promise<void> | void,
): Promise<SessionResult<SessionPublicationRecord>> {
	const current = await readSessionPublication(stateDirectory);
	if (!current.ok) return current;
	if (current.value?.state === "failed") {
		return sameIntent(current.value, expected)
			? { ok: true, value: current.value }
			: failure("session publication failed state belongs to another intent", "none");
	}
	if (
		(current.value?.state !== "staging" && current.value?.state !== "published") ||
		!sameIntent(current.value, expected)
	) return failure("session publication cannot be failed from its current state", "none");
	const record = seal({
		...bodyOf(current.value),
		state: "failed",
		publishedAt: null,
		writerEpoch: null,
		genesis: null,
		head: null,
		projectionDigest: null,
		failureDigest: canonicalDigest({ reason }),
	});
	if (!validRecord(record)) {
		return failure("session publication failure record is invalid", "none");
	}
	return writeAtomic(
		stateDirectory,
		record,
		"before_failed_write",
		"after_failed_rename_before_sync",
		onWritePhase,
	);
}
