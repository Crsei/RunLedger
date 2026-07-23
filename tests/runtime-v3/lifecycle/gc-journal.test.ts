import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalDigest } from "../../../src/runtime/protocol/v3/canonical-json.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/v3/ids.ts";
import { DurableRuntimeGcJournal } from "../../../src/runtime/lifecycle/gc-journal.ts";
import type {
	RuntimeGcCommandClaim,
	RuntimeGcMutationRequest,
	RuntimeGcReceipt,
	RuntimeGcReceiptBody,
} from "../../../src/runtime/lifecycle/gc.ts";

const roots: string[] = [];
const authorityId = createRuntimeId("authority", "gc-journal");
const tenantId = createRuntimeId("tenant", "gc-journal");
const requestId = createRuntimeId("command", "gc-journal");
const now = "2026-07-24T00:00:00.000Z";

function claim(requestDigest = canonicalDigest("gc-request")): RuntimeGcCommandClaim {
	return {
		schemaVersion: 1,
		authorityId,
		tenantId,
		requestId,
		requestDigest,
		graphRevision: 3,
		graphDigest: canonicalDigest("gc-graph"),
	};
}

function mutation(): RuntimeGcMutationRequest {
	return {
		schemaVersion: 1,
		authorityId,
		tenantId,
		requestId,
		operation: "purge",
		targetKind: "session_ref",
		targetId: createRuntimeId("session", "gc-journal"),
		graphRevision: 3,
		graphDigest: canonicalDigest("gc-graph"),
		idempotencyKey: canonicalDigest("gc-mutation"),
		requestedAt: now,
	};
}

function receipt(value = claim()): RuntimeGcReceipt {
	const body: RuntimeGcReceiptBody = {
		schemaVersion: 1,
		authorityId,
		tenantId,
		requestId,
		requestDigest: value.requestDigest,
		dryRun: false,
		operation: "purge",
		requestedAt: now,
		completedAt: now,
		graphRevision: value.graphRevision,
		graphDigest: value.graphDigest,
		entries: [{
			targetKind: "session_ref",
			targetId: createRuntimeId("session", "gc-journal"),
			action: "purged",
			reason: "eligible",
			mutationReceiptId: createRuntimeId("receipt", "gc-journal-mutation"),
			mutationDigest: canonicalDigest("gc-journal-mutation"),
		}],
	};
	return {
		...body,
		receiptId: createRuntimeId("receipt", "gc-journal-terminal"),
		receiptDigest: canonicalDigest(body),
	};
}

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("durable GC journal", () => {
	it("persists claim, mutation intent and terminal receipt across restart", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-gc-journal-"));
		roots.push(root);
		const journal = DurableRuntimeGcJournal.file(root, () => new Date(now));
		expect(await journal.claim(claim())).toEqual({ ok: true, value: { state: "claimed" } });
		expect(await journal.recordMutationIntent(claim(), mutation())).toEqual({ ok: true, value: mutation() });
		expect(await journal.complete(claim(), receipt())).toEqual({ ok: true, value: receipt() });

		const reopened = DurableRuntimeGcJournal.file(root, () => new Date(now));
		expect(await reopened.claim(claim())).toEqual({
			ok: true,
			value: { state: "completed", receipt: receipt() },
		});
		const directories = await readdir(root);
		const files = await readdir(join(root, directories[0]!));
		expect(files).toHaveLength(1);
		const file = join(root, directories[0]!, files[0]!);
		expect((await stat(file)).mode & 0o777).toBe(0o600);
		const original = await readFile(file, "utf8");
		await writeFile(file, `${original.slice(0, -1)}x`, { mode: 0o600 });
		expect(await reopened.claim(claim()))
			.toMatchObject({ ok: false, error: { code: "integrity_failed" } });
	});

	it("replays exact intents and rejects request/idempotency collisions", async () => {
		const journal = DurableRuntimeGcJournal.memory(() => new Date(now));
		await journal.claim(claim());
		expect(await journal.recordMutationIntent(claim(), mutation())).toEqual({ ok: true, value: mutation() });
		expect(await journal.recordMutationIntent(claim(), mutation())).toEqual({ ok: true, value: mutation() });
		expect(await journal.claim(claim(canonicalDigest("changed"))))
			.toMatchObject({ ok: false, error: { code: "integrity_failed" } });
		expect(await journal.recordMutationIntent(claim(), {
			...mutation(),
			targetId: createRuntimeId("session", "changed"),
		})).toMatchObject({ ok: false, error: { code: "integrity_failed" } });
	});
});
