import { describe, expect, it } from "vitest";
import { createRuntimeId } from "../../src/runtime/protocol/ids.ts";
import {
	isCanonicalUtcTimestamp,
	isRuntimeContentRef,
	isRuntimeDigest,
	isRuntimeErrorShape,
	isRuntimeRevisionRef,
	isRuntimeStreamHead,
} from "../../src/runtime/protocol/foundation-schemas.ts";

const digest = {
	algorithm: "sha256",
	digest: "a".repeat(64),
} as const;

describe("Runtime foundation exact contracts", () => {
	it("validates digests and content refs without accepting unknown fields", () => {
		expect(isRuntimeDigest(digest)).toBe(true);
		expect(isRuntimeDigest({ ...digest, algorithm: "sha512" })).toBe(false);
		expect(isRuntimeDigest({ ...digest, digest: "abc" })).toBe(false);
		expect(isRuntimeDigest({ ...digest, extra: true })).toBe(false);

		const ref = {
			subjectKind: "artifact",
			digest,
			mediaType: "application/json",
			size: 42,
		};
		expect(isRuntimeContentRef(ref)).toBe(true);
		expect(isRuntimeContentRef({ ...ref, size: -1 })).toBe(false);
		expect(isRuntimeContentRef({ ...ref, absolutePath: "/tmp/secret" })).toBe(false);
	});

	it("validates revision and stream-head correlation as exact records", () => {
		const revision = {
			subjectId: createRuntimeId("session", "fixture"),
			revision: 4,
		};
		const head = {
			streamId: createRuntimeId("session", "fixture"),
			sequence: 4,
			eventHash: digest,
		};

		expect(isRuntimeRevisionRef(revision)).toBe(true);
		expect(isRuntimeRevisionRef({ ...revision, revision: 1.5 })).toBe(false);
		expect(isRuntimeStreamHead(head)).toBe(true);
		expect(isRuntimeStreamHead({ ...head, sequence: -1 })).toBe(false);
		expect(isRuntimeStreamHead({ ...head, cursor: "hidden" })).toBe(false);
	});

	it("validates structured errors with correlation and details refs", () => {
		const error = {
			code: "expected_revision_conflict",
			message: "revision mismatch",
			retryable: false,
			correlationId: createRuntimeId("trace", "fixture"),
			detailsRef: {
				subjectKind: "details",
				digest,
				mediaType: "application/json",
				size: 128,
			},
		};

		expect(isRuntimeErrorShape(error)).toBe(true);
		expect(isRuntimeErrorShape({ ...error, code: "future_error" })).toBe(false);
		expect(isRuntimeErrorShape({ ...error, details: { secret: true } })).toBe(false);
		expect(isRuntimeErrorShape({ ...error, message: "x".repeat(2049) })).toBe(false);
	});

	it("accepts only canonical UTC millisecond timestamps", () => {
		expect(isCanonicalUtcTimestamp("2026-08-01T00:00:00.000Z")).toBe(true);
		expect(isCanonicalUtcTimestamp("2026-08-01T00:00:00Z")).toBe(false);
		expect(isCanonicalUtcTimestamp("2026-08-01T08:00:00.000+08:00")).toBe(false);
		expect(isCanonicalUtcTimestamp("2026-02-30T00:00:00.000Z")).toBe(false);
	});
});
