import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { createSessionEventStreamRef } from "../../../src/runtime/protocol/v3/events.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/v3/ids.ts";
import type { RuntimeInstanceId } from "../../../src/runtime/protocol/v3/ids.ts";
import {
	digestWriterFencingToken,
	FileWriterLeaseStore,
} from "../../../src/runtime/session/writer-lease.ts";
import type {
	FileWriterLeaseStoreOptions,
	WriterLeaseRecord,
	WriterLeaseScope,
} from "../../../src/runtime/session/writer-lease.ts";
import type { SessionResult, WriterFence } from "../../../src/runtime/session/types.ts";

const START_MS = Date.parse("2026-07-22T00:00:00.000Z");
const AUTHORITY_ID = createRuntimeId("authority", "persistent-fixture");
const TENANT_ID = createRuntimeId("tenant", "persistent-fixture");
const SESSION_ID = createRuntimeId("session", "persistent-fixture");
const STREAM = createSessionEventStreamRef({ authorityId: AUTHORITY_ID, tenantId: TENANT_ID }, SESSION_ID);
const OWNER_A = createRuntimeId("runtime", "persistent-owner-a");
const OWNER_B = createRuntimeId("runtime", "persistent-owner-b");
const OWNER_C = createRuntimeId("runtime", "persistent-owner-c");
const TOKEN_A = "A".repeat(43);
const TOKEN_B = "B".repeat(43);
const TOKEN_C = "C".repeat(43);
const SCOPE: WriterLeaseScope = {
	authorityId: AUTHORITY_ID,
	tenantId: TENANT_ID,
	stream: STREAM,
};

interface MutableClock {
	nowMs: number;
}

function resultValue<T>(result: SessionResult<T>): T {
	expect(result.ok).toBe(true);
	if (!result.ok) throw new Error(result.error.message);
	return result.value;
}

function resultError<T>(result: SessionResult<T>) {
	expect(result.ok).toBe(false);
	if (result.ok) throw new Error("expected SessionResult failure");
	return result.error;
}

function withStateFile(run: (filePath: string) => void): void {
	const directory = mkdtempSync(join(tmpdir(), "runledger-writer-lease-"));
	try {
		run(join(directory, "writer-lease.json"));
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}

function createStore(
	filePath: string,
	clock: MutableClock,
	label: string,
	tokens: readonly string[],
	extra: Partial<FileWriterLeaseStoreOptions> = {},
): FileWriterLeaseStore {
	let leaseSequence = 0;
	let tokenSequence = 0;
	return new FileWriterLeaseStore(filePath, {
		scope: SCOPE,
		now: () => new Date(clock.nowMs),
		tokenFactory: () => tokens[tokenSequence++] ?? `${label}`.repeat(43).slice(0, 43),
		leaseIdFactory: () => createRuntimeId("lease", `${label}-${++leaseSequence}`),
		...extra,
	});
}

function acquire(
	store: FileWriterLeaseStore,
	ownerRuntimeId: RuntimeInstanceId = OWNER_A,
	durationMs = 1_000,
): SessionResult<WriterLeaseRecord> {
	return store.acquire({ ...SCOPE, ownerRuntimeId, durationMs });
}

describe("FileWriterLeaseStore persistence", () => {
	it("shares acquire and heartbeat state across independent store instances", () => {
		withStateFile((filePath) => {
			const clock = { nowMs: START_MS };
			const firstStore = createStore(filePath, clock, "first", [TOKEN_A]);
			const secondStore = createStore(filePath, clock, "second", [TOKEN_B]);
			const first = resultValue(acquire(firstStore));

			expect(resultValue(secondStore.validate(first))).toEqual(first);
			expect(resultError(acquire(secondStore, OWNER_B)).code).toBe("writer_fenced");
			const wrongOwner = { ...first, ownerRuntimeId: OWNER_B } satisfies WriterFence;
			expect(resultError(secondStore.validate(wrongOwner)).code).toBe("writer_fenced");
			const otherScope = { ...SCOPE, tenantId: createRuntimeId("tenant", "other") };
			const wrongScopeStore = new FileWriterLeaseStore(filePath, {
				scope: otherScope,
				now: () => new Date(clock.nowMs),
			});
			expect(
				resultError(wrongScopeStore.acquire({ ...otherScope, ownerRuntimeId: OWNER_B })).code,
			).toBe("identity_mismatch");

			clock.nowMs += 400;
			const renewed = resultValue(secondStore.heartbeat(first, 2_000));
			expect(renewed.writerEpoch).toBe(1);
			expect(renewed.fencingToken).toBe(TOKEN_A);
			expect(renewed.renewedAt).toBe("2026-07-22T00:00:00.400Z");
			expect(renewed.expiresAt).toBe("2026-07-22T00:00:02.400Z");
			expect(resultValue(firstStore.validate(first))).toEqual(renewed);
			expect(statSync(filePath).mode & 0o777).toBe(0o600);
			expect(readdirSync(dirname(filePath)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
		});
	});

	it("persists a child-process acquire for a separate parent process", () => {
		withStateFile((filePath) => {
			const script = [
				'import { createRuntimeId } from "./src/runtime/protocol/v3/ids.ts";',
				'import { createSessionEventStreamRef } from "./src/runtime/protocol/v3/events.ts";',
				'import { FileWriterLeaseStore } from "./src/runtime/session/writer-lease.ts";',
				'const authorityId = createRuntimeId("authority", "persistent-fixture");',
				'const tenantId = createRuntimeId("tenant", "persistent-fixture");',
				'const sessionId = createRuntimeId("session", "persistent-fixture");',
				"const scope = { authorityId, tenantId, stream: createSessionEventStreamRef({ authorityId, tenantId }, sessionId) };",
				"const store = new FileWriterLeaseStore(process.env.RUNLEDGER_TEST_LEASE_FILE ?? '', {",
				"scope,",
				`now: () => new Date("2026-07-22T00:00:00.000Z"),`,
				`tokenFactory: () => "${TOKEN_A}",`,
				`leaseIdFactory: () => createRuntimeId("lease", "child-process"),`,
				"});",
				`const result = store.acquire({ ...scope, ownerRuntimeId: createRuntimeId("runtime", "persistent-owner-a"), durationMs: 1000 });`,
				"process.stdout.write(JSON.stringify(result));",
				"if (!result.ok) process.exitCode = 1;",
			].join("\n");
			const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
				cwd: process.cwd(),
				encoding: "utf8",
				env: { ...process.env, RUNLEDGER_TEST_LEASE_FILE: filePath },
			});
			expect(child.status, child.stderr).toBe(0);
			const childResult = JSON.parse(child.stdout) as SessionResult<WriterLeaseRecord>;
			const lease = resultValue(childResult);

			const parentStore = createStore(filePath, { nowMs: START_MS }, "parent", [TOKEN_B]);
			expect(resultValue(parentStore.validate(lease))).toEqual(lease);
			expect(resultError(acquire(parentStore, OWNER_B)).code).toBe("writer_fenced");
		});
	});

	it("takes over only a stale exact CAS fence and permanently rejects prior tokens", () => {
		withStateFile((filePath) => {
			const clock = { nowMs: START_MS };
			const firstStore = createStore(filePath, clock, "first", [TOKEN_A]);
			const takeoverStore = createStore(filePath, clock, "takeover", [TOKEN_A, TOKEN_B]);
			const first = resultValue(acquire(firstStore));

			clock.nowMs += 999;
			expect(
				resultError(
					takeoverStore.takeover({ expectedFence: first, ownerRuntimeId: OWNER_B, durationMs: 1_000 }),
				).code,
			).toBe("writer_fenced");
			clock.nowMs += 1;
			const second = resultValue(
				takeoverStore.takeover({ expectedFence: first, ownerRuntimeId: OWNER_B, durationMs: 1_000 }),
			);

			expect(second.writerEpoch).toBe(2);
			expect(second.fencingToken).toBe(TOKEN_B);
			expect(second.fencingTokenDigest).toBe(digestWriterFencingToken(TOKEN_B));
			expect(resultError(firstStore.validate(first)).code).toBe("writer_fenced");
			expect(
				resultError(firstStore.takeover({ expectedFence: first, ownerRuntimeId: OWNER_C })).code,
			).toBe("writer_fenced");

			const freshStore = createStore(filePath, clock, "fresh", [TOKEN_C], { lockStaleMs: 2_000 });
			mkdirSync(`${filePath}.lock`);
			const busy = resultError(freshStore.validate(second));
			expect(busy.code).toBe("durable_write_failed");
			expect(busy.retryable).toBe(true);
			expect(busy.message).not.toContain(filePath);
			const oldLockTime = new Date(Date.now() - 10_000);
			utimesSync(`${filePath}.lock`, oldLockTime, oldLockTime);
			expect(resultValue(freshStore.validate(second))).toEqual(second);
			expect(resultError(freshStore.validate(first)).code).toBe("writer_fenced");
		});
	});

	it("keeps epochs monotonic across release and reacquire without reviving a token", () => {
		withStateFile((filePath) => {
			const clock = { nowMs: START_MS };
			const firstStore = createStore(filePath, clock, "first", [TOKEN_A]);
			const releaseStore = createStore(filePath, clock, "release", [TOKEN_B]);
			const first = resultValue(acquire(firstStore));
			clock.nowMs += 100;
			const released = resultValue(releaseStore.release(first));
			expect(released.releasedAt).toBe("2026-07-22T00:00:00.100Z");

			const reacquireStore = createStore(filePath, clock, "reacquire", [TOKEN_A, TOKEN_C]);
			const second = resultValue(acquire(reacquireStore, OWNER_C));
			expect(second.writerEpoch).toBe(2);
			expect(second.fencingToken).toBe(TOKEN_C);
			expect(resultError(reacquireStore.validate(first)).code).toBe("writer_fenced");
			expect(resultError(reacquireStore.release(first)).code).toBe("writer_fenced");

			const state = JSON.parse(readFileSync(filePath, "utf8")) as {
				stateRevision: number;
				state: string;
				retiredTokenDigests: string[];
			};
			expect(state.stateRevision).toBe(3);
			expect(state.state).toBe("active");
			expect(state.retiredTokenDigests).toContain(digestWriterFencingToken(TOKEN_A));
			expect(state.retiredTokenDigests).not.toContain(digestWriterFencingToken(TOKEN_C));
		});
	});

	it("fails closed on torn or corrupt canonical state without leaking underlying content", () => {
		withStateFile((filePath) => {
			const clock = { nowMs: START_MS };
			const firstStore = createStore(filePath, clock, "first", [TOKEN_A]);
			const first = resultValue(acquire(firstStore));
			const canonical = readFileSync(filePath, "utf8");
			writeFileSync(filePath, canonical.slice(0, -11), "utf8");

			const recoveryStore = createStore(filePath, clock, "recovery", [TOKEN_B]);
			const torn = resultError(recoveryStore.validate(first));
			expect(torn.code).toBe("corrupted_log");
			expect(torn.retryable).toBe(false);
			expect(torn.message).toBe("writer lease state is invalid");
			expect(torn.message).not.toContain(filePath);
			expect(torn.message).not.toContain(TOKEN_A);
			expect(resultError(acquire(recoveryStore, OWNER_B)).code).toBe("corrupted_log");
			expect(readFileSync(filePath, "utf8")).toBe(canonical.slice(0, -11));

			const decoded = JSON.parse(canonical) as Record<string, unknown>;
			decoded.unexpected = "must fail closed";
			writeFileSync(filePath, `${JSON.stringify(decoded)}\n`, "utf8");
			expect(resultError(recoveryStore.validate(first)).code).toBe("corrupted_log");

			const digestMismatch = JSON.parse(canonical) as { stateRevision: number };
			digestMismatch.stateRevision += 1;
			writeFileSync(filePath, `${JSON.stringify(digestMismatch)}\n`, "utf8");
			expect(resultError(recoveryStore.validate(first)).code).toBe("corrupted_log");
		});
	});
});
