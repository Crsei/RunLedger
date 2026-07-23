/** authority/tenant canonical command lifecycle 的可丢弃投影。 */

import { canonicalDigest } from "../protocol/v3/canonical-json.ts";
import {
	isCanonicalCommandType,
	parseIdempotencyKey,
	type CanonicalCommandType,
	type IdempotencyKey,
} from "../protocol/v3/coordination.ts";
import {
	sameRuntimeEventStream,
	type AuthorityTenantEventStreamRef,
	type EventCursor,
	type ExpectedRevision,
	type RuntimeEventV3,
} from "../protocol/v3/events.ts";
import {
	parseRuntimeId,
	type AuthorityId,
	type CommandId,
	type EventId,
	type PrincipalId,
	type ReceiptId,
	type RuntimeInstanceId,
	type SessionId,
	type TenantId,
} from "../protocol/v3/ids.ts";
import { isEventCursor, isExpectedRevision } from "../protocol/v3/schemas.ts";
import {
	controlPlaneFailure,
	isControlPlaneError,
	type ControlPlaneErrorShape,
	type ControlPlaneResult,
} from "./errors.ts";
import {
	canonicalCommandEffectMatches,
	type CanonicalCommandEffect,
} from "./canonical-command.ts";

export type CanonicalCommandDomain = "session" | "daemon" | "lifecycle" | "policy";
export type CanonicalCommandStatus = "claimed" | "applied" | "rejected" | "reconciliation_required";

export interface CanonicalCommandClaimProjection {
	commandId: CommandId;
	commandType: CanonicalCommandType;
	idempotencyKey: IdempotencyKey;
	requestDigest: string;
	requestedBy: PrincipalId;
	runtimeId: RuntimeInstanceId;
	runtimeGeneration: number;
	domain: CanonicalCommandDomain;
	subjectSessionId: SessionId | null;
	domainExpectedRevision: ExpectedRevision | null;
	claimEventId: EventId;
	claimCursor: EventCursor;
}

export type CanonicalCommandOutcome =
	| {
			status: "claimed";
			terminalCursor: null;
	  }
	| {
			status: "applied";
			terminalCursor: EventCursor;
			appliedCursor: EventCursor;
			result: CanonicalCommandEffect;
			resultDigest: string;
	  }
	| {
			status: "rejected";
			terminalCursor: EventCursor;
			code: string;
			error: ControlPlaneErrorShape;
			reasonDigest: string;
			retryable: boolean;
	  }
	| {
			status: "reconciliation_required";
			terminalCursor: EventCursor;
			reconciliationReceiptId: ReceiptId;
			reconciliationDigest: string;
	  };

export interface CanonicalCommandProjection {
	claim: CanonicalCommandClaimProjection;
	outcome: CanonicalCommandOutcome;
}

export interface ControlPlaneProjection {
	authorityId: AuthorityId;
	tenantId: TenantId;
	stream: AuthorityTenantEventStreamRef;
	commands: readonly CanonicalCommandProjection[];
	head: EventCursor;
	projectionDigest: string;
}

interface MutableControlPlaneProjection {
	authorityId: AuthorityId;
	tenantId: TenantId;
	stream: AuthorityTenantEventStreamRef;
	commands: CanonicalCommandProjection[];
	head: EventCursor;
}

type CommandTerminalEvent = Extract<RuntimeEventV3, {
	type: "command.applied" | "command.rejected" | "command.reconciliation_required";
}>;

function invalid<T>(message: string, sequence?: number): ControlPlaneResult<T> {
	return controlPlaneFailure(
		"recovery_required",
		message,
		false,
		sequence === undefined ? undefined : { sequence },
	);
}

function cursorOf(event: RuntimeEventV3): EventCursor {
	return {
		stream: event.stream,
		sequence: event.sequence,
		eventId: event.eventId,
		eventHash: event.currentEventHash,
	};
}

function sameCursor(left: EventCursor, right: EventCursor): boolean {
	return sameRuntimeEventStream(left.stream, right.stream) &&
		left.sequence === right.sequence && left.eventId === right.eventId && left.eventHash === right.eventHash;
}

function subjectMatchesRevision(subjectSessionId: SessionId | null, revision: ExpectedRevision | null): boolean {
	if (!revision) return true;
	return revision.stream.scope === "session"
		? subjectSessionId !== null && revision.stream.sessionId === subjectSessionId
		: subjectSessionId === null;
}

function applyClaim(
	state: MutableControlPlaneProjection,
	event: Extract<RuntimeEventV3, { type: "command.claimed" }>,
): ControlPlaneResult<void> {
	const commandId = parseRuntimeId("command", event.payload.commandId);
	const commandType = event.payload.commandType;
	const idempotencyKey = parseIdempotencyKey(event.payload.idempotencyKey);
	const requestedBy = parseRuntimeId("principal", event.payload.requestedBy);
	const runtimeId = parseRuntimeId("runtime", event.payload.runtimeId);
	let subjectSessionId: SessionId | null = null;
	if (event.payload.subjectSessionId !== undefined) {
		const parsedSubject = parseRuntimeId("session", event.payload.subjectSessionId);
		if (!parsedSubject) return invalid("canonical command claim subject session id is invalid", event.sequence);
		subjectSessionId = parsedSubject;
	}
	const expectedRevision = event.payload.domainExpectedRevision;
	if (
		!commandId || !isCanonicalCommandType(commandType) || !idempotencyKey || !requestedBy || !runtimeId ||
		(expectedRevision !== null && !isExpectedRevision(expectedRevision)) ||
		requestedBy !== event.principalId ||
		!subjectMatchesRevision(subjectSessionId, expectedRevision)
	) return invalid("canonical command claim has invalid identity or revision correlation", event.sequence);
	if (state.commands.some((command) => command.claim.commandId === commandId)) {
		return invalid("canonical commandId was claimed more than once", event.sequence);
	}
	if (state.commands.some((command) => command.claim.idempotencyKey === idempotencyKey)) {
		return invalid("canonical command idempotency key was reused", event.sequence);
	}
	state.commands.push({
		claim: {
			commandId,
			commandType,
			idempotencyKey,
			requestDigest: event.payload.requestDigest,
			requestedBy,
			runtimeId,
			runtimeGeneration: event.payload.runtimeGeneration,
			domain: event.payload.domain,
			subjectSessionId,
			domainExpectedRevision: expectedRevision,
			claimEventId: event.eventId,
			claimCursor: cursorOf(event),
		},
		outcome: { status: "claimed", terminalCursor: null },
	});
	return { ok: true, value: undefined };
}

function terminalClaim(
	state: MutableControlPlaneProjection,
	event: CommandTerminalEvent,
): ControlPlaneResult<CanonicalCommandProjection> {
	const commandId = parseRuntimeId("command", event.payload.claim.commandId);
	const claimEventId = parseRuntimeId("event", event.payload.claim.claimEventId);
	const runtimeId = parseRuntimeId("runtime", event.payload.runtimeId);
	if (!commandId || !claimEventId || !runtimeId) {
		return invalid("canonical command terminal contains an invalid identity", event.sequence);
	}
	const command = state.commands.find((candidate) => candidate.claim.commandId === commandId);
	if (
		!command || command.claim.claimEventId !== claimEventId ||
		command.claim.requestDigest !== event.payload.claim.requestDigest ||
		command.claim.runtimeId !== runtimeId ||
		command.claim.runtimeGeneration !== event.payload.runtimeGeneration ||
		(command.outcome.status !== "claimed" && command.outcome.status !== "reconciliation_required")
	) return invalid("canonical command terminal is not correlated to one unsettled claim", event.sequence);
	return { ok: true, value: command };
}

function applyTerminal(
	state: MutableControlPlaneProjection,
	event: CommandTerminalEvent,
): ControlPlaneResult<void> {
	const matched = terminalClaim(state, event);
	if (!matched.ok) return matched;
	const command = matched.value;
	const terminalCursor = cursorOf(event);
	switch (event.type) {
		case "command.applied": {
			if (!isEventCursor(event.payload.appliedCursor)) {
				return invalid("command applied cursor is invalid", event.sequence);
			}
			if (
				!canonicalCommandEffectMatches(command.claim.commandType, event.payload.result) ||
				canonicalDigest(event.payload.result) !== event.payload.resultDigest
			) return invalid("command applied result conflicts with its canonical digest or type", event.sequence);
			const appliedCursor = event.payload.appliedCursor;
			if (
				(sameRuntimeEventStream(appliedCursor.stream, event.stream) && appliedCursor.sequence >= event.sequence) ||
				(command.claim.subjectSessionId !== null &&
					(appliedCursor.stream.scope !== "session" ||
						appliedCursor.stream.sessionId !== command.claim.subjectSessionId))
			) return invalid("command applied cursor does not identify an earlier matching domain event", event.sequence);
			command.outcome = {
				status: "applied",
				terminalCursor,
				appliedCursor,
				result: structuredClone(event.payload.result),
				resultDigest: event.payload.resultDigest,
			};
			return { ok: true, value: undefined };
		}
		case "command.rejected":
			if (
				!isControlPlaneError(event.payload.error) ||
				event.payload.error.code !== event.payload.code ||
				event.payload.error.retryable !== event.payload.retryable ||
				canonicalDigest(event.payload.error) !== event.payload.reasonDigest
			) return invalid("command rejection conflicts with its canonical digest or summary", event.sequence);
			command.outcome = {
				status: "rejected",
				terminalCursor,
				code: event.payload.code,
				error: structuredClone(event.payload.error),
				reasonDigest: event.payload.reasonDigest,
				retryable: event.payload.retryable,
			};
			return { ok: true, value: undefined };
		case "command.reconciliation_required": {
			if (command.outcome.status === "reconciliation_required") {
				return invalid("command reconciliation requirement was duplicated", event.sequence);
			}
			const receiptId = parseRuntimeId("receipt", event.payload.reconciliationReceiptId);
			if (!receiptId) return invalid("command reconciliation receipt identity is invalid", event.sequence);
			command.outcome = {
				status: "reconciliation_required",
				terminalCursor,
				reconciliationReceiptId: receiptId,
				reconciliationDigest: event.payload.reconciliationDigest,
			};
			return { ok: true, value: undefined };
		}
	}
}

function projectionBody(state: MutableControlPlaneProjection): Omit<ControlPlaneProjection, "projectionDigest"> {
	return {
		authorityId: state.authorityId,
		tenantId: state.tenantId,
		stream: { ...state.stream },
		commands: state.commands.map((command) => structuredClone(command)),
		head: structuredClone(state.head),
	};
}

/** 输入必须是 sequence 0 起的完整 authority stream；非 command metadata event 只推进 head。 */
export function reduceControlPlaneEvents(
	events: readonly RuntimeEventV3[],
): ControlPlaneResult<ControlPlaneProjection | null> {
	if (events.length === 0) return { ok: true, value: null };
	const first = events[0]!;
	if (first.stream.scope !== "authority_tenant") return invalid("control-plane projection requires an authority stream");
	const state: MutableControlPlaneProjection = {
		authorityId: first.authorityId,
		tenantId: first.tenantId,
		stream: first.stream,
		commands: [],
		head: cursorOf(first),
	};
	let previousHash: string | null = null;
	for (let index = 0; index < events.length; index += 1) {
		const event = events[index]!;
		if (
			event.stream.scope !== "authority_tenant" ||
			!sameRuntimeEventStream(event.stream, state.stream) ||
			event.authorityId !== state.authorityId || event.tenantId !== state.tenantId
		) return invalid("control-plane event crossed its authority/tenant stream", event.sequence);
		if (event.sequence !== index || event.previousEventHash !== previousHash) {
			return invalid("control-plane event prefix is not contiguous", event.sequence);
		}
		let applied: ControlPlaneResult<void> = { ok: true, value: undefined };
		if (event.type === "command.claimed") applied = applyClaim(state, event);
		else if (
			event.type === "command.applied" || event.type === "command.rejected" ||
			event.type === "command.reconciliation_required"
		) applied = applyTerminal(state, event);
		if (!applied.ok) return applied;
		state.head = cursorOf(event);
		previousHash = event.currentEventHash;
	}
	const body = projectionBody(state);
	return { ok: true, value: { ...body, projectionDigest: canonicalDigest(body) } };
}

export function findCanonicalCommand(
	projection: ControlPlaneProjection,
	commandId: CommandId,
): CanonicalCommandProjection | undefined {
	return projection.commands.find((command) => command.claim.commandId === commandId);
}

export function sameAppliedCursor(
	command: CanonicalCommandProjection,
	cursor: EventCursor,
): boolean {
	return command.outcome.status === "applied" && sameCursor(command.outcome.appliedCursor, cursor);
}
