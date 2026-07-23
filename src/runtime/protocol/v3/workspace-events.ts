/** Workspace/lease v3 event 的封闭 payload 合同。 */

import { Type, type TSchema } from "typebox";
import { Check } from "typebox/value";
import type { RuntimeInstanceId } from "./ids.ts";
import {
	WorkspaceBindingRefSchema,
	WorkspaceCheckpointDescriptorSchema,
	WorkspaceLeaseRefSchema,
	WorkspaceValidationReceiptRefSchema,
	type WorkspaceBindingRef,
	type WorkspaceCheckpointDescriptor,
	type WorkspaceLeaseRef,
	type WorkspaceValidationReceiptRef,
} from "./workspace.ts";

const runtimeId = (kind: string) =>
	Type.String({ pattern: `^${kind}_[A-Za-z0-9][A-Za-z0-9._~-]*$`, maxLength: 128 });
const digest = Type.String({ pattern: "^[a-f0-9]{64}$", maxLength: 64 });
const revision = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const exact = <T extends Record<string, TSchema>>(properties: T) =>
	Type.Object(properties, { additionalProperties: false });

export const WORKSPACE_RUNTIME_EVENT_TYPES = [
	"workspace.bound",
	"workspace.validation_recorded",
	"workspace.released",
	"lease.acquired",
	"lease.taken_over",
	"lease.released",
] as const;

export type WorkspaceRuntimeEventType = (typeof WORKSPACE_RUNTIME_EVENT_TYPES)[number];

export interface WorkspaceBoundPayload {
	binding: WorkspaceBindingRef;
	bindingDigest: string;
	lease: WorkspaceLeaseRef;
	checkpoint?: WorkspaceCheckpointDescriptor;
}

export interface WorkspaceValidationRecordedPayload {
	validation: WorkspaceValidationReceiptRef;
	expectedEnvelopeDigest: string;
}

export interface WorkspaceReleasedPayload {
	workspaceId: WorkspaceBindingRef["workspaceId"];
	leaseId: WorkspaceLeaseRef["leaseId"];
	leaseRevision: number;
	bindingDigest: string;
	receiptId: WorkspaceValidationReceiptRef["receiptId"];
	checkpoint?: WorkspaceCheckpointDescriptor;
}

export interface LeaseAcquiredPayload {
	lease: WorkspaceLeaseRef;
	receiptId: WorkspaceValidationReceiptRef["receiptId"];
}

export interface LeaseTakenOverPayload {
	previousOwnerRuntimeId: RuntimeInstanceId;
	previousLeaseRevision: number;
	lease: WorkspaceLeaseRef;
	receiptId: WorkspaceValidationReceiptRef["receiptId"];
}

export interface LeaseReleasedPayload {
	lease: WorkspaceLeaseRef;
	receiptId: WorkspaceValidationReceiptRef["receiptId"];
	reasonDigest: string;
}

export const WorkspaceBoundPayloadSchema = exact({
	binding: WorkspaceBindingRefSchema,
	bindingDigest: digest,
	lease: WorkspaceLeaseRefSchema,
	checkpoint: Type.Optional(WorkspaceCheckpointDescriptorSchema),
});

export const WorkspaceValidationRecordedPayloadSchema = exact({
	validation: WorkspaceValidationReceiptRefSchema,
	expectedEnvelopeDigest: digest,
});

export const WorkspaceReleasedPayloadSchema = exact({
	workspaceId: runtimeId("workspace"),
	leaseId: runtimeId("lease"),
	leaseRevision: revision,
	bindingDigest: digest,
	receiptId: runtimeId("receipt"),
	checkpoint: Type.Optional(WorkspaceCheckpointDescriptorSchema),
});

export const LeaseAcquiredPayloadSchema = exact({
	lease: WorkspaceLeaseRefSchema,
	receiptId: runtimeId("receipt"),
});

export const LeaseTakenOverPayloadSchema = exact({
	previousOwnerRuntimeId: runtimeId("runtime"),
	previousLeaseRevision: revision,
	lease: WorkspaceLeaseRefSchema,
	receiptId: runtimeId("receipt"),
});

export const LeaseReleasedPayloadSchema = exact({
	lease: WorkspaceLeaseRefSchema,
	receiptId: runtimeId("receipt"),
	reasonDigest: digest,
});

export const WORKSPACE_EVENT_PAYLOAD_SCHEMAS = {
	"workspace.bound": WorkspaceBoundPayloadSchema,
	"workspace.validation_recorded": WorkspaceValidationRecordedPayloadSchema,
	"workspace.released": WorkspaceReleasedPayloadSchema,
	"lease.acquired": LeaseAcquiredPayloadSchema,
	"lease.taken_over": LeaseTakenOverPayloadSchema,
	"lease.released": LeaseReleasedPayloadSchema,
} as const satisfies Record<WorkspaceRuntimeEventType, TSchema>;

const WORKSPACE_EVENT_TYPE_SET: ReadonlySet<string> = new Set(WORKSPACE_RUNTIME_EVENT_TYPES);

export function isWorkspaceRuntimeEventType(value: unknown): value is WorkspaceRuntimeEventType {
	return typeof value === "string" && WORKSPACE_EVENT_TYPE_SET.has(value);
}

export function isWorkspaceBoundPayload(value: unknown): value is WorkspaceBoundPayload {
	return Check(WorkspaceBoundPayloadSchema, value);
}

export function isWorkspaceValidationRecordedPayload(
	value: unknown,
): value is WorkspaceValidationRecordedPayload {
	return Check(WorkspaceValidationRecordedPayloadSchema, value);
}

export function isWorkspaceReleasedPayload(value: unknown): value is WorkspaceReleasedPayload {
	return Check(WorkspaceReleasedPayloadSchema, value);
}

export function isLeaseAcquiredPayload(value: unknown): value is LeaseAcquiredPayload {
	return Check(LeaseAcquiredPayloadSchema, value);
}

export function isLeaseTakenOverPayload(value: unknown): value is LeaseTakenOverPayload {
	return Check(LeaseTakenOverPayloadSchema, value);
}

export function isLeaseReleasedPayload(value: unknown): value is LeaseReleasedPayload {
	return Check(LeaseReleasedPayloadSchema, value);
}
