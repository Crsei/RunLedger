import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	isResourceIdentity,
	isResourceManifestDigest,
	resourceIdentityDigest,
	resourceIdentityKey,
} from "../../../src/runtime/resources/schemas.ts";
import type { ResourceIdentity, ResourceManifestDigest } from "../../../src/runtime/resources/types.ts";

interface ResourceGoldenFixture {
	contract: string;
	manifest: ResourceManifestDigest;
	identity: ResourceIdentity;
	expectedIdentityKey: string;
	expectedIdentityDigest: string;
}

function loadFixture(): ResourceGoldenFixture {
	const contents = readFileSync(
		new URL("./fixtures/resource-contract-v1.json", import.meta.url),
		"utf8",
	);
	return JSON.parse(contents) as ResourceGoldenFixture;
}

describe("resource contract v1 golden fixture", () => {
	it("keeps serialized identity and manifest digests stable", () => {
		const fixture = loadFixture();
		expect(fixture.contract).toBe("runledger.resource/v1");
		expect(isResourceManifestDigest(fixture.manifest)).toBe(true);
		expect(isResourceIdentity(fixture.identity)).toBe(true);
		expect(fixture.identity.digest).toBe(fixture.manifest.combinedDigest);
		expect(resourceIdentityKey(fixture.identity)).toBe(fixture.expectedIdentityKey);
		expect(resourceIdentityDigest(fixture.identity)).toBe(fixture.expectedIdentityDigest);
	});
});
