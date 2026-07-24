import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { readdir, stat, writeFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MarketplaceInstaller } from "../../src/extensions/marketplace/installer.ts";
import {
	Ed25519MarketplaceSignatureVerifier,
	NodeMarketplacePackagePipeline,
	NodePluginVersionStore,
	NodePublisherTrustStore,
	parseMarketplaceLocator,
} from "../../src/extensions/marketplace/node-marketplace.ts";
import type {
	MarketplaceLocator,
	MarketplaceNetworkPort,
} from "../../src/extensions/marketplace/types.ts";
import {
	makeExtensionTempDir,
	removeExtensionTempDir,
} from "./helpers.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map(removeExtensionTempDir));
});

async function temporary(label: string): Promise<string> {
	const path = await makeExtensionTempDir(label);
	temporaryDirectories.push(path);
	return path;
}

function octal(value: number, length: number): Buffer {
	return Buffer.from(value.toString(8).padStart(length - 1, "0") + "\0", "ascii");
}

function tar(entries: readonly { path: string; body?: Uint8Array; type?: "0" | "2" }[]): Buffer {
	const chunks: Buffer[] = [];
	for (const entry of entries) {
		const body = Buffer.from(entry.body ?? new Uint8Array());
		const header = Buffer.alloc(512);
		header.write(entry.path, 0, 100, "utf8");
		octal(0o600, 8).copy(header, 100);
		octal(0, 8).copy(header, 108);
		octal(0, 8).copy(header, 116);
		octal(body.byteLength, 12).copy(header, 124);
		octal(0, 12).copy(header, 136);
		header.fill(32, 148, 156);
		header.write(entry.type ?? "0", 156, 1, "ascii");
		header.write("ustar\0", 257, 6, "ascii");
		header.write("00", 263, 2, "ascii");
		const checksum = [...header].reduce((sum, value) => sum + value, 0);
		Buffer.from(checksum.toString(8).padStart(6, "0") + "\0 ", "ascii").copy(header, 148);
		chunks.push(header, body);
		const padding = Math.ceil(body.byteLength / 512) * 512 - body.byteLength;
		if (padding > 0) chunks.push(Buffer.alloc(padding));
	}
	chunks.push(Buffer.alloc(1_024));
	return Buffer.concat(chunks);
}

function pluginPackage(name: string, version: string): Buffer {
	const manifest = Buffer.from(JSON.stringify({
		schemaVersion: 1,
		name,
		version,
		description: `${name} fixture`,
		skills: [],
		hooks: [],
	}));
	return gzipSync(tar([{ path: ".runledger-plugin/plugin.json", body: manifest }]));
}

function locator(
	body: Uint8Array,
	version: string,
	privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"],
): MarketplaceLocator {
	const expectedDigest = createHash("sha256").update(body).digest("hex");
	return {
		schemaVersion: 1,
		packageName: "team-tools",
		version,
		publisherId: "publisher-1",
		sourceUrl: `https://packages.example/team-tools-${version}.tgz`,
		format: "tgz",
		expectedDigest,
		signature: {
			algorithm: "Ed25519",
			value: sign(null, Buffer.from(expectedDigest, "hex"), privateKey).toString("base64"),
		},
	};
}

describe("production marketplace pipeline", () => {
	it("installs signed exact locators into a 0600 content-addressed index, revalidates offline activation, and rolls back", async () => {
		const root = await temporary("marketplace-production");
		const keys = generateKeyPairSync("ed25519");
		const publisherTrustPath = join(root, "publisher-trust.json");
		const publishers = new NodePublisherTrustStore(publisherTrustPath);
		await publishers.trust({
			publisherId: "publisher-1",
			publicKeyPem: keys.publicKey.export({ type: "spki", format: "pem" }).toString(),
			at: new Date("2026-07-24T00:00:00.000Z"),
		});
		const packages = new Map<string, Uint8Array>();
		const network: MarketplaceNetworkPort = {
			download: async ({ url }) => {
				const body = packages.get(url);
				if (!body) throw new Error("fixture package missing");
				return {
					body,
					finalUrl: url,
					redirectChain: [],
					networkReceiptId: `network:${url}`,
				};
			},
		};
		const pipeline = new NodeMarketplacePackagePipeline({
			network,
			stagingRoot: join(root, "staging"),
		});
		const verifier = new Ed25519MarketplaceSignatureVerifier(publishers);
		const store = new NodePluginVersionStore({
			storeRoot: join(root, "store"),
			stagingRoot: join(root, "staging"),
			cacheRoot: join(root, "cache"),
			indexPath: join(root, "active-plugins.json"),
		});
		const installer = new MarketplaceInstaller({
			download: pipeline,
			signatures: verifier,
			probe: pipeline,
			approvals: {
				authorize: async ({ locator: exact, probe }) => ({
					receiptId: `approval:${exact.version}`,
					packageName: exact.packageName,
					version: exact.version,
					digest: exact.expectedDigest,
					capabilityDigest: probe.capabilityDigest,
					profile: "metadata-only",
					approvedAt: "2020-01-01T00:00:00.000Z",
					expiresAt: "2999-01-01T00:00:00.000Z",
				}),
			},
			store,
			cooldownMs: 0,
		});
		const firstBody = pluginPackage("team-tools", "1.0.0");
		const first = locator(firstBody, "1.0.0", keys.privateKey);
		packages.set(first.sourceUrl, firstBody);
		expect(await installer.install(first)).toMatchObject({
			ok: true,
			value: { version: "1.0.0", digest: first.expectedDigest },
		});
		const secondBody = pluginPackage("team-tools", "1.1.0");
		const second = locator(secondBody, "1.1.0", keys.privateKey);
		packages.set(second.sourceUrl, secondBody);
		expect(await installer.install(second, "update")).toMatchObject({
			ok: true,
			value: { version: "1.1.0", previousVersion: "1.0.0" },
		});
		expect(await installer.rollback("team-tools", "1.1.0")).toMatchObject({
			ok: true,
			value: { version: "1.0.0", previousVersion: "1.1.0" },
		});
		expect(await store.activeRoots(verifier)).toMatchObject([{
			packageName: "team-tools",
			version: "1.0.0",
			digest: first.expectedDigest,
		}]);
		expect((await stat(join(root, "active-plugins.json"))).mode & 0o777).toBe(0o600);
		expect((await stat(publisherTrustPath)).mode & 0o777).toBe(0o600);
		expect(await readdir(join(root, "staging"))).toEqual([]);
		await writeFile(join(root, "cache", `${first.expectedDigest}.tgz`), "tampered");
		expect(await store.activeRoots(verifier)).toEqual([]);
		await publishers.revoke("publisher-1");
		expect(await store.activeRoots(verifier)).toEqual([]);
	});

	it("rejects links during bounded extraction and rejects non-exact locator JSON", async () => {
		const root = await temporary("marketplace-link");
		const body = gzipSync(tar([{ path: "escape", type: "2" }]));
		const digest = createHash("sha256").update(body).digest("hex");
		const exact: MarketplaceLocator = {
			schemaVersion: 1,
			packageName: "team-tools",
			version: "1.0.0",
			publisherId: "publisher-1",
			sourceUrl: "https://packages.example/team-tools.tgz",
			format: "tgz",
			expectedDigest: digest,
			signature: { algorithm: "Ed25519", value: "a".repeat(32) },
		};
		const pipeline = new NodeMarketplacePackagePipeline({
			network: {
				download: async () => ({
					body,
					finalUrl: exact.sourceUrl,
					redirectChain: [],
					networkReceiptId: "network-link",
				}),
			},
			stagingRoot: join(root, "staging"),
		});
		await expect(pipeline.downloadToStaging(exact, {
			maxBytes: 1024 * 1024,
			requireHttps: true,
		})).rejects.toThrow(/link|unsupported/u);
		expect(parseMarketplaceLocator({ ...exact, extra: true })).toBeUndefined();
		expect(parseMarketplaceLocator(exact)).toEqual(exact);
	});
});
