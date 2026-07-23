/** Durable stop tombstone：startup recovery 必须在 snapshot/replay 前读取。 */

import { randomUUID } from "node:crypto";
import { open, mkdir, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { canonicalDigest, canonicalJson } from "../protocol/v3/canonical-json.ts";
import type { EventCursor } from "../protocol/v3/events.ts";
import type { AuthorityId, PrincipalId, SessionId, TenantId } from "../protocol/v3/ids.ts";
import { isRuntimeId } from "../protocol/v3/ids.ts";
import { isEventCursor } from "../protocol/v3/schemas.ts";
import type { SessionResult } from "./types.ts";

export const STOP_TOMBSTONE_FILE_NAME = "stop.tombstone.json";

export interface StopTombstoneBody {
	authorityId: AuthorityId;
	tenantId: TenantId;
	sessionId: SessionId;
	requestedBy: PrincipalId;
	stopCursor: EventCursor;
	reasonDigest: string;
	writtenAt: string;
}

export type StopTombstoneWritePhase = "before_write" | "before_rename" | "before_directory_sync";

export interface WriteStopTombstoneOptions {
	onWritePhase?: (phase: StopTombstoneWritePhase) => Promise<void> | void;
}

export interface StopTombstone extends StopTombstoneBody {
	tombstoneDigest: string;
}

function failure<T>(message: string): SessionResult<T> {
	return { ok: false, error: { code: "corrupted_log", message, retryable: false } };
}

function createStopTombstone(body: StopTombstoneBody): StopTombstone {
	return { ...body, tombstoneDigest: canonicalDigest(body) };
}

export function validateStopTombstone(value: unknown): value is StopTombstone {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const candidate = value as Record<string, unknown>;
	const keys = Object.keys(candidate).sort();
	if (
		keys.join(",") !==
		"authorityId,reasonDigest,requestedBy,sessionId,stopCursor,tenantId,tombstoneDigest,writtenAt"
	) return false;
	if (
		!isRuntimeId(candidate.authorityId, "authority") ||
		!isRuntimeId(candidate.tenantId, "tenant") ||
		!isRuntimeId(candidate.sessionId, "session") ||
			!isRuntimeId(candidate.requestedBy, "principal") ||
			!isEventCursor(candidate.stopCursor) ||
			candidate.stopCursor.stream.scope !== "session" ||
			candidate.stopCursor.stream.sessionId !== candidate.sessionId ||
		typeof candidate.reasonDigest !== "string" ||
		!/^[a-f0-9]{64}$/.test(candidate.reasonDigest) ||
		typeof candidate.tombstoneDigest !== "string" ||
		!/^[a-f0-9]{64}$/.test(candidate.tombstoneDigest) ||
		typeof candidate.writtenAt !== "string" ||
		!Number.isFinite(Date.parse(candidate.writtenAt))
	) return false;
	const { tombstoneDigest, ...body } = candidate;
	return canonicalDigest(body) === tombstoneDigest;
}

export async function readStopTombstone(sessionDirectory: string): Promise<SessionResult<StopTombstone | undefined>> {
	try {
		const text = await readFile(join(sessionDirectory, STOP_TOMBSTONE_FILE_NAME), "utf8");
		if (!text.endsWith("\n") || text.indexOf("\n") !== text.length - 1) return failure("stop tombstone must contain one LF-terminated record");
		const parsed: unknown = JSON.parse(text.slice(0, -1));
		if (!validateStopTombstone(parsed)) return failure("stop tombstone is invalid or has been modified");
		return { ok: true, value: parsed };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ok: true, value: undefined };
		return failure("stop tombstone cannot be read");
	}
}

export async function writeStopTombstone(
	sessionDirectory: string,
	body: StopTombstoneBody,
	options: WriteStopTombstoneOptions = {},
): Promise<SessionResult<StopTombstone>> {
	if (
		!isRuntimeId(body.authorityId, "authority") ||
		!isRuntimeId(body.tenantId, "tenant") ||
		!isRuntimeId(body.sessionId, "session") ||
		!isRuntimeId(body.requestedBy, "principal") ||
		!isEventCursor(body.stopCursor) ||
		body.stopCursor.stream.scope !== "session" ||
		body.stopCursor.stream.sessionId !== body.sessionId ||
		!/^[a-f0-9]{64}$/.test(body.reasonDigest) ||
		!Number.isFinite(Date.parse(body.writtenAt))
	) return failure("stop tombstone input is invalid");

	const tombstone = createStopTombstone(body);
	const existing = await readStopTombstone(sessionDirectory);
	if (!existing.ok) return existing;
	if (existing.value) {
		if (existing.value.tombstoneDigest === tombstone.tombstoneDigest) return { ok: true, value: existing.value };
		return { ok: false, error: { code: "stopped", message: "a different stop tombstone already exists", retryable: false } };
	}

	await mkdir(sessionDirectory, { recursive: true, mode: 0o700 });
	const target = join(sessionDirectory, STOP_TOMBSTONE_FILE_NAME);
	const temporary = join(sessionDirectory, `.stop.tombstone.${process.pid}.${randomUUID()}.tmp`);
	try {
		const handle = await open(temporary, "wx", 0o600);
		try {
			await options.onWritePhase?.("before_write");
			await handle.writeFile(`${canonicalJson(tombstone)}\n`, "utf8");
			await handle.sync();
		} finally {
			await handle.close();
		}
		await options.onWritePhase?.("before_rename");
		await rename(temporary, target);
		const directoryHandle = await open(sessionDirectory, "r");
		try {
			await options.onWritePhase?.("before_directory_sync");
			await directoryHandle.sync();
		} finally {
			await directoryHandle.close();
		}
		return { ok: true, value: tombstone };
	} catch {
		await rm(temporary, { force: true }).catch(() => undefined);
		return { ok: false, error: { code: "durable_write_failed", message: "stop tombstone could not be committed", retryable: false } };
	}
}
