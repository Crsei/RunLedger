import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSessionEventStreamRef } from "../../../src/runtime/protocol/v3/events.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/v3/ids.ts";
import {
	readStopTombstone,
	STOP_TOMBSTONE_FILE_NAME,
	writeStopTombstone,
} from "../../../src/runtime/session/stop-tombstone.ts";

const cleanup: string[] = [];

afterEach(async () => {
	await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixtureDirectory(): Promise<string> {
	const path = await mkdtemp(join(tmpdir(), "runledger-stop-"));
	cleanup.push(path);
	return path;
}

function body() {
	const sessionId = createRuntimeId("session", "fixture");
	const authorityId = createRuntimeId("authority", "local");
	const tenantId = createRuntimeId("tenant", "local");
	return {
		authorityId,
		tenantId,
		sessionId,
		requestedBy: createRuntimeId("principal", "fixture"),
		stopCursor: {
			stream: createSessionEventStreamRef({ authorityId, tenantId }, sessionId),
			sequence: 4,
			eventId: createRuntimeId("event", "stop"),
			eventHash: "a".repeat(64),
		},
		reasonDigest: "b".repeat(64),
		writtenAt: "2026-07-22T00:00:00.000Z",
	};
}

describe("durable stop tombstone", () => {
	it("atomically writes, reads, and idempotently reuses the same tombstone", async () => {
		const directory = await fixtureDirectory();
		const first = await writeStopTombstone(directory, body());
		expect(first.ok).toBe(true);
		expect(await readStopTombstone(directory)).toEqual(first);
		expect(await writeStopTombstone(directory, body())).toEqual(first);
		const text = await readFile(join(directory, STOP_TOMBSTONE_FILE_NAME), "utf8");
		expect(text.endsWith("\n")).toBe(true);
		expect(text.slice(0, -1)).not.toContain("\n");
	});

	it("rejects a conflicting stop intent", async () => {
		const directory = await fixtureDirectory();
		expect((await writeStopTombstone(directory, body())).ok).toBe(true);
		const conflict = await writeStopTombstone(directory, { ...body(), reasonDigest: "c".repeat(64) });
		expect(conflict).toMatchObject({ ok: false, error: { code: "stopped" } });
	});

	it("fails closed for a torn or modified tombstone", async () => {
		const directory = await fixtureDirectory();
		await writeFile(join(directory, STOP_TOMBSTONE_FILE_NAME), '{"partial":true}', "utf8");
		expect(await readStopTombstone(directory)).toMatchObject({ ok: false, error: { code: "corrupted_log" } });
	});

	it("does not publish a stop tombstone when atomic rename fails", async () => {
		const directory = await fixtureDirectory();
		const result = await writeStopTombstone(directory, body(), {
			onWritePhase: (phase) => {
				if (phase === "before_rename") {
					throw Object.assign(new Error("permission denied"), { code: "EACCES" });
				}
			},
		});
		expect(result).toMatchObject({ ok: false, error: { code: "durable_write_failed" } });
		expect(await readStopTombstone(directory)).toEqual({ ok: true, value: undefined });
	});
});
