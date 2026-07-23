import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { RuntimeEventPayloadMap } from "../../../src/runtime/protocol/v3/event-payloads.ts";
import type { RuntimeEventType } from "../../../src/runtime/protocol/v3/event-catalog.ts";
import {
	createSessionEventStreamRef,
	RUNTIME_SCHEMA_VERSION,
	type RuntimeEventEnvelopeV3,
} from "../../../src/runtime/protocol/v3/events.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/v3/ids.ts";
import { validateRuntimeEvent } from "../../../src/runtime/protocol/v3/schemas.ts";
import {
	WORKSPACE_EVENT_PAYLOAD_SCHEMAS,
	WORKSPACE_RUNTIME_EVENT_TYPES,
} from "../../../src/runtime/protocol/v3/workspace-events.ts";
import {
	isWorkspaceBindingRef,
	isWorkspaceCheckpointDescriptor,
	isWorkspaceLeaseRef,
	isWorkspaceValidationReceiptRef,
	workspaceBindingDigest,
	type WorkspaceBindingRef,
	type WorkspaceCheckpointDescriptor,
	type WorkspaceLeaseRef,
	type WorkspaceValidationReceiptRef,
} from "../../../src/runtime/protocol/v3/workspace.ts";

const DIGEST = "a".repeat(64);
const AUTHORITY_ID = createRuntimeId("authority", "fixture");
const TENANT_ID = createRuntimeId("tenant", "fixture");
const PRINCIPAL_ID = createRuntimeId("principal", "fixture");
const SESSION_ID = createRuntimeId("session", "fixture");
const STREAM = createSessionEventStreamRef({ authorityId: AUTHORITY_ID, tenantId: TENANT_ID }, SESSION_ID);

interface Fixture {
	binding: unknown;
	lease: unknown;
	validation: unknown;
	checkpoint: unknown;
}

function fixture(): {
	binding: WorkspaceBindingRef;
	lease: WorkspaceLeaseRef;
	validation: WorkspaceValidationReceiptRef;
	checkpoint: WorkspaceCheckpointDescriptor;
} {
	const path = fileURLToPath(new URL("./fixtures/workspace-contract-v1.json", import.meta.url));
	const parsed = JSON.parse(readFileSync(path, "utf8")) as Fixture;
	if (
		!isWorkspaceBindingRef(parsed.binding) ||
		!isWorkspaceLeaseRef(parsed.lease) ||
		!isWorkspaceValidationReceiptRef(parsed.validation) ||
		!isWorkspaceCheckpointDescriptor(parsed.checkpoint)
	) {
		throw new Error("invalid workspace golden fixture");
	}
	return {
		binding: parsed.binding,
		lease: parsed.lease,
		validation: parsed.validation,
		checkpoint: parsed.checkpoint,
	};
}

function event<TType extends RuntimeEventType>(
	type: TType,
	payload: RuntimeEventPayloadMap[TType],
): RuntimeEventEnvelopeV3<TType> {
	return {
		schemaVersion: RUNTIME_SCHEMA_VERSION,
		authorityId: AUTHORITY_ID,
		tenantId: TENANT_ID,
		principalId: PRINCIPAL_ID,
		eventId: createRuntimeId("event", `workspace-${type.replaceAll(".", "-")}`),
		stream: STREAM,
		sequence: 0,
		timestamp: "2026-07-22T00:00:02.000Z",
		type,
		previousEventHash: null,
		payloadDigest: DIGEST,
		currentEventHash: DIGEST,
		traceId: createRuntimeId("trace", "workspace-fixture"),
		payload,
	};
}

describe("Workspace v3 event payloads", () => {
	it("registers all workspace and lease schemas without a second event catalog", () => {
		expect(Object.keys(WORKSPACE_EVENT_PAYLOAD_SCHEMAS)).toEqual([...WORKSPACE_RUNTIME_EVENT_TYPES]);
		expect(new Set(Object.values(WORKSPACE_EVENT_PAYLOAD_SCHEMAS)).size).toBe(WORKSPACE_RUNTIME_EVENT_TYPES.length);
	});

	it("accepts the six exhaustive payload shapes", () => {
		const { binding, lease, validation, checkpoint } = fixture();
		const nextLease: WorkspaceLeaseRef = {
			...lease,
			ownerRuntimeId: createRuntimeId("runtime", "takeover"),
			leaseRevision: lease.leaseRevision + 1,
		};
		const releasedLease: WorkspaceLeaseRef = { ...nextLease, state: "revoked" };
		const samples = [
			event("workspace.bound", {
				binding,
				bindingDigest: workspaceBindingDigest(binding),
				lease,
				checkpoint,
			}),
			event("workspace.validation_recorded", {
				validation,
				expectedEnvelopeDigest: validation.envelopeDigest,
			}),
			event("workspace.released", {
				workspaceId: binding.workspaceId,
				leaseId: lease.leaseId,
				leaseRevision: lease.leaseRevision,
				bindingDigest: workspaceBindingDigest(binding),
				receiptId: createRuntimeId("receipt", "workspace-release"),
				checkpoint,
			}),
			event("lease.acquired", {
				lease,
				receiptId: createRuntimeId("receipt", "lease-acquire"),
			}),
			event("lease.taken_over", {
				previousOwnerRuntimeId: lease.ownerRuntimeId,
				previousLeaseRevision: lease.leaseRevision,
				lease: nextLease,
				receiptId: createRuntimeId("receipt", "lease-takeover"),
			}),
			event("lease.released", {
				lease: releasedLease,
				receiptId: createRuntimeId("receipt", "lease-release"),
				reasonDigest: DIGEST,
			}),
		];

		for (const sample of samples) expect(validateRuntimeEvent(sample), sample.type).toMatchObject({ ok: true });
	});

	it("rejects missing, unknown, and nested unknown payload fields", () => {
		const { binding, lease } = fixture();
		const valid = event("workspace.bound", {
			binding,
			bindingDigest: workspaceBindingDigest(binding),
			lease,
		});
		const { lease: _lease, ...missingLease } = valid.payload;

		expect(validateRuntimeEvent({ ...valid, payload: missingLease })).toMatchObject({
			ok: false,
			code: "invalid_schema",
		});
		expect(validateRuntimeEvent({ ...valid, payload: { ...valid.payload, future: true } })).toMatchObject({
			ok: false,
			code: "unknown_field",
		});
		expect(
			validateRuntimeEvent({
				...valid,
				payload: { ...valid.payload, binding: { ...binding, future: true } },
			}),
		).toMatchObject({ ok: false });
	});

	it("fails closed on a future workspace event version", () => {
		const { binding, lease } = fixture();
		const valid = event("workspace.bound", {
			binding,
			bindingDigest: workspaceBindingDigest(binding),
			lease,
		});
		expect(validateRuntimeEvent({ ...valid, schemaVersion: 4 })).toMatchObject({
			ok: false,
			code: "unknown_schema_version",
		});
	});
});
