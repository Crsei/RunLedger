import { Check } from "typebox/value";
import { describe, expect, it } from "vitest";
import { createRuntimeId } from "../../../src/runtime/protocol/v3/ids.ts";
import {
	RemoteExecutorInvocationSchema,
	RemoteExecutorResultReceiptSchema,
	SessionHandoffManifestSchema,
	SessionHandoffReceiptSchema,
	handoffReceiptMatchesManifest,
	isRemoteExecutorInvocation,
	isRemoteExecutorResultReceipt,
	isSessionHandoffManifest,
	remoteExecutorResultMatchesInvocation,
} from "../../../src/runtime/executors/receipts.ts";
import { handoff, handoffReceipt, invocation, result } from "./helpers.ts";

describe("remote executor receipts", () => {
	it("binds invocation/result to tenant, workspace lease, gate, Artifact and event identities", () => {
		const request = invocation();
		const receipt = result(request);
		expect(Check(RemoteExecutorInvocationSchema, request)).toBe(true);
		expect(isRemoteExecutorInvocation(request)).toBe(true);
		expect(Check(RemoteExecutorResultReceiptSchema, receipt)).toBe(true);
		expect(isRemoteExecutorResultReceipt(receipt)).toBe(true);
		expect(remoteExecutorResultMatchesInvocation(receipt, request)).toBe(true);
		expect(remoteExecutorResultMatchesInvocation({ ...receipt, tenantId: createRuntimeId("tenant", "forged") }, request)).toBe(false);
	});

	it("rejects unknown receipt fields and tampered digests", () => {
		const request = invocation();
		expect(Check(RemoteExecutorInvocationSchema, { ...request, runnerToken: "secret" })).toBe(false);
		expect(isRemoteExecutorInvocation({ ...request, invocationDigest: "f".repeat(64) })).toBe(false);
		expect(Check(RemoteExecutorResultReceiptSchema, { ...result(request), stdout: "raw output" })).toBe(false);
	});
});

describe("signed session handoff", () => {
	it("carries event head, Artifact refs and lease transfer without naked credential", () => {
		const manifest = handoff();
		const receipt = handoffReceipt(manifest);
		expect(Check(SessionHandoffManifestSchema, manifest)).toBe(true);
		expect(isSessionHandoffManifest(manifest)).toBe(true);
		expect(Check(SessionHandoffReceiptSchema, receipt)).toBe(true);
		expect(handoffReceiptMatchesManifest(receipt, manifest)).toBe(true);
		const serialized = JSON.stringify(manifest);
		expect(serialized).not.toMatch(/credential|fencingToken|runnerToken|secret/u);
		expect(Check(SessionHandoffManifestSchema, { ...manifest, credential: "secret" })).toBe(false);
	});
});
