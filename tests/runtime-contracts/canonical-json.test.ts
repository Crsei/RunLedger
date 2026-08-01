import { describe, expect, it } from "vitest";
import { canonicalDigest, canonicalJson } from "../../src/runtime/protocol/canonical-json.ts";

describe("Runtime canonical JSON scaffold", () => {
	it("sorts object keys while preserving array order", () => {
		expect(canonicalJson({ z: 1, a: { d: true, c: [2, 1] } })).toBe('{"a":{"c":[2,1],"d":true},"z":1}');
		expect(canonicalJson({ a: { c: [2, 1], d: true }, z: 1 })).toBe(
			canonicalJson({ z: 1, a: { d: true, c: [2, 1] } }),
		);
		expect(canonicalDigest({ a: 1 })).toBe(canonicalDigest({ a: 1 }));
	});

	it("fails closed for unsupported values", () => {
		expect(() => canonicalJson({ value: Number.NaN })).toThrow("non-finite number");
		expect(() => canonicalJson({ value: undefined })).toThrow("unsupported value");
		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;
		expect(() => canonicalJson(cyclic)).toThrow("cyclic value");
	});

	it("rejects non-JSON object shapes instead of silently rewriting them", () => {
		class Fixture {
			public value = 1;
		}

		expect(() => canonicalJson(new Fixture())).toThrow("non-plain object");
		expect(() => canonicalJson(new Date("2026-08-01T00:00:00.000Z"))).toThrow("non-plain object");
		expect(() => canonicalJson(new Array(1))).toThrow("sparse array");
		expect(() => canonicalJson({ [Symbol("hidden")]: true })).toThrow("symbol key");
	});

	it("freezes UTF-8 and number golden vectors while rejecting invalid Unicode", () => {
		const fixture = { emoji: "你好😀", negativeZero: -0, value: 1.5 };
		expect(canonicalJson(fixture)).toBe('{"emoji":"你好😀","negativeZero":0,"value":1.5}');
		expect(canonicalDigest(fixture)).toBe("12a239c6208785ddb13433a9010977394447f1254c6fc262901d680e0f3ee9ae");
		expect(() => canonicalJson({ invalid: "\uD800" })).toThrow("invalid Unicode");
		expect(() => canonicalJson({ ["\uDC00"]: true })).toThrow("invalid Unicode");
	});
});
