/** Durable Host shutdown/recovery marker store。 */

import { appendFile, lstat, mkdir, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { canonicalJson } from "../../runtime/protocol/canonical-json.ts";
import { runtimeDigest, type RuntimeDigest } from "../../runtime/protocol/foundation.ts";
import { hostStateRelativeLocator, type RunledgerLayout } from "../../runtime/contracts/storage-layout.ts";
import type {
	RuntimeHostLifecycleFailure,
	RuntimeHostLifecyclePhase,
	RuntimeHostProcessEvidence,
	RuntimeHostRecoveryMarker,
} from "../../runtime/host/lifecycle.ts";

const PHASES: ReadonlySet<RuntimeHostLifecyclePhase> = new Set([
	"shutdown_started",
	"admission_closed",
	"turns_drained",
	"processes_drained",
	"outputs_sealed",
	"artifacts_materialized",
	"writer_flushed",
	"resources_released",
	"shutdown_completed",
	"shutdown_incomplete",
	"recovery_started",
	"recovery_completed",
	"recovery_incomplete",
]);

export class HostRecoveryMarkerStore {
	private readonly home: string;
	private readonly directory: string;
	private readonly filePath: string;

	public constructor(layout: RunledgerLayout, workspaceStorageKey: string) {
		this.home = resolve(layout.home);
		this.directory = resolve(this.home, hostStateRelativeLocator(workspaceStorageKey));
		this.filePath = join(this.directory, "recovery.jsonl");
	}

	public path(): string {
		return this.filePath;
	}

	public async append(marker: RuntimeHostRecoveryMarker): Promise<void> {
		if (!isRuntimeHostRecoveryMarker(marker)) throw new Error("invalid Host recovery marker");
		await ensureContainedDirectoryChain(this.home, this.directory);
		await appendFile(this.filePath, `${canonicalJson(marker)}\n`, { encoding: "utf8", mode: 0o600 });
	}

	public async latest(): Promise<RuntimeHostRecoveryMarker | undefined> {
		let content: string;
		try {
			content = await readFile(this.filePath, "utf8");
		} catch (error) {
			if (isNotFound(error)) return undefined;
			throw error;
		}
		let latest: RuntimeHostRecoveryMarker | undefined;
		for (const line of content.split(/\r?\n/u).filter((entry) => entry.length > 0)) {
			let parsed: unknown;
			try {
				parsed = JSON.parse(line) as unknown;
			} catch {
				throw new Error("invalid Host recovery marker JSON");
			}
			if (!isRuntimeHostRecoveryMarker(parsed)) throw new Error("invalid Host recovery marker record");
			latest = parsed;
		}
		return latest;
	}
}

function isRuntimeHostRecoveryMarker(value: unknown): value is RuntimeHostRecoveryMarker {
	if (typeof value !== "object" || value === null) return false;
	const record = value as Record<string, unknown>;
	if (
		typeof record.hostGeneration !== "number" ||
		!Number.isSafeInteger(record.hostGeneration) ||
		record.hostGeneration < 0 ||
		typeof record.phase !== "string" ||
		!PHASES.has(record.phase as RuntimeHostLifecyclePhase) ||
		(record.artifactMode !== "off" && record.artifactMode !== "events" && record.artifactMode !== "events_and_artifacts") ||
			!Array.isArray(record.processIds) ||
			!record.processIds.every((id): id is string => typeof id === "string" && /^execution_[A-Za-z0-9._~-]{1,128}$/u.test(id)) ||
			!Array.isArray(record.processEvidence) ||
			!record.processEvidence.every(isProcessEvidence) ||
			!Array.isArray(record.failures) ||
		!record.failures.every(isFailure) ||
		!isDigest(record.markerDigest)
	) return false;
	const { markerDigest: _markerDigest, ...body } = record;
	return runtimeDigest(body).digest === (record.markerDigest as RuntimeDigest).digest;
}

function isProcessEvidence(value: unknown): value is RuntimeHostProcessEvidence {
	if (typeof value !== "object" || value === null) return false;
	const record = value as Record<string, unknown>;
	if (typeof record.id !== "string" || !/^execution_[A-Za-z0-9._~-]{1,128}$/u.test(record.id)) return false;
	if (typeof record.outputCheckpoint !== "object" || record.outputCheckpoint === null || Array.isArray(record.outputCheckpoint)) return false;
	const checkpoint = record.outputCheckpoint as Record<string, unknown>;
	if (typeof checkpoint.size !== "number" || !Number.isSafeInteger(checkpoint.size) || checkpoint.size < 0) return false;
	if (typeof checkpoint.cursor !== "object" || checkpoint.cursor === null || Array.isArray(checkpoint.cursor)) return false;
	const cursor = checkpoint.cursor as Record<string, unknown>;
	if (!isNonNegativeSafeInteger(cursor.sequence) || !isNonNegativeSafeInteger(cursor.byteOffset)) return false;
	if (record.outputSealDigest !== undefined && !isDigest(record.outputSealDigest)) return false;
	if (record.settlementEvidenceRef !== undefined && !isContentRef(record.settlementEvidenceRef)) return false;
	return true;
}

function isContentRef(value: unknown): boolean {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	if (!new Set(["artifact", "content", "details", "attestation", "receipt", "manifest", "snapshot", "projection"]).has(record.subjectKind as string)) return false;
	if (!isDigest(record.digest)) return false;
	if (record.mediaType !== undefined && typeof record.mediaType !== "string") return false;
	return record.size === undefined || isNonNegativeSafeInteger(record.size);
}

function isNonNegativeSafeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isFailure(value: unknown): value is RuntimeHostLifecycleFailure {
	if (typeof value !== "object" || value === null) return false;
	const record = value as Record<string, unknown>;
	return (
		(record.target === "host" || record.target === "process" || record.target === "writer" || record.target === "resources") &&
		typeof record.phase === "string" && PHASES.has(record.phase as RuntimeHostLifecyclePhase) &&
		(record.processId === undefined || (typeof record.processId === "string" && /^execution_[A-Za-z0-9._~-]{1,128}$/u.test(record.processId)))
	);
}

function isDigest(value: unknown): value is RuntimeDigest {
	return typeof value === "object" && value !== null &&
		(value as Record<string, unknown>).algorithm === "sha256" &&
		typeof (value as Record<string, unknown>).digest === "string" &&
		/^[a-f0-9]{64}$/u.test((value as Record<string, unknown>).digest as string);
}

function isNotFound(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

async function ensureContainedDirectoryChain(home: string, target: string): Promise<void> {
	const relativeTarget = relative(home, target);
	if (relativeTarget === ".." || relativeTarget.startsWith(`..${sep}`) || isAbsolute(relativeTarget)) {
		throw new Error("Host recovery marker containment violation");
	}
	await mkdir(home, { recursive: true, mode: 0o700 });
	await assertSafeDirectory(home, home);
	let current = home;
	for (const segment of relativeTarget.split(sep).filter((value) => value.length > 0)) {
		current = join(current, segment);
		try {
			await mkdir(current, { mode: 0o700 });
		} catch (error) {
			if (!isAlreadyExists(error)) throw error;
		}
		await assertSafeDirectory(home, current);
	}
}

async function assertSafeDirectory(home: string, candidate: string): Promise<void> {
	const info = await lstat(candidate);
	if (info.isSymbolicLink()) throw new Error("Host recovery marker ancestor symlink is not allowed");
	if (!info.isDirectory()) throw new Error("Host recovery marker ancestor must be a directory");
	const canonicalHome = await realpath(home);
	const canonicalCandidate = await realpath(candidate);
	const candidateRelative = relative(canonicalHome, canonicalCandidate);
	if (candidateRelative === ".." || candidateRelative.startsWith(`..${sep}`) || isAbsolute(candidateRelative)) {
		throw new Error("Host recovery marker containment violation");
	}
}

function isAlreadyExists(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}
