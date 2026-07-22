import type { Static } from "typebox";
import { Check } from "typebox/value";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
	CONTEXT_LAYERS,
} from "../../../src/runtime/context/types.ts";
import {
	ContextAssemblyReceiptSchema,
	ContextAssemblyRequestSchema,
	isContextAssemblyReceipt,
	isContextAssemblyRequest,
	isContextFragment,
	MAX_CONTEXT_FRAGMENT_CHARS,
	MAX_CONTEXT_FRAGMENTS,
} from "../../../src/runtime/context/schema.ts";
import type { ContextAssemblyReceipt, ContextAssemblyRequest } from "../../../src/runtime/context/types.ts";
import { runtimeEventPayloadSchema } from "../../../src/runtime/protocol/v3/event-payloads.ts";
import { asRecord, DIGEST, loadContractFixture } from "./helpers.ts";

function fixture(): Record<string, unknown> {
	return asRecord(loadContractFixture("context/assembled.json"));
}

describe("Phase 6 five-layer Context contracts", () => {
	it("keeps schema static types aligned with public types", () => {
		expectTypeOf<Static<typeof ContextAssemblyRequestSchema>>().toEqualTypeOf<ContextAssemblyRequest>();
		expectTypeOf<Static<typeof ContextAssemblyReceiptSchema>>().toEqualTypeOf<ContextAssemblyReceipt>();
	});

	it("freezes exactly five ordered layers with trust, taint and provenance", () => {
		expect(CONTEXT_LAYERS).toEqual([
			"organization_policy",
			"user_memory",
			"workspace_knowledge",
			"session_memory",
			"turn_context",
		]);
		const request = asRecord(fixture().request);
		const fragments = request.fragments;
		expect(Array.isArray(fragments)).toBe(true);
		if (!Array.isArray(fragments)) throw new Error("invalid fixture");
		expect(fragments.every(isContextFragment)).toBe(true);
		expect(asRecord(fragments[1]).taint).toEqual(["tool_output"]);
	});

	it("round-trips bounded assembly request and omission receipt", () => {
		const value = fixture();
		expect(Check(ContextAssemblyRequestSchema, value.request)).toBe(true);
		expect(isContextAssemblyRequest(value.request)).toBe(true);
		expect(Check(ContextAssemblyReceiptSchema, value.receipt)).toBe(true);
		expect(isContextAssemblyReceipt(value.receipt)).toBe(true);
		expect(isContextAssemblyReceipt(JSON.parse(JSON.stringify(value.receipt)) as unknown)).toBe(true);
	});

	it("fails closed on versions, unknown fields, trust elevation and bounds", () => {
		const request = asRecord(fixture().request);
		const fragments = request.fragments;
		if (!Array.isArray(fragments)) throw new Error("invalid fixture");
		const policy = asRecord(fragments[0]);
		expect(isContextAssemblyRequest({ ...request, schemaVersion: 2 })).toBe(false);
		expect(isContextAssemblyRequest({ ...request, future: true })).toBe(false);
		expect(isContextFragment({ ...policy, taint: ["unverified"] })).toBe(false);
		expect(isContextFragment({ ...policy, content: "x".repeat(MAX_CONTEXT_FRAGMENT_CHARS + 1), maxChars: MAX_CONTEXT_FRAGMENT_CHARS })).toBe(false);
		expect(Check(ContextAssemblyRequestSchema, { ...request, fragments: new Array(MAX_CONTEXT_FRAGMENTS + 1).fill(policy) })).toBe(false);
		expect(isContextAssemblyRequest({ ...request, budget: { ...asRecord(request.budget), reservedOutputTokens: 32768 } })).toBe(false);
	});

	it("registers an exact context receipt event payload", () => {
		const payload = {
			requestId: "contextRequest_fixture",
			receiptId: "receipt_context",
			modelId: "provider/model-a",
			modelProfileId: "resource_profile-a",
			contextDigest: DIGEST,
			receiptDigest: DIGEST,
			includedCount: 1,
			omittedCount: 1,
		};
		expect(Check(runtimeEventPayloadSchema("context.assembled"), payload)).toBe(true);
		expect(Check(runtimeEventPayloadSchema("context.assembled"), { ...payload, future: true })).toBe(false);
	});
});
