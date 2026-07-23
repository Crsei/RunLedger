import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	parseLegacyResourceIdentityV1,
	parseLegacyResourceManifestDigestV1,
} from "../../../src/runtime/resources/legacy-v1.ts";

interface ResourceGoldenFixture {
	contract: string;
	manifest: unknown;
	identity: unknown;
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
		const manifest = parseLegacyResourceManifestDigestV1(fixture.manifest);
		const identity = parseLegacyResourceIdentityV1(fixture.identity);
		expect(manifest).toBeDefined();
		expect(identity).toBeDefined();
		expect(identity?.digest).toBe(manifest?.combinedDigest);
		expect(fixture.expectedIdentityKey).toContain(identity?.qualifiedId);
		expect(fixture.expectedIdentityDigest).toMatch(/^[a-f0-9]{64}$/u);
	});
});
