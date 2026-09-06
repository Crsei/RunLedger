/** Session Owner 的 Plan authority：exact events、immutable artifact revisions 与审批绑定。 */
import type { SessionStore, SessionEventRecord } from "../../storage/session-store/session-store.ts";
import { PlanArtifactStore } from "../modes/plan/artifact-store.ts";
import { isValidPlanModeState, reducePlanModeState, type PlanModeCommand } from "../modes/plan/reducer.ts";
import type { PlanModeState } from "../modes/plan/types.ts";
import { runtimeDigest, type RuntimeDigest, type RuntimeStreamHead } from "../protocol/foundation.ts";
import { isRuntimeDigest } from "../protocol/foundation-schemas.ts";
import { createRuntimeId, isRuntimeId, type AttemptId, type CommandId, type SessionId, type WorkspaceId, type RepositoryId } from "../protocol/ids.ts";
import type { OwnerFence } from "../session-owner/types.ts";
import type { SessionProtocolOperationDescriptor } from "../session-server/protocol.ts";
import type { AttemptPort } from "./attempt-gateway.ts";
import type { SessionDomainMutationContext, SessionDomainResult } from "./domain-router.ts";
import type { SessionPlanInspection } from "./plan-composition.ts";
import type { SessionResourceDomainPort } from "./session-runtime.ts";

const SCHEMA = "runledger.session-plan.current";
const INITIAL_CONTENT = "# Plan\n\nDescribe the goal, proposed changes, and validation before requesting approval.\n";
const MAX_CONTENT_BYTES = 131_072;
const OPERATIONS = ["plan.enter", "plan.activate", "plan.write", "plan.request_approval", "plan.resolve_approval", "plan.cancel", "plan.settle_exit"] as const;
const MANIFEST: readonly SessionProtocolOperationDescriptor[] = Object.freeze(OPERATIONS.map((operation) => Object.freeze({ operation, capability: "session.plan", access: "mutate" })));

interface PlanEventPayload {
	readonly schema: typeof SCHEMA;
	readonly sessionId: SessionId;
	readonly policyCeilingDigest: RuntimeDigest;
	readonly requestId: string;
	readonly operation: string;
	readonly requestDigest: RuntimeDigest;
	readonly commandId: CommandId;
	readonly attemptId: AttemptId;
	readonly commands: readonly PlanModeCommand[];
	readonly content?: string;
}
interface LoadedPlan {
	state: PlanModeState;
	readonly artifacts: PlanArtifactStore;
	readonly requests: Map<string, { readonly digest: RuntimeDigest; readonly result: SessionDomainResult }>;
}
export interface SessionPlanDomainOptions {
	readonly store: SessionStore;
	readonly fence: OwnerFence;
	readonly workspaceId: WorkspaceId;
	readonly repositoryId: RepositoryId;
	readonly policyCeilingDigest: RuntimeDigest;
	readonly attemptPort: () => AttemptPort | undefined;
}

/** 只发布 Plan mutation；plan.inspect 复用 domainRouter 的 canonical query。 */
export class SessionPlanDomain implements SessionResourceDomainPort {
	public readonly operationManifest = MANIFEST;
	private readonly options: SessionPlanDomainOptions;

	public constructor(options: SessionPlanDomainOptions) {
		this.options = options;
		this.load();
	}

	public inspect(): SessionPlanInspection {
		return this.inspection(this.load());
	}

	public async query(operation: string): Promise<SessionDomainResult> {
		return failure(operation, "operation_unavailable", "unavailable");
	}

	public async start(): Promise<void> {
		const loaded = this.load();
		if (loaded.state.revision !== 0) return;
		const result = await this.commit("plan.initialize", { content: INITIAL_CONTENT }, { correlationId: "plan-initialize", effectId: "plan-initialize", expectedRevision: 0 }, loaded);
		if (!result.ok) throw new Error(`plan initialization failed: ${result.code}`);
	}

	public async mutate(operation: string, payload: Record<string, unknown>, context: SessionDomainMutationContext): Promise<SessionDomainResult> {
		if (!(OPERATIONS as readonly string[]).includes(operation)) return failure(operation, "operation_unavailable", "unavailable");
		try {
			const loaded = this.load();
			if (operation === "plan.enter" && loaded.state.status === "active") {
				if (!keysAllowed(payload, ["expectedRevision"]) || payload.expectedRevision !== context.expectedRevision || context.expectedRevision !== loaded.state.revision) return failure(operation, "domain_revision_conflict", "stale");
				return ok(operation, loaded.state, this.inspection(loaded));
			}
			return await this.commit(operation, payload, context, loaded);
		} catch (error) {
			return failure(operation, error instanceof Error ? error.message : "plan_operation_failed");
		}
	}

	private async commit(operation: string, payload: Record<string, unknown>, context: SessionDomainMutationContext, loaded: LoadedPlan): Promise<SessionDomainResult> {
		const { store, fence } = this.options;
		const requestId = runtimeDigest({ sessionId: fence.sessionId, correlationId: context.correlationId, effectId: context.effectId }).digest;
		const requestDigest = runtimeDigest({ operation, payload, expectedRevision: context.expectedRevision });
		const previous = loaded.requests.get(requestId);
		if (previous !== undefined) return previous.digest.digest === requestDigest.digest ? previous.result : failure(operation, "plan_idempotency_conflict");
		if (!Number.isSafeInteger(context.expectedRevision) || context.expectedRevision !== loaded.state.revision
			|| (payload.expectedRevision !== undefined && payload.expectedRevision !== context.expectedRevision)) {
			return { ...failure(operation, "domain_revision_conflict", "stale"), currentRevision: loaded.state.revision };
		}
		const prepared = this.prepare(operation, payload, loaded);
		if (!prepared.ok) return failure(operation, prepared.code);
		const port = this.options.attemptPort();
		if (port === undefined) return failure(operation, "owner_fenced");
		const commandId = createRuntimeId("command", `plan-${requestId}`);
		const attemptId = createRuntimeId("attempt", `plan-${requestId}`);
		const begun = port.beginAttempt({ commandId, attemptId, effectClass: "workspace_mutation", requestDigest });
		if ("error" in begun) return failure(operation, begun.error, begun.error === "recovery_barrier_active" ? "recovery_required" : "failed");
		if ("status" in begun && begun.status !== "started") return failure(operation, "plan_attempt_without_event");
		if (!("attemptId" in begun)) return failure(operation, "plan_attempt_unavailable");
		const eventPayload: PlanEventPayload = {
			schema: SCHEMA, sessionId: fence.sessionId, policyCeilingDigest: loaded.state.policyCeilingDigest,
			requestId, operation, requestDigest, commandId: begun.commandId, attemptId: begun.attemptId,
			commands: prepared.commands, ...(prepared.content === undefined ? {} : { content: prepared.content }),
		};
		let committed = false;
		try {
			const tail = store.replaySessionEvents(fence.sessionId).at(-1);
			store.appendEvent(fence, {
				eventId: createRuntimeId("event", `plan-${requestId}`), ownerGeneration: fence.generation,
				eventType: eventType(prepared.commands.at(-1)!), payloadJson: JSON.stringify(eventPayload),
				createdAtMs: Date.now(), expectedPreviousEventHash: tail?.currentEventHash ?? null,
			});
			committed = true;
			const result = this.load().requests.get(requestId)?.result;
			if (result === undefined) throw new Error("plan_commit_missing");
			const settled = port.settleAttempt(begun.attemptId, "committed", runtimeDigest({ operation, requestId }));
			return settled.ok ? result : failure(operation, settled.code);
		} catch (error) {
			port.settleAttempt(begun.attemptId, committed ? "uncertain" : "rejected", runtimeDigest({ code: "plan_commit_failed" }));
			return failure(operation, error instanceof Error ? error.message : "plan_commit_failed");
		}
	}

	private prepare(operation: string, payload: Record<string, unknown>, loaded: LoadedPlan):
		{ readonly ok: true; readonly commands: readonly PlanModeCommand[]; readonly content?: string } | { readonly ok: false; readonly code: string } {
		let state = loaded.state;
		const commands: PlanModeCommand[] = [];
		const updatedAt = new Date().toISOString();
		const apply = (command: PlanModeCommand): void => {
			const reduced = reducePlanModeState(state, command);
			if (!reduced.ok) throw new Error(reduced.error.code);
			state = reduced.value; commands.push(command);
		};
		try {
			let content: string | undefined;
			if (operation === "plan.initialize" || operation === "plan.write" || operation === "plan.activate") {
				if (!keysAllowed(payload, ["content", "expectedRevision", "expectedPlanRevision"]) || !validContent(payload.content)) return { ok: false, code: "plan_content_invalid" };
				content = payload.content;
				if (operation === "plan.initialize") apply({ type: "request_activation", expectedRevision: state.revision, requestedBy: "user", updatedAt });
				const expected = operation === "plan.initialize" ? null : payload.expectedPlanRevision;
				if (expected !== null && (typeof expected !== "number" || expected !== state.plan?.revision)) return { ok: false, code: "stale_expected_plan_revision" };
				if ((state.plan?.revision ?? 0) >= 255) return { ok: false, code: "plan_revision_limit" };
				const artifact = loaded.artifacts.put({ goalId: state.goalId, workspaceId: this.options.workspaceId, content, expectedRevision: expected });
				if (!artifact.ok) return { ok: false, code: artifact.error.code };
				apply(operation === "plan.initialize"
					? { type: "activate", expectedRevision: state.revision, plan: artifact.value, updatedAt }
					: { type: "write_plan", expectedRevision: state.revision, expectedPlanRevision: expected!, plan: artifact.value, updatedAt });
			} else if (operation === "plan.request_approval") {
				if (!keysAllowed(payload, ["expectedRevision", "expectedPlanRevision", "expectedPlanDigest"]) || !isRuntimeDigest(payload.expectedPlanDigest) || typeof payload.expectedPlanRevision !== "number") return { ok: false, code: "plan_approval_request_invalid" };
				if (state.plan?.revision === 0) return { ok: false, code: "plan_artifact_unedited" };
				apply({ type: "request_approval", expectedRevision: state.revision, expectedPlanRevision: payload.expectedPlanRevision, expectedPlanDigest: payload.expectedPlanDigest, updatedAt });
			} else if (operation === "plan.resolve_approval") {
				if (!keysAllowed(payload, ["expectedRevision", "expectedPlanRevision", "expectedPlanDigest", "approvalId", "decision"])
					|| state.approval === undefined || state.plan === undefined || state.approval.approvalId !== payload.approvalId
					|| payload.expectedPlanRevision !== state.plan.revision || !isRuntimeDigest(payload.expectedPlanDigest) || payload.expectedPlanDigest.digest !== state.plan.digest.digest
					|| (payload.decision !== "approved" && payload.decision !== "rejected")) return { ok: false, code: "plan_approval_binding_mismatch" };
				const receipt = { approvalId: payload.approvalId, plan: state.plan, decision: payload.decision };
				apply({ type: "resolve_approval", expectedRevision: state.revision, updatedAt, approval: { ...state.approval, status: payload.decision,
					...(payload.decision === "approved" ? { receiptRef: { subjectKind: "receipt", digest: runtimeDigest(receipt), mediaType: "application/json", size: Buffer.byteLength(JSON.stringify(receipt)) } } : {}),
				} });
			} else if (operation === "plan.cancel") {
				if (!keysAllowed(payload, ["expectedRevision"])) return { ok: false, code: "plan_cancel_invalid" };
				if (state.status === "active" && state.plan !== undefined) apply({ type: "request_exit", expectedRevision: state.revision, expectedPlanRevision: state.plan.revision, expectedPlanDigest: state.plan.digest, updatedAt });
				if (state.status === "pending") apply({ type: "cancel_activation", expectedRevision: state.revision, updatedAt });
				else if (state.status === "awaiting_approval" && state.approval !== undefined) apply({ type: "cancel_approval", expectedRevision: state.revision, approvalId: state.approval.approvalId, updatedAt });
				else return { ok: false, code: "plan_cancel_requires_pending_or_active" };
			} else if (operation === "plan.settle_exit") {
				if (!keysAllowed(payload, ["expectedRevision"])) return { ok: false, code: "plan_exit_invalid" };
				apply({ type: "settle_exit", expectedRevision: state.revision, updatedAt });
			} else return { ok: false, code: "plan_workflow_finished_create_new_session" };
			return { ok: true, commands, ...(content === undefined ? {} : { content }) };
		} catch (error) { return { ok: false, code: error instanceof Error ? error.message : "plan_request_invalid" }; }
	}

	private load(): LoadedPlan {
		const { store, fence, workspaceId } = this.options;
		const catalog = store.getSession(fence.sessionId);
		if (catalog === undefined) throw new Error("plan_session_not_found");
		const events = store.replaySessionEvents(fence.sessionId);
		const planEvents = events.filter((event) => event.eventType.startsWith("plan.") || (event.eventType === "artifact.created" && event.payloadJson.includes(SCHEMA)));
		let policy = this.options.policyCeilingDigest;
		const parsed = planEvents.map((event) => decode(event, fence.sessionId));
		if (parsed[0] !== undefined) policy = parsed[0].policyCeilingDigest;
		const base = {
			status: "inactive" as const, sessionId: fence.sessionId,
			goalId: createRuntimeId("goal", runtimeDigest({ sessionId: fence.sessionId, workspaceId }).digest.slice(0, 48)),
			revision: 0, policyCeilingDigest: policy,
			sourceHead: { streamId: fence.sessionId, sequence: 0, eventHash: runtimeDigest("runledger-empty-runtime-stream") },
			completeness: "complete" as const, updatedAt: new Date(catalog.createdAtMs).toISOString(),
		};
		const loaded: LoadedPlan = { state: { ...base, projectionDigest: runtimeDigest(base) }, artifacts: new PlanArtifactStore(), requests: new Map() };
		for (let index = 0; index < parsed.length; index += 1) {
			const payload = parsed[index]!; const event = planEvents[index]!;
			if (payload.policyCeilingDigest.digest !== policy.digest || loaded.requests.has(payload.requestId)) throw new Error("plan_event_binding_corrupt");
			for (const command of payload.commands) {
				if (command.type === "activate" || command.type === "write_plan") {
					if (!validContent(payload.content)) throw new Error("plan_artifact_corrupt");
					const artifact = loaded.artifacts.put({ goalId: loaded.state.goalId, workspaceId, content: payload.content, expectedRevision: command.type === "activate" ? null : command.expectedPlanRevision });
					if (!artifact.ok || runtimeDigest(artifact.value).digest !== runtimeDigest(command.plan).digest) throw new Error("plan_artifact_digest_mismatch");
				}
				const next = reducePlanModeState(loaded.state, command);
				if (!next.ok) throw new Error(`plan_event_corrupt: ${next.error.code}`);
				loaded.state = next.value;
			}
			loaded.state = reproject(loaded.state, { streamId: fence.sessionId, sequence: event.sequence, eventHash: { algorithm: "sha256", digest: event.currentEventHash as RuntimeDigest["digest"] } });
			const operation = payload.operation;
			loaded.requests.set(payload.requestId, { digest: payload.requestDigest, result: { ...ok(operation, loaded.state, this.inspection(loaded)), receipt: { attemptId: payload.attemptId, commandId: payload.commandId, outcome: "committed" } } });
		}
		return loaded;
	}

	private inspection(loaded: LoadedPlan): SessionPlanInspection {
		const working = loaded.artifacts.working(loaded.state.goalId, this.options.workspaceId);
		const ref = loaded.state.plan ?? (working.ok ? working.value : undefined);
		const content = ref === undefined ? undefined : loaded.artifacts.read(ref);
		return { repositoryId: this.options.repositoryId, state: loaded.state, ...(content?.ok === true ? { content: content.value } : {}) };
	}
}

function reproject(state: PlanModeState, sourceHead: RuntimeStreamHead): PlanModeState {
	const { projectionDigest: _digest, plan, approval, ...base } = state;
	const projection = { ...base, sourceHead, ...(plan === undefined ? {} : { plan }), ...(approval === undefined ? {} : { approval }) };
	const next = { ...projection, projectionDigest: runtimeDigest(projection) };
	if (!isValidPlanModeState(next)) throw new Error("plan_projection_corrupt");
	return next;
}
function validContent(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0 && value.length <= 65_536 && Buffer.byteLength(value) <= MAX_CONTENT_BYTES; }
function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function keysAllowed(value: Record<string, unknown>, keys: readonly string[]): boolean { return Object.keys(value).every((key) => keys.includes(key)); }
function decode(event: SessionEventRecord, sessionId: SessionId): PlanEventPayload {
	const value: unknown = JSON.parse(event.payloadJson);
	if (!record(value) || !keysAllowed(value, ["schema", "sessionId", "policyCeilingDigest", "requestId", "operation", "requestDigest", "commandId", "attemptId", "commands", "content"])
		|| typeof value.operation !== "string" || !["plan.initialize", ...OPERATIONS].includes(value.operation)
		|| value.schema !== SCHEMA || value.sessionId !== sessionId || !isRuntimeDigest(value.policyCeilingDigest) || !isRuntimeDigest(value.requestDigest)
		|| typeof value.requestId !== "string" || !/^[a-f0-9]{64}$/u.test(value.requestId) || !isRuntimeId(value.commandId, "command") || !isRuntimeId(value.attemptId, "attempt")
		|| !Array.isArray(value.commands) || value.commands.length < 1 || value.commands.length > 2 || !value.commands.every(validCommand)
		|| (value.content !== undefined && !validContent(value.content)) || event.eventType !== eventType(value.commands.at(-1)!)) throw new Error("plan_event_corrupt");
	return value as unknown as PlanEventPayload;
}
function validCommand(value: unknown): value is PlanModeCommand {
	if (!record(value) || typeof value.type !== "string" || !Number.isSafeInteger(value.expectedRevision) || typeof value.updatedAt !== "string") return false;
	const extra: Record<string, readonly string[]> = {
		request_activation: ["requestedBy"], activate: ["plan"], write_plan: ["expectedPlanRevision", "plan"],
		request_approval: ["expectedPlanRevision", "expectedPlanDigest"], request_exit: ["expectedPlanRevision", "expectedPlanDigest"],
		resolve_approval: ["approval"], cancel_activation: [], cancel_approval: ["approvalId"], settle_exit: [],
	};
	return Object.hasOwn(extra, value.type) && keysAllowed(value, ["type", "expectedRevision", "updatedAt", ...extra[value.type]!]);
}
function eventType(command: PlanModeCommand): string {
	switch (command.type) {
		case "request_activation": return "plan.enter_requested";
		case "activate": return "plan.entered";
		case "write_plan": return "artifact.created";
		case "request_approval": return "plan.approval_requested";
		case "request_exit": return "plan.exit_requested";
		case "resolve_approval": return command.approval.status === "approved" ? "plan.approved" : "plan.failed";
		case "invalidate_approval": return "plan.failed";
		case "cancel_activation": case "cancel_approval": case "settle_exit": return "plan.exited";
	}
}
function ok(operation: string, state: PlanModeState, value: SessionPlanInspection): Extract<SessionDomainResult, { ok: true }> { return { ok: true, status: "ok", operation, domainRevision: state.revision, value }; }
function failure(operation: string, code: string, status: "failed" | "stale" | "unavailable" | "recovery_required" = "failed"): Extract<SessionDomainResult, { ok: false }> { return { ok: false, status, code, operation }; }
