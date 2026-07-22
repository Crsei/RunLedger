/** Event/Lease/Artifact/Approval/Trust Store 的 intent-commit-reconcile 合同。 */

import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import type { EventCursor, ExpectedRevision } from "./events.ts";
import { RuntimeContractError } from "./errors.ts";
import {
	createRuntimeId,
	type AuthorityId,
	type CommandId,
	type ReceiptId,
	type TenantId,
} from "./ids.ts";

export type ExternalAuthorityKind = "event_store" | "lease_store" | "artifact_store" | "approval_store" | "trust_store";
export type CoordinationState =
	| "intent_recorded"
	| "external_pending"
	| "external_committed"
	| "event_committed"
	| "reconcile_required"
	| "reconciled"
	| "aborted";

export type IdempotencyKey = string & { readonly __idempotencyKey: true };
export const IDEMPOTENCY_KEY_PATTERN_SOURCE = "^[A-Za-z0-9][A-Za-z0-9._~-]{15,127}$";
const IDEMPOTENCY_KEY_PATTERN = new RegExp(IDEMPOTENCY_KEY_PATTERN_SOURCE);

/** idempotency key 不是 CommandId；schema 与 Static 必须保留独立品牌。 */
export const IdempotencyKeySchema = Type.Unsafe<IdempotencyKey>(
	Type.String({
		pattern: IDEMPOTENCY_KEY_PATTERN_SOURCE,
		minLength: 16,
		maxLength: 128,
	}),
);

/** Control Plane API 与 canonical command event 共用的封闭命令名。 */
export const CONTROL_PLANE_COMMAND_TYPES = [
	"session:start",
	"session:resume",
	"session:fork",
	"session:stop",
	"turn:start",
	"turn:steer",
	"turn:followUp",
	"turn:interrupt",
	"queue:cancel",
	"approval:resolve",
	"changeProposal:requestDraftPr",
	"humanGate:resolve",
	"shutdown",
] as const;

export type ControlPlaneCommandType = (typeof CONTROL_PLANE_COMMAND_TYPES)[number];

const CONTROL_PLANE_COMMAND_TYPE_SET: ReadonlySet<string> = new Set(CONTROL_PLANE_COMMAND_TYPES);

export function isControlPlaneCommandType(value: unknown): value is ControlPlaneCommandType {
	return typeof value === "string" && CONTROL_PLANE_COMMAND_TYPE_SET.has(value);
}

export function createIdempotencyKey(seed: string = randomUUID()): IdempotencyKey {
	if (!IDEMPOTENCY_KEY_PATTERN.test(seed)) {
		throw new RuntimeContractError({ code: "invalid_id", message: "invalid idempotency key", retryable: false });
	}
	return seed as IdempotencyKey;
}

export function parseIdempotencyKey(value: string): IdempotencyKey | undefined {
	return IDEMPOTENCY_KEY_PATTERN.test(value) ? (value as IdempotencyKey) : undefined;
}

export interface CoordinationIntent {
	authorityId: AuthorityId;
	tenantId: TenantId;
	operationId: CommandId;
	idempotencyKey: IdempotencyKey;
	requestDigest: string;
	expectedRevision: ExpectedRevision;
	participants: readonly ExternalAuthorityKind[];
	createdAt: string;
}

export interface ExternalMutationReceipt {
	authorityId: AuthorityId;
	tenantId: TenantId;
	operationId: CommandId;
	idempotencyKey: IdempotencyKey;
	participant: ExternalAuthorityKind;
	receiptId: ReceiptId;
	mutationDigest: string;
	revision: number;
	committedAt: string;
}

export interface CoordinationCommit {
	intent: CoordinationIntent;
	externalReceipts: readonly ExternalMutationReceipt[];
	eventCursor: EventCursor;
	commitDigest: string;
}

export type ReconcileDecision =
	| { kind: "already_consistent"; commit: CoordinationCommit }
	| { kind: "commit_event"; intent: CoordinationIntent; receipts: readonly ExternalMutationReceipt[] }
	| { kind: "retry_external"; intent: CoordinationIntent; missing: readonly ExternalAuthorityKind[] }
	| { kind: "compensate_external"; intent: CoordinationIntent; receipts: readonly ExternalMutationReceipt[] }
	| { kind: "manual_recovery"; intent: CoordinationIntent; reason: string };

export const COORDINATION_STATE_TRANSITIONS: Readonly<Record<CoordinationState, readonly CoordinationState[]>> = {
	intent_recorded: ["external_pending", "aborted"],
	external_pending: ["external_committed", "reconcile_required", "aborted"],
	external_committed: ["event_committed", "reconcile_required"],
	event_committed: ["reconciled"],
	reconcile_required: ["external_pending", "event_committed", "reconciled", "aborted"],
	reconciled: [],
	aborted: [],
};

export function isAllowedCoordinationTransition(from: CoordinationState, to: CoordinationState): boolean {
	return COORDINATION_STATE_TRANSITIONS[from].includes(to);
}

export function createCoordinationOperationId(): CommandId {
	return createRuntimeId("command");
}
