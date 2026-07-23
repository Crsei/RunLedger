import { describe, expect, it } from "vitest";
import { createSessionEventStreamRef } from "../../../src/runtime/protocol/v3/events.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/v3/ids.ts";
import type { RuntimeInstanceId, TenantId } from "../../../src/runtime/protocol/v3/ids.ts";
import {
	digestWriterFencingToken,
	InMemoryWriterLeaseStore,
} from "../../../src/runtime/session/writer-lease.ts";
import type { MemoryWriterLeaseStoreOptions } from "../../../src/runtime/session/writer-lease.ts";
import type { SessionResult, WriterFence } from "../../../src/runtime/session/types.ts";

const START_MS = Date.parse("2026-07-22T00:00:00.000Z");
const AUTHORITY_ID = createRuntimeId("authority", "fixture");
const TENANT_ID = createRuntimeId("tenant", "fixture");
const SESSION_ID = createRuntimeId("session", "fixture");
const STREAM = createSessionEventStreamRef({ authorityId: AUTHORITY_ID, tenantId: TENANT_ID }, SESSION_ID);
const OWNER_A = createRuntimeId("runtime", "owner-a");
const OWNER_B = createRuntimeId("runtime", "owner-b");
const OWNER_C = createRuntimeId("runtime", "owner-c");
const TOKEN_A = "A".repeat(43);
const TOKEN_B = "B".repeat(43);
const TOKEN_C = "C".repeat(43);

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

function createHarness(tokens: string[] = [TOKEN_A, TOKEN_B, TOKEN_C]) {
	let nowMs = START_MS;
	let leaseId = 0;
	const pendingTokens = [...tokens];
	const options: MemoryWriterLeaseStoreOptions = {
		now: () => new Date(nowMs),
		tokenFactory: () => pendingTokens.shift() ?? TOKEN_C,
		leaseIdFactory: () => createRuntimeId("lease", `fixture-${++leaseId}`),
	};
	return {
		store: new InMemoryWriterLeaseStore(options),
		advance(ms: number): void {
			nowMs += ms;
		},
	};
}

function acquire(
	store: InMemoryWriterLeaseStore,
	ownerRuntimeId: RuntimeInstanceId = OWNER_A,
	tenantId: TenantId = TENANT_ID,
	durationMs = 1_000,
) {
	return store.acquire({
		authorityId: AUTHORITY_ID,
		tenantId,
		stream: createSessionEventStreamRef({ authorityId: AUTHORITY_ID, tenantId }, SESSION_ID),
		ownerRuntimeId,
		durationMs,
	});
}

describe("InMemoryWriterLeaseStore", () => {
	it("acquires a scoped random fence and rejects a concurrent writer", () => {
		const harness = createHarness();
		const lease = resultValue(acquire(harness.store));

		expect(lease.authorityId).toBe(AUTHORITY_ID);
		expect(lease.tenantId).toBe(TENANT_ID);
		expect(lease.stream).toEqual(STREAM);
		expect(lease.leaseId).toBe(createRuntimeId("lease", "fixture-1"));
		expect(lease.ownerRuntimeId).toBe(OWNER_A);
		expect(lease.writerEpoch).toBe(1);
		expect(lease.fencingToken).toBe(TOKEN_A);
		expect(lease.fencingTokenDigest).toBe(digestWriterFencingToken(TOKEN_A));
		expect(lease.fencingTokenDigest).toMatch(/^[a-f0-9]{64}$/);
		expect(lease.acquiredAt).toBe("2026-07-22T00:00:00.000Z");
		expect(lease.renewedAt).toBe(lease.acquiredAt);
		expect(lease.expiresAt).toBe("2026-07-22T00:00:01.000Z");
		expect(resultValue(harness.store.validate(lease))).toEqual(lease);

		const busy = resultError(acquire(harness.store, OWNER_B));
		expect(busy.code).toBe("writer_fenced");
		expect(busy.retryable).toBe(true);

		const otherTenant = resultValue(acquire(harness.store, OWNER_B, createRuntimeId("tenant", "other")));
		expect(otherTenant.writerEpoch).toBe(1);
		expect(otherTenant.tenantId).toBe(createRuntimeId("tenant", "other"));
	});

	it("renews by exact fence and never revives an expired heartbeat", () => {
		const harness = createHarness();
		const lease = resultValue(acquire(harness.store));
		harness.advance(400);

		const renewed = resultValue(harness.store.heartbeat(lease, 2_000));
		expect(renewed.leaseId).toBe(lease.leaseId);
		expect(renewed.writerEpoch).toBe(lease.writerEpoch);
		expect(renewed.fencingToken).toBe(lease.fencingToken);
		expect(renewed.acquiredAt).toBe(lease.acquiredAt);
		expect(renewed.renewedAt).toBe("2026-07-22T00:00:00.400Z");
		expect(renewed.expiresAt).toBe("2026-07-22T00:00:02.400Z");

		const wrongFence = { ...renewed, fencingToken: TOKEN_B } satisfies WriterFence;
		expect(resultError(harness.store.renew(wrongFence)).code).toBe("writer_fenced");
		expect(resultValue(harness.store.validate(lease)).writerEpoch).toBe(1);

		harness.advance(2_000);
		expect(resultError(harness.store.heartbeat(renewed)).code).toBe("writer_fenced");
		expect(resultError(harness.store.validate(renewed)).code).toBe("writer_fenced");
	});

	it("takes over only a stale CAS value and permanently retires old tokens", () => {
		const harness = createHarness([TOKEN_A, TOKEN_A, TOKEN_B, TOKEN_B, TOKEN_C]);
		const first = resultValue(acquire(harness.store));
		harness.advance(999);

		const early = resultError(
			harness.store.takeover({ expectedFence: first, ownerRuntimeId: OWNER_B, durationMs: 1_000 }),
		);
		expect(early.code).toBe("writer_fenced");
		expect(early.retryable).toBe(true);

		harness.advance(1);
		const second = resultValue(
			harness.store.takeover({ expectedFence: first, ownerRuntimeId: OWNER_B, durationMs: 1_000 }),
		);
		expect(second.writerEpoch).toBe(2);
		expect(second.ownerRuntimeId).toBe(OWNER_B);
		expect(second.leaseId).not.toBe(first.leaseId);
		expect(second.fencingToken).toBe(TOKEN_B);
		expect(resultError(harness.store.validate(first)).code).toBe("writer_fenced");
		expect(
			resultError(harness.store.takeover({ expectedFence: first, ownerRuntimeId: OWNER_C })).code,
		).toBe("writer_fenced");

		harness.advance(100);
		resultValue(harness.store.release(second));
		const third = resultValue(acquire(harness.store, OWNER_C));
		expect(third.writerEpoch).toBe(3);
		expect(third.fencingToken).toBe(TOKEN_C);
		expect(resultError(harness.store.validate(first)).code).toBe("writer_fenced");
		expect(resultError(harness.store.validate(second)).code).toBe("writer_fenced");
	});

	it("releases only the current CAS fence and returns expected failures", () => {
		const harness = createHarness();
		const lease = resultValue(acquire(harness.store));
		const wrongOwner = { ...lease, ownerRuntimeId: OWNER_B } satisfies WriterFence;

		expect(resultError(harness.store.release(wrongOwner)).code).toBe("writer_fenced");
		expect(resultValue(harness.store.validate(lease)).leaseId).toBe(lease.leaseId);

		harness.advance(100);
		const released = resultValue(harness.store.release(lease));
		expect(released.releasedAt).toBe("2026-07-22T00:00:00.100Z");
		expect(resultError(harness.store.validate(lease)).code).toBe("writer_fenced");
		expect(resultError(harness.store.release(lease)).code).toBe("writer_fenced");
		expect(resultError(harness.store.heartbeat(lease)).code).toBe("writer_fenced");

		const next = resultValue(acquire(harness.store, OWNER_B));
		expect(next.writerEpoch).toBe(2);
	});

	it("encodes invalid input, clock, and token generation as SessionResult failures", () => {
		const harness = createHarness();
		expect(resultError(acquire(harness.store, OWNER_A, TENANT_ID, 0)).code).toBe("invalid_event");
		expect(
			resultError(
				harness.store.acquire({
					authorityId: "authority/invalid" as typeof AUTHORITY_ID,
					tenantId: TENANT_ID,
					stream: STREAM,
					ownerRuntimeId: OWNER_A,
				}),
			).code,
		).toBe("identity_mismatch");
		const valid = resultValue(acquire(harness.store));
		const malformedToken = {
			...valid,
			fencingToken: Symbol("invalid-token") as unknown as string,
		} satisfies WriterFence;
		expect(resultError(harness.store.validate(malformedToken)).code).toBe("identity_mismatch");

		const clockFailure = new InMemoryWriterLeaseStore({
			now: () => {
				throw new Error("clock unavailable");
			},
		});
		expect(resultError(acquire(clockFailure)).code).toBe("durable_write_failed");

		const tokenFailure = new InMemoryWriterLeaseStore({ tokenFactory: () => "too-short" });
		expect(resultError(acquire(tokenFailure)).code).toBe("durable_write_failed");
	});

	it("returns snapshots that cannot mutate the stored lease", () => {
		const harness = createHarness();
		const lease = resultValue(acquire(harness.store));
		const fence: WriterFence = { ...lease };
		lease.writerEpoch = 99;
		lease.fencingToken = TOKEN_C;
		lease.expiresAt = "1970-01-01T00:00:00.000Z";

		const stored = resultValue(harness.store.validate(fence));
		expect(stored.writerEpoch).toBe(1);
		expect(stored.fencingToken).toBe(TOKEN_A);
		expect(stored.expiresAt).toBe("2026-07-22T00:00:01.000Z");
	});
});
