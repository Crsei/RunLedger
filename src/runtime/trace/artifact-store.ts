import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import * as path from "node:path";
import type { TraceArtifactRef } from "./types.ts";

export interface ArtifactMetadata extends TraceArtifactRef {
	readonly storedDigest: string;
	readonly sourceDigest?: string;
	readonly redactionPolicyDigest: string;
	readonly createdAt: string;
}

export interface ArtifactPutRequest {
	readonly bytes: Uint8Array;
	readonly mediaType: string;
	readonly redactionPolicyDigest: string;
	readonly sourceDigest?: string;
}

export class ArtifactIntegrityError extends Error {
	public readonly artifactId: string;

	public constructor(artifactId: string) {
		super(`artifact integrity check failed: ${artifactId}`);
		this.name = "ArtifactIntegrityError";
		this.artifactId = artifactId;
	}
}

export class FileArtifactStore {
	public readonly dataRoot: string;
	public readonly metadataRoot: string;

	public constructor(options: { readonly dataRoot: string; readonly metadataRoot: string }) {
		this.dataRoot = options.dataRoot;
		this.metadataRoot = options.metadataRoot;
	}

	public async put(input: ArtifactPutRequest): Promise<TraceArtifactRef> {
		const bytes = new Uint8Array(input.bytes);
		const digest = createHash("sha256").update(bytes).digest("hex");
		const artifactId = `artifact_${digest}`;
		const ref: TraceArtifactRef = {
			storage: "artifact",
			artifactId,
			digest,
			mediaType: input.mediaType,
			size: bytes.byteLength,
		};
		const dataDirectory = path.join(this.dataRoot, "sha256", digest.slice(0, 2));
		const metadataDirectory = path.join(this.metadataRoot, "sha256", digest.slice(0, 2));
		const dataPath = path.join(dataDirectory, digest);
		const metadataPath = path.join(metadataDirectory, `${digest}.json`);
		await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
		await mkdir(metadataDirectory, { recursive: true, mode: 0o700 });

		let present = true;
		try {
			await stat(dataPath);
		} catch (error) {
			if (!isNotFound(error)) throw error;
			present = false;
		}
		if (present) await this.read(ref);
		if (!present) {
			const temporaryPath = path.join(dataDirectory, `.tmp-${randomUUID()}`);
			try {
				await writeFile(temporaryPath, bytes, { mode: 0o600 });
				await rename(temporaryPath, dataPath);
			} finally {
				await rm(temporaryPath, { force: true });
			}
		}

		let metadataPresent = true;
		try {
			await stat(metadataPath);
		} catch (error) {
			if (!isNotFound(error)) throw error;
			metadataPresent = false;
		}
		if (!metadataPresent) {
			const metadata: ArtifactMetadata = {
				...ref,
				storedDigest: digest,
				...(input.sourceDigest === undefined ? {} : { sourceDigest: input.sourceDigest }),
				redactionPolicyDigest: input.redactionPolicyDigest,
				createdAt: new Date().toISOString(),
			};
			await writeFile(metadataPath, JSON.stringify(metadata), { encoding: "utf8", mode: 0o600 });
		} else {
			await this.metadata(ref);
		}
		return ref;
	}

	public async read(ref: TraceArtifactRef): Promise<Uint8Array> {
		assertValidRef(ref);
		const bytes = new Uint8Array(await readFile(this.dataPath(ref)));
		const digest = createHash("sha256").update(bytes).digest("hex");
		if (digest !== ref.digest || bytes.byteLength !== ref.size) throw new ArtifactIntegrityError(ref.artifactId);
		return bytes;
	}

	public async metadata(ref: TraceArtifactRef): Promise<ArtifactMetadata> {
		assertValidRef(ref);
		const value = JSON.parse(await readFile(this.metadataPath(ref), "utf8")) as Partial<ArtifactMetadata>;
		if (
			value.storage !== "artifact" ||
			value.artifactId !== ref.artifactId ||
			value.digest !== ref.digest ||
			value.storedDigest !== ref.digest ||
			value.size !== ref.size ||
			value.mediaType !== ref.mediaType ||
			typeof value.redactionPolicyDigest !== "string"
		) {
			throw new ArtifactIntegrityError(ref.artifactId);
		}
		return value as ArtifactMetadata;
	}

	private dataPath(ref: TraceArtifactRef): string {
		return path.join(this.dataRoot, "sha256", ref.digest.slice(0, 2), ref.digest);
	}

	private metadataPath(ref: TraceArtifactRef): string {
		return path.join(this.metadataRoot, "sha256", ref.digest.slice(0, 2), `${ref.digest}.json`);
	}
}

function assertValidRef(ref: TraceArtifactRef): void {
	if (
		ref.storage !== "artifact" ||
		typeof ref.artifactId !== "string" ||
		typeof ref.digest !== "string" ||
		typeof ref.mediaType !== "string" ||
		!/^artifact_[0-9a-f]{64}$/.test(ref.artifactId) ||
		!/^[0-9a-f]{64}$/.test(ref.digest) ||
		ref.artifactId !== `artifact_${ref.digest}` ||
		!Number.isSafeInteger(ref.size) ||
		ref.size < 0 ||
		ref.mediaType.length === 0
	) {
		throw new ArtifactIntegrityError(ref.artifactId);
	}
}

function isNotFound(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
