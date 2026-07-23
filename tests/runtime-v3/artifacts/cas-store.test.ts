import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ArtifactCasStore, ArtifactRepository } from "../../../src/runtime/artifacts/cas-store.ts";
import { ArtifactMetadataStore } from "../../../src/runtime/artifacts/metadata-store.ts";
import { createArtifactHarness, NOW, valueOf } from "./helpers.ts";

describe("artifact CAS transaction", () => {
	it("deduplicates stored content while keeping per-artifact metadata isolated", async () => {
		const harness = await createArtifactHarness();
		try {
			const first = valueOf(await harness.repository.write(harness.request("first")));
			const second = valueOf(await harness.repository.write(harness.request("second")));
			expect(first.state).toBe("committed");
			expect(second.state).toBe("committed");
			expect(first.metadata.storedDigest).toBe(second.metadata.storedDigest);
			expect(first.metadata.artifactId).not.toBe(second.metadata.artifactId);
			expect(first.metadata.metadataDigest).not.toBe(second.metadata.metadataDigest);
			const stored = Buffer.from(valueOf(await harness.cas.read(first.metadata.storedDigest))).toString("utf8");
			expect(stored).toContain("visible output");
			expect(stored).not.toContain("hunter2");
			expect(stored).not.toContain("/home/alice");
		} finally {
			await harness.cleanup();
		}
	});

	it("idempotently resolves an exact retry of a committed intent", async () => {
		const harness = await createArtifactHarness();
		try {
			const request = harness.request("idempotent-retry");
			const first = valueOf(await harness.repository.write(request));
			const retried = valueOf(await harness.repository.write(request));
			expect(first).toMatchObject({ state: "committed", metadata: { intentId: request.intentId } });
			expect(retried).toEqual(first);
			expect(harness.journal.intents.size).toBe(1);
			expect(harness.journal.commits.size).toBe(1);
		} finally {
			await harness.cleanup();
		}
	});

	it("never returns bytes when the stored digest does not match", async () => {
		const harness = await createArtifactHarness();
		try {
			const written = valueOf(await harness.repository.write(harness.request("corrupt")));
			const digest = written.metadata.storedDigest;
			const blobPath = join(harness.rootDir, "blobs", "sha256", digest.slice(0, 2), digest.slice(2, 4), `${digest}.blob`);
			await writeFile(blobPath, "tampered");
			expect(await harness.cas.read(digest)).toMatchObject({ ok: false, error: { code: "digest_mismatch" } });
		} finally {
			await harness.cleanup();
		}
	});

	it("leaves a committed-event transaction pending and recovers it on startup", async () => {
		const harness = await createArtifactHarness({
			cas: {
				onWritePhase: (phase, target) => {
					if (phase === "before_rename" && target.includes("/blobs/")) throw new Error("promotion crash");
				},
			},
		});
		try {
			const request = harness.request("recover");
			const pending = valueOf(await harness.repository.write(request));
			expect(pending.state).toBe("pending");
			expect(valueOf(await harness.journal.stateForIntent(request.intentId)).state).toBe("committed");

			const recovering = new ArtifactRepository({
				cas: new ArtifactCasStore({ rootDir: harness.rootDir }),
				metadata: new ArtifactMetadataStore({ rootDir: harness.rootDir }),
				journal: harness.journal,
				keyProvider: harness.keyProvider,
				clock: () => new Date(NOW),
			});
			const report = valueOf(await recovering.reconcile(request));
			expect(report.recovered).toEqual([request.intentId]);
			const committed = valueOf(await harness.metadata.readCommitted(request.authorityId, request.tenantId, request.artifactId));
			expect(committed.state).toBe("committed");
			expect(Buffer.from(valueOf(await harness.cas.read(committed.storedDigest))).toString("utf8")).toContain("visible output");
		} finally {
			await harness.cleanup();
		}
	});

	it("recovers after blob promotion completed but committed metadata was not written", async () => {
		let failCommittedMetadata = true;
		const harness = await createArtifactHarness({
			metadata: {
				onWritePhase: (phase, target) => {
					if (failCommittedMetadata && phase === "before_write" && target.includes("/committed/")) {
						throw new Error("crash after blob promotion");
					}
				},
			},
		});
		try {
			const request = harness.request("after-promote-crash");
			const pending = valueOf(await harness.repository.write(request));
			expect(pending.state).toBe("pending");
			expect(valueOf(await harness.journal.stateForIntent(request.intentId))).toMatchObject({ state: "committed" });
			expect(await harness.metadata.readPending(request.authorityId, request.tenantId, request.intentId)).toMatchObject({
				ok: true,
				value: { state: "pending" },
			});
			expect(Buffer.from(valueOf(await harness.cas.read(pending.metadata.storedDigest))).toString("utf8")).toContain("visible output");

			failCommittedMetadata = false;
			const recovering = new ArtifactRepository({
				cas: new ArtifactCasStore({ rootDir: harness.rootDir }),
				metadata: new ArtifactMetadataStore({ rootDir: harness.rootDir }),
				journal: harness.journal,
				keyProvider: harness.keyProvider,
				clock: () => new Date(NOW),
			});
			const report = valueOf(await recovering.reconcile(request));
			expect(report).toEqual({ recovered: [request.intentId], rolledBack: [], failed: [] });
			expect(valueOf(await harness.metadata.readCommitted(request.authorityId, request.tenantId, request.artifactId))).toMatchObject({
				state: "committed",
				intentId: request.intentId,
			});
		} finally {
			await harness.cleanup();
		}
	});

	it("rolls back an intent-only orphan during reconciliation", async () => {
		const harness = await createArtifactHarness();
		try {
			harness.journal.failCommit = true;
			const request = harness.request("rollback");
			const pending = valueOf(await harness.repository.write(request));
			expect(pending.state).toBe("pending");
			harness.journal.failCommit = false;
			const report = valueOf(await harness.repository.reconcile(request));
			expect(report.rolledBack).toEqual([request.intentId]);
			expect(await harness.metadata.readPending(request.authorityId, request.tenantId, request.intentId)).toMatchObject({
				ok: false,
				error: { code: "not_found" },
			});
		} finally {
			await harness.cleanup();
		}
	});

	it("retains the pending recovery anchor until a durable abort can be recorded", async () => {
		const harness = await createArtifactHarness();
		try {
			harness.journal.failCommit = true;
			const request = harness.request("abort-retry");
			const pending = valueOf(await harness.repository.write(request));
			expect(pending.state).toBe("pending");
			harness.journal.failCommit = false;
			harness.journal.failAbort = true;

			const failed = valueOf(await harness.repository.reconcile(request));
			expect(failed.failed).toEqual([
				expect.objectContaining({ intentId: request.intentId, error: expect.objectContaining({ code: "durable_write_failed" }) }),
			]);
			expect(await harness.metadata.readPending(request.authorityId, request.tenantId, request.intentId)).toMatchObject({
				ok: true,
				value: { intentId: request.intentId, state: "pending" },
			});

			harness.journal.failAbort = false;
			const retried = valueOf(await harness.repository.reconcile(request));
			expect(retried).toMatchObject({ rolledBack: [request.intentId], failed: [] });
			expect(valueOf(await harness.journal.stateForIntent(request.intentId))).toMatchObject({ state: "aborted" });
			expect(await harness.metadata.readPending(request.authorityId, request.tenantId, request.intentId)).toMatchObject({
				ok: false,
				error: { code: "not_found" },
			});
		} finally {
			await harness.cleanup();
		}
	});

	it("reconciles an event-only intent after metadata staging and abort both failed", async () => {
		const harness = await createArtifactHarness({
			metadata: { onWritePhase: (phase) => { if (phase === "before_write") throw new Error("metadata unavailable"); } },
		});
		try {
			harness.journal.failAbort = true;
			const request = harness.request("event-only-reconcile");
			expect(await harness.repository.write(request)).toMatchObject({
				ok: false,
				error: { code: "durable_write_failed" },
			});
			expect(valueOf(await harness.journal.stateForIntent(request.intentId))).toMatchObject({ state: "intent_recorded" });
			harness.journal.failAbort = false;

			const report = valueOf(await harness.repository.reconcile(request));
			expect(report).toMatchObject({ rolledBack: [request.intentId], failed: [] });
			expect(valueOf(await harness.journal.stateForIntent(request.intentId))).toMatchObject({ state: "aborted" });
			const pendingDir = join(harness.rootDir, "pending", request.authorityId, request.tenantId, request.intentId);
			await expect(readdir(pendingDir)).rejects.toMatchObject({ code: "ENOENT" });
		} finally {
			await harness.cleanup();
		}
	});

	it("reports disk-full and metadata write failures without a visible reference", async () => {
		const diskFull = await createArtifactHarness({
			cas: { onWritePhase: (phase) => { if (phase === "before_write") throw Object.assign(new Error("no space"), { code: "ENOSPC" }); } },
		});
		try {
			const request = diskFull.request("disk-full");
			expect(await diskFull.repository.write(request)).toMatchObject({
				ok: false,
				error: { code: "durable_write_failed" },
			});
			expect(valueOf(await diskFull.journal.stateForIntent(request.intentId))).toMatchObject({ state: "aborted" });
		} finally {
			await diskFull.cleanup();
		}

		const metadataFailure = await createArtifactHarness({
			metadata: { onWritePhase: (phase) => { if (phase === "before_write") throw new Error("metadata unavailable"); } },
		});
		try {
			const request = metadataFailure.request("metadata-fail");
			expect(await metadataFailure.repository.write(request)).toMatchObject({
				ok: false,
				error: { code: "metadata_write_failed" },
			});
			expect(valueOf(await metadataFailure.journal.stateForIntent(request.intentId))).toMatchObject({ state: "aborted" });
			expect(await metadataFailure.metadata.readPending(request.authorityId, request.tenantId, request.intentId)).toMatchObject({
				ok: false,
				error: { code: "not_found" },
			});
		} finally {
			await metadataFailure.cleanup();
		}
	});

	it("removes partial temp files when atomic rename is interrupted", async () => {
		const harness = await createArtifactHarness({
			cas: { onWritePhase: (phase) => { if (phase === "before_rename") throw new Error("crash before rename"); } },
		});
		try {
			const request = harness.request("partial");
			expect(await harness.repository.write(request)).toMatchObject({ ok: false, error: { code: "durable_write_failed" } });
			const intentDir = join(harness.rootDir, "pending", request.authorityId, request.tenantId, request.intentId);
			const files = await readdir(intentDir);
			expect(files).toEqual([]);
			await expect(readFile(join(intentDir, ".partial"))).rejects.toBeTruthy();
		} finally {
			await harness.cleanup();
		}
	});
});
