/** Session 对 Workspace contract 的最小确定性投影。 */

import type {
	WorkspaceBindingRef,
	WorkspaceCheckpointDescriptor,
	WorkspaceLeaseRef,
	WorkspaceValidationReceiptRef,
} from "../protocol/v3/workspace.ts";

export const WORKSPACE_UNAVAILABLE_REASON_CODES = [
	"unknown_event_version",
	"unknown_workspace_event",
	"invalid_workspace_event",
	"scope_mismatch",
	"binding_digest_mismatch",
	"lease_scope_mismatch",
	"lease_workspace_mismatch",
	"stale_lease_event",
	"lease_takeover_mismatch",
	"lease_missing",
	"lease_requested",
	"lease_released",
	"lease_stale",
	"lease_revoked",
	"validation_missing",
	"validation_scope_mismatch",
	"validation_workspace_mismatch",
	"validation_digest_mismatch",
	"validation_invalid",
	"validation_unavailable",
	"checkpoint_mismatch",
	"workspace_release_mismatch",
	"workspace_released",
] as const;

export type WorkspaceUnavailableReasonCode = (typeof WORKSPACE_UNAVAILABLE_REASON_CODES)[number];

export interface WorkspaceUnavailableReason {
	code: WorkspaceUnavailableReasonCode;
	sequence: number | null;
	eventType: string;
}

/** 这里只保留外部 Workspace 真源的引用与当前不可用原因。 */
export interface SessionWorkspaceProjection {
	binding: WorkspaceBindingRef | null;
	lease: WorkspaceLeaseRef | null;
	validation: WorkspaceValidationReceiptRef | null;
	checkpoint: WorkspaceCheckpointDescriptor | null;
	unavailableReasons: readonly WorkspaceUnavailableReason[];
}

export function emptySessionWorkspaceProjection(): SessionWorkspaceProjection {
	return {
		binding: null,
		lease: null,
		validation: null,
		checkpoint: null,
		unavailableReasons: [],
	};
}
