/**
 * Session Owner 的 Goal authority：canonical 目标状态、预算与用量记账的事件真源。
 *
 * 与 plan-domain 同构：domain 是唯一 writer，提交后推进缓存；崩溃恢复走完整重放。
 * 与 plan 的差异：goal 状态没有文件工件，全部事实都在 session event 里，因此
 * 事件写入是事务性的，attempt effectClass 取 `readonly`（无工作区/外部副作用）。
 */

import type { SessionStore, SessionEventRecord } from "../../storage/session-store/session-store.ts";
import {
	createGoalBaseState,
	reduceGoalModeState,
	reprojectGoalModeState,
	type GoalModeCommand,
	type GoalUsageDelta,
} from "../modes/goal/reducer.ts";
import type { GoalBudget, GoalModeState } from "../modes/goal/types.ts";
import { runtimeDigest, type RuntimeDigest } from "../protocol/foundation.ts";
import { isRuntimeDigest } from "../protocol/foundation-schemas.ts";
import { createRuntimeId, isRuntimeId, type AttemptId, type CommandId, type RepositoryId } from "../protocol/ids.ts";
import type { OwnerFence } from "../session-owner/types.ts";
import type { SessionProtocolOperationDescriptor } from "../session-server/protocol.ts";
import type { AttemptPort } from "./attempt-gateway.ts";
import type { SessionDomainMutationContext, SessionDomainResult } from "./domain-router.ts";
import { sessionGoalId, type SessionGoalInspection } from "./goal-composition.ts";
import type { SessionResourceDomainPort } from "./session-runtime.ts";

const SCHEMA = "runledger.session-goal.current";
const MAX_PAUSE_REASON_CHARS = 128;
const OPERATIONS = [
	"goal.set", "goal.replace", "goal.pause", "goal.resume", "goal.drop",
	"goal.request_complete", "goal.settle_complete", "goal.set_budget", "goal.account_usage",
] as const;
const MANIFEST: readonly SessionProtocolOperationDescriptor[] = Object.freeze([
	...OPERATIONS.map((operation) => Object.freeze({ operation, capability: "session.goal", access: "mutate" as const })),
	Object.freeze({ operation: "goal.inspect", capability: "session.goal", access: "read" as const }),
]);

interface GoalEventPayload {
	readonly schema: typeof SCHEMA;
	readonly sessionId: string;
	readonly policyCeilingDigest: RuntimeDigest;
	readonly requestId: string;
	readonly operation: string;
	readonly requestDigest: RuntimeDigest;
	readonly commandId: CommandId;
	readonly attemptId: AttemptId;
	readonly commands: readonly GoalModeCommand[];
}

/**
 * 抑制自动续跑不是状态转移（不改 revision），因此单独一种 payload：
 * 只记录原因与当时的 revision，供审计，不参与重放。
 */
const AUDIT_SCHEMA = "runledger.session-goal.audit";

interface GoalAuditPayload {
	readonly schema: typeof AUDIT_SCHEMA;
	readonly sessionId: string;
	readonly reasonCode: string;
	readonly expectedRevision: number;
}

interface LoadedGoal {
	state: GoalModeState;
	readonly requests: Map<string, { readonly digest: RuntimeDigest; readonly result: SessionDomainResult }>;
}

export interface SessionGoalDomainOptions {
	readonly store: SessionStore;
	readonly fence: OwnerFence;
	readonly workspaceId: string;
	readonly repositoryId: RepositoryId;
	readonly policyCeilingDigest: RuntimeDigest;
	readonly attemptPort: () => AttemptPort | undefined;
}

/** 只发布 Goal mutation 与 `goal.inspect`；不做任何 prompt/TUI 判定。 */
export class SessionGoalDomain implements SessionResourceDomainPort {
	public readonly operationManifest = MANIFEST;
	private readonly options: SessionGoalDomainOptions;
	/** 已校验的 canonical 状态；只有自身 commit 成功后才替换，稳态下不重放事件。 */
	#cache: LoadedGoal | undefined;
	#continuationTurn = false;
	/**
	 * 写串行化。owner 侧记账（每轮 message_end / agent_end）与续跑记账是并发触发的，
	 * 两者都读当前 revision 再提交；不串行就会出现自己和自己抢 CAS 的伪冲突。
	 */
	#writes: Promise<unknown> = Promise.resolve();

	public constructor(options: SessionGoalDomainOptions) {
		this.options = options;
		this.load();
	}

	public inspect(): SessionGoalInspection {
		const loaded = this.load();
		return { repositoryId: this.options.repositoryId, state: loaded.state };
	}

	/**
	 * owner 侧记账入口：controller 直接调用，不经客户端的 mutation 信封。
	 * 目标非 active 时返回 false，由调用方决定是否告警；不抛错。
	 */
	public async accountUsage(delta: GoalUsageDelta): Promise<boolean> {
		return this.enqueueWrite(async () => {
		const state = this.load().state;
		if (state.status !== "active") return false;
		const result = await this.commit(
			"goal.account_usage",
			{ delta, expectedRevision: state.revision },
			{ correlationId: `goal-usage-${state.revision}`, effectId: `goal-usage-${state.revision}`, expectedRevision: state.revision },
			this.load(),
		);
		return result.ok;
		});
	}

	/** 串行执行一次 owner 侧写；保证内部提交不会互相抢 revision。 */
	private enqueueWrite<T>(work: () => Promise<T>): Promise<T> {
		const next = this.#writes.then(work, work);
		// 失败不阻断队列：下一个写仍要执行，错误由各自的调用方处理。
		this.#writes = next.then(() => undefined, () => undefined);
		return next;
	}

	/** 记录一次自动续跑；返回 false 表示当前状态不允许续跑记账。 */
	public async recordContinuation(): Promise<boolean> {
		return this.enqueueWrite(async () => {
		const state = this.load().state;
		if (state.status !== "active") return false;
		const result = await this.commit(
			"goal.continuation_requested",
			{ expectedRevision: state.revision },
			{ correlationId: `goal-continuation-${state.revision}`, effectId: `goal-continuation-${state.revision}`, expectedRevision: state.revision },
			this.load(),
		);
		return result.ok;
		});
	}

	/**
	 * 抑制自动续跑的审计记录：不改 revision，因此不参与重放，也不做幂等去重。
	 * 落库失败不抛出（与 agent.event 一致），返回 false 由调用方决定是否告警。
	 */
	public recordSuppression(reasonCode: string): boolean {
		const { store, fence } = this.options;
		const state = this.load().state;
		const payload: GoalAuditPayload = { schema: AUDIT_SCHEMA, sessionId: fence.sessionId, reasonCode, expectedRevision: state.revision };
		try {
			const tail = store.latestEventHead(fence.sessionId);
			store.appendEvent(fence, {
				eventId: createRuntimeId("event", `goal-suppressed-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`),
				ownerGeneration: fence.generation,
				eventType: "goal.continuation_suppressed",
				payloadJson: JSON.stringify(payload),
				createdAtMs: Date.now(),
				expectedPreviousEventHash: tail.hash,
			});
			return true;
		} catch {
			return false;
		}
	}

	/**
	 * 标记「本 run 由 owner 自动续跑触发」。fragment 用它加强完成前自检提示；
	 * 集合点在续跑注入前，清零点在该 run 的 agent_end。
	 */
	public markContinuationTurn(): void {
		this.#continuationTurn = true;
	}

	public clearContinuationTurn(): void {
		this.#continuationTurn = false;
	}

	public isContinuationTurn(): boolean {
		return this.#continuationTurn;
	}

	public async query(operation: string, payload: Record<string, unknown> = {}): Promise<SessionDomainResult> {
		if (operation !== "goal.inspect") return failure(operation, "operation_unavailable", "unavailable");
		if (!keysAllowed(payload, [])) return failure(operation, "goal_inspect_invalid");
		const loaded = this.load();
		return {
			ok: true,
			status: "ok",
			operation,
			domainRevision: loaded.state.revision,
			value: { repositoryId: this.options.repositoryId, state: loaded.state },
		};
	}

	public async mutate(operation: string, payload: Record<string, unknown>, context: SessionDomainMutationContext): Promise<SessionDomainResult> {
		if (!(OPERATIONS as readonly string[]).includes(operation) && operation !== "goal.continuation_requested") {
			return failure(operation, "operation_unavailable", "unavailable");
		}
		try {
			return await this.enqueueWrite(() => this.commit(operation, payload, context, this.load()));
		} catch (error) {
			return failure(operation, error instanceof Error ? error.message : "goal_operation_failed");
		}
	}

	private async commit(operation: string, payload: Record<string, unknown>, context: SessionDomainMutationContext, loaded: LoadedGoal): Promise<SessionDomainResult> {
		const { store, fence } = this.options;
		const requestId = runtimeDigest({ sessionId: fence.sessionId, correlationId: context.correlationId, effectId: context.effectId }).digest;
		const requestDigest = runtimeDigest({ operation, payload, expectedRevision: context.expectedRevision });
		const previous = loaded.requests.get(requestId);
		if (previous !== undefined) return previous.digest.digest === requestDigest.digest ? previous.result : failure(operation, "goal_idempotency_conflict");
		if (!Number.isSafeInteger(context.expectedRevision) || context.expectedRevision !== loaded.state.revision
			|| (payload.expectedRevision !== undefined && payload.expectedRevision !== context.expectedRevision)) {
			return { ...failure(operation, "domain_revision_conflict", "stale"), currentRevision: loaded.state.revision };
		}
		const prepared = this.prepare(operation, payload, loaded);
		if (!prepared.ok) return failure(operation, prepared.code);
		const port = this.options.attemptPort();
		if (port === undefined) return failure(operation, "owner_fenced");
		const commandId = createRuntimeId("command", `goal-${requestId}`);
		const attemptId = createRuntimeId("attempt", `goal-${requestId}`);
		// goal 状态只写 owner-fenced session event，没有工作区或外部副作用。
		const begun = port.beginAttempt({ commandId, attemptId, effectClass: "readonly", requestDigest });
		if ("error" in begun) return failure(operation, begun.error, begun.error === "recovery_barrier_active" ? "recovery_required" : "failed");
		if ("status" in begun && begun.status !== "started") return failure(operation, "goal_attempt_without_event");
		if (!("attemptId" in begun)) return failure(operation, "goal_attempt_unavailable");
		let committed = false;
		try {
			const eventPayload: GoalEventPayload = {
				schema: SCHEMA, sessionId: fence.sessionId, policyCeilingDigest: loaded.state.policyCeilingDigest,
				requestId, operation, requestDigest, commandId: begun.commandId, attemptId: begun.attemptId,
				commands: prepared.commands,
			};
			// 只读链尾：避免为一次追加重放整条 session 事件流。
			const head = store.latestEventHead(fence.sessionId);
			const appended = store.appendEvent(fence, {
				eventId: createRuntimeId("event", `goal-${requestId}`), ownerGeneration: fence.generation,
				eventType: prepared.eventType, payloadJson: JSON.stringify(eventPayload),
				createdAtMs: Date.now(), expectedPreviousEventHash: head.hash,
			});
			committed = true;
			const state = reprojectGoalModeState(prepared.state, {
				streamId: fence.sessionId,
				sequence: appended.sequence,
				eventHash: { algorithm: "sha256", digest: appended.currentEventHash as RuntimeDigest["digest"] },
			});
			const requests = new Map(loaded.requests);
			const result: SessionDomainResult = {
				...ok(operation, state, { repositoryId: this.options.repositoryId, state }),
				receipt: { attemptId: begun.attemptId, commandId: begun.commandId, outcome: "committed" },
			};
			requests.set(requestId, { digest: requestDigest, result });
			this.#cache = { state, requests };
			const settled = port.settleAttempt(begun.attemptId, "committed", runtimeDigest({ operation, requestId }));
			return settled.ok ? result : failure(operation, settled.code);
		} catch (error) {
			// 未提交则 canonical 状态未变；提交后异常交由下次读取重放核对。
			port.settleAttempt(begun.attemptId, committed ? "uncertain" : "rejected", runtimeDigest({ code: "goal_commit_failed" }));
			return failure(operation, error instanceof Error ? error.message : "goal_commit_failed");
		}
	}

	private prepare(operation: string, payload: Record<string, unknown>, loaded: LoadedGoal):
		{ readonly ok: true; readonly commands: readonly GoalModeCommand[]; readonly state: GoalModeState; readonly eventType: string } | { readonly ok: false; readonly code: string } {
		let state = loaded.state;
		const commands: GoalModeCommand[] = [];
		const updatedAt = new Date().toISOString();
		try {
			if (operation === "goal.set" || operation === "goal.replace") {
				if (!keysAllowed(payload, ["objective", "budget", "expectedRevision", "setBy"])) return { ok: false, code: "goal_objective_invalid" };
				const setBy = payload.setBy ?? "user";
				if (setBy !== "user" && setBy !== "agent") return { ok: false, code: "goal_objective_invalid" };
				const budget = readBudget(payload.budget);
				if (budget === undefined) return { ok: false, code: "goal_budget_invalid" };
				const command: GoalModeCommand = operation === "goal.set"
					? { type: "set", expectedRevision: state.revision, objective: payload.objective as string, ...(budget === null ? {} : { budget }), setBy, updatedAt }
					: { type: "replace", expectedRevision: state.revision, objective: payload.objective as string, ...(budget === null ? {} : { budget }), setBy, updatedAt };
				commands.push(command);
			} else if (operation === "goal.pause") {
				if (!keysAllowed(payload, ["reason", "expectedRevision"]) || !validReason(payload.reason)) return { ok: false, code: "goal_pause_invalid" };
				commands.push({ type: "pause", expectedRevision: state.revision, reason: payload.reason, updatedAt });
			} else if (operation === "goal.resume") {
				if (!keysAllowed(payload, ["expectedRevision"])) return { ok: false, code: "goal_resume_invalid" };
				commands.push({ type: "resume", expectedRevision: state.revision, updatedAt });
			} else if (operation === "goal.drop") {
				if (!keysAllowed(payload, ["expectedRevision"])) return { ok: false, code: "goal_drop_invalid" };
				commands.push({ type: "drop", expectedRevision: state.revision, updatedAt });
			} else if (operation === "goal.request_complete") {
				if (!keysAllowed(payload, ["expectedRevision", "requestedBy"])) return { ok: false, code: "goal_complete_invalid" };
				const requestedBy = payload.requestedBy ?? "agent";
				if (requestedBy !== "agent" && requestedBy !== "user") return { ok: false, code: "goal_complete_invalid" };
				commands.push({ type: "request_complete", expectedRevision: state.revision, requestedBy, updatedAt });
			} else if (operation === "goal.settle_complete") {
				if (!keysAllowed(payload, ["expectedRevision", "decision"]) || (payload.decision !== "approved" && payload.decision !== "rejected")) {
					return { ok: false, code: "goal_complete_settlement_invalid" };
				}
				commands.push({ type: "settle_complete", expectedRevision: state.revision, decision: payload.decision, updatedAt });
			} else if (operation === "goal.set_budget") {
				if (!keysAllowed(payload, ["budget", "expectedRevision"])) return { ok: false, code: "goal_budget_invalid" };
				const budget = readBudget(payload.budget);
				if (budget === undefined || budget === null) return { ok: false, code: "goal_budget_invalid" };
				commands.push({ type: "set_budget", expectedRevision: state.revision, budget, updatedAt });
			} else if (operation === "goal.account_usage") {
				if (!keysAllowed(payload, ["delta", "expectedRevision"])) return { ok: false, code: "goal_usage_invalid" };
				const delta = readUsageDelta(payload.delta);
				if (delta === undefined) return { ok: false, code: "goal_usage_invalid" };
				commands.push({ type: "account_usage", expectedRevision: state.revision, delta, updatedAt });
			} else if (operation === "goal.continuation_requested") {
				if (!keysAllowed(payload, ["expectedRevision"])) return { ok: false, code: "goal_continuation_invalid" };
				commands.push({ type: "record_continuation", expectedRevision: state.revision, updatedAt });
			} else return { ok: false, code: "operation_unavailable" };
			// 试算：任一转移失败都不写事件，也不留下半写状态。
			for (const command of commands) {
				const reduced = reduceGoalModeState(state, command);
				if (!reduced.ok) return { ok: false, code: reduced.error.code };
				state = reduced.value;
			}
			return { ok: true, commands, state, eventType: eventTypeFor(commands.at(-1)!, state) };
		} catch (error) {
			return { ok: false, code: error instanceof Error ? error.message : "goal_request_invalid" };
		}
	}

	private load(): LoadedGoal {
		if (this.#cache !== undefined) return this.#cache;
		this.#cache = this.replay();
		return this.#cache;
	}

	/** 完整重放：只在首次构造、缓存失效后与显式恢复路径执行。 */
	private replay(): LoadedGoal {
		const { store, fence, workspaceId } = this.options;
		const catalog = store.getSession(fence.sessionId);
		if (catalog === undefined) throw new Error("goal_session_not_found");
		const events = store.replaySessionEvents(fence.sessionId);
		const goalEvents = events.filter((event) => event.eventType.startsWith("goal.") && event.payloadJson.includes(SCHEMA));
		const parsed = goalEvents.map((event) => decode(event, fence.sessionId));
		let policy = this.options.policyCeilingDigest;
		if (parsed[0] !== undefined) policy = parsed[0].policyCeilingDigest;
		let state = createGoalBaseState({
			sessionId: fence.sessionId,
			goalId: sessionGoalId(fence.sessionId, workspaceId),
			policyCeilingDigest: policy,
			sourceHead: { streamId: fence.sessionId, sequence: 0, eventHash: runtimeDigest("runledger-empty-runtime-stream") },
			updatedAt: new Date(catalog.createdAtMs).toISOString(),
		});
		const loaded: LoadedGoal = { state, requests: new Map() };
		for (let index = 0; index < parsed.length; index += 1) {
			const payload = parsed[index]!;
			const event = goalEvents[index]!;
			if (payload.policyCeilingDigest.digest !== policy.digest || loaded.requests.has(payload.requestId)) throw new Error("goal_event_binding_corrupt");
			for (const command of payload.commands) {
				const next = reduceGoalModeState(state, command);
				if (!next.ok) throw new Error(`goal_event_corrupt: ${next.error.code}`);
				state = next.value;
			}
			state = reprojectGoalModeState(state, {
				streamId: fence.sessionId,
				sequence: event.sequence,
				eventHash: { algorithm: "sha256", digest: event.currentEventHash as RuntimeDigest["digest"] },
			});
			loaded.state = state;
			const inspection: SessionGoalInspection = { repositoryId: this.options.repositoryId, state };
			loaded.requests.set(payload.requestId, {
				digest: payload.requestDigest,
				result: {
					...ok(payload.operation, state, inspection),
					receipt: { attemptId: payload.attemptId, commandId: payload.commandId, outcome: "committed" },
				},
			});
		}
		return loaded;
	}
}

/** 事件类型按转移结果决定：预算耗尽与续跑记账在 catalog 里是独立类型。 */
function eventTypeFor(command: GoalModeCommand, state: GoalModeState): string {
	switch (command.type) {
		case "set": case "replace": case "pause": case "resume": case "drop":
		case "request_complete": case "settle_complete":
			return "goal.transitioned";
		case "record_continuation": return "goal.continuation_requested";
		case "set_budget": return "goal.budget_updated";
		case "account_usage":
			return state.status === "budget_limited" ? "goal.budget_exhausted" : "goal.usage_accounted";
	}
}

/** `null` 表示未提供 budget；`undefined` 表示提供了但非法。 */
function readBudget(value: unknown): GoalBudget | null | undefined {
	if (value === undefined) return null;
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	if (Object.keys(record).some((key) => key !== "tokenBudget" && key !== "timeBudgetMs")) return undefined;
	const out: { tokenBudget?: number; timeBudgetMs?: number } = {};
	for (const key of ["tokenBudget", "timeBudgetMs"] as const) {
		const entry = record[key];
		if (entry === undefined) continue;
		if (typeof entry !== "number" || !Number.isSafeInteger(entry) || entry < 0) return undefined;
		out[key] = entry;
	}
	return out;
}

function readUsageDelta(value: unknown): GoalUsageDelta | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	const allowed = ["inputTokens", "cacheWriteTokens", "outputTokens", "activeDurationMs", "tokensUnknown"];
	if (Object.keys(record).some((key) => !allowed.includes(key))) return undefined;
	const out: { inputTokens?: number; cacheWriteTokens?: number; outputTokens?: number; activeDurationMs?: number; tokensUnknown?: boolean } = {};
	for (const key of ["inputTokens", "cacheWriteTokens", "outputTokens", "activeDurationMs"] as const) {
		const entry = record[key];
		if (entry === undefined) continue;
		if (typeof entry !== "number" || !Number.isSafeInteger(entry) || entry < 0) return undefined;
		out[key] = entry;
	}
	if (record.tokensUnknown !== undefined) {
		if (typeof record.tokensUnknown !== "boolean") return undefined;
		out.tokensUnknown = record.tokensUnknown;
	}
	return out;
}

function validReason(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0 && value.length <= MAX_PAUSE_REASON_CHARS;
}

function keysAllowed(value: Record<string, unknown>, keys: readonly string[]): boolean {
	return Object.keys(value).every((key) => keys.includes(key));
}

function ok(operation: string, state: GoalModeState, value: SessionGoalInspection): Extract<SessionDomainResult, { ok: true }> {
	return { ok: true, status: "ok", operation, domainRevision: state.revision, value };
}

function failure(operation: string, code: string, status: "failed" | "stale" | "unavailable" | "recovery_required" = "failed"): Extract<SessionDomainResult, { ok: false }> {
	return { ok: false, status, code, operation };
}

function decode(event: SessionEventRecord, sessionId: string): GoalEventPayload {
	const value: unknown = JSON.parse(event.payloadJson);
	if (!record(value)
		|| !keysAllowed(value, ["schema", "sessionId", "policyCeilingDigest", "requestId", "operation", "requestDigest", "commandId", "attemptId", "commands"])
		|| typeof value.operation !== "string" || !(OPERATIONS as readonly string[]).includes(value.operation as typeof OPERATIONS[number])
		|| value.schema !== SCHEMA || value.sessionId !== sessionId
		|| !isRuntimeDigest(value.policyCeilingDigest) || !isRuntimeDigest(value.requestDigest)
		|| typeof value.requestId !== "string" || !/^[a-f0-9]{64}$/u.test(value.requestId)
		|| !isRuntimeId(value.commandId, "command") || !isRuntimeId(value.attemptId, "attempt")
		|| !Array.isArray(value.commands) || value.commands.length !== 1 || !validCommand(value.commands[0])) {
		throw new Error("goal_event_corrupt");
	}
	return value as unknown as GoalEventPayload;
}

const COMMAND_EXTRA_KEYS: Record<string, readonly string[]> = {
	set: ["objective", "budget", "setBy"],
	replace: ["objective", "budget", "setBy"],
	pause: ["reason"],
	resume: [], drop: [],
	request_complete: ["requestedBy"],
	settle_complete: ["decision"],
	set_budget: ["budget"],
	account_usage: ["delta"],
	record_continuation: [],
};

function validCommand(value: unknown): value is GoalModeCommand {
	if (!record(value) || typeof value.type !== "string" || !Number.isSafeInteger(value.expectedRevision) || typeof value.updatedAt !== "string") return false;
	const extra = COMMAND_EXTRA_KEYS[value.type];
	return extra !== undefined && keysAllowed(value, ["type", "expectedRevision", "updatedAt", ...extra]);
}

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
