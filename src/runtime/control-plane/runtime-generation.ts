/** authority/tenant canonical events 的 Runtime generation 纯投影。 */

import { canonicalDigest } from "../protocol/v3/canonical-json.ts";
import { parseIdempotencyKey, type IdempotencyKey } from "../protocol/v3/coordination.ts";
import {
	sameRuntimeEventStream,
	type AuthorityTenantEventStreamRef,
	type EventCursor,
	type RuntimeEventV3,
} from "../protocol/v3/events.ts";
import type {
	AuthorityId,
	CommandId,
	CompositionReceiptId,
	ReceiptId,
	RuntimeId,
	RuntimeIdKind,
	RuntimeInstanceId,
	TenantId,
} from "../protocol/v3/ids.ts";
import { parseRuntimeId } from "../protocol/v3/ids.ts";
import { controlPlaneFailure, type ControlPlaneResult } from "./errors.ts";

export type RuntimeReplacementStatus =
	| "prepared"
	| "activated"
	| "failed_before_activation"
	| "failed_after_activation"
	| "reconciliation_required";

export interface ActiveRuntimeGeneration {
	runtimeId: RuntimeInstanceId;
	generation: number;
	compositionReceiptId: CompositionReceiptId;
	compositionDigest: string;
	fencingReceiptId: ReceiptId;
	fencingReceiptDigest: string;
	activatedCursor: EventCursor;
	status: "active" | "paused";
}

export interface RuntimeReplacementProjection {
	replacementId: CommandId;
	idempotencyKey: IdempotencyKey;
	previousRuntimeId: RuntimeInstanceId | null;
	previousGeneration: number;
	candidateRuntimeId: RuntimeInstanceId;
	candidateGeneration: number;
	compositionReceiptId: CompositionReceiptId;
	compositionDigest: string;
	fencingIntentDigest: string;
	status: RuntimeReplacementStatus;
	preparedCursor: EventCursor;
	terminalCursor: EventCursor | null;
	errorCode: string | null;
	errorDigest: string | null;
	outcomeCertain: boolean | null;
}

export interface RuntimeGenerationProjection {
	authorityId: AuthorityId;
	tenantId: TenantId;
	stream: AuthorityTenantEventStreamRef;
	active: ActiveRuntimeGeneration | null;
	replacements: readonly RuntimeReplacementProjection[];
	lifecycleHead: EventCursor;
	reconciliationRequired: boolean;
	projectionDigest: string;
}

interface MutableRuntimeGenerationProjection {
	authorityId: AuthorityId;
	tenantId: TenantId;
	stream: AuthorityTenantEventStreamRef;
	active: ActiveRuntimeGeneration | null;
	replacements: RuntimeReplacementProjection[];
	lifecycleHead: EventCursor;
	reconciliationRequired: boolean;
}

function cursorOf(event: RuntimeEventV3): EventCursor {
	return {
		stream: event.stream,
		sequence: event.sequence,
		eventId: event.eventId,
		eventHash: event.currentEventHash,
	};
}

function invalid<T>(message: string, details?: Readonly<Record<string, string | number | boolean>>): ControlPlaneResult<T> {
	return controlPlaneFailure("recovery_required", message, false, details);
}

function projectionBody(state: MutableRuntimeGenerationProjection): Omit<RuntimeGenerationProjection, "projectionDigest"> {
	return {
		authorityId: state.authorityId,
		tenantId: state.tenantId,
		stream: { ...state.stream },
		active: state.active ? structuredClone(state.active) : null,
		replacements: state.replacements.map((replacement) => structuredClone(replacement)),
		lifecycleHead: structuredClone(state.lifecycleHead),
		reconciliationRequired: state.reconciliationRequired,
	};
}

function findReplacement(
	state: MutableRuntimeGenerationProjection,
	replacementId: CommandId,
): RuntimeReplacementProjection | undefined {
	return state.replacements.find((replacement) => replacement.replacementId === replacementId);
}

function requireRuntimeId<K extends RuntimeIdKind>(
	kind: K,
	value: string,
	sequence: number,
): ControlPlaneResult<RuntimeId<K>> {
	const parsed = parseRuntimeId(kind, value);
	return parsed
		? { ok: true, value: parsed }
		: invalid(`runtime replacement contains an invalid ${kind} id`, { sequence });
}

function reducePrepared(
	state: MutableRuntimeGenerationProjection,
	event: Extract<RuntimeEventV3, { type: "runtime.replacement_prepared" }>,
): ControlPlaneResult<void> {
	const replacementId = requireRuntimeId("command", event.payload.replacementId, event.sequence);
	if (!replacementId.ok) return replacementId;
	const idempotencyKey = parseIdempotencyKey(event.payload.idempotencyKey);
	if (!idempotencyKey) {
		return invalid("runtime replacement contains an invalid idempotency key", { sequence: event.sequence });
	}
	const candidateRuntimeId = requireRuntimeId("runtime", event.payload.candidateRuntimeId, event.sequence);
	if (!candidateRuntimeId.ok) return candidateRuntimeId;
	const compositionReceiptId = requireRuntimeId("compositionReceipt", event.payload.compositionReceiptId, event.sequence);
	if (!compositionReceiptId.ok) return compositionReceiptId;
	const previousRuntimeId = event.payload.previousRuntimeId === undefined
		? { ok: true as const, value: null }
		: requireRuntimeId("runtime", event.payload.previousRuntimeId, event.sequence);
	if (!previousRuntimeId.ok) return previousRuntimeId;
	if (findReplacement(state, replacementId.value)) {
		return invalid("runtime replacement id was reused", { sequence: event.sequence });
	}
	if (state.reconciliationRequired || state.replacements.some((replacement) => replacement.status === "prepared")) {
		return invalid("a runtime replacement cannot prepare while another replacement is unsettled", {
			sequence: event.sequence,
		});
	}
	const active = state.active;
	if (
		event.payload.previousGeneration !== (active?.generation ?? 0) ||
		(active
			? previousRuntimeId.value !== active.runtimeId
			: previousRuntimeId.value !== null) ||
		event.payload.candidateGeneration !== (active?.generation ?? 0) + 1 ||
		candidateRuntimeId.value === active?.runtimeId
	) {
		return invalid("runtime replacement preparation does not extend the active generation", {
			sequence: event.sequence,
			previousGeneration: event.payload.previousGeneration,
			candidateGeneration: event.payload.candidateGeneration,
		});
	}
	state.replacements.push({
		replacementId: replacementId.value,
		idempotencyKey,
		previousRuntimeId: previousRuntimeId.value,
		previousGeneration: event.payload.previousGeneration,
		candidateRuntimeId: candidateRuntimeId.value,
		candidateGeneration: event.payload.candidateGeneration,
		compositionReceiptId: compositionReceiptId.value,
		compositionDigest: event.payload.compositionDigest,
		fencingIntentDigest: event.payload.fencingIntentDigest,
		status: "prepared",
		preparedCursor: cursorOf(event),
		terminalCursor: null,
		errorCode: null,
		errorDigest: null,
		outcomeCertain: null,
	});
	return { ok: true, value: undefined };
}

function reduceActivated(
	state: MutableRuntimeGenerationProjection,
	event: Extract<RuntimeEventV3, { type: "runtime.generation_activated" }>,
): ControlPlaneResult<void> {
	const replacementId = requireRuntimeId("command", event.payload.replacementId, event.sequence);
	if (!replacementId.ok) return replacementId;
	const activeRuntimeId = requireRuntimeId("runtime", event.payload.activeRuntimeId, event.sequence);
	if (!activeRuntimeId.ok) return activeRuntimeId;
	const compositionReceiptId = requireRuntimeId("compositionReceipt", event.payload.compositionReceiptId, event.sequence);
	if (!compositionReceiptId.ok) return compositionReceiptId;
	const fencingReceiptId = requireRuntimeId("receipt", event.payload.fencingReceiptId, event.sequence);
	if (!fencingReceiptId.ok) return fencingReceiptId;
	const replacement = findReplacement(state, replacementId.value);
	if (
		!replacement ||
		(replacement.status !== "prepared" && replacement.status !== "reconciliation_required") ||
		replacement.candidateRuntimeId !== activeRuntimeId.value ||
		replacement.candidateGeneration !== event.payload.activeGeneration ||
		replacement.compositionReceiptId !== compositionReceiptId.value ||
		replacement.compositionDigest !== event.payload.compositionDigest
	) {
		return invalid("runtime activation has no matching prepared candidate", { sequence: event.sequence });
	}
	replacement.status = "activated";
	replacement.terminalCursor = cursorOf(event);
	replacement.errorCode = null;
	replacement.errorDigest = null;
	replacement.outcomeCertain = true;
	state.active = {
		runtimeId: activeRuntimeId.value,
		generation: event.payload.activeGeneration,
		compositionReceiptId: compositionReceiptId.value,
		compositionDigest: event.payload.compositionDigest,
		fencingReceiptId: fencingReceiptId.value,
		fencingReceiptDigest: event.payload.fencingReceiptDigest,
		activatedCursor: cursorOf(event),
		status: "active",
	};
	state.reconciliationRequired = false;
	return { ok: true, value: undefined };
}

function reduceFailed(
	state: MutableRuntimeGenerationProjection,
	event: Extract<RuntimeEventV3, { type: "runtime.replacement_failed" }>,
): ControlPlaneResult<void> {
	const replacementId = requireRuntimeId("command", event.payload.replacementId, event.sequence);
	if (!replacementId.ok) return replacementId;
	const candidateRuntimeId = requireRuntimeId("runtime", event.payload.candidateRuntimeId, event.sequence);
	if (!candidateRuntimeId.ok) return candidateRuntimeId;
	const replacement = findReplacement(state, replacementId.value);
	if (
		!replacement ||
		replacement.candidateRuntimeId !== candidateRuntimeId.value ||
		replacement.candidateGeneration !== event.payload.candidateGeneration ||
		(replacement.status !== "prepared" &&
			replacement.status !== "activated" &&
			replacement.status !== "reconciliation_required")
	) {
		return invalid("runtime replacement failure has no matching candidate", { sequence: event.sequence });
	}
	const failedAfterActivation = state.active?.runtimeId === replacement.candidateRuntimeId &&
		state.active.generation === replacement.candidateGeneration;
	replacement.status = event.payload.outcomeCertain
		? (failedAfterActivation ? "failed_after_activation" : "failed_before_activation")
		: "reconciliation_required";
	replacement.terminalCursor = cursorOf(event);
	replacement.errorCode = event.payload.error.code;
	replacement.errorDigest = event.payload.error.messageDigest;
	replacement.outcomeCertain = event.payload.outcomeCertain;
	state.reconciliationRequired = !event.payload.outcomeCertain;
	if (failedAfterActivation && state.active) state.active.status = "paused";
	return { ok: true, value: undefined };
}

/**
 * 输入必须是从 sequence 0 开始的完整、已过 schema 验证的 authority stream。
 * reducer 仍复核 chain identity/order，避免调用方把分页片段或跨租户事件误作真源。
 */
export function reduceRuntimeGenerationEvents(
	events: readonly RuntimeEventV3[],
): ControlPlaneResult<RuntimeGenerationProjection | null> {
	if (events.length === 0) return { ok: true, value: null };
	const first = events[0]!;
	if (first.stream.scope !== "authority_tenant") {
		return invalid("runtime generation projection requires an authority/tenant event stream");
	}
	let state: MutableRuntimeGenerationProjection = {
		authorityId: first.authorityId,
		tenantId: first.tenantId,
		stream: first.stream,
		active: null,
		replacements: [],
		lifecycleHead: cursorOf(first),
		reconciliationRequired: false,
	};
	let previousHash: string | null = null;
	for (let index = 0; index < events.length; index += 1) {
		const event = events[index]!;
		if (
			event.stream.scope !== "authority_tenant" ||
			!sameRuntimeEventStream(event.stream, state.stream) ||
			event.authorityId !== state.authorityId ||
			event.tenantId !== state.tenantId
		) return invalid("runtime generation event crossed its authority/tenant stream", { sequence: event.sequence });
		if (event.sequence !== index || event.previousEventHash !== previousHash) {
			return invalid("runtime generation event prefix is not contiguous", {
				sequence: event.sequence,
				expectedSequence: index,
			});
		}
		let reduced: ControlPlaneResult<void> = { ok: true, value: undefined };
		switch (event.type) {
			case "runtime.replacement_prepared":
				reduced = reducePrepared(state, event);
				break;
			case "runtime.generation_activated":
				reduced = reduceActivated(state, event);
				break;
			case "runtime.replacement_failed":
				reduced = reduceFailed(state, event);
				break;
			default:
				break;
		}
		if (!reduced.ok) return reduced;
		previousHash = event.currentEventHash;
		state.lifecycleHead = cursorOf(event);
	}
	const body = projectionBody(state);
	return { ok: true, value: { ...body, projectionDigest: canonicalDigest(body) } };
}
