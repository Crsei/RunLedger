import { describe, expect, it } from "vitest";
import { Check } from "typebox/value";
import {
	ARTIFACT_KINDS,
	ArtifactRefSchema,
	type ArtifactRef,
} from "../../../src/runtime/protocol/v3/capability.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/v3/ids.ts";

const DIGEST = "a".repeat(64);

function artifact(kind: ArtifactRef["kind"]): ArtifactRef {
	return {
		authorityId: createRuntimeId("authority", "artifact-schema"),
		tenantId: createRuntimeId("tenant", "artifact-schema"),
		artifactId: createRuntimeId("artifact", kind),
		storedDigest: DIGEST,
		kind,
		originalSize: 1,
		storedSize: 1,
		mediaType: "application/octet-stream",
		redaction: "redacted",
		transformReceipt: createRuntimeId("receipt", kind),
	};
}

describe("canonical ArtifactRef schema", () => {
	it("accepts every public artifact kind through one exact schema", () => {
		for (const kind of ARTIFACT_KINDS) expect(Check(ArtifactRefSchema, artifact(kind)), kind).toBe(true);
	});

	it("rejects unknown kinds and unknown fields", () => {
		expect(Check(ArtifactRefSchema, { ...artifact("log"), kind: "future_unknown" })).toBe(false);
		expect(Check(ArtifactRefSchema, { ...artifact("log"), rawContent: "secret" })).toBe(false);
	});
});
