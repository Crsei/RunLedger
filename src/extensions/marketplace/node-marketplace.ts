/** Node production marketplace：policy network、Ed25519、受限 tgz 与内容寻址 store。 */

import { createHash, createPublicKey, randomUUID, verify as verifySignature } from "node:crypto";
import { constants } from "node:fs";
import {
	chmod,
	cp,
	lstat,
	mkdir,
	mkdtemp,
	open,
	readFile,
	readdir,
	rename,
	rm,
	stat,
} from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { canonicalDigest } from "../../runtime/protocol/v3/canonical-json.ts";
import { parsePluginManifest } from "../plugins/manifest.ts";
import type {
	MarketplaceActivationReceipt,
	MarketplaceDownloadPort,
	MarketplaceDownloadReceipt,
	MarketplaceLocator,
	MarketplaceNetworkPort,
	MarketplaceProbePort,
	MarketplaceProbeReceipt,
	MarketplaceSignaturePort,
	MarketplaceVerificationReceipt,
	PluginVersionStorePort,
	PublisherTrustEntry,
	PublisherTrustPort,
} from "./types.ts";

const PRIVATE_FILE_MODE = 0o600;
const PRIVATE_DIRECTORY_MODE = 0o700;

function sha256(bytes: Uint8Array | string): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function contained(root: string, candidate: string): boolean {
	const value = relative(resolve(root), resolve(candidate));
	return value === "" || (value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value));
}

function plainRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? value as Record<string, unknown>
		: undefined;
}

export function parseMarketplaceLocator(value: unknown): MarketplaceLocator | undefined {
	const raw = plainRecord(value);
	if (!raw || Object.keys(raw).some((key) => ![
		"schemaVersion",
		"packageName",
		"version",
		"publisherId",
		"sourceUrl",
		"format",
		"expectedDigest",
		"signature",
	].includes(key))) return undefined;
	const signature = plainRecord(raw.signature);
	if (
		raw.schemaVersion !== 1 ||
		typeof raw.packageName !== "string" ||
		typeof raw.version !== "string" ||
		typeof raw.publisherId !== "string" ||
		typeof raw.sourceUrl !== "string" ||
		raw.format !== "tgz" ||
		typeof raw.expectedDigest !== "string" ||
		!signature ||
		Object.keys(signature).some((key) => key !== "algorithm" && key !== "value") ||
		signature.algorithm !== "Ed25519" ||
		typeof signature.value !== "string"
	) return undefined;
	return {
		schemaVersion: 1,
		packageName: raw.packageName,
		version: raw.version,
		publisherId: raw.publisherId,
		sourceUrl: raw.sourceUrl,
		format: "tgz",
		expectedDigest: raw.expectedDigest,
		signature: { algorithm: "Ed25519", value: signature.value },
	};
}

async function writePrivateJson(path: string, value: unknown): Promise<void> {
	const directory = dirname(path);
	await mkdir(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
	await chmod(directory, PRIVATE_DIRECTORY_MODE);
	const temporary = join(directory, `.${basename(path)}.${randomUUID()}.tmp`);
	let handle: Awaited<ReturnType<typeof open>> | undefined;
	try {
		handle = await open(
			temporary,
			constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
			PRIVATE_FILE_MODE,
		);
		await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
		await handle.sync();
		await handle.close();
		handle = undefined;
		await rename(temporary, path);
		await chmod(path, PRIVATE_FILE_MODE);
		const directoryHandle = await open(directory, constants.O_RDONLY);
		await directoryHandle.sync().catch(() => undefined);
		await directoryHandle.close();
	} finally {
		await handle?.close().catch(() => undefined);
		await rm(temporary, { force: true }).catch(() => undefined);
	}
}

interface PublisherTrustDocument {
	schemaVersion: 1;
	revision: number;
	publishers: Readonly<Record<string, PublisherTrustEntry>>;
}

export class NodePublisherTrustStore implements PublisherTrustPort {
	readonly #path: string;

	public constructor(path: string) {
		this.#path = resolve(path);
	}

	async #load(): Promise<PublisherTrustDocument> {
		try {
			const bytes = await readFile(this.#path);
			if (bytes.byteLength > 1024 * 1024) throw new Error("publisher trust file exceeds bound");
			const raw = plainRecord(JSON.parse(bytes.toString("utf8")));
			const publishers = plainRecord(raw?.publishers);
			if (raw?.schemaVersion !== 1 || !Number.isSafeInteger(raw.revision) || !publishers) throw new Error("invalid publisher trust document");
			const parsed: Record<string, PublisherTrustEntry> = {};
			for (const [publisherId, value] of Object.entries(publishers)) {
				const entry = plainRecord(value);
				if (
					!entry ||
					entry.publisherId !== publisherId ||
					typeof entry.publicKeyPem !== "string" ||
					!Number.isSafeInteger(entry.revision) ||
					typeof entry.trustedAt !== "string" ||
					(entry.revokedAt !== undefined && typeof entry.revokedAt !== "string")
				) throw new Error("invalid publisher trust entry");
				parsed[publisherId] = entry as unknown as PublisherTrustEntry;
			}
			return { schemaVersion: 1, revision: Number(raw.revision), publishers: parsed };
		} catch (error) {
			const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
			if (code === "ENOENT") return { schemaVersion: 1, revision: 0, publishers: {} };
			throw error;
		}
	}

	public async resolve(publisherId: string): Promise<PublisherTrustEntry | undefined> {
		return (await this.#load()).publishers[publisherId];
	}

	public async trust(input: { publisherId: string; publicKeyPem: string; at?: Date }): Promise<PublisherTrustEntry> {
		createPublicKey(input.publicKeyPem);
		const current = await this.#load();
		const entry: PublisherTrustEntry = {
			publisherId: input.publisherId,
			publicKeyPem: input.publicKeyPem,
			revision: current.revision + 1,
			trustedAt: (input.at ?? new Date()).toISOString(),
		};
		await writePrivateJson(this.#path, {
			schemaVersion: 1,
			revision: current.revision + 1,
			publishers: { ...current.publishers, [input.publisherId]: entry },
		});
		return entry;
	}

	public async revoke(publisherId: string, at = new Date()): Promise<PublisherTrustEntry | undefined> {
		const current = await this.#load();
		const existing = current.publishers[publisherId];
		if (!existing) return undefined;
		const revoked: PublisherTrustEntry = {
			...existing,
			revision: current.revision + 1,
			revokedAt: at.toISOString(),
		};
		await writePrivateJson(this.#path, {
			schemaVersion: 1,
			revision: current.revision + 1,
			publishers: { ...current.publishers, [publisherId]: revoked },
		});
		return revoked;
	}
}

export class Ed25519MarketplaceSignatureVerifier implements MarketplaceSignaturePort {
	readonly #publishers: PublisherTrustPort;

	public constructor(publishers: PublisherTrustPort) {
		this.#publishers = publishers;
	}

	public async verify(
		locator: MarketplaceLocator,
		download: MarketplaceDownloadReceipt,
	): Promise<MarketplaceVerificationReceipt> {
		const publisher = await this.#publishers.resolve(locator.publisherId);
		let signatureValid = false;
		if (publisher && !publisher.revokedAt && download.digest === locator.expectedDigest) {
			try {
				signatureValid = verifySignature(
					null,
					Buffer.from(locator.expectedDigest, "hex"),
					createPublicKey(publisher.publicKeyPem),
					Buffer.from(locator.signature.value, "base64"),
				);
			} catch {
				signatureValid = false;
			}
		}
		const publisherRevision = publisher?.revision ?? 0;
		return {
			signatureValid,
			publisherTrusted: Boolean(publisher && !publisher.revokedAt),
			publisherRevision,
			verificationReceiptId: `marketplace-verification:${canonicalDigest({
				publisherId: locator.publisherId,
				publisherRevision,
				digest: download.digest,
				signatureValid,
			})}`,
		};
	}
}

interface TarEntry {
	path: string;
	kind: "file" | "directory";
	bytes: Uint8Array;
}

function tarString(bytes: Uint8Array, offset: number, length: number): string {
	const field = Buffer.from(bytes.subarray(offset, offset + length)).toString("utf8");
	return field.split("\0", 1)[0]?.trim() ?? "";
}

function tarOctal(bytes: Uint8Array, offset: number, length: number): number {
	const value = tarString(bytes, offset, length).replace(/\s/gu, "");
	if (!/^[0-7]+$/u.test(value)) return 0;
	return Number.parseInt(value, 8);
}

function safeArchivePath(value: string): string | undefined {
	if (!value || value.includes("\\") || value.includes("\0") || value.startsWith("/")) return undefined;
	const normalized = posix.normalize(value).replace(/\/+$/u, "");
	if (!normalized || normalized === "." || normalized === ".." || normalized.startsWith("../")) return undefined;
	return normalized.split("/").some((part) => part === "" || part === "." || part === "..")
		? undefined
		: normalized;
}

function parseTgz(bytes: Uint8Array, limits: { maxFiles: number; maxBytes: number }): TarEntry[] {
	const maxOutputLength = limits.maxBytes + (limits.maxFiles + 4) * 1_024;
	const tar = gunzipSync(bytes, { maxOutputLength });
	const entries: TarEntry[] = [];
	const seen = new Set<string>();
	let offset = 0;
	let totalBytes = 0;
	while (offset + 512 <= tar.byteLength) {
		const header = tar.subarray(offset, offset + 512);
		if (header.every((value) => value === 0)) break;
		const storedChecksum = tarOctal(header, 148, 8);
		let checksum = 0;
		for (let index = 0; index < header.byteLength; index += 1) {
			checksum += index >= 148 && index < 156 ? 32 : header[index] ?? 0;
		}
		if (storedChecksum !== checksum) throw new Error("marketplace tar checksum mismatch");
		const name = tarString(header, 0, 100);
		const prefix = tarString(header, 345, 155);
		const path = safeArchivePath(prefix ? `${prefix}/${name}` : name);
		if (!path || seen.has(path)) throw new Error("marketplace tar path is unsafe or duplicated");
		seen.add(path);
		const size = tarOctal(header, 124, 12);
		const type = String.fromCharCode(header[156] ?? 0);
		if (type !== "\0" && type !== "0" && type !== "5") {
			throw new Error("marketplace tar contains a link, device, or unsupported entry");
		}
		if (!Number.isSafeInteger(size) || size < 0 || offset + 512 + size > tar.byteLength) {
			throw new Error("marketplace tar entry size is invalid");
		}
		if (entries.length + 1 > limits.maxFiles) throw new Error("marketplace tar file count exceeds bound");
		if (type === "5" && size !== 0) throw new Error("marketplace tar directory carries unexpected data");
		totalBytes += size;
		if (totalBytes > limits.maxBytes) throw new Error("marketplace tar expanded bytes exceed bound");
		entries.push({
			path,
			kind: type === "5" ? "directory" : "file",
			bytes: type === "5" ? new Uint8Array() : tar.subarray(offset + 512, offset + 512 + size),
		});
		offset += 512 + Math.ceil(size / 512) * 512;
	}
	return entries.sort((left, right) =>
		(left.kind === right.kind ? 0 : left.kind === "directory" ? -1 : 1) ||
		left.path.localeCompare(right.path)
	);
}

async function extractEntries(root: string, entries: readonly TarEntry[]): Promise<void> {
	await mkdir(root, { recursive: false, mode: PRIVATE_DIRECTORY_MODE });
	for (const entry of entries) {
		const target = resolve(root, entry.path);
		if (!contained(root, target)) throw new Error("marketplace extraction escaped staging root");
		if (entry.kind === "directory") {
			await mkdir(target, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
			await chmod(target, PRIVATE_DIRECTORY_MODE);
			continue;
		}
		await mkdir(dirname(target), { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
		let handle: Awaited<ReturnType<typeof open>> | undefined;
		try {
			handle = await open(
				target,
				constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
				PRIVATE_FILE_MODE,
			);
			await handle.writeFile(entry.bytes);
			await handle.sync();
		} finally {
			await handle?.close().catch(() => undefined);
		}
	}
}

export class NodeMarketplacePackagePipeline implements MarketplaceDownloadPort, MarketplaceProbePort {
	readonly #network: MarketplaceNetworkPort;
	readonly #stagingRoot: string;

	public constructor(options: { network: MarketplaceNetworkPort; stagingRoot: string }) {
		this.#network = options.network;
		this.#stagingRoot = resolve(options.stagingRoot);
	}

	public async downloadToStaging(
		locator: MarketplaceLocator,
		options: { maxBytes: number; requireHttps: true },
		signal?: AbortSignal,
	): Promise<MarketplaceDownloadReceipt> {
		const source = new URL(locator.sourceUrl);
		if (options.requireHttps && source.protocol !== "https:") throw new Error("marketplace source must use HTTPS");
		const network = await this.#network.download({
			url: locator.sourceUrl,
			maxBytes: options.maxBytes,
			allowedHost: source.hostname,
			maxRedirects: 3,
		}, signal);
		if (network.body.byteLength > options.maxBytes) throw new Error("marketplace package exceeds download bound");
		if (network.redirectChain.length > 3) throw new Error("marketplace redirect count exceeds bound");
		for (const value of [...network.redirectChain, network.finalUrl]) {
			const url = new URL(value);
			if (url.protocol !== "https:" || url.hostname !== source.hostname) throw new Error("marketplace redirect escaped pinned HTTPS host");
		}
		const digest = sha256(network.body);
		if (digest !== locator.expectedDigest) throw new Error("marketplace package digest mismatch");
		await mkdir(this.#stagingRoot, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
		await chmod(this.#stagingRoot, PRIVATE_DIRECTORY_MODE);
		const packageRoot = await mkdtemp(join(this.#stagingRoot, "package-"));
		await chmod(packageRoot, PRIVATE_DIRECTORY_MODE);
		const archivePath = join(packageRoot, "package.tgz");
		let archive: Awaited<ReturnType<typeof open>> | undefined;
		try {
			archive = await open(archivePath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, PRIVATE_FILE_MODE);
			await archive.writeFile(network.body);
			await archive.sync();
		} finally {
			await archive?.close().catch(() => undefined);
		}
		const contentRoot = join(packageRoot, "content");
		try {
			const entries = parseTgz(network.body, { maxFiles: 512, maxBytes: options.maxBytes });
			await extractEntries(contentRoot, entries);
		} catch (error) {
			await rm(packageRoot, { recursive: true, force: true });
			throw error;
		}
		return {
			stagedRoot: contentRoot,
			bytes: network.body.byteLength,
			digest,
			sourceUrl: locator.sourceUrl,
			downloadReceiptId: network.networkReceiptId,
		};
	}

	public async cleanupStaging(stagedRoot: string): Promise<void> {
		const packageRoot = dirname(resolve(stagedRoot));
		const relativePackage = relative(this.#stagingRoot, packageRoot);
		if (
			!contained(this.#stagingRoot, packageRoot) ||
			!relativePackage ||
			relativePackage.includes(sep) ||
			!basename(packageRoot).startsWith("package-")
		) {
			throw new Error("marketplace staging cleanup target is invalid");
		}
		await rm(packageRoot, { recursive: true, force: true });
	}

	public async probe(
		stagedRoot: string,
		options: { maxFiles: number; maxBytes: number; sandboxProfile: "strict" },
	): Promise<MarketplaceProbeReceipt> {
		if (options.sandboxProfile !== "strict" || !contained(this.#stagingRoot, stagedRoot)) throw new Error("marketplace probe staging root is invalid");
		let files = 0;
		let totalBytes = 0;
		let containsScripts = false;
		const walk = async (directory: string, depth: number): Promise<void> => {
			if (depth > 8) throw new Error("marketplace probe depth exceeds bound");
			for (const entry of (await readdir(directory, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
				if (entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory())) throw new Error("marketplace probe found a non-regular entry");
				const path = join(directory, entry.name);
				const info = await lstat(path);
				if (entry.isDirectory()) {
					if (entry.name === "scripts") containsScripts = true;
					await walk(path, depth + 1);
					continue;
				}
				files += 1;
				totalBytes += info.size;
				if (files > options.maxFiles || totalBytes > options.maxBytes) throw new Error("marketplace probe budget exceeded");
			}
		};
		await walk(stagedRoot, 0);
		const manifestPath = join(stagedRoot, ".runledger-plugin", "plugin.json");
		const manifestBytes = await readFile(manifestPath);
		if (manifestBytes.byteLength > 1024 * 1024) throw new Error("marketplace manifest exceeds bound");
		const parsed = parsePluginManifest(manifestBytes, manifestPath);
		if (!parsed.ok) {
			return {
				ok: false,
				manifestDigest: sha256(manifestBytes),
				capabilityDigest: canonicalDigest(parsed.diagnostics),
				containsExecutableResources: true,
				fileCount: files,
				totalBytes,
				probeReceiptId: `marketplace-probe:${canonicalDigest(parsed.diagnostics)}`,
			};
		}
		const containsExecutableResources = containsScripts || parsed.manifest.hooks.length > 0 || Boolean(parsed.manifest.mcpServers);
		const manifestDigest = sha256(manifestBytes);
		const capabilityDigest = canonicalDigest({
			skills: parsed.manifest.skills,
			hooks: parsed.manifest.hooks,
			mcpServers: parsed.manifest.mcpServers ?? null,
			containsExecutableResources,
		});
		return {
			ok: true,
			manifestDigest,
			capabilityDigest,
			containsExecutableResources,
			packageName: parsed.manifest.name,
			version: parsed.manifest.version,
			fileCount: files,
			totalBytes,
			probeReceiptId: `marketplace-probe:${canonicalDigest({ manifestDigest, capabilityDigest, files, totalBytes })}`,
		};
	}
}

interface InstalledVersion {
	version: string;
	digest: string;
	locator: MarketplaceLocator;
	publisherRevision: number;
	manifestDigest: string;
	capabilityDigest: string;
	verifiedAt: string;
}

interface InstalledPackage {
	activeVersion?: string;
	versions: readonly InstalledVersion[];
}

interface ActivePluginIndex {
	schemaVersion: 1;
	revision: number;
	packages: Readonly<Record<string, InstalledPackage>>;
	unknown?: Readonly<Record<string, unknown>>;
}

export interface ActivePluginRoot {
	packageName: string;
	version: string;
	digest: string;
	rootPath: string;
	locator: MarketplaceLocator;
}

export class NodePluginVersionStore implements PluginVersionStorePort {
	readonly #storeRoot: string;
	readonly #stagingRoot: string;
	readonly #cacheRoot: string;
	readonly #indexPath: string;

	public constructor(options: { storeRoot: string; stagingRoot: string; cacheRoot: string; indexPath: string }) {
		this.#storeRoot = resolve(options.storeRoot);
		this.#stagingRoot = resolve(options.stagingRoot);
		this.#cacheRoot = resolve(options.cacheRoot);
		this.#indexPath = resolve(options.indexPath);
	}

	async #load(): Promise<ActivePluginIndex> {
		try {
			const bytes = await readFile(this.#indexPath);
			if (bytes.byteLength > 4 * 1024 * 1024) throw new Error("active plugin index exceeds bound");
			const raw = plainRecord(JSON.parse(bytes.toString("utf8")));
			const packages = plainRecord(raw?.packages);
			if (raw?.schemaVersion !== 1 || !Number.isSafeInteger(raw.revision) || !packages) throw new Error("active plugin index is invalid");
			const { schemaVersion: _schemaVersion, revision: _revision, packages: _packages, ...unknown } = raw;
			return {
				schemaVersion: 1,
				revision: Number(raw.revision),
				packages: packages as unknown as Readonly<Record<string, InstalledPackage>>,
				unknown,
			};
		} catch (error) {
			const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
			if (code === "ENOENT") return { schemaVersion: 1, revision: 0, packages: {} };
			throw error;
		}
	}

	async #save(document: ActivePluginIndex): Promise<void> {
		await writePrivateJson(this.#indexPath, {
			...(document.unknown ?? {}),
			schemaVersion: 1,
			revision: document.revision,
			packages: document.packages,
		});
	}

	public async stageVerified(input: {
		locator: MarketplaceLocator;
		download: MarketplaceDownloadReceipt;
		verification: MarketplaceVerificationReceipt;
		probe: MarketplaceProbeReceipt;
	}): Promise<string> {
		if (
			!input.verification.signatureValid ||
			!input.verification.publisherTrusted ||
			!input.probe.ok ||
			input.download.digest !== input.locator.expectedDigest ||
			!contained(this.#stagingRoot, input.download.stagedRoot)
		) throw new Error("marketplace verified staging receipt is inconsistent");
		await mkdir(this.#storeRoot, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
		await mkdir(this.#cacheRoot, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
		await chmod(this.#storeRoot, PRIVATE_DIRECTORY_MODE);
		await chmod(this.#cacheRoot, PRIVATE_DIRECTORY_MODE);
		const target = join(this.#storeRoot, input.locator.expectedDigest);
		try {
			const existing = await lstat(target);
			if (!existing.isDirectory()) throw new Error("content-addressed plugin target is not a directory");
		} catch (error) {
			const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
			if (code !== "ENOENT") throw error;
			await cp(input.download.stagedRoot, target, { recursive: true, force: false, errorOnExist: true });
		}
		const archivePath = join(dirname(input.download.stagedRoot), "package.tgz");
		await cp(archivePath, join(this.#cacheRoot, `${input.locator.expectedDigest}.tgz`), { force: false, errorOnExist: true }).catch(async (error) => {
			const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
			if (code !== "EEXIST") throw error;
		});
		const current = await this.#load();
		const existing = current.packages[input.locator.packageName] ?? { versions: [] };
		const version: InstalledVersion = {
			version: input.locator.version,
			digest: input.locator.expectedDigest,
			locator: input.locator,
			publisherRevision: input.verification.publisherRevision,
			manifestDigest: input.probe.manifestDigest,
			capabilityDigest: input.probe.capabilityDigest,
			verifiedAt: new Date().toISOString(),
		};
		await this.#save({
			...current,
			revision: current.revision + 1,
			packages: {
				...current.packages,
				[input.locator.packageName]: {
					...existing,
					versions: [...existing.versions.filter((item) => item.version !== version.version), version],
				},
			},
		});
		await rm(dirname(input.download.stagedRoot), { recursive: true, force: true });
		return target;
	}

	public async activate(packageName: string, version: string, digest: string): Promise<MarketplaceActivationReceipt> {
		const current = await this.#load();
		const installed = current.packages[packageName];
		const selected = installed?.versions.find((item) => item.version === version && item.digest === digest);
		if (!installed || !selected) throw new Error("plugin version is not verified");
		const previousVersion = installed.activeVersion;
		await this.#save({
			...current,
			revision: current.revision + 1,
			packages: { ...current.packages, [packageName]: { ...installed, activeVersion: version } },
		});
		return {
			packageName,
			version,
			digest,
			...(previousVersion ? { previousVersion } : {}),
			activationReceiptId: `marketplace-activation:${canonicalDigest({ packageName, version, digest, revision: current.revision + 1 })}`,
		};
	}

	public async active(packageName: string): Promise<MarketplaceActivationReceipt | undefined> {
		const current = await this.#load();
		const installed = current.packages[packageName];
		const selected = installed?.versions.find((item) => item.version === installed.activeVersion);
		return selected ? {
			packageName,
			version: selected.version,
			digest: selected.digest,
			activationReceiptId: `marketplace-active:${canonicalDigest(selected)}`,
		} : undefined;
	}

	public async uninstall(packageName: string, expectedVersion: string): Promise<boolean> {
		const current = await this.#load();
		const installed = current.packages[packageName];
		if (!installed || installed.activeVersion !== expectedVersion) return false;
		const { activeVersion: _activeVersion, ...inactive } = installed;
		await this.#save({
			...current,
			revision: current.revision + 1,
			packages: { ...current.packages, [packageName]: inactive },
		});
		return true;
	}

	public async rollback(packageName: string, expectedCurrentVersion: string): Promise<MarketplaceActivationReceipt | undefined> {
		const current = await this.#load();
		const installed = current.packages[packageName];
		if (!installed || installed.activeVersion !== expectedCurrentVersion) return undefined;
		const selected = [...installed.versions].reverse().find((item) => item.version !== expectedCurrentVersion);
		if (!selected) return undefined;
		await this.#save({
			...current,
			revision: current.revision + 1,
			packages: { ...current.packages, [packageName]: { ...installed, activeVersion: selected.version } },
		});
		return {
			packageName,
			version: selected.version,
			digest: selected.digest,
			previousVersion: expectedCurrentVersion,
			activationReceiptId: `marketplace-rollback:${canonicalDigest({ packageName, selected, revision: current.revision + 1 })}`,
		};
	}

	public async activeRoots(verifier: MarketplaceSignaturePort): Promise<readonly ActivePluginRoot[]> {
		const current = await this.#load();
		const roots: ActivePluginRoot[] = [];
		for (const [packageName, installed] of Object.entries(current.packages).sort(([left], [right]) => left.localeCompare(right))) {
			const selected = installed.versions.find((item) => item.version === installed.activeVersion);
			if (!selected) continue;
			const cachedArchive = await readFile(
				join(this.#cacheRoot, `${selected.digest}.tgz`),
			).catch(() => undefined);
			if (!cachedArchive || cachedArchive.byteLength > 8 * 1024 * 1024 || sha256(cachedArchive) !== selected.digest) {
				continue;
			}
			const rootPath = join(this.#storeRoot, selected.digest);
			const rootInfo = await lstat(rootPath).catch(() => undefined);
			if (!rootInfo?.isDirectory() || rootInfo.isSymbolicLink()) continue;
			const download: MarketplaceDownloadReceipt = {
				stagedRoot: rootPath,
				bytes: cachedArchive.byteLength,
				digest: selected.digest,
				sourceUrl: selected.locator.sourceUrl,
				downloadReceiptId: "offline-cache-revalidation",
			};
			const verification = await verifier.verify(selected.locator, download);
			if (!verification.signatureValid || !verification.publisherTrusted || verification.publisherRevision !== selected.publisherRevision) continue;
			roots.push({
				packageName,
				version: selected.version,
				digest: selected.digest,
				rootPath: download.stagedRoot,
				locator: selected.locator,
			});
		}
		return roots;
	}
}
