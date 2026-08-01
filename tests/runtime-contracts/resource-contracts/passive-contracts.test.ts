import { describe, expect, it } from "vitest";
import { createRuntimeId } from "../../../src/runtime/protocol/ids.ts";
import {
	isResourceApprovalReceipt,
	isResourceIdentity,
	isResourceLifecycleEvent,
	isRuntimeResourceSnapshot,
	isRuntimeToolDescriptor,
	isRuntimeToolInvocation,
	isRuntimeToolResult,
} from "../../../src/runtime/resources/schemas.ts";

const digest = { algorithm: "sha256", digest: "4".repeat(64) } as const;
const contentRef = { subjectKind: "content", digest, mediaType: "application/schema+json", size: 128 } as const;

const identity = {
	resourceId: createRuntimeId("resource", "fixture-tool"),
	kind: "mcp-tool",
	qualifiedId: "fixture.server/read",
	version: "1.0.0",
	source: "project",
	digest,
} as const;

const descriptor = {
	identity,
	provenance: {
		source: "project",
		sourceLocatorDigest: digest,
		publisher: "fixture-publisher",
	},
	runtimeName: "mcp_fixture_server_read",
	description: "A bounded contract fixture",
	parametersSchemaRef: contentRef,
	claims: [],
	exposure: "deferred",
	isReadOnly: true,
	isDestructive: false,
	isConcurrencySafe: true,
	trust: "trusted",
	activation: "ready",
	descriptorDigest: digest,
} as const;

describe("Runtime resource passive exact contracts", () => {
	it("uses digest locators and exact descriptor schemas", () => {
		expect(isResourceIdentity(identity)).toBe(true);
		expect(isResourceIdentity({ ...identity, digest: "loose-digest" })).toBe(false);
		expect(isRuntimeToolDescriptor(descriptor)).toBe(true);
		expect(isRuntimeToolDescriptor({
			...descriptor,
			provenance: { ...descriptor.provenance, canonicalLocator: "/repo/private/mcp.json" },
		})).toBe(false);
		expect(isRuntimeToolDescriptor({ ...descriptor, handler: () => undefined })).toBe(false);
	});

	it("binds approval and lifecycle records to receipts without executable state", () => {
		const approval = {
			receiptId: createRuntimeId("receipt", "resource-approval"),
			identity,
			manifestDigest: digest,
			configDigest: digest,
			commandDigest: digest,
			assetsDigest: digest,
			capabilityDigest: digest,
			principalId: createRuntimeId("principal", "resource-approval"),
			scope: "session",
			approvedAt: "2026-08-02T00:00:00.000Z",
			revocationRevision: 0,
		};
		const lifecycle = {
			identity,
			state: "approved",
			snapshotId: createRuntimeId("snapshot", "resources"),
			receiptRef: { subjectKind: "receipt", digest },
			reasonCode: "policy_verified",
		};

		expect(isResourceApprovalReceipt(approval)).toBe(true);
		expect(isResourceApprovalReceipt({ ...approval, credential: "raw-secret" })).toBe(false);
		expect(isResourceLifecycleEvent(lifecycle)).toBe(true);
		expect(isResourceLifecycleEvent({ ...lifecycle, process: { pid: 42 } })).toBe(false);
	});

	it("keeps invocation input and results bounded or referenced", () => {
		const invocation = {
			requestId: createRuntimeId("command", "resource-invoke"),
			tool: identity,
			inputDigest: digest,
			inputRef: { subjectKind: "content", digest, mediaType: "application/json", size: 64 },
			requestedClaims: [],
			decisionReceiptRef: { subjectKind: "receipt", digest },
			snapshotId: createRuntimeId("snapshot", "resources"),
			correlationId: createRuntimeId("trace", "resource-invoke"),
		};
		const result = {
			requestId: invocation.requestId,
			tool: identity,
			content: [
				{ type: "text", text: "bounded result" },
				{ type: "content_ref", ref: { subjectKind: "artifact", digest, size: 4096 } },
			],
			outcome: "ok",
			originalBytes: 4_096,
			truncated: false,
			contentDigest: digest,
		};

		expect(isRuntimeToolInvocation(invocation)).toBe(true);
		expect(isRuntimeToolInvocation({ ...invocation, input: { token: "secret" } })).toBe(false);
		expect(isRuntimeToolResult(result)).toBe(true);
		expect(isRuntimeToolResult({ ...result, content: [{ type: "text", text: "x".repeat(4097) }] })).toBe(false);
	});

	it("requires snapshots to bind source heads, digest, and bounded diagnostics", () => {
		const snapshot = {
			snapshotId: createRuntimeId("snapshot", "resources"),
			generation: 2,
			createdAt: "2026-08-02T00:00:00.000Z",
			sourceHead: {
				streamId: createRuntimeId("session", "resources"),
				sequence: 8,
				eventHash: digest,
			},
			resources: [descriptor],
			diagnostics: [{ code: "resource_ready", severity: "info", message: "ready", resourceId: identity.resourceId }],
			digest,
			completeness: "complete",
		};

		expect(isRuntimeResourceSnapshot(snapshot)).toBe(true);
		expect(isRuntimeResourceSnapshot({ ...snapshot, grantsCapability: true })).toBe(false);
		expect(isRuntimeResourceSnapshot({
			...snapshot,
			diagnostics: [{ code: "oversize", severity: "error", message: "x".repeat(2049) }],
		})).toBe(false);
	});
});
