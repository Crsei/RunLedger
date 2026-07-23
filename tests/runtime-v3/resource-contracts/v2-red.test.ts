import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	isResourceIdentity,
	isResourceManifestDigest,
	resourceIdentityDigest,
} from "../../../src/runtime/resources/schemas.ts";
import {
	RESOURCE_CONTRACT_SCHEMA_VERSION,
	RESOURCE_KINDS,
	RESOURCE_PROTOCOL_VERSION,
} from "../../../src/runtime/resources/types.ts";

function fixture(name: string): unknown {
	return JSON.parse(
		readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"),
	) as unknown;
}

describe("resource contract v2 RED gate", () => {
	it("requires v2 as the unqualified public contract", () => {
		expect(RESOURCE_CONTRACT_SCHEMA_VERSION).toBe(2);
		expect(RESOURCE_PROTOCOL_VERSION).toBe(2);
	});

	it("uses exact instruction kinds and removes the ambiguous v1 kind", () => {
		expect(RESOURCE_KINDS).toContain("repository-instruction");
		expect(RESOURCE_KINDS).toContain("user-instruction");
		expect(RESOURCE_KINDS).toContain("organization-instruction");
		expect(RESOURCE_KINDS).not.toContain("instruction");
	});

	it("accepts the v2 golden identity while keeping v1 outside the current parser", () => {
		const current = fixture("resource-contract-v2.json") as {
			manifest: unknown;
			identity: unknown;
			expectedIdentityDigest: string;
		};
		const legacy = fixture("resource-contract-v1.json") as { identity: unknown };
		expect(isResourceManifestDigest(current.manifest)).toBe(true);
		expect(isResourceIdentity(current.identity)).toBe(true);
		expect(resourceIdentityDigest(current.identity as Parameters<typeof resourceIdentityDigest>[0]))
			.toBe(current.expectedIdentityDigest);
		expect(isResourceIdentity(legacy.identity)).toBe(false);
	});
});
