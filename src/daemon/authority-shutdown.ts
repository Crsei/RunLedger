/** daemon shutdown command 与 authority canonical Event Store 的有序桥接。 */

import { canonicalDigest } from "../runtime/protocol/v3/canonical-json.ts";
import { sameRuntimeEventStream, type EventCursor, type RuntimeEventV3 } from "../runtime/protocol/v3/events.ts";
import { createRuntimeId } from "../runtime/protocol/v3/ids.ts";
import { isEventCursor } from "../runtime/protocol/v3/schemas.ts";
import type {
	AuthorityCommandAppliedResolutionInput,
	AuthorityCommandCommitCursorInput,
} from "../runtime/control-plane/authority-command-idempotency.ts";
import type { CommittedCommandReceipt } from "../runtime/control-plane/idempotency.ts";
import { controlPlaneFailure, type ControlPlaneResult } from "../runtime/control-plane/errors.ts";
import type { ShutdownCoordinator, ShutdownReport } from "../runtime/control-plane/shutdown.ts";
import type {
	ControlPlaneCommand,
	ControlPlaneCommandEffect,
	ControlPlaneRequestContext,
} from "../runtime/control-plane/types.ts";
import type { RuntimeEventEnvelopeV3 } from "../runtime/protocol/v3/events.ts";
import type { AuthorityRuntimeManager } from "../storage/authority-runtime-manager.ts";
import type { DaemonShutdownProtocolPort } from "./composition-root.ts";

type ShutdownCommand = Extract<ControlPlaneCommand, { type: "shutdown" }>;
type ShutdownEffect = Extract<ControlPlaneCommandEffect, { type: "shutdown" }>;
type ShutdownRequestedEvent = RuntimeEventEnvelopeV3<"daemon.shutdown_requested">;

interface PendingShutdown {
	commandId: ShutdownCommand["commandId"];
	requestDigest: string;
	claimEventId: string;
	requested: ShutdownRequestedEvent;
	effect: ShutdownEffect;
	timeoutMs: number;
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
	return sameRuntimeEventStream(left.stream, right.stream) && left.sequence === right.sequence &&
		left.eventId === right.eventId && left.eventHash === right.eventHash;
}

function shutdownRequestForClaim(
	events: readonly RuntimeEventV3[],
	claim: AuthorityCommandCommitCursorInput["claim"],
): ShutdownRequestedEvent | undefined {
	return events.find((event): event is ShutdownRequestedEvent => (
		event.type === "daemon.shutdown_requested" &&
		event.payload.claim.commandId === claim.commandId &&
		event.payload.claim.claimEventId === claim.claimEventId &&
		event.payload.claim.requestDigest === claim.requestDigest &&
		event.payload.idempotencyKey === claim.idempotencyKey &&
		event.payload.runtimeId === claim.runtimeId &&
		event.payload.runtimeGeneration === claim.runtimeGeneration
	));
}

/** command.applied 的 shutdown cursor 必须精确指向此前的 shutdown_requested。 */
export function resolveAuthorityShutdownAppliedCursor(
	input: AuthorityCommandCommitCursorInput,
): EventCursor | null {
	if (input.result.type !== "shutdown" || input.claim.commandType !== "shutdown") return null;
	const requested = shutdownRequestForClaim(input.events, input.claim);
	if (!requested || requested.payload.drainDeadline !== input.result.drainDeadline ||
		requested.timestamp !== input.result.acceptedAt) return null;
	return cursorOf(requested);
}

/** restart 后只从 appliedCursor 指向的 canonical request 恢复完整 shutdown effect。 */
export function resolveAuthorityShutdownAppliedEffect(
	input: AuthorityCommandAppliedResolutionInput,
): ControlPlaneCommandEffect | null {
	if (input.command.claim.commandType !== "shutdown" || input.command.outcome.status !== "applied") return null;
	const event = input.events[input.command.outcome.appliedCursor.sequence];
	if (
		event?.type !== "daemon.shutdown_requested" ||
		!sameCursor(cursorOf(event), input.command.outcome.appliedCursor) ||
		event.payload.claim.commandId !== input.command.claim.commandId ||
		event.payload.claim.claimEventId !== input.command.claim.claimEventId ||
		event.payload.claim.requestDigest !== input.command.claim.requestDigest ||
		event.payload.idempotencyKey !== input.command.claim.idempotencyKey ||
		event.payload.runtimeId !== input.command.claim.runtimeId ||
		event.payload.runtimeGeneration !== input.command.claim.runtimeGeneration
	) return null;
	return { type: "shutdown", acceptedAt: event.timestamp, drainDeadline: event.payload.drainDeadline };
}

function authorityFailure<T>(message: string): ControlPlaneResult<T> {
	return controlPlaneFailure("recovery_required", message, false, undefined, "uncertain");
}

export class AuthorityDaemonShutdownProtocol implements DaemonShutdownProtocolPort {
	readonly #manager: AuthorityRuntimeManager;
	readonly #shutdown: ShutdownCoordinator;
	readonly #clock: () => Date;
	#pending: PendingShutdown | undefined;

	private constructor(manager: AuthorityRuntimeManager, shutdown: ShutdownCoordinator, clock: () => Date) {
		this.#manager = manager;
		this.#shutdown = shutdown;
		this.#clock = clock;
	}

	public static open(
		manager: AuthorityRuntimeManager,
		shutdown: ShutdownCoordinator,
		clock: () => Date = () => new Date(),
	): ControlPlaneResult<AuthorityDaemonShutdownProtocol> {
		const protocol = new AuthorityDaemonShutdownProtocol(manager, shutdown, clock);
		const registered = shutdown.registerFinalizer({
			id: "authority-runtime-writer",
			finalize: (report) => protocol.#finalize(report),
		});
		return registered.ok ? { ok: true, value: protocol } : registered;
	}

	public async request(
		command: ShutdownCommand,
		_context: ControlPlaneRequestContext,
		runtimeGeneration: number,
	): Promise<ControlPlaneResult<ShutdownEffect>> {
		const replay = await this.#manager.authorityRepository().replay();
		if (!replay.ok) return authorityFailure("authority shutdown claim replay failed");
		const claim = replay.value.events.find((event) => (
			event.type === "command.claimed" && event.payload.commandId === command.commandId
		));
		if (
			claim?.type !== "command.claimed" || claim.payload.commandType !== "shutdown" ||
			claim.payload.idempotencyKey !== command.idempotencyKey ||
			claim.payload.runtimeId !== this.#manager.runtimeId() ||
			claim.payload.runtimeGeneration !== runtimeGeneration ||
			claim.payload.requestDigest !== canonicalDigest(command)
		) return authorityFailure("authority shutdown command has no matching durable claim");
		if (this.#pending) {
			return this.#pending.commandId === command.commandId && this.#pending.requestDigest === claim.payload.requestDigest
				? { ok: true, value: structuredClone(this.#pending.effect) }
				: controlPlaneFailure("daemon_shutting_down", "another shutdown command is already pending", false);
		}
		const acceptedAt = this.#clock().toISOString();
		const drainDeadline = new Date(Date.parse(acceptedAt) + command.payload.drainTimeoutMs).toISOString();
		const appended = await this.#manager.authorityRepository().append({
			type: "daemon.shutdown_requested",
			principalId: command.principalId,
			traceId: claim.traceId,
			timestamp: acceptedAt,
			payload: {
				claim: {
					commandId: command.commandId,
					claimEventId: claim.eventId,
					requestDigest: claim.payload.requestDigest,
				},
				idempotencyKey: command.idempotencyKey,
				runtimeId: this.#manager.runtimeId(),
				runtimeGeneration,
				reasonDigest: command.payload.reasonDigest,
				drainDeadline,
			},
		});
		if (!appended.ok) return authorityFailure("canonical shutdown request was not confirmed durable");
		const effect: ShutdownEffect = { type: "shutdown", acceptedAt, drainDeadline };
		this.#pending = {
			commandId: command.commandId,
			requestDigest: claim.payload.requestDigest,
			claimEventId: claim.eventId,
			requested: appended.value.accepted.event,
			effect,
			timeoutMs: command.payload.drainTimeoutMs,
		};
		const prepared = this.#shutdown.prepare();
		return prepared.ok ? { ok: true, value: effect } : authorityFailure("shutdown mutation gate could not be closed");
	}

	public committed(
		command: ShutdownCommand,
		effect: ShutdownEffect,
		receipt: CommittedCommandReceipt,
	): void {
		const pending = this.#pending;
		if (!pending || pending.commandId !== command.commandId ||
			canonicalDigest(effect) !== canonicalDigest(pending.effect) ||
			!receipt.appliedCursor || !sameCursor(receipt.appliedCursor, cursorOf(pending.requested))) return;
		void this.#shutdown.begin(pending.timeoutMs);
	}

	async #finalize(report: ShutdownReport): Promise<void> {
		const pending = this.#pending;
		try {
			if (!pending) return;
			const replay = await this.#manager.authorityRepository().replay();
			if (!replay.ok) throw new Error("authority shutdown terminal replay failed");
			const applied = replay.value.events.find((event) => (
				event.type === "command.applied" &&
				event.payload.claim.commandId === pending.commandId &&
				event.payload.claim.claimEventId === pending.claimEventId &&
				isEventCursor(event.payload.appliedCursor) &&
				sameCursor(event.payload.appliedCursor, cursorOf(pending.requested))
			));
			if (applied?.type !== "command.applied") throw new Error("shutdown command was not durably applied before drain");
			const receiptBody = {
				commandId: pending.commandId,
				requestedEventId: pending.requested.eventId,
				startedAt: report.startedAt,
				deadline: report.deadline,
				finishedAt: report.finishedAt,
				outcomes: report.outcomes,
				recoveryRequired: report.recoveryRequired,
			};
			const shutdownReceiptDigest = canonicalDigest(receiptBody);
			const terminal = await this.#manager.authorityRepository().append({
				type: "daemon.shutdown_completed",
				principalId: pending.requested.principalId,
				traceId: pending.requested.traceId,
				timestamp: this.#clock().toISOString(),
				payload: {
					request: {
						claim: pending.requested.payload.claim,
						requestedEventId: pending.requested.eventId,
						requestedPayloadDigest: pending.requested.payloadDigest,
					},
					runtimeId: pending.requested.payload.runtimeId,
					runtimeGeneration: pending.requested.payload.runtimeGeneration,
					drainDeadline: pending.requested.payload.drainDeadline,
					outcome: report.recoveryRequired ? "recovery_required" : "drained",
					shutdownReceiptId: createRuntimeId("receipt", `shutdown-${shutdownReceiptDigest.slice(0, 48)}`),
					shutdownReceiptDigest,
					outcomeCertain: true,
				},
			});
			if (!terminal.ok) throw new Error("canonical shutdown terminal was not confirmed durable");
		} finally {
			await this.#manager.close();
		}
	}
}
