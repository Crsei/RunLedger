import { describe, expect, it } from "vitest";
import { canonicalDigest, canonicalJson } from "../../src/runtime/protocol/v3/canonical-json.ts";

describe("Runtime v3 canonical JSON scaffold", () => {
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
});
