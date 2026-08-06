/** Deterministic identity of the executable RunLedger distribution. */

import { createHash, randomUUID } from "node:crypto";
import { open, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson } from "../runtime/protocol/canonical-json.ts";
import { runtimeDigest, type RuntimeDigest } from "../runtime/protocol/foundation.ts";

export const HOST_BUILD_MANIFEST_FILE = "host-build-manifest.json";
export const HOST_BUILD_MANIFEST_FORMAT = "runledger-host-build-current" as const;

export function productionDistributionRoot(): string {
	return fileURLToPath(new URL("../../dist", import.meta.url));
}

export type HostBuildArtifactGroup = "cli_host" | "contract_security" | "catalog" | "native" | "runtime";

export interface HostBuildArtifact {
	readonly path: string;
	readonly size: number;
	readonly digest: RuntimeDigest;
	readonly group: HostBuildArtifactGroup;
}

export interface HostBuildManifest {
	readonly format: typeof HOST_BUILD_MANIFEST_FORMAT;
	readonly algorithm: "sha256";
	readonly packageVersion: string;
	readonly artifacts: readonly HostBuildArtifact[];
	readonly componentDigests: Readonly<Record<HostBuildArtifactGroup, RuntimeDigest>>;
	readonly contentDigest: RuntimeDigest;
}

export type HostBuildManifestVerification =
	| { readonly ok: true; readonly manifest: HostBuildManifest }
	| {
			readonly ok: false;
			readonly code: "invalid_manifest" | "artifact_set_mismatch" | "artifact_missing" | "artifact_digest_mismatch";
			readonly path?: string;
	  };

export async function createHostBuildManifest(root: string, packageVersion: string): Promise<HostBuildManifest> {
	const canonicalRoot = resolve(root);
	const paths = await executableArtifactPaths(canonicalRoot);
	const artifacts = await Promise.all(paths.map(async (path): Promise<HostBuildArtifact> => {
		const content = await readFile(join(canonicalRoot, ...path.split("/")));
		return {
			path,
			size: content.byteLength,
			digest: sha256(content),
			group: artifactGroup(path),
		};
	}));
	const groups: readonly HostBuildArtifactGroup[] = ["cli_host", "contract_security", "catalog", "native", "runtime"];
	const componentDigests = Object.fromEntries(groups.map((group) => [
		group,
		runtimeDigest(artifacts.filter((artifact) => artifact.group === group)),
	])) as Record<HostBuildArtifactGroup, RuntimeDigest>;
	const body = {
		format: HOST_BUILD_MANIFEST_FORMAT,
		algorithm: "sha256" as const,
		packageVersion,
		artifacts,
		componentDigests,
	};
	return { ...body, contentDigest: runtimeDigest(body) };
}

export async function verifyHostBuildManifest(root: string, manifest: HostBuildManifest): Promise<HostBuildManifestVerification> {
	if (!isHostBuildManifest(manifest)) return { ok: false, code: "invalid_manifest" };
	const { contentDigest: _ignored, ...body } = manifest;
	if (runtimeDigest(body).digest !== manifest.contentDigest.digest) return { ok: false, code: "invalid_manifest" };
	const currentPaths = await executableArtifactPaths(resolve(root));
	if (canonicalJson(currentPaths) !== canonicalJson(manifest.artifacts.map((artifact) => artifact.path))) {
		return { ok: false, code: "artifact_set_mismatch" };
	}
	for (const artifact of manifest.artifacts) {
		let content: Buffer;
		try {
			content = await readFile(join(resolve(root), ...artifact.path.split("/")));
		} catch {
			return { ok: false, code: "artifact_missing", path: artifact.path };
		}
		if (content.byteLength !== artifact.size || sha256(content).digest !== artifact.digest.digest) {
			return { ok: false, code: "artifact_digest_mismatch", path: artifact.path };
		}
	}
	return { ok: true, manifest };
}

export async function loadVerifiedHostBuildManifest(root: string): Promise<HostBuildManifest> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(await readFile(join(resolve(root), HOST_BUILD_MANIFEST_FILE), "utf8")) as unknown;
	} catch {
		throw new Error("host_build_manifest_unavailable");
	}
	if (!isHostBuildManifest(parsed)) throw new Error("host_build_manifest_invalid");
	const verified = await verifyHostBuildManifest(root, parsed);
	if (!verified.ok) throw new Error(`host_build_manifest_${verified.code}`);
	return verified.manifest;
}

export async function writeHostBuildManifest(root: string, packageVersion: string): Promise<HostBuildManifest> {
	const manifest = await createHostBuildManifest(root, packageVersion);
	const path = join(resolve(root), HOST_BUILD_MANIFEST_FILE);
	const staging = `${path}.${randomUUID()}.tmp`;
	try {
		await writeFile(staging, `${canonicalJson(manifest)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
		const handle = await open(staging, "r");
		try { await handle.sync(); } finally { await handle.close(); }
		await rename(staging, path);
	} finally {
		await unlink(staging).catch(() => undefined);
	}
	return manifest;
}

function sha256(content: Buffer): RuntimeDigest {
	return { algorithm: "sha256", digest: createHash("sha256").update(content).digest("hex") } as RuntimeDigest;
}

async function executableArtifactPaths(root: string): Promise<string[]> {
	const paths: string[] = [];
	const visit = async (directory: string): Promise<void> => {
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			const absolute = join(directory, entry.name);
			if (entry.isDirectory()) {
				await visit(absolute);
				continue;
			}
			if (!entry.isFile()) continue;
			const path = relative(root, absolute).split(sep).join("/");
			if (isExecutableArtifact(path)) paths.push(path);
		}
	};
	await visit(root);
	return paths.sort();
}

function isExecutableArtifact(path: string): boolean {
	if (path === HOST_BUILD_MANIFEST_FILE) return false;
	return path.endsWith(".js") || path.endsWith(".json") || path === "native/runledger-linux-peer-credential";
}

function artifactGroup(path: string): HostBuildArtifactGroup {
	if (path.startsWith("native/")) return "native";
	if (path.endsWith(".json")) return "catalog";
	if (path.startsWith("security/") || path.startsWith("runtime/contracts/") || path.startsWith("runtime/host/") ||
		path.startsWith("runtime/protocol/") || path === "cli/runtime-host-security.js") return "contract_security";
	if (path.startsWith("cli/")) return "cli_host";
	return "runtime";
}

function isHostBuildManifest(value: unknown): value is HostBuildManifest {
	if (!isRecord(value) || value.format !== HOST_BUILD_MANIFEST_FORMAT || value.algorithm !== "sha256" ||
		typeof value.packageVersion !== "string" || !Array.isArray(value.artifacts) || !isDigest(value.contentDigest) ||
		!isRecord(value.componentDigests)) return false;
	const componentDigests = value.componentDigests;
	const groups: readonly HostBuildArtifactGroup[] = ["cli_host", "contract_security", "catalog", "native", "runtime"];
	if (!groups.every((group) => isDigest(componentDigests[group]))) return false;
	let previous = "";
	for (const artifact of value.artifacts) {
		if (!isRecord(artifact) || typeof artifact.path !== "string" || artifact.path.length < 1 || artifact.path.includes("..") ||
			!Number.isSafeInteger(artifact.size) || (artifact.size as number) < 0 || !isDigest(artifact.digest) ||
			!groups.includes(artifact.group as HostBuildArtifactGroup) || artifact.path <= previous) return false;
		previous = artifact.path;
	}
	return true;
}

function isDigest(value: unknown): value is RuntimeDigest {
	return isRecord(value) && value.algorithm === "sha256" && typeof value.digest === "string" && /^[a-f0-9]{64}$/u.test(value.digest);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
