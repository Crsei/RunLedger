import { describe, expect, it } from "vitest";
import { createLocalIdentityContext } from "../../src/runtime/local-identity.ts";
import { isIdentityContext } from "../../src/runtime/identity/schemas.ts";
import { createRuntimeId } from "../../src/runtime/protocol/ids.ts";

const digest = {
	algorithm: "sha256",
	digest: "b".repeat(64),
} as const;

describe("Runtime identity exact contract", () => {
	it("emits and validates an exact local identity context", () => {
		const identity = createLocalIdentityContext(new Date("2026-08-01T00:00:00.000Z"));

		expect(identity.principalKind).toBe("local");
		expect(identity).not.toHaveProperty("source");
		expect(isIdentityContext(identity)).toBe(true);
		expect(isIdentityContext({ ...identity, cwd: "/tmp/private" })).toBe(false);
		expect(isIdentityContext({ ...identity, authorityId: createRuntimeId("tenant", "wrong") })).toBe(false);
	});

	it("requires service authentication and remote attestation refs", () => {
		const base = {
			authorityId: createRuntimeId("authority", "fixture"),
			tenantId: createRuntimeId("tenant", "fixture"),
			principalId: createRuntimeId("principal", "fixture"),
			issuedAt: "2026-08-01T00:00:00.000Z",
		};
		const authenticationRef = {
			subjectKind: "receipt",
			digest,
		};
		const attestationRef = {
			subjectKind: "attestation",
			digest,
		};

		expect(isIdentityContext({ ...base, principalKind: "service" })).toBe(false);
		expect(isIdentityContext({ ...base, principalKind: "service", authenticationRef })).toBe(true);
		expect(isIdentityContext({ ...base, principalKind: "remote", authenticationRef })).toBe(false);
		expect(isIdentityContext({ ...base, principalKind: "remote", authenticationRef, attestationRef })).toBe(true);
	});
});
