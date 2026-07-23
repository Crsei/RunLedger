/** v1/v2 ledger 到全新 Runtime v3 session 的显式、只读源迁移核心。 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { canonicalDigest, canonicalJson } from "../protocol/v3/canonical-json.ts";
import type { RuntimeEventPayloadMap } from "../protocol/v3/event-payloads.ts";
import {
	RUNTIME_SCHEMA_VERSION,
	sameRuntimeEventStream,
	type EventCursor,
	type RuntimeEventV3,
} from "../protocol/v3/events.ts";
import type {
	CommandId,
	PrincipalId,
	SessionId,
	TraceId,
} from "../protocol/v3/ids.ts";
import { validateRuntimeEvent } from "../protocol/v3/schemas.ts";
import type { LedgerEntry, LedgerEntryType, LedgerHeader } from "../ledger/types.ts";
import type { AgentMessage } from "../types.ts";
import { replaySession, type SessionRuntimeConfig } from "../../storage/session-codec.ts";
import { SessionManager } from "../../storage/session-manager.ts";
import type { RuntimeEventStore } from "./event-store.ts";
import type { EventWriter } from "./event-writer.ts";
import { scanJsonlV3EventLog } from "./jsonl-v3-store.ts";
import {
	LEGACY_MIGRATION_SCHEMA,
	legacyMigrationManifestDigest,
	legacyMigrationManifestFromStarted,
	legacyMigrationRecordSetDigest,
	type LegacyMigrationImportDescriptor,
	type LegacyMigrationManifestBody,
} from "./legacy-migration-manifest.ts";
import { reduceSessionEvents } from "./reducer.ts";
import { readAllRuntimeEvents } from "./snapshot.ts";
import type { SessionKernelError, SessionResult } from "./types.ts";

export const LEGACY_IMPORTER_VERSION = "runledger-legacy-importer-v1";
export { LEGACY_MIGRATION_SCHEMA } from "./legacy-migration-manifest.ts";

export type LegacySessionVersion = 1 | 2;
export type LegacyMigrationMode = "migrate" | "fork-to-v3";
export type SessionVersionFenceOperation =
	| "inspect"
	| "export"
	| "continue"
	| "append"
	| "migrate"
	| "fork-to-v3";

export interface LegacySourceFingerprint {
	readonly sourceVersion: LegacySessionVersion;
	readonly sourceDigest: string;
	readonly sourceSize: number;
	/** 首行 JSON bytes 的 SHA-256；不含 LF/CRLF framing。 */
	readonly headerDigest: string;
	readonly sourceSessionId: string;
}

export interface LegacyForensicReport {
	readonly issue: "torn_tail";
	readonly sourceDigest: string;
	readonly sourceSize: number;
	readonly byteOffset: number;
	readonly completeLineCount: number;
	readonly message: string;
	readonly sourceVersion?: LegacySessionVersion;
	readonly headerDigest?: string;
}

export interface LegacyMigrationError {
	readonly code:
		| "source_unreadable"
		| "corrupted_log"
		| "unsupported_version"
		| "version_fenced"
		| "source_changed"
		| "codec_projection_mismatch"
		| "target_not_new"
		| "target_identity_conflict"
		| "migration_manifest_conflict"
		| "migration_already_failed"
		| "event_append_failed"
		| "durable_flush_failed";
	readonly message: string;
	readonly line?: number;
	readonly byteOffset?: number;
	readonly observedVersion?: number;
	readonly cause?: SessionKernelError;
}

interface LegacyImportedMessageReceiptBase {
	readonly sourceIndex: number;
	readonly sourceEntryId: string;
	readonly sourceRecordDigest: string;
	readonly entryType: LedgerEntryType;
	readonly messageKind: "user" | "assistant" | "toolResult";
	readonly contentDigest: string;
	readonly recoveredFields: readonly string[];
	readonly lostFields: readonly string[];
}

export type LegacyImportedMessageReceipt = LegacyImportedMessageReceiptBase &
	(
		| { readonly disposition: "recovered"; readonly messageJson: string }
		| { readonly disposition: "omitted"; readonly messageJson?: never }
	);

export interface LegacyOmittedEntry {
	readonly sourceIndex: number;
	readonly sourceEntryId: string;
	readonly sourceRecordDigest: string;
	readonly entryType: LedgerEntryType;
	readonly contentDigest: string;
	readonly recoveredFields: readonly string[];
	readonly lostFields: readonly string[];
}

export interface LegacyRecoveredConfiguration {
	readonly value: Readonly<SessionRuntimeConfig>;
	readonly recoveredFields: readonly string[];
	readonly lostFields: readonly string[];
}

export interface LegacyMigrationSuccess {
	readonly status: "migrated";
	readonly mode: LegacyMigrationMode;
	readonly source: LegacySourceFingerprint;
	readonly targetSessionId: SessionId;
	readonly targetSchemaVersion: typeof RUNTIME_SCHEMA_VERSION;
	readonly importerVersion: string;
	readonly importSchema: typeof LEGACY_MIGRATION_SCHEMA;
	readonly head: EventCursor;
	readonly importedMessages: readonly AgentMessage[];
	readonly configuration: LegacyRecoveredConfiguration;
	readonly receipts: readonly LegacyImportedMessageReceipt[];
	readonly omittedEntries: readonly LegacyOmittedEntry[];
	readonly warnings: readonly string[];
}

export interface LegacyMigrationFailed {
	readonly status: "failed";
	readonly mode: LegacyMigrationMode;
	readonly source: LegacySourceFingerprint;
	readonly targetSessionId: SessionId;
	readonly head: EventCursor;
	readonly manifestDigest: string;
	readonly durableReceiptCount: number;
	readonly error: LegacyMigrationError;
}

export interface LegacyMigrationForensicRequired {
	readonly status: "forensic_required";
	readonly mode: LegacyMigrationMode;
	readonly report: LegacyForensicReport;
	readonly targetCreated: false;
}

export interface LegacyMigrationRejected {
	readonly status: "rejected";
	readonly mode: LegacyMigrationMode;
	readonly error: LegacyMigrationError;
	readonly targetCreated: false;
}

export interface LegacyMigrationPartial {
	readonly status: "partial";
	readonly mode: LegacyMigrationMode;
	readonly source: LegacySourceFingerprint;
	readonly targetSessionId: SessionId;
	readonly head: EventCursor;
	readonly durableReceiptCount: number;
	readonly error: LegacyMigrationError;
}

export type LegacyMigrationResult =
	| LegacyMigrationSuccess
	| LegacyMigrationFailed
	| LegacyMigrationForensicRequired
	| LegacyMigrationRejected
	| LegacyMigrationPartial;

export interface MigrateLegacySessionOptions {
	readonly sourcePath: string;
	readonly mode: LegacyMigrationMode;
	/** 必须是新建、空 EventWriter 的 sessionId。 */
	readonly targetSessionId: SessionId;
	readonly writer: EventWriter;
	readonly eventStore: RuntimeEventStore;
	readonly principalId: PrincipalId;
	readonly traceId: TraceId;
	readonly idempotencyKey: CommandId;
	readonly importerVersion?: string;
}

export interface FailLegacyMigrationOptions {
	readonly writer: EventWriter;
	readonly eventStore: RuntimeEventStore;
	readonly principalId: PrincipalId;
	readonly traceId: TraceId;
	readonly reasonCode: string;
	readonly reason: string;
}

export interface FailedLegacyMigrationReceipt {
	readonly targetSessionId: SessionId;
	readonly manifestDigest: string;
	readonly head: EventCursor;
	readonly importedRecordCount: number;
}

export type SessionVersionFenceResult =
	| {
			readonly status: "allowed";
			readonly operation: SessionVersionFenceOperation;
			readonly format: "legacy";
			readonly sourceVersion: LegacySessionVersion;
			readonly readOnly: true;
		}
	| {
			readonly status: "allowed";
			readonly operation: SessionVersionFenceOperation;
			readonly format: "v3";
			readonly schemaVersion: typeof RUNTIME_SCHEMA_VERSION;
			readonly readOnly: boolean;
		}
	| {
			readonly status: "blocked";
			readonly operation: SessionVersionFenceOperation;
			readonly format: "legacy" | "v3" | "unknown";
			readonly error: LegacyMigrationError;
			readonly sourceVersion?: LegacySessionVersion;
			readonly schemaVersion?: number;
		}
	| {
			readonly status: "forensic_required";
			readonly operation: SessionVersionFenceOperation;
			readonly report: LegacyForensicReport;
		};

interface RawJsonLine {
	readonly line: number;
	readonly byteOffset: number;
	readonly bytes: Uint8Array;
	readonly value: unknown;
}

interface ParsedJsonLines {
	readonly status: "parsed";
	readonly sourceDigest: string;
	readonly sourceSize: number;
	readonly lines: readonly RawJsonLine[];
	readonly tornTail?: LegacyForensicReport;
}

interface ParsedLegacySource {
	readonly status: "ready";
	readonly header: LedgerHeader;
	readonly entries: readonly LedgerEntry[];
	readonly entryRecordDigests: readonly string[];
	readonly fingerprint: LegacySourceFingerprint;
}

interface SourceRejected {
	readonly status: "rejected";
	readonly error: LegacyMigrationError;
}

interface SourceForensicRequired {
	readonly status: "forensic_required";
	readonly report: LegacyForensicReport;
}

interface SourceVersionFenced {
	readonly status: "version_fenced";
	readonly format: "v3" | "unknown";
	readonly schemaVersion?: number;
	readonly error: LegacyMigrationError;
}

type LegacySourceLoadResult =
	| ParsedLegacySource
	| SourceRejected
	| SourceForensicRequired
	| SourceVersionFenced;

interface PreparedLegacyImport {
	readonly messages: readonly AgentMessage[];
	readonly configuration: LegacyRecoveredConfiguration;
	readonly receipts: readonly LegacyImportedMessageReceipt[];
	readonly omittedEntries: readonly LegacyOmittedEntry[];
	readonly warnings: readonly string[];
}

interface PrepareImportSuccess {
	readonly ok: true;
	readonly value: PreparedLegacyImport;
}

interface PrepareImportFailure {
	readonly ok: false;
	readonly error: LegacyMigrationError;
}

type PrepareImportResult = PrepareImportSuccess | PrepareImportFailure;

const LEGACY_ENTRY_TYPES: ReadonlySet<string> = new Set([
	"session",
	"message",
	"tool_call",
	"tool_result",
	"turn",
	"agent_event",
	"custom",
]);

const LEGACY_READ_OPERATIONS: ReadonlySet<SessionVersionFenceOperation> = new Set([
	"inspect",
	"export",
	"migrate",
	"fork-to-v3",
]);

function sha256(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSafeTimestamp(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function nonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function parseLegacyVersion(value: unknown): LegacySessionVersion | undefined {
	return value === 1 || value === 2 ? value : undefined;
}

function corrupted(
	message: string,
	line?: number,
	byteOffset?: number,
): SourceRejected {
	return {
		status: "rejected",
		error: {
			code: "corrupted_log",
			message,
			...(line === undefined ? {} : { line }),
			...(byteOffset === undefined ? {} : { byteOffset }),
		},
	};
}

function decodeLine(bytes: Uint8Array): string | undefined {
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		return undefined;
	}
}

function completeLineCount(bytes: Uint8Array): number {
	let count = 0;
	for (const byte of bytes) if (byte === 0x0a) count += 1;
	return count;
}

function firstCompleteLine(bytes: Uint8Array): Uint8Array | undefined {
	const end = bytes.indexOf(0x0a);
	if (end < 0) return undefined;
	const raw = bytes.subarray(0, end);
	return raw.at(-1) === 0x0d ? raw.subarray(0, raw.byteLength - 1) : raw;
}

function partialHeaderMetadata(bytes: Uint8Array): {
	sourceVersion?: LegacySessionVersion;
	headerDigest?: string;
} {
	const headerBytes = firstCompleteLine(bytes);
	if (!headerBytes || headerBytes.byteLength === 0) return {};
	const text = decodeLine(headerBytes);
	if (text === undefined) return { headerDigest: sha256(headerBytes) };
	try {
		const value = JSON.parse(text) as unknown;
		if (!isRecord(value)) return { headerDigest: sha256(headerBytes) };
		const sourceVersion = parseLegacyVersion(value.version);
		return {
			...(sourceVersion === undefined ? {} : { sourceVersion }),
			headerDigest: sha256(headerBytes),
		};
	} catch {
		return { headerDigest: sha256(headerBytes) };
	}
}

function parseJsonLines(bytes: Uint8Array): ParsedJsonLines | SourceRejected {
	const sourceDigest = sha256(bytes);
	const sourceSize = bytes.byteLength;
	if (sourceSize === 0) return corrupted("session log is empty", 0, 0);

	const lines: RawJsonLine[] = [];
	let lineStart = 0;
	let lineNumber = 0;
	for (let offset = 0; offset < bytes.byteLength; offset += 1) {
		if (bytes[offset] !== 0x0a) continue;
		const framed = bytes.subarray(lineStart, offset);
		const lineBytes = framed.at(-1) === 0x0d ? framed.subarray(0, framed.byteLength - 1) : framed;
		if (lineBytes.byteLength === 0) return corrupted("session log contains an empty line", lineNumber, lineStart);
		if (lineBytes.includes(0x0d)) {
			return corrupted("session log contains invalid CR framing", lineNumber, lineStart + lineBytes.indexOf(0x0d));
		}
		const text = decodeLine(lineBytes);
		if (text === undefined) return corrupted("session log contains invalid UTF-8", lineNumber, lineStart);
		let value: unknown;
		try {
			value = JSON.parse(text) as unknown;
		} catch {
			return corrupted("session log contains malformed JSON", lineNumber, lineStart);
		}
		lines.push({ line: lineNumber, byteOffset: lineStart, bytes: lineBytes, value });
		lineStart = offset + 1;
		lineNumber += 1;
	}
	const tornTail = bytes.at(-1) === 0x0a
		? undefined
		: {
				issue: "torn_tail" as const,
				sourceDigest,
				sourceSize,
				byteOffset: bytes.lastIndexOf(0x0a) + 1,
				completeLineCount: completeLineCount(bytes),
				message: "session log does not end with LF; explicit forensic handling is required",
				...partialHeaderMetadata(bytes),
			};
	return { status: "parsed", sourceDigest, sourceSize, lines, ...(tornTail ? { tornTail } : {}) };
}

function validateLegacyHeader(line: RawJsonLine): LedgerHeader | SourceRejected | SourceVersionFenced {
	const value = line.value;
	if (!isRecord(value)) return corrupted("legacy header must be an object", line.line, line.byteOffset);
	if (value.type !== "ledger") {
		if (typeof value.schemaVersion === "number") {
			return {
				status: "version_fenced",
				format: value.schemaVersion === RUNTIME_SCHEMA_VERSION ? "v3" : "unknown",
				schemaVersion: value.schemaVersion,
				error: {
					code: "version_fenced",
					message: value.schemaVersion === RUNTIME_SCHEMA_VERSION
						? "source is already a Runtime v3 event log"
						: "source uses an unsupported runtime schema version",
					observedVersion: value.schemaVersion,
				},
			};
		}
		return corrupted("session header is neither a legacy ledger nor a Runtime v3 event", line.line, line.byteOffset);
	}
	const sourceVersion = parseLegacyVersion(value.version);
	if (sourceVersion === undefined) {
		return {
			status: "version_fenced",
			format: "unknown",
			error: {
				code: "unsupported_version",
				message: "legacy ledger version is not supported",
				...(typeof value.version === "number" ? { observedVersion: value.version } : {}),
			},
		};
	}
	if (
		!nonEmptyString(value.id) ||
		!isSafeTimestamp(value.createdAt) ||
		!nonEmptyString(value.sessionId) ||
		(value.metadata !== undefined && !isRecord(value.metadata))
	) {
		return corrupted("legacy ledger header has an invalid shape", line.line, line.byteOffset);
	}
	return value as unknown as LedgerHeader;
}

function validateLegacyEntries(
	lines: readonly RawJsonLine[],
	header: LedgerHeader,
): LedgerEntry[] | SourceRejected {
	const entries: LedgerEntry[] = [];
	const knownIds = new Set<string>([header.id]);
	for (const line of lines) {
		const value = line.value;
		if (
			!isRecord(value) ||
			!nonEmptyString(value.id) ||
			!nonEmptyString(value.sessionId) ||
			!nonEmptyString(value.parentId) ||
			!isSafeTimestamp(value.timestamp) ||
			!nonEmptyString(value.type) ||
			!LEGACY_ENTRY_TYPES.has(value.type) ||
			!isRecord(value.payload)
		) {
			return corrupted("legacy ledger entry has an invalid shape", line.line, line.byteOffset);
		}
		if (value.sessionId !== header.sessionId) {
			return corrupted("legacy ledger entry sessionId does not match its header", line.line, line.byteOffset);
		}
		if (knownIds.has(value.id)) {
			return corrupted("legacy ledger contains a duplicate entry id", line.line, line.byteOffset);
		}
		if (!knownIds.has(value.parentId)) {
			return corrupted("legacy ledger entry references an unknown parent", line.line, line.byteOffset);
		}
		knownIds.add(value.id);
		entries.push(value as unknown as LedgerEntry);
	}
	return entries;
}

async function loadLegacySource(sourcePath: string): Promise<LegacySourceLoadResult> {
	let bytes: Uint8Array;
	try {
		bytes = await readFile(sourcePath);
	} catch (error) {
		return {
			status: "rejected",
			error: {
				code: "source_unreadable",
				message: "legacy session source could not be read",
				cause: {
					code: "corrupted_log",
					message: "source read failed",
					retryable: false,
					details: { errorName: error instanceof Error ? error.name : "UnknownError" },
				},
			},
		};
	}
	const parsed = parseJsonLines(bytes);
	if (parsed.status === "rejected") return parsed;
	const headerLine = parsed.lines[0];
	if (!headerLine) {
		return parsed.tornTail ? { status: "forensic_required", report: parsed.tornTail } : corrupted("session log has no header", 0, 0);
	}
	const header = validateLegacyHeader(headerLine);
	if ("status" in header) return header;
	const entries = validateLegacyEntries(parsed.lines.slice(1), header);
	if (!Array.isArray(entries)) return entries;
	if (parsed.tornTail) return { status: "forensic_required", report: parsed.tornTail };
	return {
		status: "ready",
		header,
		entries,
		entryRecordDigests: parsed.lines.slice(1).map((line) => sha256(line.bytes)),
		fingerprint: {
			sourceVersion: header.version,
			sourceDigest: parsed.sourceDigest,
			sourceSize: parsed.sourceSize,
			headerDigest: sha256(headerLine.bytes),
			sourceSessionId: header.sessionId,
		},
	};
}

function messageKind(value: unknown): "user" | "assistant" | "toolResult" | undefined {
	if (!isRecord(value)) return undefined;
	return value.role === "user" || value.role === "assistant" || value.role === "toolResult"
		? value.role
		: undefined;
}

function collectRecoveredFields(
	value: unknown,
	path: string,
	out: Set<string>,
	depth: number,
): void {
	if (out.size >= 32) return;
	if (Array.isArray(value)) {
		if (value.length === 0) {
			out.add(path);
			return;
		}
		for (const item of value) collectRecoveredFields(item, `${path}[]`, out, depth + 1);
		return;
	}
	if (isRecord(value)) {
		const fields = Object.keys(value).sort();
		if (fields.length === 0 || depth >= 3 || path.endsWith(".arguments") || path.endsWith(".details")) {
			out.add(path);
			return;
		}
		for (const field of fields) {
			const next = path.length === 0 ? field : `${path}.${field}`;
			collectRecoveredFields(value[field], next, out, depth + 1);
		}
		return;
	}
	if (path.length > 0) out.add(path);
}

function recoveredV2Fields(message: AgentMessage): readonly string[] {
	const fields = new Set<string>(["schema"]);
	collectRecoveredFields(message, "", fields, 0);
	return [...fields].sort().slice(0, 32);
}

function recoveredV1Fields(message: AgentMessage): readonly string[] {
	const fields = ["role", "content[].text"];
	if (message.role === "assistant") {
		fields.push("stopReason");
		if (message.errorMessage !== undefined) fields.push("errorMessage");
	}
	return fields.sort();
}

function lostV1Fields(message: AgentMessage): readonly string[] {
	return message.role === "assistant"
		? ["content[].arguments", "content[].thinkingSignature", "schema"]
		: ["schema"];
}

function entryContentDigest(entry: LedgerEntry): string {
	return canonicalDigest({ type: entry.type, payload: entry.payload });
}

function auditReceipt(
	entry: LedgerEntry,
	sourceIndex: number,
	sourceRecordDigest: string,
): LegacyImportedMessageReceipt | undefined {
	if (entry.type === "tool_call") {
		return {
			sourceIndex,
			sourceEntryId: entry.id,
			sourceRecordDigest,
			entryType: entry.type,
			messageKind: "assistant",
			disposition: "omitted",
			contentDigest: entryContentDigest(entry),
			recoveredFields: [],
			lostFields: ["content[].toolCall"],
		};
	}
	if (entry.type === "tool_result") {
		return {
			sourceIndex,
			sourceEntryId: entry.id,
			sourceRecordDigest,
			entryType: entry.type,
			messageKind: "toolResult",
			disposition: "omitted",
			contentDigest: entryContentDigest(entry),
			recoveredFields: [],
			lostFields: ["content", "toolCallId", "toolName"],
		};
	}
	return undefined;
}

function configurationReport(
	version: LegacySessionVersion,
	config: SessionRuntimeConfig,
	entries: readonly LedgerEntry[],
): LegacyRecoveredConfiguration {
	const recognized = ["provider", "model", "thinkingLevel"].filter((field) => config[field as keyof SessionRuntimeConfig] !== undefined);
	const lost = new Set<string>();
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.payload.kind !== "runtime.config") continue;
		for (const field of Object.keys(entry.payload)) {
			if (field === "kind" || field === "provider" || field === "model" || field === "thinkingLevel") continue;
			lost.add(`runtimeConfig.${field}`);
		}
	}
	if (version === 1) {
		for (const field of recognized) lost.add(`runtimeConfig.${field}`);
		return { value: {}, recoveredFields: [], lostFields: [...lost].sort() };
	}
	return {
		value: { ...config },
		recoveredFields: recognized.map((field) => `runtimeConfig.${field}`).sort(),
		lostFields: [...lost].sort(),
	};
}

const LEGACY_THINKING_LEVELS: ReadonlySet<string> = new Set([
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
]);

function configurationEntryFields(
	version: LegacySessionVersion,
	entry: LedgerEntry,
): { readonly recoveredFields: readonly string[]; readonly lostFields: readonly string[] } {
	const recovered = new Set<string>();
	const lost = new Set<string>();
	for (const field of Object.keys(entry.payload).sort()) {
		if (field === "kind") continue;
		const value = entry.payload[field];
		const recognized =
			((field === "provider" || field === "model") && typeof value === "string") ||
			(field === "thinkingLevel" && typeof value === "string" && LEGACY_THINKING_LEVELS.has(value));
		const path = `runtimeConfig.${field}`;
		if (version === 2 && recognized) recovered.add(path);
		else lost.add(path);
	}
	return { recoveredFields: [...recovered], lostFields: [...lost] };
}

function sourceMessageCandidate(
	version: LegacySessionVersion,
	entry: LedgerEntry,
): { kind: "user" | "assistant" | "toolResult"; value: unknown } | undefined {
	if (entry.type !== "message") return undefined;
	if (version === 2) {
		if (entry.payload.schema !== "agent-message/v1") return undefined;
		const kind = messageKind(entry.payload.message);
		return kind ? { kind, value: entry.payload.message } : undefined;
	}
	const role = entry.payload.role;
	const content = entry.payload.content;
	if ((role === "user" || role === "assistant") && typeof content === "string") {
		return { kind: role, value: entry.payload };
	}
	return undefined;
}

async function prepareLegacyImport(sourcePath: string, source: ParsedLegacySource): Promise<PrepareImportResult> {
	let manager: SessionManager | undefined;
	try {
		manager = await SessionManager.open(sourcePath);
		if (manager.ledger().lastError !== undefined) {
			return {
				ok: false,
				error: { code: "codec_projection_mismatch", message: "production legacy reader reported an error" },
			};
		}
		const replay = await replaySession(manager.ledger());
		const readerEntries = await manager.ledger().entries();
		if (
			readerEntries.length !== source.entries.length ||
			canonicalDigest(readerEntries) !== canonicalDigest(source.entries)
		) {
			return {
				ok: false,
				error: { code: "codec_projection_mismatch", message: "production reader did not preserve the verified source entries" },
			};
		}

		const candidates = source.entries.flatMap((entry, sourceIndex) => {
			const candidate = sourceMessageCandidate(source.header.version, entry);
			return candidate ? [{ ...candidate, entry, sourceIndex }] : [];
		});
		const invalidMessage = source.entries.find(
			(entry) => entry.type === "message" && sourceMessageCandidate(source.header.version, entry) === undefined,
		);
		if (invalidMessage) {
			return {
				ok: false,
				error: { code: "codec_projection_mismatch", message: "legacy message is not recoverable by the production codec" },
			};
		}
		if (candidates.length !== replay.messages.length) {
			return {
				ok: false,
				error: { code: "codec_projection_mismatch", message: "production codec changed the legacy message count" },
			};
		}

		const receipts: LegacyImportedMessageReceipt[] = [];
		for (let index = 0; index < candidates.length; index += 1) {
			const candidate = candidates[index];
			const message = replay.messages[index];
			if (!candidate || !message || candidate.kind !== message.role) {
				return {
					ok: false,
					error: { code: "codec_projection_mismatch", message: "production codec changed a legacy message role" },
				};
			}
			if (source.header.version === 2 && canonicalDigest(candidate.value) !== canonicalDigest(message)) {
				return {
					ok: false,
					error: { code: "codec_projection_mismatch", message: "v2 canonical message was not recovered losslessly" },
				};
			}
			const messageJson = canonicalJson(message);
			const sourceRecordDigest = source.entryRecordDigests[candidate.sourceIndex];
			if (!sourceRecordDigest) {
				return {
					ok: false,
					error: { code: "codec_projection_mismatch", message: "verified source record digest is missing" },
				};
			}
			receipts.push({
				sourceIndex: candidate.sourceIndex,
				sourceEntryId: candidate.entry.id,
				sourceRecordDigest,
				entryType: candidate.entry.type,
				messageKind: candidate.kind,
				disposition: "recovered",
				contentDigest: canonicalDigest(messageJson),
				messageJson,
				recoveredFields: source.header.version === 2 ? recoveredV2Fields(message) : recoveredV1Fields(message),
				lostFields: source.header.version === 2 ? [] : lostV1Fields(message),
			});
		}

		const configuration = configurationReport(source.header.version, replay.config, source.entries);
		const omittedEntries: LegacyOmittedEntry[] = [];
		for (let sourceIndex = 0; sourceIndex < source.entries.length; sourceIndex += 1) {
			const entry = source.entries[sourceIndex];
			if (!entry || entry.type === "message") continue;
			const sourceRecordDigest = source.entryRecordDigests[sourceIndex];
			if (!sourceRecordDigest) {
				return {
					ok: false,
					error: { code: "codec_projection_mismatch", message: "verified source record digest is missing" },
				};
			}
			const audit = auditReceipt(entry, sourceIndex, sourceRecordDigest);
			if (audit) {
				receipts.push(audit);
				continue;
			}
			const configurationFields = entry.type === "custom" && entry.payload.kind === "runtime.config"
				? configurationEntryFields(source.header.version, entry)
				: undefined;
			omittedEntries.push({
				sourceIndex,
				sourceEntryId: entry.id,
				sourceRecordDigest,
				entryType: entry.type,
				contentDigest: entryContentDigest(entry),
				recoveredFields: configurationFields?.recoveredFields ?? [],
				lostFields: configurationFields?.lostFields ?? [`legacy.${entry.type}`],
			});
		}
		receipts.sort((left, right) => left.sourceIndex - right.sourceIndex);

		const after = await readFile(sourcePath);
		if (sha256(after) !== source.fingerprint.sourceDigest || after.byteLength !== source.fingerprint.sourceSize) {
			return {
				ok: false,
				error: { code: "source_changed", message: "legacy source changed while it was being inspected" },
			};
		}
		return {
			ok: true,
			value: {
				messages: replay.messages,
				configuration,
				receipts,
				omittedEntries,
				warnings: replay.warnings,
			},
		};
	} catch (error) {
		return {
			ok: false,
			error: {
				code: "codec_projection_mismatch",
				message: "production legacy reader could not replay the verified source",
				cause: {
					code: "corrupted_log",
					message: "legacy replay failed",
					retryable: false,
					details: { errorName: error instanceof Error ? error.name : "UnknownError" },
				},
			},
		};
	} finally {
		if (manager) await manager.closeAll().catch(() => undefined);
	}
}

function rejected(mode: LegacyMigrationMode, error: LegacyMigrationError): LegacyMigrationRejected {
	return { status: "rejected", mode, error, targetCreated: false };
}

interface BuiltLegacyMigrationManifest {
	readonly value: LegacyMigrationManifestBody;
	readonly digest: string;
}

function importRecordDescriptor(
	receipt: LegacyImportedMessageReceipt,
	sourceVersion: LegacySessionVersion,
): LegacyMigrationImportDescriptor {
	const common = {
		sourceVersion,
		sourceIndex: receipt.sourceIndex,
		sourceEntryId: receipt.sourceEntryId,
		sourceRecordDigest: receipt.sourceRecordDigest,
		messageKind: receipt.messageKind,
		contentDigest: receipt.contentDigest,
		recoveredFields: [...receipt.recoveredFields],
		lostFields: [...receipt.lostFields],
	};
	return receipt.disposition === "recovered"
		? { ...common, entryType: "message", disposition: "recovered", messageJson: receipt.messageJson }
		: { ...common, entryType: receipt.entryType, disposition: "omitted" };
}

function omittedEntryDescriptor(
	entry: LegacyOmittedEntry,
	sourceVersion: LegacySessionVersion,
): LegacyMigrationImportDescriptor {
	return {
		sourceVersion,
		sourceIndex: entry.sourceIndex,
		sourceEntryId: entry.sourceEntryId,
		sourceRecordDigest: entry.sourceRecordDigest,
		entryType: entry.entryType,
		messageKind: "non_message",
		disposition: "omitted",
		contentDigest: entry.contentDigest,
		recoveredFields: [...entry.recoveredFields],
		lostFields: [...entry.lostFields],
	};
}

function migrationRecordDescriptors(
	prepared: PreparedLegacyImport,
	sourceVersion: LegacySessionVersion,
): readonly LegacyMigrationImportDescriptor[] {
	return [
		...prepared.receipts.map((receipt) => importRecordDescriptor(receipt, sourceVersion)),
		...prepared.omittedEntries.map((entry) => omittedEntryDescriptor(entry, sourceVersion)),
	].sort((left, right) => left.sourceIndex - right.sourceIndex);
}

function buildMigrationManifest(
	mode: LegacyMigrationMode,
	source: LegacySourceFingerprint,
	importerVersion: string,
	prepared: PreparedLegacyImport,
): BuiltLegacyMigrationManifest {
	const descriptors = migrationRecordDescriptors(prepared, source.sourceVersion);
	const configurationJson = canonicalJson(prepared.configuration.value);
	const recoveredFields = [...new Set([
		...prepared.configuration.recoveredFields,
		...descriptors.flatMap((descriptor) => descriptor.recoveredFields),
	])].sort();
	const lostFields = [...new Set([
		...prepared.configuration.lostFields,
		...descriptors.flatMap((descriptor) => descriptor.lostFields),
	])].sort();
	const value: LegacyMigrationManifestBody = {
		mode,
		sourceVersion: source.sourceVersion,
		sourceDigest: source.sourceDigest,
		sourceSize: source.sourceSize,
		headerDigest: source.headerDigest,
		sourceSessionId: source.sourceSessionId,
		importerVersion,
		importSchema: LEGACY_MIGRATION_SCHEMA,
		configurationJson,
		configurationDigest: canonicalDigest(configurationJson),
		recoveredFields,
		lostFields,
		expectedRecordCount: descriptors.length,
		expectedRecordSetDigest: legacyMigrationRecordSetDigest(descriptors),
	};
	return { value, digest: legacyMigrationManifestDigest(value) };
}

function importPayload(
	descriptor: LegacyMigrationImportDescriptor,
	manifestDigest: string,
): RuntimeEventPayloadMap["session.legacy_message_imported"] {
	if (descriptor.disposition === "recovered") {
		return { manifestDigest, ...descriptor, recoveredFields: [...descriptor.recoveredFields], lostFields: [...descriptor.lostFields] };
	}
	return { manifestDigest, ...descriptor, recoveredFields: [...descriptor.recoveredFields], lostFields: [...descriptor.lostFields] };
}

function cursorFor(event: RuntimeEventV3): EventCursor {
	return {
		stream: event.stream,
		sequence: event.sequence,
		eventId: event.eventId,
		eventHash: event.currentEventHash,
	};
}

function migrationSuccess(
	options: MigrateLegacySessionOptions,
	source: ParsedLegacySource,
	prepared: PreparedLegacyImport,
	importerVersion: string,
	head: EventCursor,
): LegacyMigrationSuccess {
	return {
		status: "migrated",
		mode: options.mode,
		source: source.fingerprint,
		targetSessionId: options.targetSessionId,
		targetSchemaVersion: RUNTIME_SCHEMA_VERSION,
		importerVersion,
		importSchema: LEGACY_MIGRATION_SCHEMA,
		head,
		importedMessages: prepared.messages,
		configuration: prepared.configuration,
		receipts: prepared.receipts,
		omittedEntries: prepared.omittedEntries,
		warnings: prepared.warnings,
	};
}

function appendFailure(
	mode: LegacyMigrationMode,
	source: LegacySourceFingerprint,
	targetSessionId: SessionId,
	writer: EventWriter,
	durableReceiptCount: number,
	code: "event_append_failed" | "durable_flush_failed",
	cause: SessionKernelError,
): LegacyMigrationRejected | LegacyMigrationPartial {
	const head = writer.currentHead();
	const error: LegacyMigrationError = {
		code,
		message: code === "event_append_failed" ? "v3 migration event append failed" : "v3 migration flush failed",
		cause,
	};
	return head
		? { status: "partial", mode, source, targetSessionId, head, durableReceiptCount, error }
		: rejected(mode, error);
}

/**
 * 迁移源始终只读；writer 必须绑定到一个独立且为空的 v3 session。
 * 函数不关闭 writer，target 生命周期归 composition root 所有。
 */
export async function migrateLegacySessionToV3(
	options: MigrateLegacySessionOptions,
): Promise<LegacyMigrationResult> {
	const source = await loadLegacySource(options.sourcePath);
	if (source.status === "forensic_required") {
		return { status: "forensic_required", mode: options.mode, report: source.report, targetCreated: false };
	}
	if (source.status === "rejected" || source.status === "version_fenced") {
		return rejected(options.mode, source.error);
	}
	if (source.header.sessionId === options.targetSessionId) {
		return rejected(options.mode, {
			code: "target_identity_conflict",
			message: "v3 target sessionId must differ from the legacy source sessionId",
		});
	}
	const prepared = await prepareLegacyImport(options.sourcePath, source);
	if (!prepared.ok) return rejected(options.mode, prepared.error);

	const importerVersion = options.importerVersion ?? LEGACY_IMPORTER_VERSION;
	const descriptors = migrationRecordDescriptors(prepared.value, source.fingerprint.sourceVersion);
	const manifest = buildMigrationManifest(options.mode, source.fingerprint, importerVersion, prepared.value);
	const targetEvents = await readAllRuntimeEvents(options.eventStore);
	if (!targetEvents.ok) {
		return appendFailure(
			options.mode,
			source.fingerprint,
			options.targetSessionId,
			options.writer,
			0,
			"event_append_failed",
			targetEvents.error,
		);
	}

	let importedEvents: readonly Extract<RuntimeEventV3, { type: "session.legacy_message_imported" }>[] = [];
	if (targetEvents.value.length === 0) {
		if (options.writer.currentHead() !== undefined) {
			return rejected(options.mode, {
				code: "target_not_new",
				message: "migration target writer head does not match its empty event store",
			});
		}
		const genesis = await options.writer.append({
			type: "session.migration_started",
			principalId: options.principalId,
			traceId: options.traceId,
			payload: {
				...manifest.value,
				recoveredFields: [...manifest.value.recoveredFields],
				lostFields: [...manifest.value.lostFields],
				manifestDigest: manifest.digest,
				idempotencyKey: options.idempotencyKey,
			},
		});
		if (!genesis.ok) {
			return appendFailure(options.mode, source.fingerprint, options.targetSessionId, options.writer, 0, "event_append_failed", genesis.error);
		}
		if (
			genesis.value.event.stream.scope !== "session" ||
			genesis.value.event.stream.sessionId !== options.targetSessionId
		) {
			return {
				status: "partial",
				mode: options.mode,
				source: source.fingerprint,
				targetSessionId: options.targetSessionId,
				head: genesis.value.cursor,
				durableReceiptCount: 0,
				error: {
					code: "target_identity_conflict",
					message: "EventWriter target does not match the declared target sessionId",
				},
			};
		}
	} else {
		const first = targetEvents.value[0];
		const targetHeadEvent = targetEvents.value.at(-1);
		const writerHead = options.writer.currentHead();
		if (
			!targetHeadEvent ||
			!writerHead ||
				!sameRuntimeEventStream(writerHead.stream, targetHeadEvent.stream) ||
			writerHead.sequence !== targetHeadEvent.sequence ||
			writerHead.eventId !== targetHeadEvent.eventId ||
			writerHead.eventHash !== targetHeadEvent.currentEventHash
		) {
			return {
				status: "partial",
				mode: options.mode,
				source: source.fingerprint,
				targetSessionId: options.targetSessionId,
				head: cursorFor(targetHeadEvent ?? first!),
				durableReceiptCount: targetEvents.value.filter((event) => event.type === "session.legacy_message_imported").length,
				error: {
					code: "target_identity_conflict",
					message: "migration writer head does not match the durable target head",
				},
			};
		}
		if (
			!first ||
			first.stream.scope !== "session" ||
			first.stream.sessionId !== options.targetSessionId ||
			first.type !== "session.migration_started"
		) {
			const head = options.writer.currentHead();
			return head
				? {
						status: "partial",
						mode: options.mode,
						source: source.fingerprint,
						targetSessionId: options.targetSessionId,
						head,
						durableReceiptCount: 0,
						error: { code: "target_not_new", message: "target is not a legacy migration session" },
					}
				: rejected(options.mode, { code: "target_not_new", message: "target is not a legacy migration session" });
		}
		const recordedManifest = legacyMigrationManifestFromStarted(first.payload);
		if (
			legacyMigrationManifestDigest(recordedManifest) !== first.payload.manifestDigest ||
			first.payload.manifestDigest !== manifest.digest
		) {
			return {
				status: "partial",
				mode: options.mode,
				source: source.fingerprint,
				targetSessionId: options.targetSessionId,
				head: cursorFor(targetEvents.value.at(-1) ?? first),
				durableReceiptCount: targetEvents.value.filter((event) => event.type === "session.legacy_message_imported").length,
				error: {
					code: "migration_manifest_conflict",
					message: "partial migration target is bound to a different source or importer manifest",
				},
			};
		}
		const projection = reduceSessionEvents(targetEvents.value);
		if (!projection.ok || !projection.value.migration) {
			return appendFailure(
				options.mode,
				source.fingerprint,
				options.targetSessionId,
				options.writer,
				0,
				"event_append_failed",
				projection.ok
					? { code: "invalid_event", message: "migration projection is missing", retryable: false }
					: projection.error,
			);
		}
		const terminal = targetEvents.value.at(-1);
		if (projection.value.migration.status === "committed") {
			const committedEvent = targetEvents.value[projection.value.migration.terminalSequence ?? -1];
			if (!committedEvent || committedEvent.type !== "session.migration_committed") {
				return appendFailure(
					options.mode,
					source.fingerprint,
					options.targetSessionId,
					options.writer,
					projection.value.migration.records.length,
					"event_append_failed",
					{ code: "invalid_event", message: "migration commit event is missing", retryable: false },
				);
			}
			return migrationSuccess(options, source, prepared.value, importerVersion, cursorFor(committedEvent));
		}
		if (projection.value.migration.status === "failed") {
			if (!terminal || terminal.type !== "session.migration_failed") {
				return appendFailure(
					options.mode,
					source.fingerprint,
					options.targetSessionId,
					options.writer,
					projection.value.migration.records.length,
					"event_append_failed",
					{ code: "invalid_event", message: "migration failure is not the target head", retryable: false },
				);
			}
			return {
				status: "failed",
				mode: options.mode,
				source: source.fingerprint,
				targetSessionId: options.targetSessionId,
				head: cursorFor(terminal),
				manifestDigest: manifest.digest,
				durableReceiptCount: projection.value.migration.records.length,
				error: {
					code: "migration_already_failed",
					message: `migration target is terminally failed (${terminal.payload.reasonCode})`,
				},
			};
		}
		importedEvents = targetEvents.value.filter(
			(event): event is Extract<RuntimeEventV3, { type: "session.legacy_message_imported" }> =>
				event.type === "session.legacy_message_imported",
		);
		for (let index = 0; index < importedEvents.length; index += 1) {
			const event = importedEvents[index];
			const descriptor = descriptors[index];
			if (!event || !descriptor || canonicalDigest(event.payload) !== canonicalDigest(importPayload(
				descriptor,
				manifest.digest,
			))) {
				return {
					status: "partial",
					mode: options.mode,
					source: source.fingerprint,
					targetSessionId: options.targetSessionId,
					head: cursorFor(targetEvents.value.at(-1) ?? first),
					durableReceiptCount: importedEvents.length,
					error: {
						code: "migration_manifest_conflict",
						message: "durable imported record does not match its source index and digest",
					},
				};
			}
		}
	}

	let durableReceiptCount = importedEvents.length;
	for (let index = importedEvents.length; index < descriptors.length; index += 1) {
		const descriptor = descriptors[index];
		if (!descriptor) continue;
		const appended = await options.writer.append({
			type: "session.legacy_message_imported",
			principalId: options.principalId,
			traceId: options.traceId,
			payload: importPayload(descriptor, manifest.digest),
		});
		if (!appended.ok) {
			return appendFailure(
				options.mode,
				source.fingerprint,
				options.targetSessionId,
				options.writer,
				durableReceiptCount,
				"event_append_failed",
				appended.error,
			);
		}
		durableReceiptCount += 1;
	}
	const committed = await options.writer.append({
		type: "session.migration_committed",
		principalId: options.principalId,
		traceId: options.traceId,
		payload: {
			manifestDigest: manifest.digest,
			expectedRecordCount: manifest.value.expectedRecordCount,
			importedRecordCount: durableReceiptCount,
			recordSetDigest: manifest.value.expectedRecordSetDigest,
		},
	});
	if (!committed.ok) {
		return appendFailure(
			options.mode,
			source.fingerprint,
			options.targetSessionId,
			options.writer,
			durableReceiptCount,
			"event_append_failed",
			committed.error,
		);
	}
	return migrationSuccess(options, source, prepared.value, importerVersion, cursorFor(committed.value.event));
}

/**
 * 操作者显式放弃 partial target 时写唯一 durable failure terminal。
 * source mismatch 本身不会自动调用此函数，以免阻断仍可用原 manifest 续跑的目标。
 */
export async function failLegacyMigrationTarget(
	options: FailLegacyMigrationOptions,
): Promise<SessionResult<FailedLegacyMigrationReceipt>> {
	const events = await readAllRuntimeEvents(options.eventStore);
	if (!events.ok) return events;
	const projection = reduceSessionEvents(events.value);
	if (!projection.ok) return projection;
	const migration = projection.value.migration;
	const reasonCode = options.reasonCode.slice(0, 128) || "operator_failed";
	const reasonDigest = canonicalDigest(options.reason);
	if (migration?.status === "failed") {
		const terminal = events.value[migration.terminalSequence ?? -1];
		if (
			terminal?.type === "session.migration_failed" &&
			terminal.payload.manifestDigest === migration.manifestDigest &&
			terminal.payload.importedRecordCount === migration.records.length &&
			terminal.payload.reasonCode === reasonCode &&
			terminal.payload.reasonDigest === reasonDigest
		) {
			return {
				ok: true,
				value: {
					targetSessionId: projection.value.sessionId,
					manifestDigest: migration.manifestDigest,
					head: cursorFor(terminal),
					importedRecordCount: migration.records.length,
				},
			};
		}
		return {
			ok: false,
			error: {
				code: "stopped",
				message: "legacy migration already has a different durable failure terminal",
				retryable: false,
			},
		};
	}
	if (!migration || migration.status !== "in_progress") {
		return {
			ok: false,
			error: {
				code: "stopped",
				message: "only an in-progress legacy migration can be marked failed",
				retryable: false,
			},
		};
	}
	const failed = await options.writer.append({
		type: "session.migration_failed",
		principalId: options.principalId,
		traceId: options.traceId,
		payload: {
			manifestDigest: migration.manifestDigest,
			expectedRecordCount: migration.expectedRecordCount,
			importedRecordCount: migration.records.length,
			reasonCode,
			reasonDigest,
		},
	});
	if (!failed.ok) return failed;
	return {
		ok: true,
		value: {
			targetSessionId: projection.value.sessionId,
			manifestDigest: migration.manifestDigest,
			head: cursorFor(failed.value.event),
			importedRecordCount: migration.records.length,
		},
	};
}

function allowedLegacyOperation(operation: SessionVersionFenceOperation): boolean {
	return LEGACY_READ_OPERATIONS.has(operation);
}

/** CLI/TUI 共用的版本栅栏纯结果；本模块不执行路由或展示。 */
export async function inspectSessionVersionFence(
	sourcePath: string,
	operation: SessionVersionFenceOperation,
): Promise<SessionVersionFenceResult> {
	const source = await loadLegacySource(sourcePath);
	if (source.status === "forensic_required") {
		return { status: "forensic_required", operation, report: source.report };
	}
	if (source.status === "rejected") {
		return { status: "blocked", operation, format: "unknown", error: source.error };
	}
	if (source.status === "ready") {
		if (allowedLegacyOperation(operation)) {
			return {
				status: "allowed",
				operation,
				format: "legacy",
				sourceVersion: source.fingerprint.sourceVersion,
				readOnly: true,
			};
		}
		return {
			status: "blocked",
			operation,
			format: "legacy",
			sourceVersion: source.fingerprint.sourceVersion,
			error: {
				code: "version_fenced",
				message: "legacy v1/v2 sessions are read-only; migrate or fork-to-v3 before continuing",
			},
		};
	}
	if (source.format === "unknown") {
		return {
			status: "blocked",
			operation,
			format: "unknown",
			...(source.schemaVersion === undefined ? {} : { schemaVersion: source.schemaVersion }),
			error: source.error,
		};
	}

	let bytes: Uint8Array;
	try {
		bytes = await readFile(sourcePath);
	} catch {
		return { status: "blocked", operation, format: "v3", error: source.error };
	}
	const parsed = parseJsonLines(bytes);
	if (parsed.status === "rejected") {
		return { status: "blocked", operation, format: "v3", error: parsed.error };
	}
	const first = parsed.lines[0]?.value;
	const validated = validateRuntimeEvent(first);
	if (!validated.ok) {
		return {
			status: "blocked",
			operation,
			format: "v3",
			schemaVersion: RUNTIME_SCHEMA_VERSION,
			error: { code: "corrupted_log", message: validated.message },
		};
	}
	const scanned = scanJsonlV3EventLog(bytes, {
		authorityId: validated.value.authorityId,
		tenantId: validated.value.tenantId,
		stream: validated.value.stream,
	});
	if (scanned.firstError?.code === "torn_tail" && parsed.tornTail) {
		return { status: "forensic_required", operation, report: parsed.tornTail };
	}
	if (scanned.firstError) {
		return {
			status: "blocked",
			operation,
			format: "v3",
			schemaVersion: RUNTIME_SCHEMA_VERSION,
			error: {
				code: "corrupted_log",
				message: scanned.firstError.message,
				line: scanned.firstError.line,
				byteOffset: scanned.firstError.byteOffset,
			},
		};
	}
	const projection = reduceSessionEvents(scanned.events);
	if (!projection.ok) {
		return {
			status: "blocked",
			operation,
			format: "v3",
			schemaVersion: RUNTIME_SCHEMA_VERSION,
			error: { code: "corrupted_log", message: projection.error.message },
		};
	}
	if (operation === "migrate" || operation === "fork-to-v3") {
		return {
			status: "blocked",
			operation,
			format: "v3",
			schemaVersion: RUNTIME_SCHEMA_VERSION,
			error: {
				code: "version_fenced",
				message: "source is already v3; use the v3 stable-fork path instead of legacy migration",
			},
		};
	}
	if (projection.value.migration && projection.value.migration.status !== "committed") {
		if (operation === "inspect" || operation === "export") {
			return {
				status: "allowed",
				operation,
				format: "v3",
				schemaVersion: RUNTIME_SCHEMA_VERSION,
				readOnly: true,
			};
		}
		return {
			status: "blocked",
			operation,
			format: "v3",
			schemaVersion: RUNTIME_SCHEMA_VERSION,
			error: {
				code: "version_fenced",
				message: projection.value.migration.status === "failed"
					? "legacy migration target is terminally failed and remains inspect-only"
					: "legacy migration target is incomplete and remains inspect-only until committed",
			},
		};
	}
	return {
		status: "allowed",
		operation,
		format: "v3",
		schemaVersion: RUNTIME_SCHEMA_VERSION,
		readOnly: operation === "inspect" || operation === "export",
	};
}
