import type { Static } from "typebox";
import { Check } from "typebox/value";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
	isMemoryInjectionReceipt,
	isMemoryProposal,
	isMemoryRecord,
	isMemoryRef,
	isMemorySearchReceipt,
	isMemorySearchRequest,
	MAX_MEMORY_SEARCH_RESULTS,
	MemoryInjectionReceiptSchema,
	MemoryProposalSchema,
	MemoryRecordSchema,
	MemorySearchReceiptSchema,
	MemorySearchRequestSchema,
} from "../../../src/runtime/context/memory/schema.ts";
import type { MemoryProposal, MemoryRecord, MemorySearchReceipt } from "../../../src/runtime/context/memory/types.ts";
import { runtimeEventPayloadSchema } from "../../../src/runtime/protocol/v3/event-payloads.ts";
import { asRecord, DIGEST, loadContractFixture } from "./helpers.ts";

function fixture(): Record<string, unknown> {
	return asRecord(loadContractFixture("memory/lifecycle.json"));
}

describe("Phase 6 memory contracts", () => {
	it("keeps schema static types aligned with public types", () => {
		expectTypeOf<Static<typeof MemoryRecordSchema>>().toEqualTypeOf<MemoryRecord>();
		expectTypeOf<Static<typeof MemoryProposalSchema>>().toEqualTypeOf<MemoryProposal>();
		expectTypeOf<Static<typeof MemorySearchReceiptSchema>>().toEqualTypeOf<MemorySearchReceipt>();
	});

	it("round-trips approved records, proposal diffs, bounded search and injection receipts", () => {
		const value = fixture();
		expect(Check(MemoryRecordSchema, value.record)).toBe(true);
		expect(isMemoryRecord(value.record)).toBe(true);
		expect(Check(MemoryProposalSchema, value.proposal)).toBe(true);
		expect(isMemoryProposal(value.proposal)).toBe(true);
		expect(Check(MemorySearchRequestSchema, value.searchRequest)).toBe(true);
		expect(isMemorySearchRequest(value.searchRequest)).toBe(true);
		expect(Check(MemorySearchReceiptSchema, value.searchReceipt)).toBe(true);
		expect(isMemorySearchReceipt(value.searchReceipt)).toBe(true);
		expect(Check(MemoryInjectionReceiptSchema, value.injectionReceipt)).toBe(true);
		expect(isMemoryInjectionReceipt(value.injectionReceipt)).toBe(true);
		expect(isMemoryRecord(JSON.parse(JSON.stringify(value.record)) as unknown)).toBe(true);
	});

	it("represents revoked and expired records without treating them as injectable", () => {
		const value = fixture();
		expect(isMemoryRef(value.revoked)).toBe(true);
		expect(isMemoryRef(value.expired)).toBe(true);
		const injection = asRecord(value.injectionReceipt);
		expect(isMemoryInjectionReceipt({ ...injection, memories: [value.revoked] })).toBe(false);
		expect(isMemoryInjectionReceipt({ ...injection, memories: [value.expired] })).toBe(false);
	});

	it("fails closed on unapproved trust elevation, scope/version drift and search bounds", () => {
		const value = fixture();
		const record = asRecord(value.record);
		const sourceRefs = record.sourceRefs;
		if (!Array.isArray(sourceRefs)) throw new Error("invalid fixture");
		const source = asRecord(sourceRefs[0]);
		const request = asRecord(value.searchRequest);
		expect(isMemoryRecord({ ...record, schemaVersion: 2 })).toBe(false);
		expect(isMemoryRecord({ ...record, future: true })).toBe(false);
		expect(isMemoryRecord({ ...record, sourceRefs: [{ ...source, trust: "untrusted" }] })).toBe(false);
		expect(isMemoryProposal({ ...asRecord(value.proposal), tenantId: "tenant_other" })).toBe(false);
		expect(isMemorySearchRequest({ ...request, maxResults: MAX_MEMORY_SEARCH_RESULTS + 1 })).toBe(false);
		expect(isMemorySearchRequest({ ...request, scopes: [{ scope: "workspace", ownerPrincipalId: "principal_fixture" }] })).toBe(false);
	});

	it("registers proposal, approval, publication, search and injection event metadata", () => {
		expect(Check(runtimeEventPayloadSchema("memory.proposed"), {
			memoryId: "memory_fixture",
			proposalId: "memoryProposal_fixture",
			scope: "workspace",
			contentDigest: DIGEST,
			diffArtifactId: "artifact_memory-diff",
			diffDigest: DIGEST,
			approvalId: "approval_memory",
		})).toBe(true);
		expect(Check(runtimeEventPayloadSchema("memory.approved"), {
			memoryId: "memory_fixture",
			proposalId: "memoryProposal_fixture",
			approvalId: "approval_memory",
			receiptId: "receipt_memory",
		})).toBe(true);
		expect(Check(runtimeEventPayloadSchema("memory.published"), {
			memoryId: "memory_fixture",
			recordDigest: DIGEST,
			publicationReceiptId: "receipt_publication",
		})).toBe(true);
		expect(Check(runtimeEventPayloadSchema("memory.searched"), {
			requestId: "command_search",
			receiptId: "receipt_search",
			queryDigest: DIGEST,
			mode: "lexical",
			resultCount: 1,
			receiptDigest: DIGEST,
		})).toBe(true);
		expect(Check(runtimeEventPayloadSchema("memory.injected"), {
			memoryId: "memory_fixture",
			contextRequestId: "contextRequest_fixture",
			receiptId: "receipt_injection",
			recordDigest: DIGEST,
			receiptDigest: DIGEST,
		})).toBe(true);
	});
});
