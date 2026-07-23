import { canonicalDigest } from "../../protocol/v3/canonical-json.ts";
import type { RuntimeEventPayloadMap } from "../../protocol/v3/event-payloads.ts";
import { createRuntimeId, type AuthorityId, type CommandId, type PlanId, type PrincipalId, type SessionId, type TenantId, type TraceId, type WorkspaceId } from "../../protocol/v3/ids.ts";
import type { ExpectedRevision } from "../../protocol/v3/events.ts";
import type { ContextFragment } from "../../context/types.ts";
import { createPlanApprovalRequest } from "./approval-coordinator.ts";
import { markPlanActivationDelivered, recoverPlanModeState, reducePlanModeCommand, settlePlanExit } from "./reducer.ts";
import type { ApprovedPlanRef, PlanApprovalRef, PlanArtifactRef, PlanModeCommand, PlanModeState } from "./types.ts";

export interface PlanArtifactPort {
	create(body?: string): Promise<PlanArtifactRef>;
	write(planId: PlanId, expectedRevision: number, body: string): Promise<PlanArtifactRef>;
	inspectWorkingCopy(ref: PlanArtifactRef): Promise<"current" | "changed_unreviewed" | "missing">;
}

export type PlanRuntimeEvent = {
	[TType in "mode.transitioned" | "plan.proposed" | "plan.approved" | "plan.rejected" | "plan.invalidated"]: {
		type: TType;
		principalId: PrincipalId;
		traceId: TraceId;
		payload: RuntimeEventPayloadMap[TType];
	};
}["mode.transitioned" | "plan.proposed" | "plan.approved" | "plan.rejected" | "plan.invalidated"];

export interface PlanRuntimeEventSink {
	append(event: PlanRuntimeEvent): Promise<void>;
}

/** Durable projection cache；canonical transition 仍由 v3 event 决定。 */
export interface PlanModeProjectionPort {
	commit(state: PlanModeState): Promise<void>;
}

export interface PlanModeServiceIdentity {
	authorityId: AuthorityId;
	tenantId: TenantId;
	principalId: PrincipalId;
	sessionId: SessionId;
	workspaceId: WorkspaceId;
}

export interface PlanDecisionResult {
	state: PlanModeState;
	approvedPlan?: ApprovedPlanRef;
	implementation: "none" | "same_session" | "fresh_context";
}

export function createInactivePlanModeState(identity: PlanModeServiceIdentity, now: string): PlanModeState {
	return {
		schemaVersion: 1,
		authorityId: identity.authorityId,
		tenantId: identity.tenantId,
		sessionId: identity.sessionId,
		kind: "inactive",
		mode: "default",
		modeRevision: 0,
		updatedByPrincipalId: identity.principalId,
		updatedAt: now,
	};
}

export class PlanModeService {
	readonly #identity: PlanModeServiceIdentity;
	readonly #store: PlanArtifactPort;
	readonly #events: PlanRuntimeEventSink;
	readonly #projection: PlanModeProjectionPort | undefined;
	readonly #clock: () => Date;
	#state: PlanModeState;

	public constructor(options: {
		identity: PlanModeServiceIdentity;
		state: PlanModeState;
		store: PlanArtifactPort;
		events: PlanRuntimeEventSink;
		projection?: PlanModeProjectionPort;
		clock?: () => Date;
	}) {
		this.#identity = options.identity;
		this.#state = options.state;
		this.#store = options.store;
		this.#events = options.events;
		this.#projection = options.projection;
		this.#clock = options.clock ?? (() => new Date());
	}

	public snapshot(): PlanModeState {
		return this.#state;
	}

	private commandBase(commandId: CommandId, expectedRevision: ExpectedRevision) {
		return {
			schemaVersion: 1 as const,
			authorityId: this.#identity.authorityId,
			tenantId: this.#identity.tenantId,
			principalId: this.#identity.principalId,
			sessionId: this.#identity.sessionId,
			commandId,
			expectedRevision,
		};
	}

	private async transition(command: PlanModeCommand, traceId: TraceId): Promise<PlanModeState> {
		const previous = this.#state;
		const next = reducePlanModeCommand(previous, command, this.#clock().toISOString());
		await this.#events.append({
			type: "mode.transitioned",
			principalId: command.principalId,
			traceId,
			payload: {
				from: previous.mode,
				to: next.mode,
				fromState: previous.kind,
				toState: next.kind,
				modeRevision: next.modeRevision,
				commandId: command.commandId,
				...(next.kind === "awaiting_approval" ? { approvalId: next.approval.approvalId } : {}),
			},
		});
		await this.#projection?.commit(next);
		this.#state = next;
		return next;
	}

	public requestActivation(
		requestedBy: "user" | "agent",
		expectedRevision: ExpectedRevision,
		traceId: TraceId,
		commandId: CommandId = createRuntimeId("command"),
	): Promise<PlanModeState> {
		return this.transition({ ...this.commandBase(commandId, expectedRevision), kind: "request_activation", requestedBy }, traceId);
	}

	public async activateAtSafePoint(
		expectedRevision: ExpectedRevision,
		traceId: TraceId,
		initialBody = "",
		commandId: CommandId = createRuntimeId("command"),
	): Promise<PlanModeState> {
		if (this.#state.kind !== "pending_activation") throw new Error("plan mode is not pending activation");
		const plan = await this.#store.create(initialBody);
		await this.#events.append({
			type: "plan.proposed",
			principalId: this.#identity.principalId,
			traceId,
			payload: {
				planId: plan.planId,
				planRevision: plan.revision,
				artifactId: plan.artifact.artifactId,
				planDigest: plan.contentDigest,
			},
		});
		return this.transition({
			...this.commandBase(commandId, expectedRevision),
			kind: "activate",
			expectedModeRevision: this.#state.modeRevision,
			plan,
		}, traceId);
	}

	public async markActivationDelivered(
		traceId: TraceId,
		commandId: CommandId = createRuntimeId("command"),
	): Promise<PlanModeState> {
		const previous = this.#state;
		const next = markPlanActivationDelivered(previous, this.#clock().toISOString());
		if (next === previous) return previous;
		await this.#events.append({
			type: "mode.transitioned",
			principalId: this.#identity.principalId,
			traceId,
			payload: {
				from: "plan",
				to: "plan",
				fromState: "active",
				toState: "active",
				modeRevision: next.modeRevision,
				commandId,
			},
		});
		await this.#projection?.commit(next);
		this.#state = next;
		return next;
	}

	public async writePlan(
		body: string,
		expectedPlanRevision: number,
		expectedRevision: ExpectedRevision,
		traceId: TraceId,
		commandId: CommandId = createRuntimeId("command"),
	): Promise<PlanModeState> {
		if (this.#state.kind !== "active") throw new Error("plan mode is not active");
		const plan = await this.#store.write(this.#state.plan.planId, expectedPlanRevision, body);
		await this.#events.append({
			type: "plan.proposed",
			principalId: this.#identity.principalId,
			traceId,
			payload: { planId: plan.planId, planRevision: plan.revision, artifactId: plan.artifact.artifactId, planDigest: plan.contentDigest },
		});
		return this.transition({
			...this.commandBase(commandId, expectedRevision),
			kind: "write_revision",
			expectedModeRevision: this.#state.modeRevision,
			expectedPlanRevision,
			plan,
		}, traceId);
	}

	public async requestApproval(
		expectedRevision: ExpectedRevision,
		traceId: TraceId,
		commandId: CommandId = createRuntimeId("command"),
	): Promise<PlanModeState> {
		if (this.#state.kind !== "active") throw new Error("plan mode is not active");
		const drift = await this.#store.inspectWorkingCopy(this.#state.plan);
		if (drift !== "current") {
			await this.#events.append({
				type: "plan.invalidated",
				principalId: this.#identity.principalId,
				traceId,
				payload: { planId: this.#state.plan.planId, planRevision: this.#state.plan.revision, reasonDigest: canonicalDigest({ drift }) },
			});
			throw new Error("working plan changed outside the immutable revision store");
		}
		const plan = this.#state.plan;
		const approval = createPlanApprovalRequest(plan, this.#clock().toISOString());
		return this.transition({
			...this.commandBase(commandId, expectedRevision),
			kind: "request_approval",
			expectedModeRevision: this.#state.modeRevision,
			plan,
			approval,
		}, traceId);
	}

	public async decideApproval(
		approval: Exclude<PlanApprovalRef, { state: "pending" }>,
		action: Extract<PlanModeCommand, { kind: "resolve_approval" }>["action"],
		expectedRevision: ExpectedRevision,
		traceId: TraceId,
		commandId: CommandId = createRuntimeId("command"),
	): Promise<PlanDecisionResult> {
		if (this.#state.kind !== "awaiting_approval") throw new Error("no plan approval is pending");
		const previous = this.#state;
		const plan = this.#state.plan;
		const command = {
			...this.commandBase(commandId, expectedRevision),
			kind: "resolve_approval",
			expectedModeRevision: this.#state.modeRevision,
			plan,
			approval,
			action,
		} as const satisfies Extract<PlanModeCommand, { kind: "resolve_approval" }>;
		const next = reducePlanModeCommand(previous, command, this.#clock().toISOString());
		// 审批结果必须先于退出/回到 active 的 mode transition 成为 durable 事实。
		if (approval.state === "approved") {
			await this.#events.append({
				type: "plan.approved",
				principalId: this.#identity.principalId,
				traceId,
				payload: { planId: plan.planId, planRevision: plan.revision, approvalId: approval.approvalId, receiptId: approval.receipt.receiptId },
			});
		} else {
			await this.#events.append({
				type: "plan.rejected",
				principalId: this.#identity.principalId,
				traceId,
				payload: { planId: plan.planId, planRevision: plan.revision, approvalId: approval.approvalId, reasonDigest: canonicalDigest({ state: approval.state, action }) },
			});
		}
		await this.#events.append({
			type: "mode.transitioned",
			principalId: command.principalId,
			traceId,
			payload: {
				from: previous.mode,
				to: next.mode,
				fromState: previous.kind,
				toState: next.kind,
				modeRevision: next.modeRevision,
				commandId,
			},
		});
		await this.#projection?.commit(next);
		this.#state = next;
		return {
			state: next,
			...(next.kind === "exit_pending" && next.approvedPlan !== undefined ? { approvedPlan: next.approvedPlan } : {}),
			implementation: action === "approve_same_session" ? "same_session" : action === "approve_fresh_context" ? "fresh_context" : "none",
		};
	}

	public async settleExit(traceId: TraceId, commandId: CommandId = createRuntimeId("command")): Promise<PlanModeState> {
		const previous = this.#state;
		const next = settlePlanExit(previous, this.#clock().toISOString());
		await this.#events.append({
			type: "mode.transitioned",
			principalId: this.#identity.principalId,
			traceId,
			payload: { from: "plan", to: "default", fromState: "exit_pending", toState: "inactive", modeRevision: next.modeRevision, commandId },
		});
		await this.#projection?.commit(next);
		this.#state = next;
		return next;
	}

	public recover(recoveredAt: string): { state: PlanModeState; exitReminderRequired: boolean } {
		const recovered = recoverPlanModeState(this.#state, recoveredAt);
		this.#state = recovered.state;
		return recovered;
	}
}

export function planModeContextFragment(state: PlanModeState): ContextFragment | undefined {
	if (state.mode !== "plan") return undefined;
	const content = JSON.stringify({
		mode: "plan",
		state: state.kind,
		modeRevision: state.modeRevision,
		planId: "plan" in state ? state.plan.planId : undefined,
		planRevision: "plan" in state ? state.plan.revision : undefined,
		planDigest: "plan" in state ? state.plan.contentDigest : undefined,
		constraint: "Read-only exploration. Only the runtime-bound plan writer may mutate the current plan artifact.",
	});
	const digest = canonicalDigest(content);
	return {
		schemaVersion: 1,
		authorityId: state.authorityId,
		tenantId: state.tenantId,
		fragmentId: createRuntimeId("resource", `plan-mode-${state.sessionId.slice(-32)}-${state.modeRevision}`),
		layer: "session_memory",
		order: 0,
		contentDigest: digest,
		trust: "system",
		taint: [],
		inputSources: [],
		declassificationReceipts: [],
		priority: "required",
		maxTokens: 512,
		maxChars: 4_096,
		provenance: {
			authorityId: state.authorityId,
			tenantId: state.tenantId,
			kind: "session_range",
			sessionId: state.sessionId,
			fromSequence: state.modeRevision,
			toSequence: state.modeRevision,
			sourceDigest: digest,
			observedAt: state.updatedAt,
		},
		storage: "inline",
		content,
	};
}
