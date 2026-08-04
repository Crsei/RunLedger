/** Private durable process output store。
 *
 * 记录文件只由 Host/storage 层访问；路径、PID 与 backend handle 不会进入
 * public page。每条记录保存 UTF-8 完整 code point，cursor 以 record sequence
 * 和 byte offset 共同定义，便于 retention 后返回 typed resync。
 */

import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { canonicalJson } from "../../runtime/protocol/canonical-json.ts";
import { runtimeDigest, type RuntimeDigest } from "../../runtime/protocol/foundation.ts";
import type { AttemptId, ExecutionId } from "../../runtime/protocol/ids.ts";
import type { ProcessOutputMaterializationRecord } from "../../runtime/process/output-artifact.ts";
import {
	clipUtf8Output,
	PROCESS_OUTPUT_BOUNDS,
	type OutputCursor,
} from "../../runtime/process/output.ts";
import type { RunledgerLayout } from "../../runtime/contracts/storage-layout.ts";

export interface ProcessOutputStoreOptions {
	readonly layout: RunledgerLayout;
	readonly workspaceStorageKey: string;
	readonly executionId: ExecutionId;
	readonly attemptId: AttemptId;
	readonly maxBytes?: number;
}

export interface OutputRecoveryMarker {
	readonly kind: "checkpoint" | "seal" | "materialization";
	readonly digest: string;
	readonly cursor: OutputCursor;
}

export interface OutputRetentionPlan {
	readonly before: OutputCursor;
	readonly sourceEarliest: OutputCursor;
	readonly sourceHead: OutputCursor;
	readonly blockedBy: readonly string[];
	readonly planDigest: RuntimeDigest;
}

export interface PrivateProcessOutputPage {
	readonly startCursor: OutputCursor;
	readonly endCursor: OutputCursor;
	readonly nextCursor: OutputCursor;
	readonly text: string;
	readonly truncated: boolean;
}

export interface ProcessOutputSeal {
	readonly digest: RuntimeDigest;
	readonly size: number;
}

export type ProcessOutputStoreErrorCode =
	| "output_cursor_invalid"
	| "output_cursor_resync_required"
	| "output_capacity_exceeded"
	| "output_retention_blocked"
	| "output_retention_conflict"
	| "output_materialization_conflict"
	| "output_sealed"
	| "output_unavailable";

export type ProcessOutputAppendResult =
	| { readonly ok: true; readonly cursor: OutputCursor }
	| { readonly ok: false; readonly code: ProcessOutputStoreErrorCode };

export type ProcessOutputReadResult =
	| { readonly ok: true; readonly page: PrivateProcessOutputPage; readonly head: OutputCursor }
	| { readonly ok: false; readonly code: ProcessOutputStoreErrorCode; readonly earliestCursor?: OutputCursor };

export type ProcessOutputSealResult =
	| { readonly ok: true; readonly seal: ProcessOutputSeal }
	| { readonly ok: false; readonly code: Extract<ProcessOutputStoreErrorCode, "output_unavailable" | "output_sealed"> };

export type ProcessOutputMutationResult =
	| { readonly ok: true }
	| { readonly ok: false; readonly code: ProcessOutputStoreErrorCode };

export type ProcessOutputReadAllResult =
	| { readonly ok: true; readonly text: string; readonly head: OutputCursor; readonly seal?: ProcessOutputSeal }
	| { readonly ok: false; readonly code: ProcessOutputStoreErrorCode };

interface OutputRecord {
	readonly sequence: number;
	readonly startByte: number;
	readonly endByte: number;
	readonly text: string;
}

interface OutputMetadata {
	readonly earliestCursor: OutputCursor;
	readonly head: OutputCursor;
	readonly pins?: Readonly<Record<string, OutputCursor>>;
	readonly recoveryMarker?: OutputRecoveryMarker;
	readonly sealed?: ProcessOutputSeal;
	readonly materialization?: ProcessOutputMaterializationRecord;
}

interface LoadedOutput {
	readonly records: readonly OutputRecord[];
	readonly metadata: OutputMetadata;
}

export class FileProcessOutputStore {
	private readonly filePathValue: string;
	private readonly metadataPath: string;
	private readonly maxBytes: number;
	private tail: Promise<void> = Promise.resolve();

	public constructor(options: ProcessOutputStoreOptions) {
		if (!Number.isSafeInteger(options.maxBytes ?? PROCESS_OUTPUT_BOUNDS.maxDurableOutputBytes) || (options.maxBytes ?? PROCESS_OUTPUT_BOUNDS.maxDurableOutputBytes) < 1) {
			throw new Error("maxBytes must be a positive safe integer");
		}
		this.maxBytes = options.maxBytes ?? PROCESS_OUTPUT_BOUNDS.maxDurableOutputBytes;
		const directory = join(options.layout.state, "processes", options.workspaceStorageKey, "output", options.executionId);
		this.filePathValue = join(directory, `${options.attemptId}.jsonl`);
		this.metadataPath = join(directory, `${options.attemptId}.meta.json`);
	}

	public async readMaterialization(): Promise<ProcessOutputMaterializationRecord | undefined> {
		return this.serial(async () => {
			try {
				const value = (await this.load()).metadata.materialization;
				return isMaterializationRecord(value) ? value : undefined;
			} catch {
				return undefined;
			}
		});
	}

	public async recordMaterialization(record: ProcessOutputMaterializationRecord): Promise<ProcessOutputMutationResult> {
		return this.serial(async () => {
			try {
				if (!isMaterializationRecord(record)) return { ok: false, code: "output_materialization_conflict" };
				const loaded = await this.load();
				const prior = loaded.metadata.materialization;
				if (isMaterializationRecord(prior)) {
					if (prior.recordDigest.digest === record.recordDigest.digest) return { ok: true };
					if (prior.sourceDigest.digest !== record.sourceDigest.digest) {
						return { ok: false, code: "output_materialization_conflict" };
					}
				}
				await this.writeMetadata({ ...loaded.metadata, materialization: record });
				return { ok: true };
			} catch {
				return { ok: false, code: "output_unavailable" };
			}
		});
	}

	public async append(text: string): Promise<ProcessOutputAppendResult> {
		if (text.length === 0) return this.headResult();
		return this.serial(async () => {
			try {
				const loaded = await this.load();
				if (loaded.metadata.sealed) return { ok: false, code: "output_sealed" };
				const size = Buffer.byteLength(text, "utf8");
				const nextSize = loaded.metadata.head.byteOffset + size - loaded.metadata.earliestCursor.byteOffset;
				if (nextSize > this.maxBytes) return { ok: false, code: "output_capacity_exceeded" };
				const sequence = loaded.metadata.head.sequence + 1;
				const record: OutputRecord = {
					sequence,
					startByte: loaded.metadata.head.byteOffset,
					endByte: loaded.metadata.head.byteOffset + size,
					text,
				};
				await this.ensureDirectory();
				await appendFile(this.filePathValue, `${canonicalJson(record)}\n`, { encoding: "utf8", mode: 0o600 });
				const metadata: OutputMetadata = {
					earliestCursor: loaded.metadata.earliestCursor,
					head: { sequence, byteOffset: record.endByte },
				};
				await this.writeMetadata(metadata);
				return { ok: true, cursor: metadata.head };
			} catch {
				return { ok: false, code: "output_unavailable" };
			}
		});
	}

	public async head(): Promise<OutputCursor> {
		return this.serial(async () => {
			try {
				return (await this.load()).metadata.head;
			} catch {
				return { sequence: 0, byteOffset: 0 };
			}
		});
	}

	public async read(cursor: OutputCursor, maxBytes: number = PROCESS_OUTPUT_BOUNDS.maxPageBytes): Promise<ProcessOutputReadResult> {
		if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error("maxBytes must be a non-negative safe integer");
		return this.serial(async () => {
			try {
				const loaded = await this.load();
				const { earliestCursor, head } = loaded.metadata;
				if (compareCursor(cursor, earliestCursor) < 0) {
					return { ok: false, code: "output_cursor_resync_required", earliestCursor };
				}
				if (compareCursor(cursor, head) > 0) return { ok: false, code: "output_cursor_invalid" };

				let nextCursor = cursor;
				let text = "";
				let remaining = maxBytes;
				let truncated = false;
				for (const record of loaded.records) {
					if (record.endByte <= cursor.byteOffset) continue;
					const offset = Math.max(cursor.byteOffset, record.startByte) - record.startByte;
					const suffix = suffixAtByteOffset(record.text, offset);
					if (suffix === undefined) return { ok: false, code: "output_cursor_invalid" };
					const clipped = clipUtf8Output(suffix, remaining);
					text += clipped.text;
					nextCursor = {
						sequence: record.sequence,
						byteOffset: record.startByte + offset + clipped.byteLength,
					};
					remaining -= clipped.byteLength;
					if (clipped.truncated || nextCursor.byteOffset < record.endByte) {
						truncated = true;
						break;
					}
					if (remaining === 0 && nextCursor.byteOffset < head.byteOffset) {
						truncated = true;
						break;
					}
				}
				if (!truncated && compareCursor(nextCursor, head) < 0 && maxBytes === 0) truncated = true;
				return {
					ok: true,
					page: { startCursor: cursor, endCursor: nextCursor, nextCursor, text, truncated },
					head,
				};
			} catch {
				return { ok: false, code: "output_unavailable" };
			}
		});
	}

	public async compactBefore(cursor: OutputCursor): Promise<ProcessOutputAppendResult> {
		return this.serial(async () => {
			try {
				const loaded = await this.load();
				if (loaded.metadata.sealed) return { ok: false, code: "output_retention_blocked" };
				if (compareCursor(cursor, loaded.metadata.earliestCursor) < 0 || compareCursor(cursor, loaded.metadata.head) > 0) {
					return { ok: false, code: "output_cursor_invalid" };
				}
				if (pinnedBefore(loaded.metadata.pins, cursor).length > 0) return { ok: false, code: "output_retention_blocked" };
				await this.compactLoaded(loaded, cursor);
				return { ok: true, cursor: loaded.metadata.head };
			} catch {
				return { ok: false, code: "output_unavailable" };
			}
		});
	}

	public async pin(pinId: string, cursor: OutputCursor): Promise<ProcessOutputMutationResult> {
		return this.serial(async () => {
			try {
				if (!/^[A-Za-z0-9._~-]{1,128}$/u.test(pinId)) return { ok: false, code: "output_cursor_invalid" };
				const loaded = await this.load();
				if (compareCursor(cursor, loaded.metadata.earliestCursor) < 0 || compareCursor(cursor, loaded.metadata.head) > 0) return { ok: false, code: "output_cursor_invalid" };
				await this.writeMetadata({ ...loaded.metadata, pins: { ...(loaded.metadata.pins ?? {}), [pinId]: cursor } });
				return { ok: true };
			} catch {
				return { ok: false, code: "output_unavailable" };
			}
		});
	}

	public async unpin(pinId: string): Promise<ProcessOutputMutationResult> {
		return this.serial(async () => {
			try {
				const loaded = await this.load();
				const pins = { ...(loaded.metadata.pins ?? {}) };
				delete pins[pinId];
				await this.writeMetadata({ ...loaded.metadata, pins });
				return { ok: true };
			} catch {
				return { ok: false, code: "output_unavailable" };
			}
		});
	}

	public async planRetention(cursor: OutputCursor): Promise<
		| { readonly ok: true; readonly plan: OutputRetentionPlan }
		| { readonly ok: false; readonly code: Extract<ProcessOutputStoreErrorCode, "output_cursor_invalid" | "output_unavailable"> }
	> {
		return this.serial(async () => {
			try {
				const loaded = await this.load();
				if (compareCursor(cursor, loaded.metadata.earliestCursor) < 0 || compareCursor(cursor, loaded.metadata.head) > 0) return { ok: false, code: "output_cursor_invalid" };
				const blockedBy = [
					...(loaded.metadata.sealed ? ["sealed"] : []),
					...pinnedBefore(loaded.metadata.pins, cursor),
				];
				const planBody = {
					before: cursor,
					sourceEarliest: loaded.metadata.earliestCursor,
					sourceHead: loaded.metadata.head,
					blockedBy,
				};
				return { ok: true, plan: { ...planBody, planDigest: runtimeDigest(planBody) } };
			} catch {
				return { ok: false, code: "output_unavailable" };
			}
		});
	}

	public async commitRetention(plan: OutputRetentionPlan): Promise<ProcessOutputMutationResult> {
		return this.serial(async () => {
			try {
				const loaded = await this.load();
				if (loaded.metadata.sealed) return { ok: false, code: "output_retention_blocked" };
				const blockedBy = pinnedBefore(loaded.metadata.pins, plan.before);
				if (blockedBy.length > 0) return { ok: false, code: "output_retention_blocked" };
				if (compareCursor(plan.sourceEarliest, loaded.metadata.earliestCursor) !== 0 || compareCursor(plan.sourceHead, loaded.metadata.head) !== 0) return { ok: false, code: "output_retention_conflict" };
				const body = { before: plan.before, sourceEarliest: plan.sourceEarliest, sourceHead: plan.sourceHead, blockedBy: plan.blockedBy };
				if (runtimeDigest(body).digest !== plan.planDigest.digest || plan.blockedBy.length > 0) return { ok: false, code: "output_retention_conflict" };
				await this.compactLoaded(loaded, plan.before);
				return { ok: true };
			} catch {
				return { ok: false, code: "output_unavailable" };
			}
		});
	}

	public async writeRecoveryMarker(marker: OutputRecoveryMarker): Promise<ProcessOutputMutationResult> {
		return this.serial(async () => {
			try {
				const loaded = await this.load();
				if (compareCursor(marker.cursor, loaded.metadata.head) > 0) return { ok: false, code: "output_cursor_invalid" };
				await this.writeMetadata({ ...loaded.metadata, recoveryMarker: marker });
				return { ok: true };
			} catch {
				return { ok: false, code: "output_unavailable" };
			}
		});
	}

	public async recoveryMarker(): Promise<OutputRecoveryMarker | undefined> {
		return this.serial(async () => (await this.load()).metadata.recoveryMarker);
	}

	public async readAll(maxBytes: number = PROCESS_OUTPUT_BOUNDS.maxDurableOutputBytes): Promise<ProcessOutputReadAllResult> {
		return this.serial(async () => {
			try {
				const loaded = await this.load();
				const text = loaded.records.map((record) => record.text).join("");
				if (Buffer.byteLength(text, "utf8") > maxBytes) return { ok: false, code: "output_capacity_exceeded" };
				return { ok: true, text, head: loaded.metadata.head, ...(loaded.metadata.sealed === undefined ? {} : { seal: loaded.metadata.sealed }) };
			} catch {
				return { ok: false, code: "output_unavailable" };
			}
		});
	}

	public async seal(): Promise<ProcessOutputSealResult> {
		return this.serial(async () => {
			try {
				const loaded = await this.load();
				if (loaded.metadata.sealed) return { ok: true, seal: loaded.metadata.sealed };
				const content = loaded.records.map((record) => record.text).join("");
				const seal: ProcessOutputSeal = {
					digest: runtimeDigest(content),
					size: Buffer.byteLength(content, "utf8"),
				};
				await this.writeMetadata({ ...loaded.metadata, sealed: seal });
				return { ok: true, seal };
			} catch {
				return { ok: false, code: "output_unavailable" };
			}
		});
	}

	private async headResult(): Promise<ProcessOutputAppendResult> {
		return { ok: true, cursor: await this.head() };
	}

	private async serial<T>(task: () => Promise<T>): Promise<T> {
		const previous = this.tail;
		let release: (() => void) | undefined;
		this.tail = new Promise<void>((resolve) => {
			release = resolve;
		});
		await previous;
		try {
			return await task();
		} finally {
			release?.();
		}
	}

	private async ensureDirectory(): Promise<void> {
		await mkdir(join(this.filePathValue, ".."), { recursive: true, mode: 0o700 });
	}

	private async load(): Promise<LoadedOutput> {
		const records = await this.readRecords();
		const persisted = await readJson<OutputMetadata>(this.metadataPath);
		const first = records[0];
		const last = records.at(-1);
		// As with head, a non-empty record file defines the retained lower bound
		// when metadata and records disagree. Preserve the metadata sequence when
		// the byte boundary agrees: compaction at a record boundary can retain the
		// original checkpoint sequence even though the first retained record has a
		// later sequence.
		const earliestCursor = first === undefined
			? persisted?.earliestCursor ?? zeroCursor()
			: persisted?.earliestCursor !== undefined && persisted.earliestCursor.byteOffset === first.startByte
				? persisted.earliestCursor
				: { sequence: first.sequence, byteOffset: first.startByte };
		// The record file is the append-only source of truth for head. Metadata is
		// updated after the record write, so a crash/response loss can leave one
		// extra durable record while the previous metadata head is still present.
		// An empty file is retained as a valid compacted representation and must
		// therefore keep its persisted head.
		const head = last === undefined
			? persisted?.head ?? zeroCursor()
			: { sequence: last.sequence, byteOffset: last.endByte };
		const metadata: OutputMetadata = {
			earliestCursor,
			head,
			...(persisted?.pins === undefined ? {} : { pins: persisted.pins }),
			...(persisted?.recoveryMarker === undefined ? {} : { recoveryMarker: persisted.recoveryMarker }),
			...(persisted?.sealed === undefined ? {} : { sealed: persisted.sealed }),
			...(persisted?.materialization === undefined ? {} : { materialization: persisted.materialization }),
		};
		if (metadata.sealed !== undefined) {
			const content = records.map((record) => record.text).join("");
			if (
				runtimeDigest(content).digest !== metadata.sealed.digest.digest ||
				Buffer.byteLength(content, "utf8") !== metadata.sealed.size
			) throw new Error("sealed private output integrity failure");
		}
		return {
			records,
			metadata,
		};
	}

	private async readRecords(): Promise<readonly OutputRecord[]> {
		let content: string;
		try {
			content = await readFile(this.filePathValue, "utf8");
		} catch (error) {
			if (isNotFound(error)) return [];
			throw error;
		}
		const records: OutputRecord[] = [];
		for (const line of content.split("\n")) {
			if (line.length === 0) continue;
			const parsed = JSON.parse(line) as Partial<OutputRecord>;
			const sequence = parsed.sequence;
			const startByte = parsed.startByte;
			const endByte = parsed.endByte;
			const text = parsed.text;
			if (
				typeof sequence !== "number" ||
				!Number.isSafeInteger(sequence) ||
				typeof startByte !== "number" ||
				!Number.isSafeInteger(startByte) ||
				typeof endByte !== "number" ||
				!Number.isSafeInteger(endByte) ||
				typeof text !== "string" ||
				endByte < startByte ||
				Buffer.byteLength(text, "utf8") !== endByte - startByte
			) throw new Error("invalid private output record");
			records.push({ sequence, startByte, endByte, text });
		}
		return records;
	}

	private async rewrite(records: readonly OutputRecord[]): Promise<void> {
		await this.ensureDirectory();
		const temporary = `${this.filePathValue}.tmp`;
		const content = records.length === 0 ? "" : `${records.map((record) => canonicalJson(record)).join("\n")}\n`;
		await writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
		await rename(temporary, this.filePathValue);
	}

	private async compactLoaded(loaded: LoadedOutput, cursor: OutputCursor): Promise<void> {
		const retained: OutputRecord[] = [];
		for (const record of loaded.records) {
			if (record.endByte <= cursor.byteOffset) continue;
			if (record.startByte < cursor.byteOffset) {
				const suffix = suffixAtByteOffset(record.text, cursor.byteOffset - record.startByte);
				if (suffix === undefined) throw new Error("invalid retention cursor");
				retained.push({ sequence: record.sequence, startByte: cursor.byteOffset, endByte: record.endByte, text: suffix });
			} else retained.push(record);
		}
		await this.rewrite(retained);
		await this.writeMetadata({ ...loaded.metadata, earliestCursor: cursor, head: loaded.metadata.head });
	}

	private async writeMetadata(metadata: OutputMetadata): Promise<void> {
		await this.ensureDirectory();
		const temporary = `${this.metadataPath}.tmp`;
		await writeFile(temporary, `${canonicalJson(metadata)}\n`, { encoding: "utf8", mode: 0o600 });
		await rename(temporary, this.metadataPath);
	}
}

async function readJson<T>(filePath: string): Promise<T | undefined> {
	try {
		return JSON.parse(await readFile(filePath, "utf8")) as T;
	} catch (error) {
		if (isNotFound(error)) return undefined;
		throw error;
	}
}

function suffixAtByteOffset(text: string, offset: number): string | undefined {
	if (!Number.isSafeInteger(offset) || offset < 0) return undefined;
	let byteOffset = 0;
	let stringOffset = 0;
	for (const codePoint of text) {
		if (byteOffset === offset) return text.slice(stringOffset);
		byteOffset += Buffer.byteLength(codePoint, "utf8");
		stringOffset += codePoint.length;
		if (byteOffset > offset) return undefined;
	}
	return byteOffset === offset ? "" : undefined;
}

function zeroCursor(): OutputCursor {
	return { sequence: 0, byteOffset: 0 };
}

function compareCursor(left: OutputCursor, right: OutputCursor): number {
	if (left.byteOffset !== right.byteOffset) return left.byteOffset < right.byteOffset ? -1 : 1;
	return left.sequence === right.sequence ? 0 : left.sequence < right.sequence ? -1 : 1;
}

function pinnedBefore(pins: Readonly<Record<string, OutputCursor>> | undefined, cursor: OutputCursor): string[] {
	return Object.entries(pins ?? {})
		.filter(([, pinned]) => compareCursor(pinned, cursor) < 0)
		.map(([pinId]) => pinId)
		.sort();
}

function isNotFound(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isMaterializationRecord(value: unknown): value is ProcessOutputMaterializationRecord {
	if (!isRecord(value)) return false;
	const mode = value.mode;
	const sourceDigest = value.sourceDigest;
	const materialization = value.materialization;
	const recordDigest = value.recordDigest;
	if (mode !== "off" && mode !== "events" && mode !== "events_and_artifacts") return false;
	if (!isRuntimeDigest(sourceDigest) || !isRuntimeDigest(recordDigest) || !isRecord(materialization)) return false;
	if (!isRuntimeContentRef(materialization.outputRef)) return false;
	if (materialization.traceContent !== undefined && !isTraceContent(materialization.traceContent)) return false;
	if (materialization.artifactRef !== undefined && !isArtifactRef(materialization.artifactRef)) return false;
	try {
		return runtimeDigest({ mode, sourceDigest, materialization }).digest === recordDigest.digest;
	} catch {
		return false;
	}
}

function isRuntimeContentRef(value: unknown): value is { readonly digest: RuntimeDigest } {
	if (!isRecord(value) || !isRuntimeDigest(value.digest) || typeof value.subjectKind !== "string") return false;
	return value.mediaType === undefined || typeof value.mediaType === "string";
}

function isTraceContent(value: unknown): boolean {
	if (!isRecord(value) || typeof value.storage !== "string" || !isSha256(value.digest)) return false;
	return value.storage === "digest_only" || isArtifactRef(value);
}

function isArtifactRef(value: unknown): boolean {
	return isRecord(value) && value.storage === "artifact" && typeof value.artifactId === "string" &&
		isSha256(value.digest) && typeof value.mediaType === "string" &&
		Number.isSafeInteger(value.size) && (value.size as number) >= 0;
}

function isSha256(value: unknown): value is string {
	return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
}

function isRuntimeDigest(value: unknown): value is RuntimeDigest {
	return isRecord(value) && value.algorithm === "sha256" && typeof value.digest === "string" && /^[0-9a-f]{64}$/u.test(value.digest);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
