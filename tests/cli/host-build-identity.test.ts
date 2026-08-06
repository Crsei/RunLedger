import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
	createHostBuildManifest,
	verifyHostBuildManifest,
	writeHostBuildManifest,
} from "../../src/cli/host-build-identity.ts";

describe("Host build identity", () => {
	it("changes for executable content while ignoring declarations and source maps", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-build-identity-"));
		await mkdir(join(root, "cli"), { recursive: true });
		await mkdir(join(root, "native"), { recursive: true });
		await writeFile(join(root, "cli/runtime-host.js"), "export const build = 1;\n");
		await writeFile(join(root, "cli/runtime-host.d.ts"), "export declare const build: number;\n");
		await writeFile(join(root, "cli/runtime-host.js.map"), "{}\n");
		await writeFile(join(root, "native/runledger-linux-peer-credential"), "native-one\n");
		await writeFile(join(root, "native/runledger-peer-broker"), "unused-legacy-broker\n");

		const first = await createHostBuildManifest(root, "0.0.1");
		await writeFile(join(root, "cli/runtime-host.d.ts"), "export declare const changed: string;\n");
		await writeFile(join(root, "cli/runtime-host.js.map"), "{\"changed\":true}\n");
		const ignored = await createHostBuildManifest(root, "0.0.1");
		expect(ignored.contentDigest).toEqual(first.contentDigest);
		await writeFile(join(root, "native/runledger-peer-broker"), "changed-unused-broker\n");
		const ignoredLegacyNative = await createHostBuildManifest(root, "0.0.1");
		expect(ignoredLegacyNative.contentDigest).toEqual(first.contentDigest);

		await writeFile(join(root, "cli/runtime-host.js"), "export const build = 2;\n");
		const second = await createHostBuildManifest(root, "0.0.1");
		expect(second.contentDigest).not.toEqual(first.contentDigest);
		expect(second.packageVersion).toBe(first.packageVersion);
	});

	it("fails closed when a manifested artifact changes", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-build-verify-"));
		await mkdir(join(root, "runtime"), { recursive: true });
		await writeFile(join(root, "runtime/host.js"), "export const host = true;\n");
		const manifest = await createHostBuildManifest(root, "0.0.1");
		await expect(verifyHostBuildManifest(root, manifest)).resolves.toEqual({ ok: true, manifest });

		await writeFile(join(root, "runtime/host.js"), "export const host = false;\n");
		await expect(verifyHostBuildManifest(root, manifest)).resolves.toEqual({
			ok: false,
			code: "artifact_digest_mismatch",
			path: "runtime/host.js",
		});
	});

	it("writes a verified canonical manifest for the runtime loader", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-build-write-"));
		await writeFile(join(root, "entry.js"), "export {};\n");
		const manifest = await writeHostBuildManifest(root, "0.0.1");
		const persisted = JSON.parse(await readFile(join(root, "host-build-manifest.json"), "utf8")) as unknown;
		expect(persisted).toEqual(manifest);
		await expect(verifyHostBuildManifest(root, manifest)).resolves.toMatchObject({ ok: true });
	});
});
