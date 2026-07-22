/** Compaction live projection 的跨进程 expected-revision CAS store。 */

import { mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import lockfile from "proper-lockfile";
import { canonicalDigest } from "../runtime/protocol/v3/canonical-json.ts";
import {
	createRuntimeId,
	isRuntimeId,
	type AuthorityId,
	type SessionId,
	type TenantId,
} from "../runtime/protocol/v3/ids.ts";
import {
	isCompactionCheckpointRef,
	isCompactionProjectionInstallationReceipt,
} from "../runtime/context/compaction/schema.ts";
import type { CompactionProjectionInstallationReceipt } from "../runtime/context/compaction/types.ts";
import {
	createCompactedHistoryProjection,
	type CompactedHistoryProjection,
} from "../runtime/context/compaction/projection.ts";
import type {
	CompactionProjectionInstallRequest,
	CompactionProjectionPort,
} from "../runtime/context/compaction/service.ts";

const MAX_PROJECTION_BYTES = 16 * 1024 * 1024;

export type CompactionProjectionWritePhase = "before_write" | "before_rename" | "after_rename";

interface StoredCompactionProjection {
	schemaVersion: 2;
	authorityId: AuthorityId;
	tenantId: TenantId;
	sessionId: SessionId;
	revision: number;
	projection: CompactedHistoryProjection;
	installation: CompactionProjectionInstallationReceipt;
	storedDigest: string;
}

export interface CompactionProjectionStoreState {
	revision: number;
	projection?: CompactedHistoryProjection;
	installation?: CompactionProjectionInstallationReceipt;
}

export interface FileCompactionProjectionStoreOptions {
	path: string;
	authorityId: AuthorityId;
	tenantId: TenantId;
	sessionId: SessionId;
	clock?: () => Date;
	onWritePhase?: (phase: CompactionProjectionWritePhase, targetPath: string) => Promise<void> | void;
}

export class CompactionProjectionRevisionConflictError extends Error {
	public readonly expectedRevision: number;
	public readonly actualRevision: number;

	public constructor(expectedRevision: number, actualRevision: number) {
		super(`compaction projection revision conflict: expected ${expectedRevision}, actual ${actualRevision}`);
		this.name = "CompactionProjectionRevisionConflictError";
		this.expectedRevision = expectedRevision;
		this.actualRevision = actualRevision;
	}
}

function envelopeDigest(value: Omit<StoredCompactionProjection, "storedDigest">): string {
	return canonicalDigest(value);
}

function isDigest(value: unknown): value is string {
	return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function isProjection(value: unknown): value is CompactedHistoryProjection {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	if (!isCompactionCheckpointRef(record.checkpoint) || typeof record.summary !== "string" ||
		!Array.isArray(record.retained) || !isDigest(record.projectionDigest)) return false;
	if (record.summary.length > MAX_PROJECTION_BYTES) return false;
	for (const entry of record.retained) {
		if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return false;
		const candidate = entry as Record<string, unknown>;
		if (!Number.isSafeInteger(candidate.sequence) || Number(candidate.sequence) < 0 ||
			!isDigest(candidate.contentDigest)) return false;
	}
	try {
		const reproduced = createCompactedHistoryProjection(
			record.checkpoint,
			record.summary,
			record.retained as CompactedHistoryProjection["retained"],
		);
		return reproduced.projectionDigest === record.projectionDigest;
	} catch {
		return false;
	}
}

function isStoredProjection(
	value: unknown,
	scope: Pick<FileCompactionProjectionStoreOptions, "authorityId" | "tenantId" | "sessionId">,
): value is StoredCompactionProjection {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	if (record.schemaVersion !== 2 || record.authorityId !== scope.authorityId ||
		record.tenantId !== scope.tenantId || record.sessionId !== scope.sessionId ||
		!Number.isSafeInteger(record.revision) || Number(record.revision) < 1 ||
		!isProjection(record.projection) ||
		!isCompactionProjectionInstallationReceipt(record.installation) ||
		!isDigest(record.storedDigest)) return false;
	const projection = record.projection;
	const installation = record.installation;
	if (
		installation.authorityId !== scope.authorityId ||
		installation.tenantId !== scope.tenantId ||
		installation.sessionId !== scope.sessionId ||
		installation.installedProjectionRevision !== record.revision ||
		installation.checkpointId !== projection.checkpoint.checkpointId ||
		installation.checkpointDigest !== projection.checkpoint.checkpointDigest ||
		installation.replacementHistoryDigest !== projection.checkpoint.replacementHistoryDigest ||
		installation.projectionDigest !== projection.projectionDigest
	) return false;
	const body = {
		schemaVersion: 2 as const,
		authorityId: scope.authorityId,
		tenantId: scope.tenantId,
		sessionId: scope.sessionId,
		revision: Number(record.revision),
		projection,
		installation,
	};
	return record.storedDigest === envelopeDigest(body);
}

async function ensurePrivateParent(path: string): Promise<void> {
	const directory = dirname(path);
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const metadata = await stat(directory);
	if (!metadata.isDirectory() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0) {
		throw new Error("compaction projection parent must be a private non-symlink directory");
	}
}

export class FileCompactionProjectionStore implements CompactionProjectionPort {
	readonly #path: string;
	readonly #scope: Pick<FileCompactionProjectionStoreOptions, "authorityId" | "tenantId" | "sessionId">;
	readonly #clock: () => Date;
	readonly #onWritePhase?: FileCompactionProjectionStoreOptions["onWritePhase"];

	public constructor(options: FileCompactionProjectionStoreOptions) {
		if (!isAbsolute(options.path) || resolve(options.path) !== options.path || !isRuntimeId(options.authorityId, "authority") ||
			!isRuntimeId(options.tenantId, "tenant") || !isRuntimeId(options.sessionId, "session")) {
			throw new TypeError("compaction projection store options are invalid");
		}
		this.#path = resolve(options.path);
		this.#scope = {
			authorityId: options.authorityId,
			tenantId: options.tenantId,
			sessionId: options.sessionId,
		};
		this.#clock = options.clock ?? (() => new Date());
		this.#onWritePhase = options.onWritePhase;
	}

	async #readStored(): Promise<StoredCompactionProjection | undefined> {
		let metadata;
		try {
			metadata = await stat(this.#path);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw error;
		}
		if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_PROJECTION_BYTES ||
			(metadata.mode & 0o077) !== 0) throw new Error("compaction projection file is unsafe");
		const source = await readFile(this.#path, "utf8");
		if (Buffer.byteLength(source, "utf8") > MAX_PROJECTION_BYTES) throw new Error("compaction projection is oversized");
		let parsed: unknown;
		try {
			parsed = JSON.parse(source) as unknown;
		} catch {
			throw new Error("compaction projection is malformed");
		}
		if (!isStoredProjection(parsed, this.#scope)) throw new Error("compaction projection failed scope or digest validation");
		return parsed;
	}

	public async loadState(): Promise<CompactionProjectionStoreState> {
		const stored = await this.#readStored();
		return stored === undefined
			? { revision: 0 }
			: {
				revision: stored.revision,
				projection: structuredClone(stored.projection),
				installation: structuredClone(stored.installation),
			};
	}

	public async load(): Promise<CompactedHistoryProjection | undefined> {
		return (await this.loadState()).projection;
	}

	public async install(request: CompactionProjectionInstallRequest): Promise<CompactionProjectionInstallationReceipt> {
		const projection = request.projection;
		if (!isProjection(projection) || projection.checkpoint.authorityId !== this.#scope.authorityId ||
			projection.checkpoint.tenantId !== this.#scope.tenantId ||
			projection.checkpoint.sessionId !== this.#scope.sessionId ||
			!Number.isSafeInteger(request.expectedProjectionRevision) || request.expectedProjectionRevision < 0 ||
			!isDigest(request.previousProjectionDigest)) {
			throw new Error("compaction projection install request is invalid or outside the store scope");
		}
		await ensurePrivateParent(this.#path);
		const lockTarget = `${this.#path}.install`;
		const lockHandle = await open(lockTarget, "a", 0o600);
		await lockHandle.close();
		const release = await lockfile.lock(lockTarget, {
			realpath: false,
			retries: { retries: 10, minTimeout: 10, maxTimeout: 100 },
		});
		try {
			const current = await this.#readStored();
			const actualRevision = current?.revision ?? 0;
			if (
				current !== undefined &&
				actualRevision === request.expectedProjectionRevision + 1 &&
				current.projection.projectionDigest === projection.projectionDigest &&
				current.projection.checkpoint.checkpointDigest === projection.checkpoint.checkpointDigest &&
				current.installation.previousProjectionDigest === request.previousProjectionDigest
			) return structuredClone(current.installation);
			if (actualRevision !== request.expectedProjectionRevision) {
				throw new CompactionProjectionRevisionConflictError(request.expectedProjectionRevision, actualRevision);
			}
			if (current !== undefined && current.projection.projectionDigest !== request.previousProjectionDigest) {
				throw new Error("compaction projection predecessor digest does not match the current live projection");
			}

			const installedProjectionRevision = actualRevision + 1;
			const installedAt = this.#clock().toISOString();
			const receiptBody = {
				schemaVersion: 1 as const,
				...this.#scope,
				receiptId: createRuntimeId("receipt", `compaction-install-${canonicalDigest({
					checkpointDigest: projection.checkpoint.checkpointDigest,
					installedProjectionRevision,
				}).slice(0, 48)}`),
				state: "live_projection_installed" as const,
				checkpointId: projection.checkpoint.checkpointId,
				checkpointDigest: projection.checkpoint.checkpointDigest,
				replacementHistoryArtifact: projection.checkpoint.replacementHistoryArtifact,
				replacementHistoryDigest: projection.checkpoint.replacementHistoryDigest,
				expectedProjectionRevision: request.expectedProjectionRevision,
				installedProjectionRevision,
				previousProjectionDigest: request.previousProjectionDigest,
				projectionDigest: projection.projectionDigest,
				installedAt,
			};
			const installation: CompactionProjectionInstallationReceipt = {
				...receiptBody,
				receiptDigest: canonicalDigest(receiptBody),
			};
			if (!isCompactionProjectionInstallationReceipt(installation)) {
				throw new Error("compaction projection installation receipt is invalid");
			}
			const body = {
				schemaVersion: 2 as const,
				...this.#scope,
				revision: installedProjectionRevision,
				projection: structuredClone(projection),
				installation,
			};
			const stored: StoredCompactionProjection = { ...body, storedDigest: envelopeDigest(body) };
			const content = `${JSON.stringify(stored)}\n`;
			if (Buffer.byteLength(content, "utf8") > MAX_PROJECTION_BYTES) throw new Error("compaction projection is oversized");
			const temporary = `${this.#path}.${canonicalDigest(stored).slice(0, 16)}.tmp`;
			let handle: Awaited<ReturnType<typeof open>> | undefined;
			try {
				await this.#onWritePhase?.("before_write", this.#path);
				handle = await open(temporary, "wx", 0o600);
				await handle.writeFile(content, "utf8");
				await handle.sync();
				await handle.close();
				handle = undefined;
				await this.#onWritePhase?.("before_rename", this.#path);
				await rename(temporary, this.#path);
				await this.#onWritePhase?.("after_rename", this.#path);
				const parent = await open(dirname(this.#path), "r");
				try {
					await parent.sync();
				} finally {
					await parent.close();
				}
			} catch (error) {
				if (handle) await handle.close().catch(() => undefined);
				await unlink(temporary).catch(() => undefined);
				throw error;
			}
			return installation;
		} finally {
			await release();
		}
	}
}
