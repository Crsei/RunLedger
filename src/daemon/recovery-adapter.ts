/** daemon restart 只恢复 projection/runtime handle，绝不重放 terminal 或 uncertain 副作用。 */

import type {
	AgentId,
	CommandId,
	LeaseId,
	SessionId,
	ToolCallId,
} from "../runtime/protocol/v3/ids.ts";
import type { ControlPlaneResult } from "../runtime/control-plane/errors.ts";
import { controlPlaneFailure } from "../runtime/control-plane/errors.ts";
import type { CommandClaimToken, CommandIdempotencyRepository } from "../runtime/control-plane/idempotency.ts";

export type DaemonSessionRecoveryState = "resume" | "pause_for_approval" | "stopped" | "closed" | "corrupted";

export type RecoveredSideEffectKind =
	| "artifact"
	| "tool"
	| "sandbox"
	| "workspace"
	| "remote_executor"
	| "child_agent";

export interface RecoveredSideEffectState {
	kind: RecoveredSideEffectKind;
	operationId: CommandId | ToolCallId | LeaseId | AgentId;
	state: "not_started" | "terminal" | "uncertain";
}

export interface DaemonSessionRecoveryDescriptor {
	sessionId: SessionId;
	state: DaemonSessionRecoveryState;
	sideEffects: readonly RecoveredSideEffectState[];
}

export interface RestoredDaemonSession {
	sessionId: SessionId;
	projectionDigest: string;
	mode: "read_only" | "paused" | "active_candidate";
}

export interface DaemonRuntimeRecoveryPort {
	discover(): Promise<ControlPlaneResult<readonly DaemonSessionRecoveryDescriptor[]>>;
	/** restoreProjection 只能重放 canonical events/reducer，不能 execute tool/model/child。 */
	restoreProjection(
		descriptor: DaemonSessionRecoveryDescriptor,
		mode: RestoredDaemonSession["mode"],
	): Promise<ControlPlaneResult<RestoredDaemonSession>>;
	activate(restored: RestoredDaemonSession): Promise<ControlPlaneResult<void>>;
}

export interface DaemonRecoveryReport {
	active: readonly SessionId[];
	paused: readonly SessionId[];
	terminal: readonly SessionId[];
	corrupted: readonly SessionId[];
	inFlightCommands: readonly CommandClaimToken[];
}

export class DaemonRecoveryAdapter {
	readonly #runtime: DaemonRuntimeRecoveryPort;
	readonly #idempotency: CommandIdempotencyRepository;

	public constructor(runtime: DaemonRuntimeRecoveryPort, idempotency: CommandIdempotencyRepository) {
		this.#runtime = runtime;
		this.#idempotency = idempotency;
	}

	public async recover(): Promise<ControlPlaneResult<DaemonRecoveryReport>> {
		const inFlight = await this.#idempotency.listInFlight();
		if (!inFlight.ok) return inFlight;
		const discovered = await this.#runtime.discover();
		if (!discovered.ok) return discovered;
		const active: SessionId[] = [];
		const paused: SessionId[] = [];
		const terminal: SessionId[] = [];
		const corrupted: SessionId[] = [];
		for (const descriptor of discovered.value) {
			const hasUncertain = descriptor.sideEffects.some((effect) => effect.state === "uncertain");
			const hasNonTerminal = descriptor.sideEffects.some((effect) => effect.state !== "terminal");
			if (descriptor.state === "stopped" || descriptor.state === "closed") {
				const restored = await this.#runtime.restoreProjection(descriptor, "read_only");
				if (!restored.ok) return restored;
				terminal.push(descriptor.sessionId);
				continue;
			}
			if (descriptor.state === "corrupted") {
				const restored = await this.#runtime.restoreProjection(descriptor, "read_only");
				if (!restored.ok) return restored;
				corrupted.push(descriptor.sessionId);
				continue;
			}
			if (descriptor.state === "pause_for_approval" || hasUncertain || hasNonTerminal) {
				const restored = await this.#runtime.restoreProjection(descriptor, "paused");
				if (!restored.ok) return restored;
				paused.push(descriptor.sessionId);
				continue;
			}
			const restored = await this.#runtime.restoreProjection(descriptor, "active_candidate");
			if (!restored.ok) return restored;
			if (restored.value.sessionId !== descriptor.sessionId || restored.value.mode !== "active_candidate") {
				return controlPlaneFailure("adapter_contract_violation", "runtime recovery adapter returned mismatched session state");
			}
			const activated = await this.#runtime.activate(restored.value);
			if (!activated.ok) return activated;
			active.push(descriptor.sessionId);
		}
		return {
			ok: true,
			value: {
				active,
				paused,
				terminal,
				corrupted,
				inFlightCommands: inFlight.value,
			},
		};
	}
}
