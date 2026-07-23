import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Check } from "typebox/value";
import { MODEL_ROUTING_CONTRACT_VERSION } from "../../src/runtime/model-routing/types.ts";
import { runtimeEventPayloadSchema } from "../../src/runtime/protocol/v3/event-payloads.ts";

function fixture(path: string): unknown {
	return JSON.parse(
		readFileSync(new URL(`./fixtures/${path}`, import.meta.url), "utf8"),
	) as unknown;
}

describe("Phase 6 v2 RED gate", () => {
	it("requires Model Routing v2 while retaining Plan/Context/Memory v1", () => {
		expect(MODEL_ROUTING_CONTRACT_VERSION).toBe(2);
	});

	it("requires exact parity and catalog bindings in the v2 fixture", () => {
		expect(fixture("model-routing/v2-bindings.json")).toMatchObject({
			piAiParityManifestDigest: "fcb4713c661a7de0732d9f1379bbbc0525250ebcdd7027186d076cddcd938d77",
			catalogDigest: "14f43c2629e3aa082691c730ab7ae7c1a65ef092ad7135f52601f161fd1cded7",
			upstreamCommit: "3f1762cc7d3af39898aa5d21891335935011287f",
		});
	});

	it("requires the exact v2 model.routed event branch for current producers", () => {
		expect(Check(runtimeEventPayloadSchema("model.routed"), {
			turnId: "turn_fixture",
			routeRequestId: "command_route",
			decisionId: "receipt_route",
			decisionDigest: "a".repeat(64),
			outcome: "compatible",
			profileId: "resource_profile",
			manifestDigest: "b".repeat(64),
			profileDigest: "c".repeat(64),
			routeContractVersion: 2,
			conversionReceiptId: "receipt_conversion",
			conversionReceiptDigest: "d".repeat(64),
		})).toBe(true);
	});

	it("requires an explicit compaction recovery assessment API", () => {
		const source = readFileSync(
			new URL("../../src/runtime/context/compaction/validator.ts", import.meta.url),
			"utf8",
		);
		expect(source).toContain("assessCompactionRecovery");
		expect(fixture("compaction/recovery-failures-v1.json")).toMatchObject({
			cases: expect.arrayContaining([
				{ name: "invalid-window", expected: "invalid" },
				{ name: "suffix-jsonl-corruption", expected: "corrupted" },
			]),
		});
	});
});
