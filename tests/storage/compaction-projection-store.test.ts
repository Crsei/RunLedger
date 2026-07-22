import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createCompactedHistoryProjection } from "../../src/runtime/context/compaction/projection.ts";
import type { CompactionSourceEntry } from "../../src/runtime/context/compaction/cut-planner.ts";
import { canonicalDigest } from "../../src/runtime/protocol/v3/canonical-json.ts";
import { createRuntimeId } from "../../src/runtime/protocol/v3/ids.ts";
import {
	CompactionProjectionRevisionConflictError,
	FileCompactionProjectionStore,
	type FileCompactionProjectionStoreOptions,
} from "../../src/storage/compaction-projection-store.ts";

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const authorityId = createRuntimeId("authority", "projection-store");
const tenantId = createRuntimeId("tenant", "projection-store");
const sessionId = createRuntimeId("session", "projection-store");

function artifact(body: string) {
	const storedDigest = canonicalDigest(body);
	return {
		authorityId,
		tenantId,
		artifactId: createRuntimeId("artifact", `projection-${storedDigest.slice(0, 40)}`),
		storedDigest,
		kind: "session_report" as const,
		originalSize: Buffer.byteLength(body),
		storedSize: Buffer.byteLength(body),
		mediaType: "text/markdown",
		redaction: "metadata_only" as const,
		transformReceipt: createRuntimeId("receipt", `projection-${storedDigest.slice(0, 40)}`),
	};
}

function projection(seed = "one") {
	const summary = `bounded summary ${seed}`;
	const retained: readonly CompactionSourceEntry[] = [{
		sequence: 7,
		turnId: "turn-7",
		kind: "assistant",
		content: "retained tail",
		contentDigest: canonicalDigest("retained tail"),
		stable: true,
		turnCompleted: true,
		inputSources: [],
		declassificationReceipts: [],
	}];
	return createCompactedHistoryProjection({
		schemaVersion: 1,
		authorityId,
		tenantId,
		checkpointId: createRuntimeId("checkpoint", `projection-store-${seed}`),
		compactionId: createRuntimeId("compaction", `projection-store-${seed}`),
		sessionId,
		sourceFromSequence: 1,
		sourceToSequence: 6,
		retainedFromSequence: 7,
		survivingSuffixFromSequence: 7,
		summaryArtifact: artifact(summary),
		summaryDigest: canonicalDigest(summary),
		replacementHistoryArtifact: artifact(`replacement ${seed}`),
		replacementHistoryDigest: canonicalDigest(`replacement ${seed}`),
		invariantDigest: canonicalDigest("invariants"),
		checkpointDigest: canonicalDigest(`checkpoint ${seed}`),
	}, summary, retained);
}

async function setup(options: Partial<Pick<FileCompactionProjectionStoreOptions, "clock" | "onWritePhase">> = {}) {
	const root = await mkdtemp(join(tmpdir(), "runledger-compaction-projection-"));
	roots.push(root);
	const path = join(root, "state", "projection.json");
	return {
		root,
		path,
		store: new FileCompactionProjectionStore({ path, authorityId, tenantId, sessionId, ...options }),
	};
}

function installRequest(value = projection(), expectedProjectionRevision = 0, previousProjectionDigest = canonicalDigest("original projection")) {
	return { projection: value, expectedProjectionRevision, previousProjectionDigest };
}

describe("FileCompactionProjectionStore", () => {
	it("durably reopens an exact scoped projection with private permissions", async () => {
		const { path, store } = await setup();
		const expected = projection();
		const installation = await store.install(installRequest(expected));
		const reopened = new FileCompactionProjectionStore({ path, authorityId, tenantId, sessionId });
		expect(await reopened.load()).toEqual(expected);
		expect(await reopened.loadState()).toMatchObject({
			revision: 1,
			installation: { state: "live_projection_installed", receiptDigest: installation.receiptDigest },
		});
		expect((await stat(path)).mode & 0o777).toBe(0o600);
		expect((await stat(join(path, ".."))).mode & 0o777).toBe(0o700);
	});

	it("fails closed on digest tampering, foreign scope, and permissive mode", async () => {
		const { path, store } = await setup();
		await store.install(installRequest());
		const parsed = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
		await writeFile(path, `${JSON.stringify({ ...parsed, storedDigest: "f".repeat(64) })}\n`, { mode: 0o600 });
		await expect(store.load()).rejects.toThrow("scope or digest");

		await writeFile(path, "", { mode: 0o600 });
		await rm(path, { force: true });
		await store.install(installRequest());
		const foreign = new FileCompactionProjectionStore({
			path,
			authorityId,
			tenantId: createRuntimeId("tenant", "foreign"),
			sessionId,
		});
		await expect(foreign.load()).rejects.toThrow("scope or digest");

		await chmod(path, 0o644);
		await expect(store.load()).rejects.toThrow("unsafe");
	});

	it("keeps revision zero when installation crashes before rename", async () => {
		const { path, store } = await setup({
			onWritePhase: (phase) => { if (phase === "before_rename") throw new Error("crash before projection rename"); },
		});
		await expect(store.install(installRequest())).rejects.toThrow("crash before projection rename");
		expect(await new FileCompactionProjectionStore({ path, authorityId, tenantId, sessionId }).loadState()).toEqual({ revision: 0 });
	});

	it("treats an after-rename crash as an idempotently installed projection on retry", async () => {
		let crash = true;
		const { path, store } = await setup({
			clock: () => new Date("2026-07-22T00:00:00.000Z"),
			onWritePhase: (phase) => {
				if (crash && phase === "after_rename") throw new Error("crash after projection rename");
			},
		});
		const request = installRequest();
		await expect(store.install(request)).rejects.toThrow("crash after projection rename");
		const reopened = new FileCompactionProjectionStore({ path, authorityId, tenantId, sessionId });
		expect(await reopened.loadState()).toMatchObject({ revision: 1, projection: { projectionDigest: request.projection.projectionDigest } });
		crash = false;
		const receipt = await store.install(request);
		expect(receipt.installedProjectionRevision).toBe(1);
		expect((await store.loadState()).revision).toBe(1);
	});

	it("rejects stale expected revisions without replacing the installed projection", async () => {
		const { store } = await setup();
		const first = projection("first");
		await store.install(installRequest(first));
		await expect(store.install(installRequest(projection("stale"), 0))).rejects.toBeInstanceOf(
			CompactionProjectionRevisionConflictError,
		);
		expect(await store.load()).toEqual(first);
	});

	it("serializes concurrent cross-instance CAS so exactly one revision-zero writer wins", async () => {
		const { path } = await setup();
		const left = new FileCompactionProjectionStore({ path, authorityId, tenantId, sessionId });
		const right = new FileCompactionProjectionStore({ path, authorityId, tenantId, sessionId });
		const results = await Promise.allSettled([
			left.install(installRequest(projection("left"))),
			right.install(installRequest(projection("right"))),
		]);
		expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
		expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
		expect((await left.loadState()).revision).toBe(1);
	});
});
