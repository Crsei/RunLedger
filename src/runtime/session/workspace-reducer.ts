/** Workspace v3 events 的纯 reducer；输入之外不访问任何外部状态。 */

import { RUNTIME_SCHEMA_VERSION, sameRuntimeEventStream, type RuntimeEventV3 } from "../protocol/v3/events.ts";
import { validateRuntimeEvent } from "../protocol/v3/schemas.ts";
import {
	isLeaseAcquiredPayload,
	isLeaseReleasedPayload,
	isLeaseTakenOverPayload,
	isWorkspaceBoundPayload,
	isWorkspaceReleasedPayload,
	isWorkspaceRuntimeEventType,
	isWorkspaceValidationRecordedPayload,
} from "../protocol/v3/workspace-events.ts";
import {
	isWorkspaceCheckpointDescriptor,
	workspaceBindingDigest,
	type WorkspaceBindingRef,
	type WorkspaceCheckpointDescriptor,
	type WorkspaceLeaseRef,
	type WorkspaceValidationReceiptRef,
} from "../protocol/v3/workspace.ts";
import {
	emptySessionWorkspaceProjection,
	type SessionWorkspaceProjection,
	type WorkspaceUnavailableReason,
	type WorkspaceUnavailableReasonCode,
} from "./workspace-projection.ts";

interface EventMetadata {
	type: string;
	sequence: number | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function metadata(value: unknown): EventMetadata {
	if (!isRecord(value)) return { type: "unknown", sequence: null };
	return {
		type: typeof value.type === "string" ? value.type : "unknown",
		sequence: typeof value.sequence === "number" && Number.isInteger(value.sequence) ? value.sequence : null,
	};
}

function isWorkspaceDomainEvent(type: string): boolean {
	return type.startsWith("workspace.") || type.startsWith("lease.");
}

function sameScope(
	event: RuntimeEventV3,
	ref: { authorityId: string; tenantId: string; principalId?: string },
): boolean {
	return (
		ref.authorityId === event.authorityId &&
		ref.tenantId === event.tenantId &&
		(ref.principalId === undefined || ref.principalId === event.principalId)
	);
}

function checkpointMatches(
	event: RuntimeEventV3,
	checkpoint: WorkspaceCheckpointDescriptor,
	workspaceId: string,
): boolean {
	return (
		sameScope(event, checkpoint) &&
		checkpoint.workspaceId === workspaceId &&
		sameRuntimeEventStream(checkpoint.eventCursor.stream, event.stream)
	);
}

function sameLeaseIdentity(left: WorkspaceLeaseRef, right: WorkspaceLeaseRef): boolean {
	return (
		left.leaseId === right.leaseId &&
		left.workspaceId === right.workspaceId &&
		left.ownerRuntimeId === right.ownerRuntimeId &&
		left.leaseRevision === right.leaseRevision &&
		left.fencingTokenDigest === right.fencingTokenDigest
	);
}

function markLeaseReleased(value: WorkspaceLeaseRef): WorkspaceLeaseRef {
	return {
		authorityId: value.authorityId,
		tenantId: value.tenantId,
		principalId: value.principalId,
		leaseId: value.leaseId,
		workspaceId: value.workspaceId,
		ownerRuntimeId: value.ownerRuntimeId,
		leaseRevision: value.leaseRevision,
		fencingTokenDigest: value.fencingTokenDigest,
		state: "released",
	};
}

/**
 * 对 workspace/lease 事件进行确定重放。
 *
 * reducer 接受 unknown 是为了让 future schema version 也产生 fail-closed 投影，
 * 而不是在调用点被不安全地强转为 RuntimeEventV3。
 */
export function reduceSessionWorkspaceEvents(events: readonly unknown[]): SessionWorkspaceProjection {
	let binding: WorkspaceBindingRef | null = null;
	let lease: WorkspaceLeaseRef | null = null;
	let validation: WorkspaceValidationReceiptRef | null = null;
	let checkpoint: WorkspaceCheckpointDescriptor | null = null;
	let bindingMetadata: EventMetadata = { type: "workspace.bound", sequence: null };
	let leaseMetadata: EventMetadata = { type: "lease.acquired", sequence: null };
	let validationMetadata: EventMetadata = { type: "workspace.validation_recorded", sequence: null };
	let releasedMetadata: EventMetadata | null = null;
	const reasons: WorkspaceUnavailableReason[] = [];
	const reasonKeys = new Set<string>();

	const addReason = (code: WorkspaceUnavailableReasonCode, eventMetadata: EventMetadata): void => {
		const key = `${code}:${eventMetadata.sequence ?? "none"}:${eventMetadata.type}`;
		if (reasonKeys.has(key)) return;
		reasonKeys.add(key);
		reasons.push({ code, sequence: eventMetadata.sequence, eventType: eventMetadata.type });
	};

	for (const input of events) {
		const eventMetadata = metadata(input);
		if (!isWorkspaceDomainEvent(eventMetadata.type)) continue;
		if (!isRecord(input) || input.schemaVersion !== RUNTIME_SCHEMA_VERSION) {
			addReason("unknown_event_version", eventMetadata);
			continue;
		}
		if (!isWorkspaceRuntimeEventType(eventMetadata.type)) {
			addReason("unknown_workspace_event", eventMetadata);
			continue;
		}

		const checked = validateRuntimeEvent(input);
		if (!checked.ok) {
			addReason("invalid_workspace_event", eventMetadata);
			continue;
		}
		const event = checked.value;

		switch (event.type) {
			case "workspace.bound": {
				if (!isWorkspaceBoundPayload(event.payload)) {
					addReason("invalid_workspace_event", eventMetadata);
					break;
				}
				const nextBinding = event.payload.binding;
				const nextLease = event.payload.lease;
				if (!sameScope(event, nextBinding) || !sameScope(event, nextLease)) {
					addReason("scope_mismatch", eventMetadata);
					break;
				}
				if (nextBinding.workspaceId !== nextLease.workspaceId) {
					addReason("lease_workspace_mismatch", eventMetadata);
					break;
				}
				if (workspaceBindingDigest(nextBinding) !== event.payload.bindingDigest) {
					addReason("binding_digest_mismatch", eventMetadata);
					break;
				}
				let nextCheckpoint: WorkspaceCheckpointDescriptor | null = null;
				if (event.payload.checkpoint !== undefined) {
					if (
						!isWorkspaceCheckpointDescriptor(event.payload.checkpoint) ||
						!checkpointMatches(event, event.payload.checkpoint, nextBinding.workspaceId)
					) {
						addReason("checkpoint_mismatch", eventMetadata);
						break;
					}
					nextCheckpoint = event.payload.checkpoint;
				}
				binding = nextBinding;
				lease = nextLease;
				validation = null;
				checkpoint = nextCheckpoint;
				bindingMetadata = eventMetadata;
				leaseMetadata = eventMetadata;
				validationMetadata = eventMetadata;
				releasedMetadata = null;
				break;
			}

			case "workspace.validation_recorded": {
				if (!isWorkspaceValidationRecordedPayload(event.payload)) {
					addReason("invalid_workspace_event", eventMetadata);
					break;
				}
				const nextValidation = event.payload.validation;
				validation = nextValidation;
				validationMetadata = eventMetadata;
				if (!sameScope(event, nextValidation)) {
					addReason("validation_scope_mismatch", eventMetadata);
					break;
				}
				if (!binding || nextValidation.workspaceId !== binding.workspaceId) {
					addReason("validation_workspace_mismatch", eventMetadata);
					break;
				}
				if (nextValidation.envelopeDigest !== event.payload.expectedEnvelopeDigest) {
					addReason("validation_digest_mismatch", eventMetadata);
				}
				break;
			}

			case "workspace.released": {
				if (!isWorkspaceReleasedPayload(event.payload)) {
					addReason("invalid_workspace_event", eventMetadata);
					break;
				}
				const currentBinding: WorkspaceBindingRef | null = binding;
				const currentLease: WorkspaceLeaseRef | null = lease;
				if (
					!currentBinding ||
					!currentLease ||
					event.payload.workspaceId !== currentBinding.workspaceId ||
					event.payload.leaseId !== currentLease.leaseId ||
					event.payload.leaseRevision !== currentLease.leaseRevision ||
					event.payload.bindingDigest !== workspaceBindingDigest(currentBinding)
				) {
					addReason("workspace_release_mismatch", eventMetadata);
					break;
				}
				if (event.payload.checkpoint !== undefined) {
					if (
						!isWorkspaceCheckpointDescriptor(event.payload.checkpoint) ||
						!checkpointMatches(event, event.payload.checkpoint, currentBinding.workspaceId)
					) {
						addReason("checkpoint_mismatch", eventMetadata);
						break;
					}
					checkpoint = event.payload.checkpoint;
				}
				lease = markLeaseReleased(currentLease);
				leaseMetadata = eventMetadata;
				validation = null;
				validationMetadata = eventMetadata;
				releasedMetadata = eventMetadata;
				break;
			}

			case "lease.acquired": {
				if (!isLeaseAcquiredPayload(event.payload)) {
					addReason("invalid_workspace_event", eventMetadata);
					break;
				}
				const nextLease = event.payload.lease;
				if (!sameScope(event, nextLease)) {
					addReason("lease_scope_mismatch", eventMetadata);
					break;
				}
				if (nextLease.state !== "active") {
					addReason("invalid_workspace_event", eventMetadata);
					break;
				}
				if (binding && nextLease.workspaceId !== binding.workspaceId) {
					addReason("lease_workspace_mismatch", eventMetadata);
					break;
				}
				if (
					lease &&
					(nextLease.leaseRevision < lease.leaseRevision ||
						(nextLease.leaseRevision === lease.leaseRevision && !sameLeaseIdentity(nextLease, lease)))
				) {
					addReason("stale_lease_event", eventMetadata);
					break;
				}
				const leaseChanged = !lease || !sameLeaseIdentity(nextLease, lease);
				lease = nextLease;
				leaseMetadata = eventMetadata;
				if (leaseChanged) {
					validation = null;
					validationMetadata = eventMetadata;
				}
				break;
			}

			case "lease.taken_over": {
				if (!isLeaseTakenOverPayload(event.payload)) {
					addReason("invalid_workspace_event", eventMetadata);
					break;
				}
				const nextLease = event.payload.lease;
				if (!sameScope(event, nextLease)) {
					addReason("lease_scope_mismatch", eventMetadata);
					break;
				}
				if (
					!lease ||
					nextLease.state !== "active" ||
					nextLease.workspaceId !== lease.workspaceId ||
					event.payload.previousOwnerRuntimeId !== lease.ownerRuntimeId ||
					event.payload.previousLeaseRevision !== lease.leaseRevision ||
					nextLease.leaseRevision <= lease.leaseRevision
				) {
					addReason("lease_takeover_mismatch", eventMetadata);
					break;
				}
				lease = nextLease;
				leaseMetadata = eventMetadata;
				validation = null;
				validationMetadata = eventMetadata;
				break;
			}

			case "lease.released": {
				if (!isLeaseReleasedPayload(event.payload)) {
					addReason("invalid_workspace_event", eventMetadata);
					break;
				}
				const nextLease = event.payload.lease;
				if (!sameScope(event, nextLease)) {
					addReason("lease_scope_mismatch", eventMetadata);
					break;
				}
				if (
					!lease ||
					(nextLease.state !== "released" && nextLease.state !== "stale" && nextLease.state !== "revoked") ||
					nextLease.leaseId !== lease.leaseId ||
					nextLease.workspaceId !== lease.workspaceId ||
					nextLease.ownerRuntimeId !== lease.ownerRuntimeId ||
					nextLease.leaseRevision !== lease.leaseRevision
				) {
					addReason("stale_lease_event", eventMetadata);
					break;
				}
				lease = nextLease;
				leaseMetadata = eventMetadata;
				validation = null;
				validationMetadata = eventMetadata;
				break;
			}
		}
	}

	if (binding) {
		if (!lease) addReason("lease_missing", bindingMetadata);
		else {
			switch (lease.state) {
				case "requested":
					addReason("lease_requested", leaseMetadata);
					break;
				case "released":
					addReason("lease_released", leaseMetadata);
					break;
				case "stale":
					addReason("lease_stale", leaseMetadata);
					break;
				case "revoked":
					addReason("lease_revoked", leaseMetadata);
					break;
				case "active":
					break;
			}
		}

		if (!validation) addReason("validation_missing", bindingMetadata);
		else if (validation.outcome === "invalid") addReason("validation_invalid", validationMetadata);
		else if (validation.outcome === "unavailable") addReason("validation_unavailable", validationMetadata);
	}
	if (releasedMetadata) addReason("workspace_released", releasedMetadata);

	return {
		...emptySessionWorkspaceProjection(),
		binding,
		lease,
		validation,
		checkpoint,
		unavailableReasons: reasons,
	};
}
