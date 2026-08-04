import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRunledgerLayout } from "../../../src/runtime/contracts/storage-layout.ts";
import { runtimeDigest, type RuntimeDigest } from "../../../src/runtime/protocol/foundation.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/ids.ts";
import { FileArtifactStore } from "../../../src/runtime/trace/artifact-store.ts";
import { FileProcessOutputStore } from "../../../src/storage/process/output-store.ts";
import { ManagedProcessOutputMaterializer } from "../../../src/runtime/process/output-artifact.ts";

const digest = (seed: string): RuntimeDigest => runtimeDigest(seed);

describe("R7 process output artifact materialization", () => {
	it("keeps off/events free of Artifact Store calls and materializes only in events_and_artifacts", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-process-artifact-"));
		try {
			const layout = buildRunledgerLayout(join(root, "home"), "posix");
			const store = new FileProcessOutputStore({
				layout,
				workspaceStorageKey: "ws-" + "e".repeat(64),
				executionId: createRuntimeId("execution", "artifact"),
				attemptId: createRuntimeId("attempt", "artifact"),
			});
			await store.append("tool output\n");
			let calls = 0;
			const artifactStore = {
				put: async (input: { readonly bytes: Uint8Array; readonly mediaType: string; readonly redactionPolicyDigest: string }) => {
					calls += 1;
					return {
						storage: "artifact" as const,
						artifactId: "artifact_" + "a".repeat(64),
						digest: "a".repeat(64),
						mediaType: input.mediaType,
						size: input.bytes.byteLength,
					};
				},
			};
			const off = await new ManagedProcessOutputMaterializer({ mode: "off", artifactStore }).materialize(store);
			const events = await new ManagedProcessOutputMaterializer({ mode: "events", artifactStore }).materialize(store);
			expect(off.ok).toBe(true);
			expect(events.ok).toBe(true);
			expect(calls).toBe(0);
			if (!events.ok) return;
			expect(events.materialization.traceContent?.storage).toBe("digest_only");

			const artifacts = await new ManagedProcessOutputMaterializer({
				mode: "events_and_artifacts",
				artifactStore,
				redactionPolicyDigest: "policy",
			}).materialize(store);
			expect(artifacts.ok).toBe(true);
			expect(calls).toBe(1);
			if (artifacts.ok) expect(artifacts.materialization.traceContent?.storage).toBe("artifact");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("fails closed on artifact materialization failure without changing the private seal", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-process-artifact-failure-"));
		try {
			const layout = buildRunledgerLayout(join(root, "home"), "posix");
			const store = new FileProcessOutputStore({
				layout,
				workspaceStorageKey: "ws-" + "f".repeat(64),
				executionId: createRuntimeId("execution", "artifact-failure"),
				attemptId: createRuntimeId("attempt", "artifact-failure"),
			});
			await store.append("stable\n");
			const before = await store.seal();
			const result = await new ManagedProcessOutputMaterializer({
				mode: "events_and_artifacts",
				artifactStore: { put: async () => { throw new Error("artifact unavailable"); } },
				redactionPolicyDigest: "policy",
			}).materialize(store);
			expect(result).toEqual({ ok: false, code: "artifact_materialization_failed" });
			expect(await store.seal()).toEqual(before);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("reuses a durable ArtifactRef after Host recovery instead of materializing twice", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-process-artifact-recovery-"));
		try {
			const layout = buildRunledgerLayout(join(root, "home"), "posix");
			const options = {
				layout,
				workspaceStorageKey: "ws-" + "r".repeat(64),
				executionId: createRuntimeId("execution", "artifact-recovery"),
				attemptId: createRuntimeId("attempt", "artifact-recovery_1"),
			};
			const store = new FileProcessOutputStore(options);
			await store.append("recoverable output\n");
			const backingStore = new FileArtifactStore({
				dataRoot: layout.artifacts,
				metadataRoot: layout.artifactMetadata,
			});
			let firstCalls = 0;
			const artifactStore = {
				put: async (input: { readonly bytes: Uint8Array; readonly mediaType: string; readonly redactionPolicyDigest: string; readonly sourceDigest?: string }) => {
					firstCalls += 1;
					return backingStore.put(input);
				},
				read: (ref: Parameters<FileArtifactStore["read"]>[0]) => backingStore.read(ref),
				metadata: (ref: Parameters<FileArtifactStore["metadata"]>[0]) => backingStore.metadata(ref),
			};
			const first = await new ManagedProcessOutputMaterializer({
				mode: "events_and_artifacts",
				artifactStore,
			}).materialize(store);
			expect(first.ok).toBe(true);
			expect(firstCalls).toBe(1);

			const recovered = new FileProcessOutputStore(options);
			const second = await new ManagedProcessOutputMaterializer({
				mode: "events_and_artifacts",
				artifactStore: {
					...artifactStore,
					put: async () => { throw new Error("re-materialization must not be needed"); },
				},
			}).materialize(recovered);
			expect(second).toEqual(first);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("fails closed instead of reusing a tampered ArtifactRef during recovery", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-process-artifact-tamper-"));
		try {
			const layout = buildRunledgerLayout(join(root, "home"), "posix");
			const options = {
				layout,
				workspaceStorageKey: "ws-" + "t".repeat(64),
				executionId: createRuntimeId("execution", "artifact-tamper"),
				attemptId: createRuntimeId("attempt", "artifact-tamper_1"),
			};
			const output = new FileProcessOutputStore(options);
			await output.append("tamper-sensitive output\n");
			const artifactStore = new FileArtifactStore({
				dataRoot: layout.artifacts,
				metadataRoot: layout.artifactMetadata,
			});
			const first = await new ManagedProcessOutputMaterializer({
				mode: "events_and_artifacts",
				artifactStore,
			}).materialize(output);
			expect(first.ok).toBe(true);
			if (!first.ok || first.materialization.artifactRef === undefined) return;

			await writeFile(
				join(layout.artifacts, "sha256", first.materialization.artifactRef.digest.slice(0, 2), first.materialization.artifactRef.digest),
				"tampered artifact\n",
				"utf8",
			);

			const recovered = new FileProcessOutputStore(options);
			const second = await new ManagedProcessOutputMaterializer({
				mode: "events_and_artifacts",
				artifactStore,
			}).materialize(recovered);
			expect(second).toEqual({ ok: false, code: "artifact_materialization_failed" });
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("rejects sealed private output tampering before materialization", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-process-output-tamper-"));
		try {
			const layout = buildRunledgerLayout(join(root, "home"), "posix");
			const options = {
				layout,
				workspaceStorageKey: "ws-" + "s".repeat(64),
				executionId: createRuntimeId("execution", "sealed-output-tamper"),
				attemptId: createRuntimeId("attempt", "sealed-output-tamper_1"),
			};
			const output = new FileProcessOutputStore(options);
			await output.append("original\n");
			const sealed = await output.seal();
			expect(sealed.ok).toBe(true);

			const outputPath = join(
				layout.state,
				"processes",
				options.workspaceStorageKey,
				"output",
				options.executionId,
				`${options.attemptId}.jsonl`,
			);
			const persisted = await readFile(outputPath, "utf8");
			await writeFile(outputPath, persisted.replace("original", "tampered"), "utf8");

			await expect(output.readAll()).resolves.toEqual({ ok: false, code: "output_unavailable" });
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
