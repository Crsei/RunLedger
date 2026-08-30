/**
 * S5 拆分:idle recap 对已有 IdleRecapCoordinator 的 runtime adapter。
 *
 * 拥有 editorEmpty / epochReady / status 字段:domain agent_end 后 arm、
 * driver state/editor 变化时 notify/clear;fire 前逐项复检 activity
 * 资格与 generation/digest,避免过期 recap 回灌。
 */

import { runtimeDigest } from "../protocol/foundation.ts";
import type { SessionId } from "../protocol/ids.ts";
import type { OwnerFence } from "../session-owner/types.ts";
import type { AgentEvent } from "../types.ts";
import type { SessionRuntimeServer, SessionControllerEvent } from "../session-server/runtime-server.ts";
import type { RecoveryBarrier } from "./recovery-barrier.ts";
import type { EffectiveRecapSettings } from "../../storage/settings-manager.ts";
import { DEFAULT_RECAP_SETTINGS } from "../../storage/settings-manager.ts";
import {
	IdleRecapCoordinator,
	IDLE_RECAP_PROMPT,
	isIdleRecapEligible,
	type IdleRecapActivity,
	type IdleRecapRequest,
} from "./idle-recap.ts";
import type { EphemeralTurnDiagnostic } from "../agent.ts";
import type { SessionDomainPort, SessionRuntimeState } from "./session-runtime.ts";

export interface SessionIdleRecapPort {
	readonly domain: SessionDomainPort | undefined;
	readonly sessionId: SessionId;
	readonly fence: OwnerFence;
	readonly barrier: RecoveryBarrier;
	readonly server: SessionRuntimeServer;
	readonly state: () => SessionRuntimeState;
	readonly emit: (event: SessionControllerEvent) => void;
	readonly settings: EffectiveRecapSettings;
}

export class SessionIdleRecapController {
	private readonly port: SessionIdleRecapPort;
	private readonly idleRecap: IdleRecapCoordinator;
	private editorEmpty = true;
	private idleRecapEpochReady = false;
	private idleRecapStatusRequestId: string | undefined;
	private idleRecapStatusActivityGeneration: number | undefined;

	public constructor(port: SessionIdleRecapPort) {
		this.port = port;
		this.idleRecap = new IdleRecapCoordinator({
			settings: port.settings ?? DEFAULT_RECAP_SETTINGS,
			onFire: (request) => this.fireIdleRecap(request),
			onStatus: (replyText, request) => this.publishIdleRecap(replyText, request),
		});
	}

	public handleDomainAgentEvent(event: AgentEvent): void {
		if (event.type === "agent_start" || event.type === "turn_start" || event.type === "message_start") {
			this.invalidateIdleRecap();
			return;
		}
		if (event.type !== "agent_end") return;
		this.idleRecapEpochReady = true;
		// Agent marks inFlight false in its prompt() finally after agent_end is
		// dispatched. A macrotask lets that lifecycle settle before we snapshot.
		const messageCount = event.messageCountAtEnd;
		const timer = setTimeout(() => {
			if (this.port.state() !== "ready" && this.port.state() !== "ready_with_uncertainty") return;
			const activity = this.currentIdleRecapActivity(messageCount);
			this.idleRecap.arm(activity);
		}, 0);
		timer.unref?.();
	}

	public currentIdleRecapActivity(messageCountOverride?: number): IdleRecapActivity {
		const snapshot = this.port.domain?.snapshot();
		const selection = snapshot?.selection;
		const model = selection?.model;
		const streaming = snapshot?.inFlight ?? false;
		const maintenance = (this.port.state() === "ready" || this.port.state() === "ready_with_uncertainty") && !streaming ? "idle" : "busy";
		return {
			sessionId: this.port.sessionId,
			ownerGeneration: this.port.fence.generation,
			driverRevision: this.port.server.driverRevision?.() ?? 0,
			driverAttached: this.port.server.driverConnectionId?.() !== undefined,
			editorEmpty: this.editorEmpty,
			streaming,
			maintenance,
			recoveryBarrier: this.port.barrier.currentState,
			hasModel: model !== undefined,
			hasHistory: (snapshot?.messages.length ?? 0) > 0 || (messageCountOverride ?? 0) > 0,
			selectionDigest: runtimeDigest({
				provider: selection?.provider ?? null,
				model: model?.id ?? null,
				thinkingLevel: selection?.thinkingLevel ?? "off",
			}).digest,
		};
	}

	public invalidateIdleRecap(): void {
		this.idleRecapEpochReady = false;
		this.idleRecap.notifyActivity(this.currentIdleRecapActivity());
		this.clearIdleRecapStatus();
	}

	public refreshIdleRecapActivity(): void {
		this.idleRecap.notifyActivity(this.currentIdleRecapActivity());
		this.clearIdleRecapStatus();
	}

	public handleDriverStateChange(): void {
		const activity = this.currentIdleRecapActivity();
		if (this.idleRecapEpochReady && activity.driverAttached && activity.editorEmpty && !activity.streaming) this.idleRecap.arm(activity);
		else {
			this.idleRecap.notifyActivity(activity);
			this.clearIdleRecapStatus();
		}
	}

	/** editor_activity 命令的领域侧处理:更新 editorEmpty 并刷新 recap 状态。 */
	public handleEditorActivity(empty: boolean): void {
		this.editorEmpty = empty;
		if (this.editorEmpty) this.handleDriverStateChange();
		else this.refreshIdleRecapActivity();
	}

	public dispose(): void {
		this.idleRecap.dispose();
	}

	private async fireIdleRecap(request: IdleRecapRequest): Promise<string | undefined> {
		const activity = this.currentIdleRecapActivity();
		if (
			!isIdleRecapEligible(activity) ||
			activity.ownerGeneration !== request.ownerGeneration ||
			activity.driverRevision !== request.driverRevision ||
			activity.selectionDigest !== request.expectedSelectionDigest
		) return undefined;
		const runEphemeralTurn = this.port.domain?.controller.runEphemeralTurn;
		if (runEphemeralTurn === undefined) return undefined;
		return runEphemeralTurn({
			kind: "idle-recap",
			requestId: request.requestId,
			ownerGeneration: request.ownerGeneration,
			activityGeneration: request.activityGeneration,
			promptText: IDLE_RECAP_PROMPT,
			signal: request.signal,
			onDiagnostic: (diagnostic) => this.publishIdleRecapDiagnostic(diagnostic, request),
		});
	}

	private publishIdleRecapDiagnostic(diagnostic: EphemeralTurnDiagnostic, request: IdleRecapRequest): void {
		const activity = this.currentIdleRecapActivity();
		if (
			diagnostic.kind !== "idle-recap" ||
			diagnostic.requestId !== request.requestId ||
			!isIdleRecapEligible(activity) ||
			activity.ownerGeneration !== request.ownerGeneration ||
			activity.driverRevision !== request.driverRevision ||
			activity.selectionDigest !== request.expectedSelectionDigest
		) return;
		this.port.emit({
			eventType: "session.idle_recap",
			payload: {
				sessionId: this.port.sessionId,
				requestId: request.requestId,
				ownerGeneration: request.ownerGeneration,
				activityGeneration: request.activityGeneration,
				driverRevision: request.driverRevision,
				diagnostic,
			},
		});
	}

	private publishIdleRecap(replyText: string, request: IdleRecapRequest): void {
		const activity = this.currentIdleRecapActivity();
		if (
			!isIdleRecapEligible(activity) ||
			activity.ownerGeneration !== request.ownerGeneration ||
			activity.driverRevision !== request.driverRevision ||
			activity.selectionDigest !== request.expectedSelectionDigest
		) return;
		this.idleRecapStatusRequestId = request.requestId;
		this.idleRecapStatusActivityGeneration = request.activityGeneration;
		this.port.emit({
			eventType: "session.idle_recap",
			payload: {
				sessionId: this.port.sessionId,
				requestId: request.requestId,
				ownerGeneration: request.ownerGeneration,
				activityGeneration: request.activityGeneration,
				driverRevision: request.driverRevision,
				text: replyText,
			},
		});
	}

	public clearIdleRecapStatus(): void {
		const requestId = this.idleRecapStatusRequestId;
		if (requestId === undefined) return;
		const activityGeneration = this.idleRecapStatusActivityGeneration;
		this.idleRecapStatusRequestId = undefined;
		this.idleRecapStatusActivityGeneration = undefined;
		this.port.emit({
			eventType: "session.idle_recap",
			payload: {
				sessionId: this.port.sessionId,
				requestId,
				ownerGeneration: this.port.fence.generation,
				...(activityGeneration === undefined ? {} : { activityGeneration }),
				cleared: true,
			},
		});
	}
}
