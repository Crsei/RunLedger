import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ArtifactIntegrityError, FileArtifactStore } from "../../../src/runtime/trace/artifact-store.ts";

const roots: string[] = [];

async function createStore() {
	const root = await mkdtemp(join(tmpdir(), "runledger-trace-artifacts-"));
	roots.push(root);
	return new FileArtifactStore({
		dataRoot: join(root, "artifacts"),
		metadataRoot: join(root, "artifact-metadata"),
	});
}

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("FileArtifactStore", () => {
	it("stores content by digest, deduplicates it, and reads it back", async () => {
		const store = await createStore();
		const bytes = new TextEncoder().encode('{"message":"hello"}');

		const first = await store.put({
			bytes,
			mediaType: "application/json",
			redactionPolicyDigest: "policy_trace_v1",
		});
		const second = await store.put({
			bytes: new Uint8Array(bytes),
			mediaType: "application/json",
			redactionPolicyDigest: "policy_trace_v1",
		});

		expect(second).toEqual(first);
		expect(first.storage).toBe("artifact");
		expect(new TextDecoder().decode(await store.read(first))).toBe('{"message":"hello"}');
		expect((await store.metadata(first)).storedDigest).toBe(first.digest);
	});

	it("rejects content tampering during read", async () => {
		const store = await createStore();
		const ref = await store.put({
			bytes: new TextEncoder().encode("original"),
			mediaType: "text/plain",
			redactionPolicyDigest: "policy_trace_v1",
		});
		await writeFile(join(store.dataRoot, "sha256", ref.digest.slice(0, 2), ref.digest), "tampered", "utf8");

		await expect(store.read(ref)).rejects.toBeInstanceOf(ArtifactIntegrityError);
	});

	it("rejects an artifact ref that could escape the CAS root", async () => {
		const store = await createStore();
		const ref = await store.put({
			bytes: new TextEncoder().encode("safe"),
			mediaType: "text/plain",
			redactionPolicyDigest: "policy_trace_v1",
		});

		await expect(store.read({ ...ref, digest: `../${ref.digest}`, artifactId: "artifact_escape" }))
			.rejects.toBeInstanceOf(ArtifactIntegrityError);
	});

	it("rejects metadata whose storage discriminant was tampered", async () => {
		const store = await createStore();
		const ref = await store.put({
			bytes: new TextEncoder().encode("safe metadata"),
			mediaType: "text/plain",
			redactionPolicyDigest: "policy_trace_v1",
		});
		const metadataPath = join(
			store.metadataRoot,
			"sha256",
			ref.digest.slice(0, 2),
			`${ref.digest}.json`,
		);
		await writeFile(metadataPath, JSON.stringify({
			...(await store.metadata(ref)),
			storage: "digest_only",
		}), "utf8");

		await expect(store.metadata(ref)).rejects.toBeInstanceOf(ArtifactIntegrityError);
	});
});
