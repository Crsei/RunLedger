import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { canonicalDigest, canonicalJson, canonicalUtf8 } from "../../src/runtime/protocol/v3/canonical-json.ts";
import { computeRuntimeEventHash } from "../../src/runtime/protocol/v3/event-hash.ts";
import { createSessionEventStreamRef } from "../../src/runtime/protocol/v3/events.ts";
import { createRuntimeId } from "../../src/runtime/protocol/v3/ids.ts";

interface CanonicalVector {
	name: string;
	input: unknown;
	canonical: string;
	sha256: string;
}

function vectors(): CanonicalVector[] {
	const path = fileURLToPath(new URL("../fixtures/runtime-v3/canonical-vectors.json", import.meta.url));
	const fixture = JSON.parse(readFileSync(path, "utf8")) as { version: number; vectors: CanonicalVector[] };
	expect(fixture.version).toBe(1);
	return fixture.vectors;
}

describe("Runtime v3 canonical JSON", () => {
	it("matches frozen UTF-8 canonical and SHA-256 vectors", () => {
		for (const vector of vectors()) {
			expect(canonicalJson(vector.input), vector.name).toBe(vector.canonical);
			expect(canonicalDigest(vector.input), vector.name).toBe(vector.sha256);
			expect(Buffer.from(canonicalUtf8(vector.input)).toString("utf8"), vector.name).toBe(vector.canonical);
			expect(vector.canonical.endsWith("\n"), vector.name).toBe(false);
		}
	});

	it("normalizes negative zero but rejects unsafe or non-finite numbers", () => {
		expect(canonicalJson({ value: -0 })).toBe('{"value":0}');
		expect(() => canonicalJson({ value: Number.MAX_SAFE_INTEGER + 1 })).toThrow("unsafe integer");
		expect(() => canonicalJson({ value: Number.NaN })).toThrow("non-finite number");
	});

	it("rejects unsupported, cyclic, non-plain and malformed Unicode values", () => {
		expect(() => canonicalJson({ value: undefined })).toThrow("unsupported value");
		expect(() => canonicalJson(new Date("2026-07-22T00:00:00.000Z"))).toThrow("non-plain object");
		expect(() => canonicalJson({ value: "\ud800" })).toThrow("lone high surrogate");
		const sparse = new Array<unknown>(1);
		expect(() => canonicalJson(sparse)).toThrow("sparse array");
		const symbolKey = { ok: true } as Record<PropertyKey, unknown>;
		symbolKey[Symbol("hidden")] = true;
		expect(() => canonicalJson(symbolKey)).toThrow("symbol key");
		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;
		expect(() => canonicalJson(cyclic)).toThrow("cyclic value");
	});

	it("freezes the event hash input fields", () => {
		const authorityId = createRuntimeId("authority", "local");
		const tenantId = createRuntimeId("tenant", "local");
		const sessionId = createRuntimeId("session", "fixture");
		const hash = computeRuntimeEventHash({
			schemaVersion: 3,
			authorityId,
			tenantId,
			principalId: createRuntimeId("principal", "fixture"),
			eventId: createRuntimeId("event", "0001"),
			stream: createSessionEventStreamRef({ authorityId, tenantId }, sessionId),
			sequence: 0,
			timestamp: "2026-07-22T00:00:00.000Z",
			type: "session.created",
			previousEventHash: null,
			payloadDigest: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
			traceId: createRuntimeId("trace", "fixture"),
		});
		expect(hash).toBe("c79bb97582df3da14aa99eaba4547f3497a1410edade5e0a34cc2d5ec4f19673");
	});
});
