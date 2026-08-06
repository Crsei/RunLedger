/**
 * Host domain adapter：Host `Record<string, unknown>` 响应 -> typed bounded 投影。
 *
 * 所有 Host 响应必须先过 schema/typed validator 才能进入 workflow；
 * 非法 body 编码为 failed（不 throw），字段一律有界 + 终端安全。
 * capability 缺失（无 Host 通道）时端口 undefined，不发 effect。
 */

import type { TuiField, TuiPortRequest, TuiResultEnvelope } from "../application/common.ts";
import type { SafeBoundedText } from "../presentation/tools/types.ts";
import type { TuiDomainPorts } from "../application/ports.ts";
import type { ExtensionResourcePort, ExtensionResourceSnapshot, ExtensionResourceView, ExtensionKind, ExtensionTrust, ExtensionActivation, ExtensionReloadReceipt } from "../extensions/types.ts";
import type { RuntimeSnapshotQueryPort, TuiRuntimeSnapshot } from "../runtime-snapshot/types.ts";
import type { ProcessPassivePort, ProcessPassiveSnapshot } from "../process/types.ts";
import type { TaskGoalQueryPort, TaskGoalSnapshot } from "../task-goal/types.ts";
import type { PlanRenderQueryPort, PlanRenderView } from "../goal-plan/types.ts";
import type { AgentActivityQueryPort, AgentActivitySnapshot, AgentActivityView } from "../agents/types.ts";
import type { SecurityModeWorkflowPort, SecurityModeSnapshot } from "../security-mode/types.ts";
import type { WorkspaceGitPort, WorkspaceGitSnapshot, WorkspaceGitHead } from "../workspace/types.ts";
import type { UpdateQueryPort, UpdateNoticeView } from "../update/types.ts";
import { boundedToolText } from "../presentation/tools/projector.ts";

const LABEL_BOUND = 120;

type HostQuery = (operation: string, body?: Record<string, unknown>) => Promise<Record<string, unknown>>;

export interface HostDomainPortsInput {
	readonly query?: HostQuery;
	readonly command?: HostQuery;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asArray(value: unknown): readonly unknown[] {
	return Array.isArray(value) ? value : [];
}

function stringField(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function numberField(value: unknown): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
}

function boolField(value: unknown): boolean {
	return value === true;
}

function envelope<T>(request: TuiPortRequest, produce: () => Promise<TuiResultEnvelope<T>>): Promise<TuiResultEnvelope<T>> {
	return produce().then(
		(value) => value,
		(error: unknown) => ({
			ok: false as const,
			ref: request,
			error: { code: "host_query_error", message: String(error), retryable: true },
		}),
	);
}

export function createHostDomainPorts(host: HostDomainPortsInput | undefined): TuiDomainPorts {
	if (host === undefined || host.query === undefined) return {};

	const extensionPort: ExtensionResourcePort = {
		inspect: (request) => envelope(request, () => inspectExtensions(host.query!, request)),
		reload: async (request) => {
			if (host.command === undefined) {
				return { ok: false, ref: request, error: { code: "capability_unavailable", message: "extension mutation needs a Host command channel", retryable: false } };
			}
			return envelope(request, async () => {
				const body = await host.command!("extension.reload", {});
				if (body.ok === false) return { ok: false, ref: request, error: { code: stringField(body.code), message: stringField(body.message), retryable: true } };
				return { ok: true, ref: request, value: { resourceId: "extension-snapshot", operation: "reload", generation: 1, receiptPrefix: boundedToolText("reload", 40), outcome: "completed", recoveryRequired: false } };
			});
		},
	};

	const runtimeSnapshotPort: RuntimeSnapshotQueryPort = {
		getSnapshot: (request) => envelope(request, () => inspectRuntimeSnapshot(host.query!, request)),
	};

	const processPort: ProcessPassivePort = {
		list: (request) => envelope(request, () => listProcesses(host.query!, request)),
		// Host 无 process domain contract → 显式 unavailable（真实 output 走 local bridge）
		output: async (request) => ({ ok: false, ref: request, error: { code: "process_output_unavailable", message: "Host has no process output contract; use the local bridge", retryable: false } }),
		mutate: async (request) => ({ ok: false, ref: request, error: { code: "process_mutation_unavailable", message: "Host has no process mutation contract", retryable: false } }),
	};

	const taskGoalPort: TaskGoalQueryPort = {
		inspect: (request) => envelope(request, () => inspectTaskGoal(host.query!, request)),
	};

	const planPort: PlanRenderQueryPort = {
		inspect: (request) => envelope(request, () => inspectPlan(host.query!, request)),
	};

	const agentPort: AgentActivityQueryPort = {
		inspect: (request) => envelope(request, () => inspectAgents(host.query!, request)),
	};

	const securityPort: SecurityModeWorkflowPort = {
		inspect: (request) => envelope(request, () => inspectSecurityMode(host.query!, request)),
		// Host 只有 security.inspect（无 mutation operation）→ 显式 unavailable，不伪装实现
		set: async (request) => ({ ok: false, ref: request, error: { code: "host_operation_unsupported", message: "Host has no security-mode mutation contract", retryable: false } }),
	};

	const workspaceGitPort: WorkspaceGitPort = {
		inspect: (request) => envelope(request, () => inspectWorkspaceGit(host.query!, request)),
	};

	const updatePort: UpdateQueryPort = {
		inspect: (request) => envelope(request, () => inspectUpdate(host.query!, request)),
	};

	return {
		extensions: extensionPort,
		runtimeSnapshot: runtimeSnapshotPort,
		process: processPort,
		taskGoal: taskGoalPort,
		plan: planPort,
		agents: agentPort,
		securityMode: securityPort,
		workspaceGit: workspaceGitPort,
		update: updatePort,
	};
}

/** 只读枚举校验：非法值一律落 unknown/缺省，绝不 cast 进合同。 */
function enumOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
	return typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

function extensionKind(value: unknown): ExtensionKind {
	switch (value) {
		case "plugin": return "plugin";
		case "skill": return "skill";
		case "hook": return "hook";
		case "mcp": return "mcp-server";
		case "mcp-server": return "mcp-server";
		case "mcp-tool": return "mcp-tool";
		default: return "plugin";
	}
}

function extensionTrust(value: unknown): ExtensionTrust {
	switch (value) {
		case "trusted": return "trusted";
		case "untrusted": return "untrusted";
		case "stale": return "stale";
		case "revoked": return "revoked";
		default: return "unknown";
	}
}

function extensionActivation(value: unknown, ready: boolean): ExtensionActivation {
	if (ready) return "ready";
	switch (value) {
		case "disabled": return "disabled";
		case "blocked": return "blocked";
		case "failed": return "failed";
		default: return "disabled";
	}
}

async function inspectExtensions(query: HostQuery, request: TuiPortRequest): Promise<TuiResultEnvelope<ExtensionResourceSnapshot>> {
	const body = await query("extension.inspect", {});
	if (body.ok === false) {
		return { ok: false, ref: request, error: { code: stringField(body.code), message: stringField(body.message), retryable: true } };
	}
	const snapshot = isRecord(body.snapshot) ? body.snapshot : body;
	const descriptors = asArray(snapshot.descriptors);
	const resources: ExtensionResourceView[] = descriptors.flatMap((descriptor) => {
		if (!isRecord(descriptor)) return [];
		const identity = isRecord(descriptor.identity) ? descriptor.identity : {};
		const qualifiedId = stringField(identity.qualifiedId);
		const version = stringField(identity.version);
		const digest = isRecord(identity.digest) ? stringField(identity.digest.digest) : "";
		if (qualifiedId.length === 0) return [];
		const view: ExtensionResourceView = {
			resourceId: qualifiedId,
			kind: extensionKind(identity.kind ?? descriptor.kind),
			label: boundedToolText(stringField(descriptor.displayName) || qualifiedId, LABEL_BOUND),
			digestPrefix: boundedToolText(digest || `${qualifiedId}@${version || "unknown"}`, LABEL_BOUND),
			trust: extensionTrust(descriptor.trust ?? (descriptor.trusted === true ? "trusted" : "untrusted")),
			activation: extensionActivation(descriptor.activation, descriptor.ready === true),
			...(isRecord(descriptor.diagnostics) ? { diagnostic: boundedToolText(stringField((descriptor.diagnostics as Record<string, unknown>).message), LABEL_BOUND) } : {}),
		};
		return [view];
	});
	return { ok: true, ref: request, value: { generation: numberField(snapshot.generation) ?? 1, resources } };
}

async function inspectRuntimeSnapshot(query: HostQuery, request: TuiPortRequest): Promise<TuiResultEnvelope<TuiRuntimeSnapshot>> {
	const body = await query("runtime.inspect", {});
	if (body.ok === false) {
		return { ok: false, ref: request, error: { code: stringField(body.code), message: stringField(body.message), retryable: true } };
	}
	const runtime = isRecord(body.runtime) ? body.runtime : body;
	// typed validation：字段经结构校验后才标 known；shape 不符落 unknown（绝不 cast 任意值进合同）
	const structField = <T>(value: unknown, validate: (value: Record<string, unknown>) => T | undefined): TuiField<T> => {
		if (!isRecord(value)) return { state: "unknown", reason: "not-reported" };
		const validated = validate(value);
		return validated === undefined ? { state: "unknown", reason: "invalid-shape" } : { state: "known", value: validated };
	};
	const numField = (value: unknown): TuiField<number> =>
		numberField(value) === undefined ? { state: "unknown", reason: "not-reported" } : { state: "known", value: numberField(value)! };
	const textField = (value: unknown): SafeBoundedText => boundedToolText(stringField(value), LABEL_BOUND);
	const snapshot: TuiRuntimeSnapshot = {
		authorityGeneration: numberField(runtime.authorityGeneration) ?? 0,
		// sourceRevision 可能是裸数字或 { revision } 对象
		sourceRevision: isRecord(runtime.sourceRevision)
			? numField(runtime.sourceRevision.revision)
			: numField(runtime.sourceRevision),
		session: structField(runtime.session, (value) => {
			const sessionId = stringField(value.sessionId);
			const lifecycle = stringField(value.lifecycle);
			return sessionId.length > 0 && lifecycle.length > 0 ? { sessionId, lifecycle } : undefined;
		}),
		activity: structField(runtime.activity, (value) => {
			const phase = stringField(value.phase);
			const turn = numberField(value.turn);
			return phase.length > 0 && turn !== undefined
				? { phase: boundedToolText(phase, LABEL_BOUND), turn: { state: "known", value: turn } }
				: undefined;
		}),
		security: structField(runtime.security, (value) => {
			const mode = stringField(value.mode);
			const revision = numberField(value.revision);
			return mode.length > 0 && revision !== undefined
				? { mode: boundedToolText(mode, LABEL_BOUND), revision }
				: undefined;
		}),
		selection: structField(runtime.selection, (value) => {
			const providerId = stringField(value.providerId);
			const modelId = stringField(value.modelId);
			const thinkingLevel = stringField(value.thinkingLevel);
			return providerId.length > 0 && modelId.length > 0 && thinkingLevel.length > 0 ? { providerId, modelId, thinkingLevel } : undefined;
		}),
		context: structField(runtime.context, (value) => {
			const totalTokens = numberField(value.totalTokens);
			const contextWindow = numberField(value.contextWindow);
			return totalTokens !== undefined && contextWindow !== undefined
				? { totalTokens: { state: "known", value: totalTokens }, contextWindow: { state: "known", value: contextWindow } }
				: undefined;
		}),
		queue: {
			steering: numField(runtime.steeringCount),
			followUp: numField(runtime.followUpCount),
			claimed: numField(runtime.claimedCount),
		},
		pendingApprovals: numField(runtime.pendingApprovalCount),
		toolCount: numField(runtime.toolCount),
		extensions: structField(runtime.extensions, (value) => {
			const generation = numberField(value.generation);
			const ready = numberField(value.ready);
			const blocked = numberField(value.blocked);
			return generation !== undefined && ready !== undefined && blocked !== undefined
				? { generation, ready: { state: "known", value: ready }, blocked: { state: "known", value: blocked } }
				: undefined;
		}),
	};
	return { ok: true, ref: request, value: snapshot };
}

async function listProcesses(query: HostQuery, request: TuiPortRequest): Promise<TuiResultEnvelope<readonly ProcessPassiveSnapshot[]>> {
	const body = await query("process.list", {});
	if (body.ok === false) {
		return { ok: false, ref: request, error: { code: stringField(body.code), message: stringField(body.message), retryable: true } };
	}
	const processes = asArray(body.processes);
	const snapshots: ProcessPassiveSnapshot[] = processes.flatMap((process) => {
		if (!isRecord(process)) return [];
		const executionId = stringField(process.executionId);
		const attemptId = stringField(process.attemptId);
		if (executionId.length === 0) return [];
		return [{
			executionId: executionId as ProcessPassiveSnapshot["executionId"],
			attemptId: attemptId as ProcessPassiveSnapshot["attemptId"],
			// 枚举校验：非法 state 落 uncertain（ProcessState 无 unknown），不 cast 进合同
			state: enumOf(process.state, ["queued", "starting", "running", "backgrounded", "completed", "failed", "timed_out", "killed", "lost", "uncertain"] as const, "uncertain"),
			authorityGeneration: numberField(process.authorityGeneration) ?? 0,
			hostRevision: numberField(process.hostRevision) === undefined
				? { state: "unknown", reason: "not-reported" }
				: { state: "known", value: numberField(process.hostRevision)! },
			output: {
				cursor: typeof process.outputCursor === "string"
					? { state: "known", value: process.outputCursor }
					: { state: "unknown", reason: "not-reported" },
				bytes: numberField(process.outputSize) === undefined
					? { state: "unknown", reason: "not-reported" }
					: { state: "known", value: numberField(process.outputSize)! },
				truncated: boolField(process.truncated),
			},
			driver: process.driver === true ? "driver" : process.driver === false ? "observer" : "unknown",
		}];
	});
	return { ok: true, ref: request, value: snapshots };
}

async function inspectTaskGoal(query: HostQuery, request: TuiPortRequest): Promise<TuiResultEnvelope<TaskGoalSnapshot>> {
	const body = await query("task-goal.inspect", {});
	if (body.ok === false) {
		return { ok: false, ref: request, error: { code: stringField(body.code), message: stringField(body.message), retryable: true } };
	}
	const repository = isRecord(body.repository) ? body.repository : body;
	const tasks = asArray(repository.tasks);
	const goals = asArray(repository.goals);
	const taskViews: TaskGoalSnapshot["tasks"] = tasks.flatMap((task) => {
		if (!isRecord(task)) return [];
		const taskId = stringField(task.taskId);
		if (taskId.length === 0) return [];
		return [{
			taskId,
			content: boundedToolText(stringField(task.content) || taskId, LABEL_BOUND),
			priority: enumOf(task.priority, ["low", "medium", "high"] as const, "medium"),
			status: enumOf(task.status, ["pending", "in_progress", "completed", "deleted"] as const, "pending"),
			revision: numberField(task.revision) ?? 0,
		}];
	});
	const goalViews: TaskGoalSnapshot["goals"] = goals.flatMap((goal) => {
		if (!isRecord(goal)) return [];
		const goalId = stringField(goal.goalId);
		if (goalId.length === 0) return [];
		return [{
			goalId,
			label: boundedToolText(stringField(goal.label) || goalId, LABEL_BOUND),
			lifecycle: enumOf(goal.lifecycle, ["active", "paused", "blocked", "completed", "failed", "unknown"] as const, "unknown"),
			repositoryRevision: numberField(goal.repositoryRevision) ?? 0,
			digestPrefix: boundedToolText(stringField(goal.digestPrefix), 40),
		}];
	});
	return {
		ok: true,
		ref: request,
		value: {
			repositoryId: stringField(repository.repositoryId) || "unknown",
			repositoryRevision: numberField(repository.repositoryRevision) ?? 0,
			tasks: taskViews,
			goals: goalViews,
		},
	};
}

async function inspectPlan(query: HostQuery, request: TuiPortRequest): Promise<TuiResultEnvelope<PlanRenderView>> {
	const body = await query("plan.inspect", {});
	if (body.ok === false) {
		return { ok: false, ref: request, error: { code: stringField(body.code), message: stringField(body.message), retryable: true } };
	}
	const state = isRecord(body.state) ? body.state : body;
	const planStatus = enumOf(state.status, ["verified", "in-progress", "blocked", "unknown"] as const, "unknown");
	return {
		ok: true,
		ref: request,
		value: {
			reference: {
				repositoryId: stringField(body.repositoryId) || "unknown",
				planId: stringField(state.planId) || stringField(body.planId) || "unknown",
				revision: numberField(state.revision) ?? 0,
				digestPrefix: boundedToolText(stringField(state.digestPrefix) || stringField(body.digest), 40),
			},
			title: boundedToolText(stringField(state.title), LABEL_BOUND),
			status: planStatus,
			summary: boundedToolText(stringField(state.summary), LABEL_BOUND),
			evidenceCount: numberField(state.evidenceCount) === undefined
				? { state: "unknown", reason: "not-reported" }
				: { state: "known", value: numberField(state.evidenceCount)! },
		},
	};
}

async function inspectAgents(query: HostQuery, request: TuiPortRequest): Promise<TuiResultEnvelope<AgentActivitySnapshot>> {
	const body = await query("agent.inspect", {});
	if (body.ok === false) {
		return { ok: false, ref: request, error: { code: stringField(body.code), message: stringField(body.message), retryable: true } };
	}
	const agents = asArray(body.agents);
	const views: AgentActivityView[] = agents.flatMap((agent) => {
		if (!isRecord(agent)) return [];
		const agentId = stringField(agent.agentId);
		if (agentId.length === 0) return [];
		return [{
			agentId,
			parentAgentId: stringField(agent.parentAgentId) === "" ? { state: "unknown", reason: "not-reported" } : { state: "known", value: stringField(agent.parentAgentId) },
			sessionId: stringField(agent.sessionId) || "unknown",
			label: boundedToolText(stringField(agent.label) || agentId, LABEL_BOUND),
			phase: boundedToolText(stringField(agent.phase), LABEL_BOUND),
			residency: enumOf(agent.residency, ["foreground", "background", "unknown"] as const, "unknown"),
			progress: numberField(agent.progress) === undefined ? { state: "unknown", reason: "not-reported" } : { state: "known", value: numberField(agent.progress)! },
			repositoryRevision: numberField(agent.repositoryRevision) === undefined ? { state: "unknown", reason: "not-reported" } : { state: "known", value: numberField(agent.repositoryRevision)! },
		}];
	});
	return { ok: true, ref: request, value: { authorityGeneration: numberField(body.authorityGeneration) ?? 0, agents: views } };
}

async function inspectSecurityMode(query: HostQuery, request: TuiPortRequest): Promise<TuiResultEnvelope<SecurityModeSnapshot>> {
	const body = await query("security-mode.inspect", {});
	if (body.ok === false) {
		return { ok: false, ref: request, error: { code: stringField(body.code), message: stringField(body.message), retryable: true } };
	}
	const mode = stringField(body.mode);
	return {
		ok: true,
		ref: request,
		value: {
			authorityGeneration: numberField(body.authorityGeneration) ?? 0,
			mode: mode === "guarded" || mode === "unrestricted"
				? { state: "known", value: mode }
				: { state: "unknown", reason: "not-reported" },
			modeRevision: numberField(body.modeRevision) === undefined
				? { state: "unknown", reason: "not-reported" }
				: { state: "known", value: numberField(body.modeRevision)! },
		},
	};
}

async function inspectWorkspaceGit(query: HostQuery, request: TuiPortRequest): Promise<TuiResultEnvelope<WorkspaceGitSnapshot>> {
	const body = await query("workspace-git.inspect", {});
	if (body.ok === false) {
		return { ok: false, ref: request, error: { code: stringField(body.code), message: stringField(body.message), retryable: true } };
	}
	const headValue = isRecord(body.head) ? body.head : {};
	const kind = stringField(headValue.kind);
	const head: WorkspaceGitHead = kind === "branch"
		? { kind: "branch", name: boundedToolText(stringField(headValue.name), LABEL_BOUND) }
		: kind === "detached"
			? { kind: "detached", commitPrefix: boundedToolText(stringField(headValue.commitPrefix), 40) }
			: { kind: "unavailable", reason: stringField(headValue.reason) || "not-reported" };
	return {
		ok: true,
		ref: request,
		value: {
			workspaceId: stringField(body.workspaceId) || "unknown",
			observedRevision: numberField(body.observedRevision) ?? 0,
			head,
		},
	};
}

async function inspectUpdate(query: HostQuery, request: TuiPortRequest): Promise<TuiResultEnvelope<UpdateNoticeView>> {
	const body = await query("update.inspect", {});
	if (body.ok === false) {
		return { ok: false, ref: request, error: { code: stringField(body.code), message: stringField(body.message), retryable: true } };
	}
	return {
		ok: true,
		ref: request,
		value: {
			channel: boundedToolText(stringField(body.channel) || "unknown", LABEL_BOUND),
			releasePrefix: boundedToolText(stringField(body.releasePrefix), 40),
			message: boundedToolText(stringField(body.message), LABEL_BOUND),
			policy: enumOf(body.policy, ["informational", "disabled", "unknown"] as const, "unknown"),
		},
	};
}

export type { ExtensionReloadReceipt };
