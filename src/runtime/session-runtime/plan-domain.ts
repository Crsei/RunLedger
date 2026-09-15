/** Session Owner 的 Plan authority：exact events、immutable artifact revisions 与审批绑定。 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SessionStore, SessionEventRecord } from "../../storage/session-store/session-store.ts";
import { PlanArtifactStore } from "../modes/plan/artifact-store.ts";
import { isValidPlanModeState, reducePlanModeState, type PlanModeCommand } from "../modes/plan/reducer.ts";
import { PLAN_GOAL_MAX_BYTES, type PlanArtifactRef, type PlanModeState } from "../modes/plan/types.ts";
import { derivePlanTitle, planExportCandidates, planExportFileName } from "../modes/plan/title.ts";
import { runtimeDigest, type RuntimeDigest, type RuntimeStreamHead } from "../protocol/foundation.ts";
import { isRuntimeDigest } from "../protocol/foundation-schemas.ts";
import { createRuntimeId, isRuntimeId, type AttemptId, type CommandId, type SessionId, type WorkspaceId, type RepositoryId } from "../protocol/ids.ts";
import { standardHarnessProfileRef } from "../harness-profiles/resolver.ts";
import type { OwnerFence } from "../session-owner/types.ts";
import type { SessionProtocolOperationDescriptor } from "../session-server/protocol.ts";
import type { AttemptPort } from "./attempt-gateway.ts";
import type { SessionDomainMutationContext, SessionDomainResult } from "./domain-router.ts";
import type { SessionPlanInspection } from "./plan-composition.ts";
import type { SessionResourceDomainPort } from "./session-runtime.ts";

const SCHEMA = "runledger.session-plan.current";
const INITIAL_CONTENT = "# Plan\n\nDescribe the goal, proposed changes, and validation before requesting approval.\n";
const MAX_CONTENT_BYTES = 131_072;
const MAX_FEEDBACK_CHARS = 8_192;
/** 空转提示上限：超过后不再注入，避免每轮重复占用预算。 */
const PLAN_CONVERGENCE_REMINDER_MAX = 3;
const OPERATIONS = [
	"plan.enter", "plan.reenter", "plan.activate", "plan.write",
	"plan.request_approval", "plan.resolve_approval", "plan.cancel", "plan.exit", "plan.settle_exit", "plan.export", "plan.handoff",
] as const;
const MANIFEST: readonly SessionProtocolOperationDescriptor[] = Object.freeze([
	...OPERATIONS.map((operation) => Object.freeze({ operation, capability: "session.plan", access: "mutate" as const })),
	Object.freeze({ operation: "plan.list", capability: "session.plan", access: "read" as const }),
]);

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
	/** 审批决策附带的修改意见；作为下一 planning turn 的输入，不写入工件正文。 */
	readonly feedback?: string;
	/** plan.export 的投影目标路径；导出不是状态转移，但必须可审计。 */
	readonly exportPath?: string;
	/** 被导出的工件 revision 与 digest。 */
	readonly exportedRevision?: number;
	readonly exportedDigest?: RuntimeDigest;
	/** plan.handoff 创建的实施会话与其绑定的审批证据。 */
	readonly handoffTargetSessionId?: SessionId;
	readonly handoffReceiptDigest?: RuntimeDigest;
}
interface ExportTarget {
	readonly ref: PlanArtifactRef;
	readonly content: string;
}

/** 导出投影的写入结果；`path` 已由独占创建落盘。 */
interface ExportWrite {
	readonly path: string;
}

/**
 * 实施交接目标：在源 session 的同一 attempt 内创建标准实施会话。
 * 目标会话不复制 planning tail；已批准正文由返回载荷交给客户端作为首个 user turn，
 * 因此不需要跨 session 写入或新增 schema。
 */
interface HandoffTarget {
	readonly targetSessionId: SessionId;
	readonly receiptDigest: RuntimeDigest;
	readonly content: string;
	readonly revision: number;
	readonly digest: RuntimeDigest;
}

/** 冲突退避上限；超过后用时间戳前缀兜底，不覆盖既有文件。 */
const EXPORT_CANDIDATE_LIMIT = 100;

/** 导出投影根与文件名由 canonical home 与标题派生决定；写失败必须抛出，不得静默降级。 */
async function writeExportProjection(input: {
	readonly plansDir: string;
	readonly fileName: string;
	readonly content: string;
}): Promise<ExportWrite> {
	await mkdir(input.plansDir, { recursive: true, mode: 0o700 });
	for (const candidate of planExportCandidates(input.fileName, EXPORT_CANDIDATE_LIMIT)) {
		const path = join(input.plansDir, candidate);
		try {
			await writeFile(path, input.content, { flag: "wx", mode: 0o600 });
			return { path };
		} catch (error) {
			if ((error as { code?: string }).code !== "EEXIST") throw error;
		}
	}
	const fallback = join(input.plansDir, `${Date.now()}-${input.fileName}`);
	await writeFile(fallback, input.content, { flag: "wx", mode: 0o600 });
	return { path: fallback };
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
	/** 仅 plan@1：owner 启动即建立工件并进入 active；standard 会话按需 enter。 */
	readonly autoActivate: boolean;
	/** 导出投影根：canonical home 的 `<home>/plans`；只写投影，不是第二真源。 */
	readonly plansDir: string;
}

/** 只发布 Plan mutation；plan.inspect 复用 domainRouter 的 canonical query。 */
export class SessionPlanDomain implements SessionResourceDomainPort {
	public readonly operationManifest = MANIFEST;
	private readonly options: SessionPlanDomainOptions;
	/** 已校验的 canonical 投影；只有自身 commit 成功后才替换，稳态下不重放事件。 */
	#cache: LoadedPlan | undefined;
	/** 收敛提示状态：只在 active 且 revision/审批未推进时累计。 */
	#convergenceMarker: string | undefined;
	#idleTurns = 0;

	public constructor(options: SessionPlanDomainOptions) {
		this.options = options;
		this.load();
	}

	public inspect(): SessionPlanInspection {
		const loaded = this.load();
		return this.inspection(loaded.state, loaded.artifacts);
	}

	/**
	 * 每个模型请求组装调用一次：plan mode 在 active 下若连续若干轮既未写 revision
	 * 也未提交审批，返回收敛提示的序号（1..MAX），否则 0。
	 * 计数随 revision 或审批提交归零，因此提示只在真正空转时出现，且有上限。
	 */
	public notePlanTurn(): number {
		const state = this.load().state;
		if (state.status !== "active") { this.#idleTurns = 0; return 0; }
		const marker = `${state.revision}:${state.plan?.revision ?? -1}`;
		if (marker !== this.#convergenceMarker) {
			this.#convergenceMarker = marker;
			this.#idleTurns = 1;
			return 0;
		}
		this.#idleTurns += 1;
		const reminder = this.#idleTurns - 1;
		return reminder > PLAN_CONVERGENCE_REMINDER_MAX ? 0 : reminder;
	}

	/** 只读 query：`plan.list` 返回会话内全部不可变 revision 及其 pin 状态。 */
	public async query(operation: string, payload: Record<string, unknown> = {}): Promise<SessionDomainResult> {
		if (operation !== "plan.list") return failure(operation, "operation_unavailable", "unavailable");
		if (!keysAllowed(payload, [])) return failure(operation, "plan_list_invalid");
		const loaded = this.load();
		const revisions = loaded.artifacts.revisions(loaded.state.goalId, this.options.workspaceId);
		if (!revisions.ok) return failure(operation, revisions.error.code);
		const inspection = this.inspection(loaded.state, loaded.artifacts);
		// `current` 指工作指针（inspect/export/reentry 解析到的那个 revision），
		// 退出后 state.plan 已清空但指针仍在，因此不能按 state.plan 判定。
		const working = loaded.artifacts.working(loaded.state.goalId, this.options.workspaceId);
		const currentRevision = working.ok ? working.value?.revision : undefined;
		return {
			ok: true,
			status: "ok",
			operation,
			domainRevision: loaded.state.revision,
			value: {
				...inspection,
				revisions: revisions.value.map((ref) => {
					const content = loaded.artifacts.read(ref);
					return {
						revision: ref.revision,
						digest: ref.digest,
						bytes: ref.artifactRef.size,
						title: content.ok ? derivePlanTitle({ content: content.value }) : undefined,
						current: currentRevision === ref.revision,
					};
				}),
			},
		};
	}

	public async start(): Promise<void> {
		if (!this.options.autoActivate) return;
		const loaded = this.load();
		if (loaded.state.revision !== 0) return;
		const result = await this.commit("plan.initialize", { content: INITIAL_CONTENT }, { correlationId: "plan-initialize", effectId: "plan-initialize", expectedRevision: 0 }, loaded);
		if (!result.ok) throw new Error(`plan initialization failed: ${result.code}`);
	}

	public async mutate(operation: string, payload: Record<string, unknown>, context: SessionDomainMutationContext): Promise<SessionDomainResult> {
		if (!(OPERATIONS as readonly string[]).includes(operation)) return failure(operation, "operation_unavailable", "unavailable");
		try {
			const loaded = this.load();
			if ((operation === "plan.enter" || operation === "plan.reenter") && loaded.state.status === "active") {
				if (!keysAllowed(payload, ["expectedRevision"]) || payload.expectedRevision !== context.expectedRevision || context.expectedRevision !== loaded.state.revision) return failure(operation, "domain_revision_conflict", "stale");
				return ok(operation, loaded.state, this.inspection(loaded.state, loaded.artifacts));
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
		let committed = false;
		try {
			// 交接先创建实施会话，再把目标写入事件；任一失败都不留下 handoff 事件。
			if (prepared.handoffTarget !== undefined) {
				const catalog = store.getSession(fence.sessionId);
				if (catalog === undefined) throw new Error("plan_session_not_found");
				store.createSession({
					sessionId: prepared.handoffTarget.targetSessionId,
					workspaceId: catalog.workspaceId,
					repositoryId: catalog.repositoryId,
					settingsDigest: catalog.settingsDigest,
					harnessProfile: standardHarnessProfileRef(2),
					...(catalog.sourceWorkspaceLocator === undefined ? {} : { sourceWorkspaceLocator: catalog.sourceWorkspaceLocator }),
				});
			}
			// 导出先把投影写到 canonical home，再把实际路径写进事件；没有事件就不算导出成功。
			const exported = prepared.exportTarget === undefined
				? undefined
				: await writeExportProjection({
					plansDir: this.options.plansDir,
					fileName: planExportFileName(derivePlanTitle({
						content: prepared.exportTarget.content,
						...(store.getSession(fence.sessionId)?.title === undefined || store.getSession(fence.sessionId)?.title === null
							? {}
							: { sessionTitle: store.getSession(fence.sessionId)!.title! }),
					})),
					content: prepared.exportTarget.content,
				});
			const eventPayload: PlanEventPayload = {
				schema: SCHEMA, sessionId: fence.sessionId, policyCeilingDigest: loaded.state.policyCeilingDigest,
				requestId, operation, requestDigest, commandId: begun.commandId, attemptId: begun.attemptId,
				commands: prepared.commands, ...(prepared.content === undefined ? {} : { content: prepared.content }),
				...(prepared.feedback === undefined ? {} : { feedback: prepared.feedback }),
				...(exported === undefined || prepared.exportTarget === undefined ? {} : {
					exportPath: exported.path,
					exportedRevision: prepared.exportTarget.ref.revision,
					exportedDigest: prepared.exportTarget.ref.digest,
				}),
				...(prepared.handoffTarget === undefined ? {} : {
					handoffTargetSessionId: prepared.handoffTarget.targetSessionId,
					handoffReceiptDigest: prepared.handoffTarget.receiptDigest,
				}),
			};
			// 只读链尾：避免为一次追加重放整条 session 事件流。
			const head = store.latestEventHead(fence.sessionId);
			const appended = store.appendEvent(fence, {
				eventId: createRuntimeId("event", `plan-${requestId}`), ownerGeneration: fence.generation,
				eventType: eventTypeFor(operation, prepared.commands), payloadJson: JSON.stringify(eventPayload),
				createdAtMs: Date.now(), expectedPreviousEventHash: head.hash,
			});
			committed = true;
			// 已提交事件即新权威：直接用试算结果推进缓存，不再重放整条 plan 事件流。
			const state = reproject(prepared.state, {
				streamId: fence.sessionId,
				sequence: appended.sequence,
				eventHash: { algorithm: "sha256", digest: appended.currentEventHash as RuntimeDigest["digest"] },
			});
			const requests = new Map(loaded.requests);
			const inspection = this.inspection(state, prepared.artifacts);
			const result: SessionDomainResult = {
				...ok(operation, state, {
					...inspection,
					...(prepared.feedback === undefined ? {} : { feedback: prepared.feedback }),
					...(exported === undefined ? {} : { exportPath: exported.path }),
					...(prepared.handoffTarget === undefined ? {} : {
						handoff: {
							targetSessionId: prepared.handoffTarget.targetSessionId,
							harnessProfileId: "standard",
							harnessProfileVersion: 2,
							revision: prepared.handoffTarget.revision,
							digest: prepared.handoffTarget.digest,
							receiptDigest: prepared.handoffTarget.receiptDigest,
							content: prepared.handoffTarget.content,
						},
					}),
				}),
				receipt: { attemptId: begun.attemptId, commandId: begun.commandId, outcome: "committed" },
			};
			requests.set(requestId, { digest: requestDigest, result });
			this.#cache = { state, artifacts: prepared.artifacts, requests };
			const settled = port.settleAttempt(begun.attemptId, "committed", runtimeDigest({ operation, requestId }));
			return settled.ok ? result : failure(operation, settled.code);
		} catch (error) {
			// 未提交则 canonical 状态未变，已发布的缓存继续有效；提交后异常交由下次读取重放核对。
			port.settleAttempt(begun.attemptId, committed ? "uncertain" : "rejected", runtimeDigest({ code: "plan_commit_failed" }));
			return failure(operation, error instanceof Error ? error.message : "plan_commit_failed");
		}
	}

	private prepare(operation: string, payload: Record<string, unknown>, loaded: LoadedPlan):
		{ readonly ok: true; readonly commands: readonly PlanModeCommand[]; readonly content?: string; readonly state: PlanModeState; readonly artifacts: PlanArtifactStore; readonly feedback?: string; readonly exportTarget?: ExportTarget; readonly handoffTarget?: HandoffTarget } | { readonly ok: false; readonly code: string } {
		let state = loaded.state;
		// 在副本上试算：任一失败分支都不得留下半写的工件指针。
		const artifacts = loaded.artifacts.clone();
		const commands: PlanModeCommand[] = [];
		const updatedAt = new Date().toISOString();
		const apply = (command: PlanModeCommand): void => {
			const reduced = reducePlanModeState(state, command);
			if (!reduced.ok) throw new Error(reduced.error.code);
			state = reduced.value; commands.push(command);
		};
		try {
			let content: string | undefined;
			let feedback: string | undefined;
			let exportTarget: ExportTarget | undefined;
			let handoffTarget: HandoffTarget | undefined;
			const initialBytes = artifacts.byteSize(state.goalId, this.options.workspaceId);
			if (operation === "plan.initialize" || operation === "plan.write") {
				if (!keysAllowed(payload, ["content", "expectedRevision", "expectedPlanRevision"]) || !validContent(payload.content)) return { ok: false, code: "plan_content_invalid" };
				content = payload.content;
				if (operation === "plan.initialize") apply({ type: "request_activation", expectedRevision: state.revision, requestedBy: "user", updatedAt });
				const expected = operation === "plan.initialize" ? null : payload.expectedPlanRevision;
				if (expected !== null && (typeof expected !== "number" || expected !== state.plan?.revision)) return { ok: false, code: "stale_expected_plan_revision" };
				if ((state.plan?.revision ?? 0) >= 255) return { ok: false, code: "plan_revision_limit" };
				if (initialBytes + Buffer.byteLength(content, "utf8") > PLAN_GOAL_MAX_BYTES) return { ok: false, code: "plan_goal_byte_limit" };
				const artifact = artifacts.put({ goalId: state.goalId, workspaceId: this.options.workspaceId, content, expectedRevision: expected });
				if (!artifact.ok) return { ok: false, code: artifact.error.code };
				apply(operation === "plan.initialize"
					? { type: "activate", expectedRevision: state.revision, plan: artifact.value, updatedAt }
					: { type: "write_plan", expectedRevision: state.revision, expectedPlanRevision: expected!, plan: artifact.value, updatedAt });
			} else if (operation === "plan.enter" || operation === "plan.reenter") {
				if (!keysAllowed(payload, ["expectedRevision", "requestedBy"])) return { ok: false, code: "plan_enter_invalid" };
				const requestedBy = payload.requestedBy ?? "user";
				if (requestedBy !== "user" && requestedBy !== "agent") return { ok: false, code: "plan_enter_invalid" };
				if (state.status !== "inactive") return { ok: false, code: "plan_enter_requires_inactive" };
				apply({ type: "request_activation", expectedRevision: state.revision, requestedBy, updatedAt });
				// agent 主动进入只落 pending：没有用户显式批准不得切换 tool surface。
				if (requestedBy === "agent") return { ok: true, commands, state, artifacts };
				const working = artifacts.working(state.goalId, this.options.workspaceId);
				const existing = working.ok ? working.value : undefined;
				if (existing === undefined) {
					if (operation === "plan.reenter") return { ok: false, code: "plan_reentry_requires_existing_plan" };
					const artifact = artifacts.put({ goalId: state.goalId, workspaceId: this.options.workspaceId, content: INITIAL_CONTENT, expectedRevision: null });
					if (!artifact.ok) return { ok: false, code: artifact.error.code };
					content = INITIAL_CONTENT;
					apply({ type: "activate", expectedRevision: state.revision, plan: artifact.value, updatedAt });
				} else {
					// reentry 复用既有 revision，不写新正文。
					apply({ type: "reactivate", expectedRevision: state.revision, plan: existing, updatedAt });
				}
			} else if (operation === "plan.activate") {
				// pending 交付：用户批准 agent 的进入请求，建立 revision 0 工件并转为 active。
				if (!keysAllowed(payload, ["expectedRevision", "content"])) return { ok: false, code: "plan_activate_invalid" };
				const body = payload.content === undefined ? INITIAL_CONTENT : payload.content;
				if (!validContent(body)) return { ok: false, code: "plan_content_invalid" };
				if (initialBytes + Buffer.byteLength(body, "utf8") > PLAN_GOAL_MAX_BYTES) return { ok: false, code: "plan_goal_byte_limit" };
				const artifact = artifacts.put({ goalId: state.goalId, workspaceId: this.options.workspaceId, content: body, expectedRevision: null });
				if (!artifact.ok) return { ok: false, code: artifact.error.code };
				apply({ type: "activate", expectedRevision: state.revision, plan: artifact.value, updatedAt });
				content = body;
			} else if (operation === "plan.exit") {
				if (!keysAllowed(payload, ["expectedRevision"])) return { ok: false, code: "plan_exit_invalid" };
				apply({ type: "exit", expectedRevision: state.revision, updatedAt });
			} else if (operation === "plan.request_approval") {
				if (!keysAllowed(payload, ["expectedRevision", "expectedPlanRevision", "expectedPlanDigest"]) || !isRuntimeDigest(payload.expectedPlanDigest) || typeof payload.expectedPlanRevision !== "number") return { ok: false, code: "plan_approval_request_invalid" };
				if (state.plan?.revision === 0) return { ok: false, code: "plan_artifact_unedited" };
				apply({ type: "request_approval", expectedRevision: state.revision, expectedPlanRevision: payload.expectedPlanRevision, expectedPlanDigest: payload.expectedPlanDigest, updatedAt });
			} else if (operation === "plan.resolve_approval") {
				const decision = payload.decision;
				if (!keysAllowed(payload, ["expectedRevision", "expectedPlanRevision", "expectedPlanDigest", "approvalId", "decision", "feedback"])
					|| state.approval === undefined || state.plan === undefined || state.approval.approvalId !== payload.approvalId
					|| payload.expectedPlanRevision !== state.plan.revision || !isRuntimeDigest(payload.expectedPlanDigest) || payload.expectedPlanDigest.digest !== state.plan.digest.digest
					|| (decision !== "approved" && decision !== "rejected" && decision !== "changes_requested")) return { ok: false, code: "plan_approval_binding_mismatch" };
				if (payload.feedback !== undefined && !validFeedback(payload.feedback)) return { ok: false, code: "plan_feedback_invalid" };
				if (payload.feedback !== undefined) feedback = payload.feedback;
				const receipt = { approvalId: payload.approvalId, plan: state.plan, decision, ...(payload.feedback === undefined ? {} : { feedback: payload.feedback }) };
				apply({ type: "resolve_approval", expectedRevision: state.revision, updatedAt, approval: { ...state.approval, status: decision,
					...(decision === "rejected" ? {} : { receiptRef: { subjectKind: "receipt", digest: runtimeDigest(receipt), mediaType: "application/json", size: Buffer.byteLength(JSON.stringify(receipt)) } }),
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
			} else if (operation === "plan.handoff") {
				if (!keysAllowed(payload, ["expectedRevision"])) return { ok: false, code: "plan_handoff_invalid" };
				if (state.status !== "exit_pending" || state.approval?.status !== "approved" || state.plan === undefined) {
					return { ok: false, code: "plan_handoff_requires_approved_plan" };
				}
				const receipt = state.approval.receiptRef;
				if (receipt === undefined) return { ok: false, code: "plan_handoff_requires_receipt" };
				const observed = artifacts.read(state.plan);
				if (!observed.ok) return { ok: false, code: observed.error.code };
				const targetSessionId = createRuntimeId("session", `plan-handoff-${runtimeDigest({ source: this.options.fence.sessionId, plan: state.plan.digest, revision: state.revision }).digest.slice(0, 32)}`);
				handoffTarget = {
					targetSessionId,
					receiptDigest: receipt.digest,
					content: observed.value,
					revision: state.plan.revision,
					digest: state.plan.digest,
				};
			} else if (operation === "plan.export") {
				if (!keysAllowed(payload, ["expectedRevision"])) return { ok: false, code: "plan_export_invalid" };
				// 退出后 state.plan 被清空，但工作指针仍在：导出当前或已批准的 revision。
				const working = artifacts.working(state.goalId, this.options.workspaceId);
				const ref = state.plan ?? (working.ok ? working.value : undefined);
				if (ref === undefined) return { ok: false, code: "plan_export_requires_artifact" };
				const observed = artifacts.read(ref);
				if (!observed.ok) return { ok: false, code: observed.error.code };
				exportTarget = { ref, content: observed.value };
			} else return { ok: false, code: "plan_workflow_finished_create_new_session" };
			return {
				ok: true, commands, state, artifacts,
				...(content === undefined ? {} : { content }),
				...(feedback === undefined ? {} : { feedback }),
				...(exportTarget === undefined ? {} : { exportTarget }),
				...(handoffTarget === undefined ? {} : { handoffTarget }),
			};
		} catch (error) { return { ok: false, code: error instanceof Error ? error.message : "plan_request_invalid" }; }
	}

	private load(): LoadedPlan {
		if (this.#cache !== undefined) return this.#cache;
		this.#cache = this.replay();
		return this.#cache;
	}

	/** 完整重放：只在首次构造、缓存失效后与显式恢复路径执行。 */
	private replay(): LoadedPlan {
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
	// handoff 重放时按 ref 读取正文；无工件时用零 digest 占位，由下方断言保证不会出现。
	const digestOfNothing = runtimeDigest("runledger-absent-plan-artifact");
		for (let index = 0; index < parsed.length; index += 1) {
			const payload = parsed[index]!; const event = planEvents[index]!;
			if (payload.policyCeilingDigest.digest !== policy.digest || loaded.requests.has(payload.requestId)) throw new Error("plan_event_binding_corrupt");
			for (const command of payload.commands) {
				if (command.type === "activate" || command.type === "write_plan") {
					if (!validContent(payload.content)) throw new Error("plan_artifact_corrupt");
					const artifact = loaded.artifacts.put({ goalId: loaded.state.goalId, workspaceId, content: payload.content, expectedRevision: command.type === "activate" ? null : command.expectedPlanRevision });
					if (!artifact.ok || runtimeDigest(artifact.value).digest !== runtimeDigest(command.plan).digest) throw new Error("plan_artifact_digest_mismatch");
				} else if (command.type === "reactivate") {
					// reentry 不产生新 revision：必须指向既有 working revision，且正文仍可校验。
					const stored = loaded.artifacts.read(command.plan);
					if (!stored.ok || (payload.content !== undefined && stored.value !== payload.content)) throw new Error("plan_reentry_artifact_mismatch");
				}
				const next = reducePlanModeState(loaded.state, command);
				if (!next.ok) throw new Error(`plan_event_corrupt: ${next.error.code}`);
				loaded.state = next.value;
			}
			loaded.state = reproject(loaded.state, { streamId: fence.sessionId, sequence: event.sequence, eventHash: { algorithm: "sha256", digest: event.currentEventHash as RuntimeDigest["digest"] } });
			const operation = payload.operation;
			const inspection = this.inspection(loaded.state, loaded.artifacts);
			const approvedRef = payload.handoffTargetSessionId === undefined ? undefined : loaded.state.plan;
			const approvedBody = approvedRef === undefined ? undefined : loaded.artifacts.read(approvedRef);
			const approvedContent = approvedBody?.ok === true ? approvedBody.value : undefined;
			loaded.requests.set(payload.requestId, {
				digest: payload.requestDigest,
				result: {
					...ok(operation, loaded.state, {
						...inspection,
						...(payload.feedback === undefined ? {} : { feedback: payload.feedback }),
						...(payload.exportPath === undefined ? {} : { exportPath: payload.exportPath }),
						...(payload.handoffTargetSessionId === undefined || payload.handoffReceiptDigest === undefined ? {} : {
							handoff: {
								targetSessionId: payload.handoffTargetSessionId,
								harnessProfileId: "standard",
								harnessProfileVersion: 2,
								revision: approvedRef?.revision ?? 0,
								digest: approvedRef?.digest ?? digestOfNothing,
								receiptDigest: payload.handoffReceiptDigest,
								// 正文不重复写入事件：从同一 revision 的工件读取，保持重放结果与首次一致。
								...(approvedContent === undefined ? {} : { content: approvedContent }),
							},
						}),
					}),
					receipt: { attemptId: payload.attemptId, commandId: payload.commandId, outcome: "committed" },
				},
			});
		}
		return loaded;
	}

	private inspection(state: PlanModeState, artifacts: PlanArtifactStore): SessionPlanInspection {
		const working = artifacts.working(state.goalId, this.options.workspaceId);
		const ref = state.plan ?? (working.ok ? working.value : undefined);
		const content = ref === undefined ? undefined : artifacts.read(ref);
		return { repositoryId: this.options.repositoryId, state, ...(content?.ok === true ? { content: content.value } : {}) };
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
function validFeedback(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0 && value.length <= MAX_FEEDBACK_CHARS; }
function validExportPath(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 4096 && !value.includes(" "); }
function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function keysAllowed(value: Record<string, unknown>, keys: readonly string[]): boolean { return Object.keys(value).every((key) => keys.includes(key)); }
function decode(event: SessionEventRecord, sessionId: SessionId): PlanEventPayload {
	const value: unknown = JSON.parse(event.payloadJson);
	if (!record(value) || !keysAllowed(value, ["schema", "sessionId", "policyCeilingDigest", "requestId", "operation", "requestDigest", "commandId", "attemptId", "commands", "content", "feedback", "exportPath", "exportedRevision", "exportedDigest", "handoffTargetSessionId", "handoffReceiptDigest"])
		|| typeof value.operation !== "string" || !["plan.initialize", ...OPERATIONS].includes(value.operation)
		|| value.schema !== SCHEMA || value.sessionId !== sessionId || !isRuntimeDigest(value.policyCeilingDigest) || !isRuntimeDigest(value.requestDigest)
		|| typeof value.requestId !== "string" || !/^[a-f0-9]{64}$/u.test(value.requestId) || !isRuntimeId(value.commandId, "command") || !isRuntimeId(value.attemptId, "attempt")
		|| !Array.isArray(value.commands) || value.commands.length > 2 || !value.commands.every(validCommand)
		|| (value.commands.length === 0) !== NON_TRANSITION_OPERATIONS.has(value.operation)
		|| (value.content !== undefined && !validContent(value.content))
		|| (value.feedback !== undefined && !validFeedback(value.feedback))
		|| (value.exportPath !== undefined && !validExportPath(value.exportPath))
		|| (value.exportPath === undefined) !== (value.exportedRevision === undefined)
		|| (value.handoffTargetSessionId !== undefined && !isRuntimeId(value.handoffTargetSessionId, "session"))
		|| (value.handoffReceiptDigest !== undefined && !isRuntimeDigest(value.handoffReceiptDigest))
		|| (value.handoffTargetSessionId === undefined) !== (value.handoffReceiptDigest === undefined)
		|| (value.exportedDigest !== undefined && !isRuntimeDigest(value.exportedDigest))
		|| event.eventType !== eventTypeFor(value.operation, value.commands)) throw new Error("plan_event_corrupt");
	return value as unknown as PlanEventPayload;
}
function validCommand(value: unknown): value is PlanModeCommand {
	if (!record(value) || typeof value.type !== "string" || !Number.isSafeInteger(value.expectedRevision) || typeof value.updatedAt !== "string") return false;
	const extra: Record<string, readonly string[]> = {
		request_activation: ["requestedBy"], activate: ["plan"], reactivate: ["plan"], write_plan: ["expectedPlanRevision", "plan"],
		request_approval: ["expectedPlanRevision", "expectedPlanDigest"], request_exit: ["expectedPlanRevision", "expectedPlanDigest"],
		resolve_approval: ["approval"], cancel_activation: [], cancel_approval: ["approvalId"], settle_exit: [], exit: [],
	};
	return Object.hasOwn(extra, value.type) && keysAllowed(value, ["type", "expectedRevision", "updatedAt", ...extra[value.type]!]);
}
/** 不含状态转移的审计型 operation；其事件类型由 operation 决定。 */
const NON_TRANSITION_OPERATIONS = new Set<string>(["plan.export", "plan.handoff"]);

function eventTypeFor(operation: string, commands: readonly PlanModeCommand[]): string {
	if (operation === "plan.export") return "plan.exported";
	if (operation === "plan.handoff") return "plan.handoff_created";
	return eventType(commands.at(-1)!);
}

function eventType(command: PlanModeCommand): string {
	switch (command.type) {
		case "request_activation": return "plan.enter_requested";
		case "activate": case "reactivate": return "plan.entered";
		case "write_plan": return "plan.revision_written";
		case "request_approval": return "plan.approval_requested";
		case "request_exit": return "plan.exit_requested";
		case "resolve_approval":
			return command.approval.status === "approved"
				? "plan.approved"
				: command.approval.status === "rejected" ? "plan.approval_rejected" : "plan.changes_requested";
		case "invalidate_approval": return "plan.approval_invalidated";
		case "cancel_activation": case "cancel_approval": case "settle_exit": return "plan.exited";
		case "exit": return "plan.exited";
	}
}
function ok(operation: string, state: PlanModeState, value: SessionPlanInspection): Extract<SessionDomainResult, { ok: true }> { return { ok: true, status: "ok", operation, domainRevision: state.revision, value }; }
function failure(operation: string, code: string, status: "failed" | "stale" | "unavailable" | "recovery_required" = "failed"): Extract<SessionDomainResult, { ok: false }> { return { ok: false, status, code, operation }; }
