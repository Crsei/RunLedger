/** Artifact metadata 的独立持久化层；pending 与 committed 可见性分离。 */

import { open, mkdir, readFile, readdir, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { canonicalDigest, canonicalJson } from "../protocol/v3/canonical-json.ts";
import { isRuntimeId } from "../protocol/v3/ids.ts";
import { isArtifactLineage } from "./lineage.ts";
import type { ArtifactId, AuthorityId, CommandId, TenantId } from "../protocol/v3/ids.ts";
import {
	ARTIFACT_METADATA_SCHEMA_VERSION,
	type ArtifactError,
	type ArtifactMetadata,
	type ArtifactMetadataBody,
	type ArtifactResult,
} from "./types.ts";

export type MetadataWritePhase = "before_write" | "before_rename";

export interface ArtifactMetadataStoreOptions {
	rootDir: string;
	onWritePhase?: (phase: MetadataWritePhase, targetPath: string) => Promise<void> | void;
}

function failure(code: ArtifactError["code"], message: string, retryable = false): ArtifactResult<never> {
	return { ok: false, error: { code, message, retryable } };
}

function isDigest(value: unknown): value is string {
	return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function isTimestamp(value: unknown): value is string {
	return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function bodyOf(metadata: ArtifactMetadata): ArtifactMetadataBody {
	const { metadataDigest: _metadataDigest, ...body } = metadata;
	return body;
}

export function finalizeArtifactMetadata(body: ArtifactMetadataBody): ArtifactMetadata {
	return { ...body, metadataDigest: canonicalDigest(body) };
}

export function validateArtifactMetadata(value: unknown): value is ArtifactMetadata {
	if (!isRecord(value)) return false;
	if (
		value.schemaVersion !== ARTIFACT_METADATA_SCHEMA_VERSION ||
		!isRuntimeId(value.authorityId, "authority") ||
		!isRuntimeId(value.tenantId, "tenant") ||
		!isRuntimeId(value.artifactId, "artifact") ||
		!isRuntimeId(value.intentId, "command") ||
		(value.state !== "pending" && value.state !== "committed") ||
		!isDigest(value.storedDigest) ||
		!isDigest(value.metadataDigest) ||
		typeof value.mediaType !== "string" ||
		value.mediaType.length < 1 ||
		typeof value.originalSize !== "number" ||
		!Number.isSafeInteger(value.originalSize) ||
		value.originalSize < 0 ||
		typeof value.storedSize !== "number" ||
		!Number.isSafeInteger(value.storedSize) ||
		value.storedSize < 0 ||
		(value.compression !== "none" && value.compression !== "gzip") ||
		!isRecord(value.source) ||
		!isRuntimeId(value.source.sessionId, "session") ||
		(value.source.workspaceId !== undefined && !isRuntimeId(value.source.workspaceId, "workspace")) ||
		(!isRuntimeId(value.source.producerId, "agent") && !isRuntimeId(value.source.producerId, "principal")) ||
		!isRecord(value.lineage) ||
		!isArtifactLineage(value.lineage as unknown as ArtifactMetadata["lineage"], {
			authorityId: value.authorityId as unknown as AuthorityId,
			tenantId: value.tenantId as unknown as TenantId,
		}) ||
		!Array.isArray(value.references) ||
		!value.references.every((entry) => isRuntimeId(entry, "artifact")) ||
		!Array.isArray(value.pins) ||
		!value.pins.every((entry) => typeof entry === "string" && entry.length > 0 && entry.length <= 128) ||
		typeof value.referenceCount !== "number" ||
		!Number.isSafeInteger(value.referenceCount) ||
		value.referenceCount < 0 ||
		!isRecord(value.legalHold) ||
		(value.legalHold.status !== "none" && value.legalHold.status !== "active") ||
		!isTimestamp(value.createdAt) ||
		(value.expiresAt !== undefined && !isTimestamp(value.expiresAt)) ||
		(value.committedAt !== undefined && !isTimestamp(value.committedAt)) ||
		(value.state === "committed" && value.committedAt === undefined) ||
		(value.state === "pending" && value.committedAt !== undefined)
	) return false;
	try {
		return canonicalDigest(bodyOf(value as unknown as ArtifactMetadata)) === value.metadataDigest;
	} catch {
		return false;
	}
}

async function syncDirectory(path: string): Promise<void> {
	const directory = await open(path, "r");
	try {
		await directory.sync();
	} finally {
		await directory.close();
	}
}

export class ArtifactMetadataStore {
	readonly #rootDir: string;
	readonly #onWritePhase?: ArtifactMetadataStoreOptions["onWritePhase"];

	public constructor(options: ArtifactMetadataStoreOptions) {
		this.#rootDir = options.rootDir;
		this.#onWritePhase = options.onWritePhase;
	}

	#scopeDir(authorityId: AuthorityId, tenantId: TenantId): string {
		return join(this.#rootDir, "metadata", authorityId, tenantId);
	}

	#pendingPath(authorityId: AuthorityId, tenantId: TenantId, intentId: CommandId): string {
		return join(this.#scopeDir(authorityId, tenantId), "pending", `${intentId}.json`);
	}

	#committedPath(authorityId: AuthorityId, tenantId: TenantId, artifactId: ArtifactId): string {
		return join(this.#scopeDir(authorityId, tenantId), "committed", `${artifactId}.json`);
	}

	async #atomicWrite(targetPath: string, value: ArtifactMetadata): Promise<ArtifactResult<void>> {
		const parent = dirname(targetPath);
		const temporary = join(parent, `.${randomUUID()}.tmp`);
		let handle: Awaited<ReturnType<typeof open>> | undefined;
		try {
			await mkdir(parent, { recursive: true, mode: 0o700 });
			await this.#onWritePhase?.("before_write", targetPath);
			handle = await open(temporary, "wx", 0o600);
			await handle.writeFile(canonicalJson(value), "utf8");
			await handle.sync();
			await handle.close();
			handle = undefined;
			await this.#onWritePhase?.("before_rename", targetPath);
			await rename(temporary, targetPath);
			await syncDirectory(parent);
			return { ok: true, value: undefined };
		} catch (cause) {
			if (handle) await handle.close().catch(() => undefined);
			await rm(temporary, { force: true }).catch(() => undefined);
			return failure(
				"metadata_write_failed",
				cause instanceof Error ? cause.message : "artifact metadata write failed",
				true,
			);
		}
	}

	async #read(path: string): Promise<ArtifactResult<ArtifactMetadata>> {
		let content: string;
		try {
			content = await readFile(path, "utf8");
		} catch (cause) {
			const nodeError = cause as NodeJS.ErrnoException;
			if (nodeError.code === "ENOENT") return failure("not_found", "artifact metadata not found");
			return failure("corrupted_metadata", nodeError.message, true);
		}
		try {
			const value = JSON.parse(content) as unknown;
			if (!validateArtifactMetadata(value)) return failure("corrupted_metadata", "artifact metadata failed validation");
			return { ok: true, value };
		} catch (cause) {
			return failure("corrupted_metadata", cause instanceof Error ? cause.message : "invalid artifact metadata");
		}
	}

	public async stage(metadata: ArtifactMetadata): Promise<ArtifactResult<void>> {
		if (!validateArtifactMetadata(metadata) || metadata.state !== "pending") {
			return failure("invalid_request", "pending artifact metadata is invalid");
		}
		return this.#atomicWrite(
			this.#pendingPath(metadata.authorityId, metadata.tenantId, metadata.intentId),
			metadata,
		);
	}

	public readPending(authorityId: AuthorityId, tenantId: TenantId, intentId: CommandId): Promise<ArtifactResult<ArtifactMetadata>> {
		return this.#read(this.#pendingPath(authorityId, tenantId, intentId));
	}

	public readCommitted(authorityId: AuthorityId, tenantId: TenantId, artifactId: ArtifactId): Promise<ArtifactResult<ArtifactMetadata>> {
		return this.#read(this.#committedPath(authorityId, tenantId, artifactId));
	}

	public async commit(
		authorityId: AuthorityId,
		tenantId: TenantId,
		intentId: CommandId,
		committedAt: string,
	): Promise<ArtifactResult<ArtifactMetadata>> {
		const pending = await this.readPending(authorityId, tenantId, intentId);
		if (!pending.ok) return pending;
		if (!isTimestamp(committedAt)) return failure("invalid_request", "committedAt is invalid");
		const committed = finalizeArtifactMetadata({ ...bodyOf(pending.value), state: "committed", committedAt });
		const written = await this.#atomicWrite(
			this.#committedPath(authorityId, tenantId, committed.artifactId),
			committed,
		);
		if (!written.ok) return written;
		await rm(this.#pendingPath(authorityId, tenantId, intentId), { force: true }).catch(() => undefined);
		return { ok: true, value: committed };
	}

	public async updateCommitted(metadata: ArtifactMetadata): Promise<ArtifactResult<ArtifactMetadata>> {
		if (!validateArtifactMetadata(metadata) || metadata.state !== "committed") {
			return failure("invalid_request", "committed artifact metadata is invalid");
		}
		const updated = finalizeArtifactMetadata(bodyOf(metadata));
		const result = await this.#atomicWrite(
			this.#committedPath(metadata.authorityId, metadata.tenantId, metadata.artifactId),
			updated,
		);
		return result.ok ? { ok: true, value: updated } : result;
	}

	public async removePending(authorityId: AuthorityId, tenantId: TenantId, intentId: CommandId): Promise<ArtifactResult<void>> {
		try {
			await rm(this.#pendingPath(authorityId, tenantId, intentId), { force: true });
			return { ok: true, value: undefined };
		} catch (cause) {
			return failure("metadata_write_failed", cause instanceof Error ? cause.message : "pending metadata removal failed", true);
		}
	}

	public async removeCommitted(authorityId: AuthorityId, tenantId: TenantId, artifactId: ArtifactId): Promise<ArtifactResult<void>> {
		try {
			await rm(this.#committedPath(authorityId, tenantId, artifactId), { force: true });
			return { ok: true, value: undefined };
		} catch (cause) {
			return failure("metadata_write_failed", cause instanceof Error ? cause.message : "artifact metadata removal failed", true);
		}
	}

	async #listDirectory(directory: string): Promise<ArtifactResult<readonly ArtifactMetadata[]>> {
		let names: string[];
		try {
			names = await readdir(directory);
		} catch (cause) {
			const nodeError = cause as NodeJS.ErrnoException;
			if (nodeError.code === "ENOENT") return { ok: true, value: [] };
			return failure("corrupted_metadata", nodeError.message, true);
		}
		const entries: ArtifactMetadata[] = [];
		for (const name of names.sort()) {
			if (!name.endsWith(".json")) continue;
			const entry = await this.#read(join(directory, name));
			if (!entry.ok) return entry;
			entries.push(entry.value);
		}
		return { ok: true, value: entries };
	}

	public listPending(authorityId: AuthorityId, tenantId: TenantId): Promise<ArtifactResult<readonly ArtifactMetadata[]>> {
		return this.#listDirectory(join(this.#scopeDir(authorityId, tenantId), "pending"));
	}

	public listCommitted(authorityId: AuthorityId, tenantId: TenantId): Promise<ArtifactResult<readonly ArtifactMetadata[]>> {
		return this.#listDirectory(join(this.#scopeDir(authorityId, tenantId), "committed"));
	}
}
