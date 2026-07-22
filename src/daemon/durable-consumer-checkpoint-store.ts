/** 内置 projection consumer 的跨进程、原子 checkpoint 存储。 */

import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import lockfile from "proper-lockfile";
import { canonicalDigest, canonicalJson } from "../runtime/protocol/v3/canonical-json.ts";
import { sameRuntimeEventStream, type EventCursor } from "../runtime/protocol/v3/events.ts";
import { isRuntimeId, type SessionId } from "../runtime/protocol/v3/ids.ts";
import { isEventCursor, validateRuntimeEvent } from "../runtime/protocol/v3/schemas.ts";
import { controlPlaneFailure, type ControlPlaneResult } from "../runtime/control-plane/errors.ts";
import type {
	DurableConsumerCheckpoint,
	DurableProjectionCheckpointStore,
	ProjectionCheckpointMutation,
	ProjectionCheckpointOutcome,
} from "../runtime/control-plane/subscriptions.ts";

const CHECKPOINT_SCHEMA_VERSION = 1 as const;
const DIGEST = /^[a-f0-9]{64}$/u;
const CONSUMER_ID = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/u;
const MAX_CHECKPOINT_BYTES = 16 * 1024 * 1024;

interface StoredCheckpointBody<TState> {
	schemaVersion: 1;
	checkpoint: DurableConsumerCheckpoint<TState>;
}

interface StoredCheckpoint<TState> extends StoredCheckpointBody<TState> {
	recordDigest: string;
}

export interface FileDurableProjectionCheckpointStoreOptions<TState> {
	rootDirectory: string;
	initial: (consumerId: string, sessionId: SessionId) => TState;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
	const actual = Object.keys(value).sort();
	const sortedExpected = [...expected].sort();
	return actual.length === sortedExpected.length && actual.every((key, index) => key === sortedExpected[index]);
}

function sameCursor(left: EventCursor | null, right: EventCursor | null): boolean {
	if (!left || !right) return left === right;
	return sameRuntimeEventStream(left.stream, right.stream) &&
		left.sequence === right.sequence &&
		left.eventId === right.eventId &&
		left.eventHash === right.eventHash;
}

function validCursor(value: unknown, sessionId: SessionId): value is EventCursor | null {
	if (value === null) return true;
	return isEventCursor(value) && value.stream.scope === "session" && value.stream.sessionId === sessionId;
}

function checkpointPath(rootDirectory: string, consumerId: string, sessionId: SessionId): string {
	const name = createHash("sha256").update(`${consumerId}\0${sessionId}`, "utf8").digest("hex");
	return join(rootDirectory, `${name}.json`);
}

function cloneCheckpoint<TState>(checkpoint: DurableConsumerCheckpoint<TState>): DurableConsumerCheckpoint<TState> {
	return structuredClone(checkpoint);
}

function storedCheckpoint<TState>(checkpoint: DurableConsumerCheckpoint<TState>): StoredCheckpoint<TState> {
	const body: StoredCheckpointBody<TState> = { schemaVersion: CHECKPOINT_SCHEMA_VERSION, checkpoint };
	return { ...body, recordDigest: canonicalDigest(body) };
}

function parseCheckpoint<TState>(
	input: unknown,
	consumerId: string,
	sessionId: SessionId,
): ControlPlaneResult<DurableConsumerCheckpoint<TState>> {
	if (!isRecord(input) || !exactKeys(input, ["schemaVersion", "checkpoint", "recordDigest"]) ||
		input.schemaVersion !== CHECKPOINT_SCHEMA_VERSION || typeof input.recordDigest !== "string" || !DIGEST.test(input.recordDigest) ||
		!isRecord(input.checkpoint)) {
		return controlPlaneFailure("recovery_required", "consumer checkpoint record is invalid");
	}
	const checkpoint = input.checkpoint;
	if (!exactKeys(checkpoint, ["consumerId", "sessionId", "revision", "cursor", "projection", "projectionDigest"]) ||
		checkpoint.consumerId !== consumerId || checkpoint.sessionId !== sessionId ||
		!Number.isSafeInteger(checkpoint.revision) || Number(checkpoint.revision) < 0 ||
		!validCursor(checkpoint.cursor, sessionId) ||
		typeof checkpoint.projectionDigest !== "string" || !DIGEST.test(checkpoint.projectionDigest)) {
		return controlPlaneFailure("recovery_required", "consumer checkpoint correlation is invalid");
	}
	try {
		if (canonicalDigest(checkpoint.projection) !== checkpoint.projectionDigest ||
			canonicalDigest({ schemaVersion: CHECKPOINT_SCHEMA_VERSION, checkpoint }) !== input.recordDigest) {
			return controlPlaneFailure("recovery_required", "consumer checkpoint digest is invalid");
		}
	} catch {
		return controlPlaneFailure("recovery_required", "consumer checkpoint projection is not canonical JSON");
	}
	return { ok: true, value: cloneCheckpoint(checkpoint as unknown as DurableConsumerCheckpoint<TState>) };
}

/**
 * 一个 checkpoint 文件同时保存 projection 与 cursor；跨进程锁内完成 CAS，临时文件
 * fsync + rename + directory fsync 后才报告 committed。production 不回退内存状态。
 */
export class FileDurableProjectionCheckpointStore<TState> implements DurableProjectionCheckpointStore<TState> {
	readonly #rootDirectory: string;
	readonly #lockTarget: string;
	readonly #initial: (consumerId: string, sessionId: SessionId) => TState;

	private constructor(options: FileDurableProjectionCheckpointStoreOptions<TState>) {
		this.#rootDirectory = resolve(options.rootDirectory);
		this.#lockTarget = join(this.#rootDirectory, ".checkpoint-store");
		this.#initial = options.initial;
	}

	public static async open<TState>(
		options: FileDurableProjectionCheckpointStoreOptions<TState>,
	): Promise<ControlPlaneResult<FileDurableProjectionCheckpointStore<TState>>> {
		if (!isAbsolute(options.rootDirectory) || resolve(options.rootDirectory) !== options.rootDirectory ||
			options.rootDirectory.includes("\0")) {
			return controlPlaneFailure("invalid_request", "consumer checkpoint root must be an exact absolute path");
		}
		const store = new FileDurableProjectionCheckpointStore(options);
		try {
			await mkdir(store.#rootDirectory, { recursive: true, mode: 0o700 });
			let rootStats = await lstat(store.#rootDirectory);
			if (!rootStats.isDirectory() || rootStats.isSymbolicLink() ||
				resolve(await realpath(store.#rootDirectory)) !== store.#rootDirectory) {
				return controlPlaneFailure("recovery_required", "consumer checkpoint root is not a canonical directory");
			}
			if (typeof process.getuid === "function" && rootStats.uid !== process.getuid()) {
				return controlPlaneFailure("unauthorized_peer", "consumer checkpoint root has a different owner");
			}
			if ((rootStats.mode & 0o077) !== 0) {
				await chmod(store.#rootDirectory, 0o700);
				rootStats = await lstat(store.#rootDirectory);
				if ((rootStats.mode & 0o077) !== 0) {
					return controlPlaneFailure("adapter_unavailable", "consumer checkpoint root permissions are too broad");
				}
			}
			let lockHandle: Awaited<ReturnType<typeof open>> | undefined;
			try {
				lockHandle = await open(store.#lockTarget, "wx", 0o600);
				await lockHandle.sync();
			} catch (error) {
				if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
			} finally {
				await lockHandle?.close();
			}
			const lockStats = await lstat(store.#lockTarget);
			if (!lockStats.isFile() || lockStats.isSymbolicLink()) {
				return controlPlaneFailure("recovery_required", "consumer checkpoint lock target is invalid");
			}
			await chmod(store.#lockTarget, 0o600);
			return { ok: true, value: store };
		} catch (error) {
			return controlPlaneFailure("adapter_unavailable", "consumer checkpoint store could not be opened", true, {
				errorName: error instanceof Error ? error.name : "UnknownError",
			});
		}
	}

	async #withLock<TResult>(operation: () => Promise<ControlPlaneResult<TResult>>): Promise<ControlPlaneResult<TResult>> {
		let release: (() => Promise<void>) | undefined;
		try {
			release = await lockfile.lock(this.#lockTarget, {
				realpath: false,
				stale: 30_000,
				update: 10_000,
				retries: { retries: 20, minTimeout: 10, maxTimeout: 100 },
			});
			return await operation();
		} catch (error) {
			return controlPlaneFailure("adapter_unavailable", "consumer checkpoint lock is unavailable", true, {
				errorName: error instanceof Error ? error.name : "UnknownError",
			});
		} finally {
			await release?.().catch(() => undefined);
		}
	}

	#initialCheckpoint(consumerId: string, sessionId: SessionId): ControlPlaneResult<DurableConsumerCheckpoint<TState>> {
		if (!CONSUMER_ID.test(consumerId) || !isRuntimeId(sessionId, "session")) {
			return controlPlaneFailure("invalid_request", "consumer checkpoint identity is invalid");
		}
		try {
			const projection = structuredClone(this.#initial(consumerId, sessionId));
			return {
				ok: true,
				value: {
					consumerId,
					sessionId,
					revision: 0,
					cursor: null,
					projection,
					projectionDigest: canonicalDigest(projection),
				},
			};
		} catch {
			return controlPlaneFailure("adapter_contract_violation", "initial consumer projection is not canonical JSON");
		}
	}

	async #read(consumerId: string, sessionId: SessionId): Promise<ControlPlaneResult<DurableConsumerCheckpoint<TState>>> {
		const initial = this.#initialCheckpoint(consumerId, sessionId);
		if (!initial.ok) return initial;
		const path = checkpointPath(this.#rootDirectory, consumerId, sessionId);
		let handle: Awaited<ReturnType<typeof open>> | undefined;
		try {
			handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
			const stats = await handle.stat();
			if (!stats.isFile() || stats.size > MAX_CHECKPOINT_BYTES) {
				return controlPlaneFailure("recovery_required", "consumer checkpoint file is invalid or oversized");
			}
			const source = await handle.readFile("utf8");
			let parsed: unknown;
			try {
				parsed = JSON.parse(source) as unknown;
			} catch {
				return controlPlaneFailure("recovery_required", "consumer checkpoint JSON is corrupted");
			}
			return parseCheckpoint<TState>(parsed, consumerId, sessionId);
		} catch (error) {
			if (error instanceof Error && "code" in error && error.code === "ENOENT") return initial;
			return controlPlaneFailure("adapter_unavailable", "consumer checkpoint could not be read", true, {
				errorName: error instanceof Error ? error.name : "UnknownError",
			});
		} finally {
			await handle?.close();
		}
	}

	async #write(checkpoint: DurableConsumerCheckpoint<TState>): Promise<ControlPlaneResult<void>> {
		const path = checkpointPath(this.#rootDirectory, checkpoint.consumerId, checkpoint.sessionId);
		const temporary = join(this.#rootDirectory, `.${randomUUID()}.partial`);
		let handle: Awaited<ReturnType<typeof open>> | undefined;
		try {
			handle = await open(temporary, "wx", 0o600);
			await handle.writeFile(canonicalJson(storedCheckpoint(checkpoint)), "utf8");
			await handle.sync();
			await handle.close();
			handle = undefined;
			await rename(temporary, path);
			await chmod(path, 0o600);
			const directory = await open(this.#rootDirectory, constants.O_RDONLY);
			try {
				await directory.sync();
			} finally {
				await directory.close();
			}
			return { ok: true, value: undefined };
		} catch (error) {
			return controlPlaneFailure("adapter_unavailable", "consumer checkpoint commit was not confirmed durable", false, {
				errorName: error instanceof Error ? error.name : "UnknownError",
			}, "uncertain");
		} finally {
			await handle?.close().catch(() => undefined);
			await unlink(temporary).catch(() => undefined);
		}
	}

	public load(consumerId: string, sessionId: SessionId): Promise<ControlPlaneResult<DurableConsumerCheckpoint<TState>>> {
		return this.#withLock(() => this.#read(consumerId, sessionId));
	}

	public applyAndCheckpoint(
		mutation: ProjectionCheckpointMutation<TState>,
	): Promise<ControlPlaneResult<ProjectionCheckpointOutcome<TState>>> {
		return this.#withLock<ProjectionCheckpointOutcome<TState>>(async () => {
			const event = validateRuntimeEvent(mutation.event);
			if (!event.ok || event.value.stream.scope !== "session" || event.value.stream.sessionId !== mutation.sessionId) {
				return controlPlaneFailure("cursor_mismatch", "consumer checkpoint event is invalid or crossed a session boundary");
			}
			let nextProjection: TState;
			try {
				nextProjection = structuredClone(mutation.nextProjection);
				if (canonicalDigest(nextProjection) !== mutation.nextProjectionDigest) {
					return controlPlaneFailure("adapter_contract_violation", "projection digest does not match next state");
				}
			} catch {
				return controlPlaneFailure("adapter_contract_violation", "next consumer projection is not canonical JSON");
			}
			const current = await this.#read(mutation.consumerId, mutation.sessionId);
			if (!current.ok) return current;
			if (current.value.cursor && event.value.sequence === current.value.cursor.sequence &&
				event.value.eventId === current.value.cursor.eventId &&
				event.value.currentEventHash === current.value.cursor.eventHash) {
				return { ok: true, value: { status: "duplicate", checkpoint: cloneCheckpoint(current.value) } };
			}
			if (mutation.expectedRevision !== current.value.revision ||
				!sameCursor(mutation.expectedCursor, current.value.cursor)) {
				return { ok: true, value: { status: "conflict", actualRevision: current.value.revision } };
			}
			const expectedSequence = current.value.cursor ? current.value.cursor.sequence + 1 : 0;
			if (event.value.sequence !== expectedSequence) {
				return controlPlaneFailure("cursor_mismatch", "consumer checkpoint event is not the next session event", false, {
					expectedSequence,
					actualSequence: event.value.sequence,
				});
			}
			const checkpoint: DurableConsumerCheckpoint<TState> = {
				consumerId: mutation.consumerId,
				sessionId: mutation.sessionId,
				revision: current.value.revision + 1,
				cursor: {
					stream: event.value.stream,
					sequence: event.value.sequence,
					eventId: event.value.eventId,
					eventHash: event.value.currentEventHash,
				},
				projection: nextProjection,
				projectionDigest: mutation.nextProjectionDigest,
			};
			const written = await this.#write(checkpoint);
			return written.ok
				? { ok: true, value: { status: "committed", checkpoint: cloneCheckpoint(checkpoint) } }
				: written;
		});
	}
}
