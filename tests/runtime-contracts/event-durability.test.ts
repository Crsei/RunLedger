import { describe, expect, it } from "vitest";
import {
	isAppendEventOutcome,
	isDurableEventReceipt,
	isRuntimeEventRangeRef,
} from "../../src/runtime/protocol/schemas.ts";
import { createRuntimeId } from "../../src/runtime/protocol/ids.ts";

const digest = {
	algorithm: "sha256",
	digest: "c".repeat(64),
} as const;

const stream = {
	scope: "session",
	streamId: createRuntimeId("session", "durability"),
	sessionId: createRuntimeId("session", "durability"),
} as const;

describe("Runtime event durability contracts", () => {
	it("distinguishes a durable receipt from accepted progress", () => {
		const receipt = {
			receiptId: createRuntimeId("receipt", "durability"),
			stream,
			cursor: "cursor-1",
			sequence: 3,
			eventHash: digest,
			writerEpoch: 2,
			durableAt: "2026-08-01T00:00:00.000Z",
		};

		expect(isDurableEventReceipt(receipt)).toBe(true);
		expect(isDurableEventReceipt({ ...receipt, writerEpoch: -1 })).toBe(false);
		expect(isDurableEventReceipt({ ...receipt, acceptedAt: receipt.durableAt })).toBe(false);
		expect(isAppendEventOutcome({
			outcome: "accepted",
			eventId: createRuntimeId("event", "durability"),
			stream,
			sequence: 3,
			acceptedAt: "2026-08-01T00:00:00.000Z",
		})).toBe(true);
		expect(isAppendEventOutcome({ outcome: "durable", receipt })).toBe(true);
		expect(isAppendEventOutcome({ outcome: "accepted", receipt })).toBe(false);
	});

	it("validates rejected and uncertain append outcomes as exact branches", () => {
		const error = {
			code: "contract_unavailable",
			message: "writer unavailable",
			retryable: true,
			correlationId: createRuntimeId("trace", "durability"),
		};
		expect(isAppendEventOutcome({ outcome: "rejected", error })).toBe(true);
		expect(isAppendEventOutcome({
			outcome: "uncertain",
			eventId: createRuntimeId("event", "durability"),
			stream,
			error,
		})).toBe(true);
		expect(isAppendEventOutcome({ outcome: "future", error })).toBe(false);
	});

	it("binds event ranges to a source stream head", () => {
		const range = {
			stream,
			startSequence: 1,
			endSequence: 3,
			head: {
				streamId: createRuntimeId("session", "durability"),
				sequence: 3,
				eventHash: digest,
			},
			rangeDigest: digest,
			complete: true,
		};

		expect(isRuntimeEventRangeRef(range)).toBe(true);
		expect(isRuntimeEventRangeRef({ ...range, startSequence: 4 })).toBe(false);
		expect(isRuntimeEventRangeRef({ ...range, head: { ...range.head, streamId: createRuntimeId("session", "other") } })).toBe(false);
	});
});
