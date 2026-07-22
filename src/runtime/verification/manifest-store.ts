/** Episode Manifest body 的独立原子存储；不写 session event，避免 head/digest 自引用。 */

import { randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { canonicalDigest, canonicalJson } from "../protocol/v3/canonical-json.ts";
import type { ArtifactRef } from "../protocol/v3/capability.ts";
import { createRuntimeId, isRuntimeId } from "../protocol/v3/ids.ts";
import { isEpisodeManifest } from "../artifacts/episode-manifest.ts";
import type { EpisodeManifest, EpisodeManifestBody } from "../artifacts/types.ts";
import type { EpisodeManifestStorePort } from "./report.ts";
import type { VerificationCoreResult } from "./types.ts";

export const EPISODE_MANIFEST_BODY_MEDIA_TYPE = "application/vnd.runledger.episode-manifest-body+json";

export type EpisodeManifestStorePhase = "before_link" | "after_link";

export interface FileEpisodeManifestStoreOptions {
	rootDir: string;
	onPhase?: (phase: EpisodeManifestStorePhase, targetPath: string) => Promise<void> | void;
}

function failure<T>(
	code: "invalid_schema" | "invalid_digest" | "scope_mismatch" | "lifecycle_paused",
	message: string,
	retryable = false,
): VerificationCoreResult<T> {
	return { ok: false, error: { code, message, retryable } };
}

function manifestBody(manifest: EpisodeManifest): EpisodeManifestBody {
	const { manifestDigest: _manifestDigest, ...body } = manifest;
	return body;
}

async function syncDirectory(path: string): Promise<void> {
	const handle = await open(path, "r");
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}

export class FileEpisodeManifestStore implements EpisodeManifestStorePort {
	readonly #rootDir: string;
	readonly #onPhase: FileEpisodeManifestStoreOptions["onPhase"];

	public constructor(options: FileEpisodeManifestStoreOptions) {
		this.#rootDir = resolve(options.rootDir);
		this.#onPhase = options.onPhase;
	}

	#target(manifest: Pick<EpisodeManifest, "authorityId" | "tenantId" | "manifestDigest">): string {
		return join(this.#rootDir, "episode-manifests", manifest.authorityId, manifest.tenantId, `${manifest.manifestDigest}.json`);
	}

	#reference(manifest: EpisodeManifest, byteLength: number): ArtifactRef {
		return {
			authorityId: manifest.authorityId,
			tenantId: manifest.tenantId,
			artifactId: createRuntimeId("artifact", `episode-manifest-${manifest.manifestDigest.slice(0, 48)}`),
			storedDigest: manifest.manifestDigest,
			kind: "episode_manifest",
			originalSize: byteLength,
			storedSize: byteLength,
			mediaType: EPISODE_MANIFEST_BODY_MEDIA_TYPE,
			redaction: "metadata_only",
			transformReceipt: createRuntimeId("receipt", `episode-manifest-${manifest.manifestDigest.slice(0, 48)}`),
			workspaceId: manifest.workspace.workspaceId,
		};
	}

	async #read(reference: ArtifactRef): Promise<VerificationCoreResult<EpisodeManifest>> {
		if (
			!isRuntimeId(reference.authorityId, "authority") ||
			!isRuntimeId(reference.tenantId, "tenant") ||
			!isRuntimeId(reference.artifactId, "artifact") ||
			!isRuntimeId(reference.transformReceipt, "receipt") ||
			!isRuntimeId(reference.workspaceId, "workspace") ||
			reference.kind !== "episode_manifest" ||
			reference.mediaType !== EPISODE_MANIFEST_BODY_MEDIA_TYPE ||
			reference.redaction !== "metadata_only" ||
			!/^[a-f0-9]{64}$/.test(reference.storedDigest)
		) return failure("invalid_schema", "Episode Manifest Artifact reference is invalid");
		let text: string;
		try {
			text = await readFile(this.#target({
				authorityId: reference.authorityId,
				tenantId: reference.tenantId,
				manifestDigest: reference.storedDigest,
			}), "utf8");
		} catch (cause) {
			const code = (cause as NodeJS.ErrnoException).code;
			return failure("lifecycle_paused", code === "ENOENT" ? "Episode Manifest body is missing" : "Episode Manifest store is unavailable", code !== "ENOENT");
		}
		let body: unknown;
		try {
			body = JSON.parse(text) as unknown;
		} catch {
			return failure("invalid_schema", "Episode Manifest body is not JSON");
		}
		if (canonicalJson(body) !== text || canonicalDigest(body) !== reference.storedDigest) {
			return failure("invalid_digest", "Episode Manifest body is not canonical or its digest changed");
		}
		if (typeof body !== "object" || body === null) return failure("invalid_schema", "Episode Manifest body is invalid");
		const manifest = { ...(body as EpisodeManifestBody), manifestDigest: reference.storedDigest };
		if (
			!isEpisodeManifest(manifest) ||
			manifest.authorityId !== reference.authorityId ||
			manifest.tenantId !== reference.tenantId ||
			manifest.workspace.workspaceId !== reference.workspaceId ||
			Buffer.byteLength(text, "utf8") !== reference.storedSize ||
			reference.originalSize !== reference.storedSize ||
			reference.artifactId !== createRuntimeId("artifact", `episode-manifest-${reference.storedDigest.slice(0, 48)}`) ||
			reference.transformReceipt !== createRuntimeId("receipt", `episode-manifest-${reference.storedDigest.slice(0, 48)}`)
		) return failure("scope_mismatch", "Episode Manifest body does not match its Artifact reference");
		return { ok: true, value: manifest };
	}

	public async commit(manifest: EpisodeManifest): Promise<VerificationCoreResult<ArtifactRef>> {
		if (!isEpisodeManifest(manifest)) return failure("invalid_schema", "Episode Manifest is invalid");
		const body = manifestBody(manifest);
		const text = canonicalJson(body);
		if (canonicalDigest(body) !== manifest.manifestDigest) return failure("invalid_digest", "Episode Manifest body digest changed");
		const reference = this.#reference(manifest, Buffer.byteLength(text, "utf8"));
		const target = this.#target(manifest);
		const parent = dirname(target);
		const temporary = join(parent, `.${randomUUID()}.partial`);
		try {
			await mkdir(parent, { recursive: true, mode: 0o700 });
			const existing = await this.#read(reference);
			if (existing.ok) return { ok: true, value: reference };
			if (existing.error.code !== "lifecycle_paused" || existing.error.retryable) return existing;
			const handle = await open(temporary, "wx", 0o600);
			try {
				await handle.writeFile(text, "utf8");
				await handle.sync();
			} finally {
				await handle.close();
			}
			await this.#onPhase?.("before_link", target);
			try {
				await link(temporary, target);
			} catch (cause) {
				if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
				const raced = await this.#read(reference);
				if (!raced.ok) return raced;
			}
			await syncDirectory(parent);
			await this.#onPhase?.("after_link", target);
			return { ok: true, value: reference };
		} catch {
			const recovered = await this.#read(reference);
			return recovered.ok
				? failure("lifecycle_paused", "Episode Manifest body is durable but acknowledgement is uncertain", false)
				: failure("lifecycle_paused", "Episode Manifest body commit failed", true);
		} finally {
			await rm(temporary, { force: true }).catch(() => undefined);
		}
	}

	public resolve(reference: ArtifactRef): Promise<VerificationCoreResult<EpisodeManifest>> {
		return this.#read(reference);
	}
}
