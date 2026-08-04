import { describe, expect, it } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRunledgerLayout } from "../../../src/runtime/contracts/storage-layout.ts";
import { runtimeDigest, type RuntimeDigest } from "../../../src/runtime/protocol/foundation.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/ids.ts";
import { FileProcessOutputStore } from "../../../src/storage/process/output-store.ts";

describe("R7 private durable process output", () => {
	it("keeps UTF-8 boundaries, bounded pages, and recovers from the private store", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-process-output-"));
		try {
			const layout = buildRunledgerLayout(join(root, "home"), "posix");
			const options = {
				layout,
				workspaceStorageKey: "ws-" + "a".repeat(64),
				executionId: createRuntimeId("execution", "output"),
				attemptId: createRuntimeId("attempt", "output"),
				maxBytes: 128,
			};
			const store = new FileProcessOutputStore(options);
			expect(await store.append("alpha😀\n")).toMatchObject({ ok: true, cursor: { sequence: 1 } });
			expect(await store.append("beta世界\n")).toMatchObject({ ok: true, cursor: { sequence: 2 } });

			const page = await store.read({ sequence: 0, byteOffset: 0 }, 8);
			expect(page.ok).toBe(true);
			if (!page.ok) return;
		expect(page.page.text).toBe("alpha");
			expect(page.page.truncated).toBe(true);
			expect(Buffer.byteLength(page.page.text, "utf8")).toBeLessThanOrEqual(8);
			expect(page.page.text).not.toContain("�");

			const recovered = new FileProcessOutputStore(options);
			expect(await recovered.head()).toEqual(await store.head());
			const recoveredPage = await recovered.read(page.page.nextCursor, 128);
			expect(recoveredPage.ok).toBe(true);
			if (recoveredPage.ok) expect(recoveredPage.page.text).toBe("😀\nbeta世界\n");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("returns typed resync after retention and seals immutable output evidence", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-process-output-retention-"));
		try {
			const layout = buildRunledgerLayout(join(root, "home"), "posix");
			const options = {
				layout,
				workspaceStorageKey: "ws-" + "b".repeat(64),
				executionId: createRuntimeId("execution", "retention"),
				attemptId: createRuntimeId("attempt", "retention"),
				maxBytes: 128,
			};
			const store = new FileProcessOutputStore(options);
			const first = await store.append("one\n");
			const oldCursor = { sequence: 0, byteOffset: 0 };
			const second = await store.append("two\n");
			if (!first.ok || !second.ok) throw new Error("append failed");
			await store.compactBefore(first.cursor);

			const stale = await store.read(oldCursor, 64);
			expect(stale).toEqual({ ok: false, code: "output_cursor_resync_required", earliestCursor: first.cursor });

			const sealed = await store.seal();
			expect(sealed.ok).toBe(true);
			if (!sealed.ok) return;
			expect(sealed.seal.digest).toEqual(runtimeDigest("two\n"));
			expect(sealed.seal.size).toBe(4);
			expect(await store.seal()).toEqual(sealed);

			const privateFiles = await readFile(join(layout.state, "processes", options.workspaceStorageKey, "output", options.executionId, `${options.attemptId}.jsonl`), "utf8");
			expect(privateFiles).not.toContain("/tmp/");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("rejects output beyond the durable bound without changing the head", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-process-output-cap-"));
		try {
			const layout = buildRunledgerLayout(join(root, "home"), "posix");
			const store = new FileProcessOutputStore({
				layout,
				workspaceStorageKey: "ws-" + "c".repeat(64),
				executionId: createRuntimeId("execution", "cap"),
				attemptId: createRuntimeId("attempt", "cap"),
				maxBytes: 4,
			});
			expect(await store.append("1234")).toMatchObject({ ok: true });
			const before = await store.head();
			expect(await store.append("5")).toEqual({ ok: false, code: "output_capacity_exceeded" });
			expect(await store.head()).toEqual(before);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("rebuilds the durable head when a crash leaves the record ahead of metadata", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-process-output-recovery-gap-"));
		try {
			const layout = buildRunledgerLayout(join(root, "home"), "posix");
			const options = {
				layout,
				workspaceStorageKey: "ws-" + "r".repeat(64),
				executionId: createRuntimeId("execution", "recovery-gap"),
				attemptId: createRuntimeId("attempt", "recovery-gap"),
			};
			const store = new FileProcessOutputStore(options);
			const first = await store.append("first\n");
			const second = await store.append("second\n");
			if (!first.ok || !second.ok) throw new Error("append failed");
			const metadataPath = join(layout.state, "processes", options.workspaceStorageKey, "output", options.executionId, `${options.attemptId}.meta.json`);
			await writeFile(metadataPath, `${JSON.stringify({ earliestCursor: { sequence: 0, byteOffset: 0 }, head: first.cursor })}\n`, "utf8");

			const recovered = new FileProcessOutputStore(options);
			expect(await recovered.head()).toEqual(second.cursor);
			const page = await recovered.read(first.cursor, 128);
			expect(page).toMatchObject({ ok: true, page: { text: "second\n" } });
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("rebuilds the earliest cursor when compaction committed records before metadata", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-process-output-retention-gap-"));
		try {
			const layout = buildRunledgerLayout(join(root, "home"), "posix");
			const options = {
				layout,
				workspaceStorageKey: "ws-" + "s".repeat(64),
				executionId: createRuntimeId("execution", "retention-gap"),
				attemptId: createRuntimeId("attempt", "retention-gap"),
			};
			const store = new FileProcessOutputStore(options);
			const first = await store.append("first\n");
			const second = await store.append("second\n");
			if (!first.ok || !second.ok) throw new Error("append failed");
			expect(await store.compactBefore(first.cursor)).toMatchObject({ ok: true });
			const metadataPath = join(layout.state, "processes", options.workspaceStorageKey, "output", options.executionId, `${options.attemptId}.meta.json`);
			await writeFile(metadataPath, `${JSON.stringify({ earliestCursor: { sequence: 0, byteOffset: 0 }, head: second.cursor })}\n`, "utf8");

		const recovered = new FileProcessOutputStore(options);
		expect(await recovered.read({ sequence: 0, byteOffset: 0 }, 128)).toEqual({
				ok: false,
				code: "output_cursor_resync_required",
				earliestCursor: { sequence: 2, byteOffset: first.cursor.byteOffset },
			});
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("plans retention, honors pins, and persists a recovery marker", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-process-output-plan-"));
		try {
			const layout = buildRunledgerLayout(join(root, "home"), "posix");
			const store = new FileProcessOutputStore({
				layout,
				workspaceStorageKey: "ws-" + "d".repeat(64),
				executionId: createRuntimeId("execution", "plan"),
				attemptId: createRuntimeId("attempt", "plan"),
			});
			const first = await store.append("one\n");
			const second = await store.append("two\n");
			if (!first.ok || !second.ok) throw new Error("append failed");
			expect(await store.pin("trace", first.cursor)).toEqual({ ok: true });
			const blocked = await store.planRetention(second.cursor);
			expect(blocked).toMatchObject({ ok: true, plan: { blockedBy: ["trace"] } });
			expect(await store.commitRetention(blocked.ok ? blocked.plan : { before: second.cursor, sourceHead: second.cursor, planDigest: digest("invalid") })).toEqual({
			ok: false,
			code: "output_retention_blocked",
		});
		await store.unpin("trace");
		const plan = await store.planRetention(second.cursor);
		if (!plan.ok) throw new Error("retention plan failed");
			expect(await store.commitRetention(plan.plan)).toMatchObject({ ok: true });
			const marker = { kind: "seal" as const, digest: second.cursor.byteOffset.toString(16), cursor: second.cursor };
			expect(await store.writeRecoveryMarker(marker)).toEqual({ ok: true });
			expect(await store.recoveryMarker()).toEqual(marker);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("does not compact sealed private output because the seal covers the retained bytes", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-process-output-sealed-retention-"));
		try {
			const layout = buildRunledgerLayout(join(root, "home"), "posix");
			const store = new FileProcessOutputStore({
				layout,
				workspaceStorageKey: "ws-" + "e".repeat(64),
				executionId: createRuntimeId("execution", "sealed-retention"),
				attemptId: createRuntimeId("attempt", "sealed-retention"),
			});
			const first = await store.append("one\n");
			const second = await store.append("two\n");
			if (!first.ok || !second.ok) throw new Error("append failed");
			expect((await store.seal()).ok).toBe(true);
			expect(await store.planRetention(second.cursor)).toMatchObject({
				ok: true,
				plan: { blockedBy: ["sealed"] },
			});
			const plan = await store.planRetention(second.cursor);
			if (!plan.ok) throw new Error("retention plan failed");
			expect(await store.commitRetention(plan.plan)).toEqual({ ok: false, code: "output_retention_blocked" });
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
