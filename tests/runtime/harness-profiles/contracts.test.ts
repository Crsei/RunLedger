import { describe, expect, it } from "vitest";
import {
	isHarnessProfileDescriptor,
	isHarnessProfileRef,
	minimalHarnessProfileRef,
	resolveHarnessProfile,
	standardHarnessProfileRef,
} from "../../../src/runtime/harness-profiles/index.ts";

describe("HarnessProfile contracts", () => {
	it("exposes exact refs and rejects unknown fields", () => {
		const standard = standardHarnessProfileRef();
		expect(isHarnessProfileRef(standard)).toBe(true);
		expect(isHarnessProfileRef({ ...standard, authority: "user" })).toBe(false);
		expect(isHarnessProfileRef({ ...standard, id: "custom" })).toBe(false);
		expect(isHarnessProfileRef({ ...standard, version: 3 })).toBe(false);
		expect(isHarnessProfileRef({ ...standard, descriptorDigest: { algorithm: "sha256", digest: "f".repeat(63) } })).toBe(false);
	});

	it("validates descriptor shape and cross-field invariants", () => {
		const minimal = resolveHarnessProfile(minimalHarnessProfileRef());
		expect(minimal.ok).toBe(true);
		if (!minimal.ok) return;
		expect(isHarnessProfileDescriptor(minimal.descriptor)).toBe(true);
		expect(isHarnessProfileDescriptor({ ...minimal.descriptor, executable: true })).toBe(false);
		expect(isHarnessProfileDescriptor({
			...minimal.descriptor,
			prompt: { mode: "complete" },
		})).toBe(false);
		expect(isHarnessProfileDescriptor({
			...minimal.descriptor,
			tools: { ...minimal.descriptor.tools, allowlist: ["bash", "bash"] },
		})).toBe(false);
	});

	it("fails closed when a stored ref does not match the builtin descriptor", () => {
		const standard = standardHarnessProfileRef();
		const mismatch = resolveHarnessProfile({
			...standard,
			descriptorDigest: { algorithm: "sha256", digest: "0".repeat(64) },
		});
		expect(mismatch).toMatchObject({
			ok: false,
			error: { code: "harness_profile_digest_mismatch" },
		});
		expect(resolveHarnessProfile({ ...standard, version: 3 })).toMatchObject({
			ok: false,
			error: { code: "unsupported_harness_profile" },
		});
	});
});
