/** Runtime v3 生命周期的封闭状态图；reducer 只能消费这里允许的边。 */

import { sameRuntimeEventStream, type RuntimeEventV3 } from "./events.ts";

export type DaemonShutdownRequestedEvent = Extract<RuntimeEventV3, { type: "daemon.shutdown_requested" }>;
export type DaemonShutdownCommandClaimEvent = Extract<RuntimeEventV3, { type: "command.claimed" }>;
export type DaemonShutdownTerminalEvent = Extract<
	RuntimeEventV3,
	{ type: "daemon.shutdown_completed" | "daemon.shutdown_failed" }
>;

export const RUNTIME_STATE_TRANSITIONS = {
	session: {
		new: ["active", "migration_in_progress", "corrupted"],
		active: ["stop_requested", "closed", "corrupted"],
		migration_in_progress: ["active", "migration_failed", "corrupted"],
		migration_failed: [],
		stop_requested: ["stopped", "corrupted"],
		stopped: ["closed"],
		closed: [],
		corrupted: [],
	},
	turn: {
		pending: ["started"],
		started: ["finished", "interrupted", "failed"],
		finished: [],
		interrupted: [],
		failed: [],
	},
	model_request: {
		pending: ["requested"],
		requested: ["finished", "failed"],
		finished: [],
		failed: [],
	},
	tool_call: {
		pending: ["requested"],
		requested: ["authorized", "interrupted", "failed"],
		authorized: ["started", "interrupted", "failed"],
		started: ["finished", "interrupted", "failed"],
		finished: [],
		interrupted: [],
		failed: [],
	},
	approval: {
		pending: ["requested"],
		requested: ["allowed", "denied", "cancelled", "expired"],
		allowed: ["revoked", "expired"],
		denied: [],
		cancelled: [],
		expired: [],
		revoked: [],
	},
	resource: {
		discovered: ["approved", "revoked", "failed"],
		approved: ["activated", "revoked", "failed"],
		activated: ["deactivated", "revoked", "failed"],
		deactivated: ["activated", "revoked", "failed"],
		revoked: [],
		failed: ["discovered", "revoked"],
	},
	compaction: {
		planned: ["started", "suppressed"],
		started: ["completed", "failed"],
		completed: [],
		failed: [],
		suppressed: [],
	},
	memory: {
		proposed: ["approved", "rejected", "expired"],
		approved: ["published", "revoked", "expired"],
		rejected: [],
		published: ["revoked", "expired"],
		revoked: [],
		expired: [],
	},
	verification: {
		pending: ["started"],
		started: ["passed", "failed", "inconclusive"],
		passed: [],
		failed: [],
		inconclusive: [],
	},
	episode: {
		evidence_ready: ["manifest_committed"],
		manifest_committed: ["seal_recorded"],
		seal_recorded: ["completed"],
		completed: [],
	},
	draft_pr: {
		pending: ["requested"],
		requested: ["created", "failed"],
		created: [],
		failed: [],
	},
	human_gate: {
		pending: ["requested"],
		requested: ["approved", "denied"],
		approved: [],
		denied: [],
	},
	task: {
		pending: ["ready", "running", "blocked", "cancelled"],
		ready: ["running", "blocked", "cancelled"],
		running: ["blocked", "completed", "failed", "cancelled"],
		blocked: ["ready", "running", "failed", "cancelled"],
		completed: [],
		failed: [],
		cancelled: [],
	},
	session_handoff: {
		requested: ["committed", "failed"],
		committed: [],
		failed: [],
	},
	session_deletion: {
		planned: ["tombstoned", "failed"],
		tombstoned: ["committed", "failed"],
		committed: [],
		failed: [],
	},
	command: {
		claimed: ["applied", "rejected", "reconciliation_required"],
		applied: [],
		rejected: [],
		reconciliation_required: ["applied", "rejected"],
	},
	runtime_generation: {
		prepared: ["activated", "failed", "reconciliation_required"],
		activated: [],
		failed: [],
		reconciliation_required: ["activated", "failed"],
	},
	daemon_shutdown: {
		requested: ["completed", "failed"],
		completed: [],
		failed: [],
	},
	agent: {
		requested: ["spawned", "failed"],
		spawned: ["running", "paused", "failed", "stopped"],
		running: ["paused", "completed", "failed", "stopped", "partial"],
		paused: ["running", "failed", "stopped", "partial"],
		completed: [],
		failed: [],
		stopped: [],
		partial: ["running", "completed", "failed", "stopped"],
	},
} as const;

export type RuntimeStateDomain = keyof typeof RUNTIME_STATE_TRANSITIONS;
export type RuntimeDomainState<TDomain extends RuntimeStateDomain> = keyof (typeof RUNTIME_STATE_TRANSITIONS)[TDomain] & string;

export function isAllowedRuntimeStateTransition<TDomain extends RuntimeStateDomain>(
	domain: TDomain,
	from: RuntimeDomainState<TDomain>,
	to: string,
): boolean {
	const transitions = RUNTIME_STATE_TRANSITIONS[domain] as Readonly<Record<string, readonly string[]>>;
	return transitions[from]?.includes(to) ?? false;
}

/** shutdown request 只能关联同一 authority stream 上更早的 daemon-scoped shutdown claim。 */
export function isCorrelatedDaemonShutdownRequest(
	claimed: DaemonShutdownCommandClaimEvent,
	requested: DaemonShutdownRequestedEvent,
): boolean {
	return claimed.stream.scope === "authority_tenant" &&
		requested.stream.scope === "authority_tenant" &&
		sameRuntimeEventStream(claimed.stream, requested.stream) &&
		claimed.authorityId === requested.authorityId &&
		claimed.tenantId === requested.tenantId &&
		requested.sequence > claimed.sequence &&
		claimed.payload.commandType === "shutdown" &&
		claimed.payload.domain === "daemon" &&
		claimed.payload.subjectSessionId === undefined &&
		claimed.payload.domainExpectedRevision === null &&
		requested.payload.claim.commandId === claimed.payload.commandId &&
		requested.payload.claim.claimEventId === claimed.eventId &&
		requested.payload.claim.requestDigest === claimed.payload.requestDigest &&
		requested.payload.idempotencyKey === claimed.payload.idempotencyKey &&
		requested.payload.runtimeId === claimed.payload.runtimeId &&
		requested.payload.runtimeGeneration === claimed.payload.runtimeGeneration;
}

/** terminal 必须指向同一 authority stream 上更早的 shutdown request 及其完整 payload digest。 */
export function isCorrelatedDaemonShutdownTerminal(
	requested: DaemonShutdownRequestedEvent,
	terminal: DaemonShutdownTerminalEvent,
): boolean {
	return requested.stream.scope === "authority_tenant" &&
		terminal.stream.scope === "authority_tenant" &&
		sameRuntimeEventStream(requested.stream, terminal.stream) &&
		requested.authorityId === terminal.authorityId &&
		requested.tenantId === terminal.tenantId &&
		terminal.sequence > requested.sequence &&
		terminal.payload.request.requestedEventId === requested.eventId &&
		terminal.payload.request.requestedPayloadDigest === requested.payloadDigest &&
		terminal.payload.request.claim.commandId === requested.payload.claim.commandId &&
		terminal.payload.request.claim.claimEventId === requested.payload.claim.claimEventId &&
		terminal.payload.request.claim.requestDigest === requested.payload.claim.requestDigest &&
		terminal.payload.runtimeId === requested.payload.runtimeId &&
		terminal.payload.runtimeGeneration === requested.payload.runtimeGeneration &&
		terminal.payload.drainDeadline === requested.payload.drainDeadline;
}
