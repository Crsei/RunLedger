/** 有界 root-owned child lifecycle 的 durable orchestration。 */

import { runtimeDigest, type RuntimeDigest } from "../protocol/foundation.ts";
import { createRuntimeId, type AgentId, type AttemptId, type CommandId } from "../protocol/ids.ts";
import type { AttemptPort } from "../session-runtime/attempt-gateway.ts";
import {
	AgentGraphStore,
	type AgentGraphCommitOutcome,
	type AgentGraphHead,
} from "./graph-store.ts";
import {
	type AgentGraphInspection,
	type AgentGraphNode,
	inspectAgentGraph,
} from "./graph-projection.ts";
import { createAgentSemanticTerminalRecord } from "./graph-events.ts";
import type { AgentGraphCommand, AgentTerminalCommand } from "./graph-events.ts";
import {
	type ActiveChildHandle,
	type ChildPrepareSpec,
	type ChildRuntimeProviderPort,
	type ChildStopReason,
	type PreparedChildHandle,
} from "./child-runtime.ts";
import type {
	ChildReport,
	MultiAgentLimits,
	MultiAgentResult,
	SubagentInvocationContext,
	ValidatedSpawnSubagentInput,
} from "./types.ts";

export type SupervisorChildRuntimeTemplate = Omit<ChildPrepareSpec, "agentId" | "objective" | "budget" | "signal">;

export type PreviousOwnerLiveness = "dead" | "alive" | "unknown";

export interface AgentSupervisorOptions {
	readonly graph: AgentGraphStore;
	readonly rootAgentId: AgentId;
	readonly policyReceiptDigest: RuntimeDigest;
	readonly provider: ChildRuntimeProviderPort;
	readonly childRuntime: SupervisorChildRuntimeTemplate;
	/** 仅用于与当前 Session Owner 的 agent_spawn attempt/recovery barrier 对接。 */
	readonly attemptPort?: AttemptPort;
	/** 新 owner 启动时由 Host 提供 previous owner 的可验证 liveness 证据。 */
	readonly previousOwnerLiveness?: (node: AgentGraphNode) => PreviousOwnerLiveness | Promise<PreviousOwnerLiveness>;
	/** 仅作为组合层文档/校验输入；graph 自身仍是 limits 的唯一 durable projection。 */
	readonly limits?: MultiAgentLimits;
}

export interface AgentRecoverySummary {
	readonly stopped: readonly AgentId[];
	readonly recoveryRequired: readonly AgentId[];
}

interface ChildIdentity {
	readonly commandId: CommandId;
	readonly attemptId: AttemptId;
	readonly agentId: AgentId;
	readonly requestDigest: RuntimeDigest;
	readonly identityDigest: RuntimeDigest;
}

interface SpawnOperation {
	readonly identity: ChildIdentity;
	readonly request: ValidatedSpawnSubagentInput;
	readonly invocation: SubagentInvocationContext;
	promise?: Promise<MultiAgentResult<ChildReport>>;
	prepared?: PreparedChildHandle;
	active?: ActiveChildHandle;
	cancelRequested?: ChildStopReason;
}

export class AgentSupervisor {
	private readonly graph: AgentGraphStore;
	private readonly rootAgentId: AgentId;
	private readonly policyReceiptDigest: RuntimeDigest;
	private readonly provider: ChildRuntimeProviderPort;
	private readonly childRuntime: SupervisorChildRuntimeTemplate;
	private readonly attemptPort: AttemptPort | undefined;
	private readonly previousOwnerLiveness: ((node: AgentGraphNode) => PreviousOwnerLiveness | Promise<PreviousOwnerLiveness>) | undefined;
	private readonly operations = new Map<CommandId, SpawnOperation>();
	private readonly operationsByAgent = new Map<AgentId, SpawnOperation>();

	public constructor(options: AgentSupervisorOptions) {
		this.graph = options.graph;
		this.rootAgentId = options.rootAgentId;
		this.policyReceiptDigest = options.policyReceiptDigest;
		this.provider = options.provider;
		this.childRuntime = options.childRuntime;
		this.attemptPort = options.attemptPort;
		this.previousOwnerLiveness = options.previousOwnerLiveness;
	}

	/** Root registration is an internal composition action, not a model-visible command. */
	public async registerRoot(): Promise<MultiAgentResult<void>> {
		const loaded = await this.graph.load();
		if (!loaded.ok) return loaded;
		if (loaded.value.projection.rootAgentId === this.rootAgentId) {
			return loaded.value.projection.policyReceiptDigest !== undefined && sameDigest(loaded.value.projection.policyReceiptDigest, this.policyReceiptDigest)
				? { ok: true, value: undefined }
				: failure("idempotency_conflict", "registered root policy receipt differs from this supervisor");
		}
		if (loaded.value.projection.rootAgentId !== undefined) return failure("invalid_request", "agent graph is owned by another root");
		const command: AgentGraphCommand = {
			type: "agent.root_registered",
			commandId: createRuntimeId("command", `agent-root-${this.rootAgentId}`),
			requestDigest: runtimeDigest({
				kind: "agent-root-registration",
				rootAgentId: this.rootAgentId,
				policyReceiptDigest: this.policyReceiptDigest,
			}),
			expectedRevision: loaded.value.revision,
			rootAgentId: this.rootAgentId,
			agentId: this.rootAgentId,
			policyReceiptDigest: this.policyReceiptDigest,
		};
		const committed = await this.graph.commit(command);
		if (!committed.ok) return committed;
		if (committed.value.status === "conflict") return failure("store_conflict", "root registration conflicted with another graph mutation");
		return { ok: true, value: undefined };
	}

	public spawn(
		request: ValidatedSpawnSubagentInput,
		invocation: SubagentInvocationContext,
	): Promise<MultiAgentResult<ChildReport>> {
		const identity = deriveChildIdentity(request, invocation);
		const existing = this.operations.get(identity.commandId);
		if (existing !== undefined) {
			if (!sameDigest(existing.identity.requestDigest, identity.requestDigest)) {
				return Promise.resolve(failure("idempotency_conflict", "child spawn identity was reused with a different request"));
			}
			return existing.promise ?? Promise.resolve(failure("store_conflict", "child spawn operation has no promise"));
		}
		const operation: SpawnOperation = { identity, request, invocation };
		const promise = this.executeSpawn(operation);
		operation.promise = promise;
		this.operations.set(identity.commandId, operation);
		this.operationsByAgent.set(identity.agentId, operation);
		return promise;
	}

	public async cancel(
		agentId: AgentId,
		reason: ChildStopReason = "cancelled",
	): Promise<MultiAgentResult<ChildReport>> {
		const operation = this.operationsByAgent.get(agentId);
		if (operation !== undefined) {
			operation.cancelRequested ??= reason;
			if (operation.prepared !== undefined) await operation.prepared.cancel(reason);
			return operation.promise ?? failure("store_conflict", "child cancel has no spawn operation");
		}
		const durable = await this.findTerminalReport(agentId);
		if (!durable.ok) return durable;
		if (durable.value !== undefined) return { ok: true, value: durable.value };
		return failure("recovery_required", "child runtime is not resident in this Session Owner");
	}

	public async inspect(): Promise<MultiAgentResult<AgentGraphInspection>> {
		const loaded = await this.graph.load();
		if (!loaded.ok) return loaded;
		if (loaded.value.projection.rootAgentId !== this.rootAgentId) return failure("invalid_request", "agent graph root is not registered for this supervisor");
		try {
			return { ok: true, value: inspectAgentGraph(loaded.value.projection) };
		} catch (error) {
			return failure("store_conflict", errorMessage(error, "agent graph inspection failed"));
		}
	}

	public async recover(): Promise<MultiAgentResult<AgentRecoverySummary>> {
		const loaded = await this.graph.load();
		if (!loaded.ok) return loaded;
		if (loaded.value.projection.rootAgentId !== this.rootAgentId) return failure("invalid_request", "agent graph root is not registered for recovery");
		const stopped: AgentId[] = [];
		const recoveryRequired: AgentId[] = [];
		const nodes = [...loaded.value.projection.nodes.values()]
			.filter((node) => node.agentId !== this.rootAgentId && !isTerminal(node.state))
			.sort((left, right) => left.createdSequence - right.createdSequence || left.agentId.localeCompare(right.agentId));
		for (const node of nodes) {
			if (this.operationsByAgent.has(node.agentId)) continue;
			let liveness: PreviousOwnerLiveness = "unknown";
			try {
				liveness = this.previousOwnerLiveness === undefined ? "unknown" : await this.previousOwnerLiveness(node);
			} catch {
				liveness = "unknown";
			}
			if (liveness !== "dead") {
				if (node.state === "prepared" || node.state === "running") {
					const reconciled = await this.commitReconciliation(node);
					if (!reconciled.ok && reconciled.error.code !== "invalid_request") return reconciled;
				}
				recoveryRequired.push(node.agentId);
				continue;
			}
			let recoveredNode = node;
			if (node.state === "prepared" || node.state === "running") {
				const reconciled = await this.commitReconciliation(node);
				if (!reconciled.ok) return reconciled;
				recoveredNode = await this.requireNode(node.agentId);
			}
			const report = stoppedReport(recoveredNode.agentId, "owner_takeover", recoveredNode.usage);
			const terminal = await this.commitTerminalForNode(recoveredNode, report, `recovery-${recoveredNode.agentId}`);
			if (!terminal.ok) return terminal;
			stopped.push(terminal.value.agentId);
		}
		return { ok: true, value: { stopped: Object.freeze(stopped), recoveryRequired: Object.freeze(recoveryRequired) } };
	}

	private async executeSpawn(operation: SpawnOperation): Promise<MultiAgentResult<ChildReport>> {
		const { identity, request, invocation } = operation;
		if (invocation.parentAgentId !== this.rootAgentId || invocation.rootAgentId !== this.rootAgentId) {
			return failure("invalid_request", "only the registered root Agent may spawn a child");
		}
		const root = await this.ensureRoot();
		if (!root.ok) return root;
		const existingNode = await this.findNode(identity.agentId);
		if (!existingNode.ok) return existingNode;
		if (existingNode.value !== undefined && !sameDigest(existingNode.value.requestDigest, identity.requestDigest)) {
			return failure("idempotency_conflict", "child spawn identity was reused with a different request");
		}

		const existingTerminal = await this.findTerminalReport(identity.agentId);
		if (!existingTerminal.ok) return existingTerminal;
		if (existingTerminal.value !== undefined) return { ok: true, value: existingTerminal.value };
		const capacity = await this.checkSpawnCapacity(identity.agentId);
		if (!capacity.ok) return capacity;

		const attempt = this.beginAttempt(identity, invocation);
		if (!attempt.ok) return attempt;
		if (attempt.value === "replay_committed") {
			const replay = await this.findTerminalReport(identity.agentId);
			return replay.ok && replay.value !== undefined
				? { ok: true, value: replay.value }
				: failure("recovery_required", "agent_spawn attempt is committed but terminal graph evidence is missing");
		}
		if (attempt.value === "recovery_required") return failure("recovery_required", "agent_spawn attempt requires recovery before retry");

		const spawnCommand: AgentGraphCommand = {
			type: "agent.spawn_requested",
			commandId: identity.commandId,
			requestDigest: identity.requestDigest,
			expectedRevision: 0,
			rootAgentId: this.rootAgentId,
			agentId: identity.agentId,
			parentAgentId: this.rootAgentId,
			role: request.role,
			objective: request.objective,
			requestedCapabilities: request.requestedCapabilities,
			budget: request.budget,
			maxReportBytes: request.output.maxBytes,
		};
		const requested = await this.commitAtHead((head) => ({ ...spawnCommand, expectedRevision: head.revision }));
		if (!requested.ok) return requested;
		if (requested.value.status === "duplicate") {
			const replay = await this.findTerminalReport(identity.agentId);
			return replay.ok && replay.value !== undefined
				? { ok: true, value: replay.value }
				: failure("recovery_required", "durable spawn request exists without a resident child operation");
		}

		let prepared: PreparedChildHandle;
		try {
			const preparedResult = await this.provider.prepare({
				...this.childRuntime,
				agentId: identity.agentId,
				objective: request.objective,
				budget: {
					maxModelTurns: request.budget.maxModelTurns,
					maxToolCalls: request.budget.maxToolCalls,
					maxActiveDurationMs: request.budget.maxActiveDurationMs,
					maxReportBytes: request.output.maxBytes,
				},
				signal: invocation.signal,
			});
			if (!preparedResult.ok) {
				const report = stoppedOrFailedReport(identity.agentId, "failed", "runtime_failed");
				return this.finishAndSettle(operation, await this.commitTerminalForNode(await this.requireNode(identity.agentId), report, identity.commandId));
			}
			prepared = preparedResult.value;
		} catch {
			const report = stoppedOrFailedReport(identity.agentId, "failed", "runtime_failed");
			return this.finishAndSettle(operation, await this.commitTerminalForNode(await this.requireNode(identity.agentId), report, identity.commandId));
		}
		operation.prepared = prepared;

		const spawned = await this.commitAtHead((head) => ({
			type: "agent.spawned",
			commandId: stageCommandId(identity.commandId, "prepared"),
			requestDigest: runtimeDigest({ stage: "prepared", spawnRequestDigest: identity.requestDigest, descriptorDigest: prepared.descriptor.descriptorDigest }),
			expectedRevision: head.revision,
			rootAgentId: this.rootAgentId,
			agentId: identity.agentId,
			runtimeDescriptorDigest: prepared.descriptor.descriptorDigest,
		}));
		if (!spawned.ok) {
			await prepared.dispose();
			return spawned;
		}

		if (operation.cancelRequested !== undefined || invocation.signal.aborted) {
			await prepared.cancel(operation.cancelRequested ?? "cancelled");
			const report = stoppedOrFailedReport(identity.agentId, "stopped", operation.cancelRequested === "owner_takeover" ? "owner_takeover" : "cancelled");
			return this.finishAndSettle(operation, await this.commitTerminalForNode(await this.requireNode(identity.agentId), report, identity.commandId));
		}

		const activated = await prepared.activate();
		if (!activated.ok) {
			if (activated.error.code === "recovery_required") {
				await this.commitReconciliation(await this.requireNode(identity.agentId), "activation_uncertain");
				return activated;
			}
			const report = stoppedOrFailedReport(identity.agentId, "failed", "runtime_failed");
			return this.finishAndSettle(operation, await this.commitTerminalForNode(await this.requireNode(identity.agentId), report, identity.commandId));
		}
		operation.active = activated.value;

		const activeEvent = await this.commitAtHead((head) => ({
			type: "agent.activated",
			commandId: stageCommandId(identity.commandId, "activated"),
			requestDigest: runtimeDigest({ stage: "activated", spawnRequestDigest: identity.requestDigest, activationReceiptDigest: activated.value.activationReceipt.receiptDigest }),
			expectedRevision: head.revision,
			rootAgentId: this.rootAgentId,
			agentId: identity.agentId,
			activationReceiptDigest: activated.value.activationReceipt.receiptDigest,
		}));
		if (!activeEvent.ok) {
			const reconciled = await this.commitReconciliation(await this.requireNode(identity.agentId), "activation_uncertain");
			if (!reconciled.ok) return reconciled;
			return failure("recovery_required", "child activation is live but its durable activation event is uncertain");
		}

		const completion = await activated.value.completion;
		if (!completion.ok) return completion;
		const terminal = await this.commitTerminalForNode(await this.requireNode(identity.agentId), completion.value.report, identity.commandId);
		await prepared.dispose();
		return this.finishAndSettle(operation, terminal);
	}

	private beginAttempt(identity: ChildIdentity, invocation: SubagentInvocationContext): MultiAgentResult<"started" | "replay_committed" | "recovery_required"> {
		if (this.attemptPort === undefined) return { ok: true, value: "started" };
		const begun = this.attemptPort.beginAttempt({
			commandId: identity.commandId,
			attemptId: identity.attemptId,
			effectClass: "agent_spawn",
			requestDigest: identity.requestDigest,
		});
		if ("error" in begun) return failure(begun.error === "recovery_barrier_active" ? "recovery_required" : "runtime_unavailable", `agent_spawn attempt rejected: ${begun.error}`);
		if ("status" in begun) {
			if (begun.status === "conflict") return failure("idempotency_conflict", "agent_spawn attempt identity conflicts with a different request");
			if (begun.status === "replay_committed") return { ok: true, value: "replay_committed" };
			if (begun.status === "recovery_required") return { ok: true, value: "recovery_required" };
		}
		void invocation;
		return { ok: true, value: "started" };
	}

	private async finishAndSettle(
		operation: SpawnOperation,
		terminal: MultiAgentResult<ChildReport>,
	): Promise<MultiAgentResult<ChildReport>> {
		if (terminal.ok && this.attemptPort !== undefined) {
			const outcome = terminal.value.outcome === "completed" ? "committed" : terminal.value.outcome === "failed" ? "rejected" : "interrupted";
			this.attemptPort.settleAttempt(operation.identity.attemptId, outcome, terminal.value.reportDigest);
		}
		return terminal;
	}

	private async commitTerminalForNode(
		node: AgentGraphNode,
		report: ChildReport,
		key: string,
	): Promise<MultiAgentResult<ChildReport>> {
		const existing = await this.findTerminalReport(node.agentId);
		if (!existing.ok) return existing;
		if (existing.value !== undefined) return { ok: true, value: existing.value };
		const runtimeDescriptorDigest = node.runtimeDescriptorDigest ?? runtimeDigest({ agentId: node.agentId, providerId: this.provider.providerId });
		const terminal = createAgentSemanticTerminalRecord({
			spawnRequestDigest: node.requestDigest,
			runtimeDescriptorDigest,
			outcome: report.outcome,
			report: report.report,
			reportDigest: report.reportDigest,
			reportBytes: report.reportBytes,
			usage: report.usage,
			...(report.reasonCode === undefined ? {} : { reasonCode: report.reasonCode }),
		});
		const committed = await this.commitAtHead((head) => ({
			type: terminalType(report.outcome),
			commandId: stageCommandId(key, "terminal"),
			requestDigest: runtimeDigest({ stage: "terminal", terminalDigest: terminal.terminalDigest }),
			expectedRevision: head.revision,
			rootAgentId: this.rootAgentId,
			agentId: node.agentId,
			terminal,
		}));
		if (!committed.ok) {
			const winner = await this.findTerminalReport(node.agentId);
			return winner.ok && winner.value !== undefined ? { ok: true, value: winner.value } : committed;
		}
		const winner = await this.findTerminalReport(node.agentId);
		return winner.ok && winner.value !== undefined ? { ok: true, value: winner.value } : failure("store_conflict", "terminal graph event acknowledgement could not be verified");
	}

	private async commitReconciliation(
		node: AgentGraphNode,
		reasonCode: "activation_uncertain" | "owner_takeover" = "owner_takeover",
	): Promise<MultiAgentResult<void>> {
		if (node.state === "recovery_required") return { ok: true, value: undefined };
		const committed = await this.commitAtHead((head) => ({
			type: "agent.reconciliation_required",
			commandId: stageCommandId(node.requestDigest.digest, "recovery"),
			requestDigest: runtimeDigest({ stage: "reconciliation", requestDigest: node.requestDigest }),
			expectedRevision: head.revision,
			rootAgentId: this.rootAgentId,
			agentId: node.agentId,
			reasonCode,
		}));
		return committed.ok ? { ok: true, value: undefined } : committed;
	}

	private async ensureRoot(): Promise<MultiAgentResult<void>> {
		const loaded = await this.graph.load();
		if (!loaded.ok) return loaded;
		return loaded.value.projection.rootAgentId === this.rootAgentId
			? { ok: true, value: undefined }
			: failure("invalid_request", "registerRoot must complete before spawning a child");
	}

	private async checkSpawnCapacity(agentId: AgentId): Promise<MultiAgentResult<void>> {
		const loaded = await this.graph.load();
		if (!loaded.ok) return loaded;
		const existing = loaded.value.projection.nodes.get(agentId);
		if (existing !== undefined && !isTerminal(existing.state)) return failure("recovery_required", "durable child graph state requires recovery before retry");
		if ([...loaded.value.projection.nodes.values()].some((node) => node.state === "recovery_required")) {
			return failure("recovery_required", "agent graph recovery barrier is open");
		}
		const activeChildren = [...loaded.value.projection.nodes.values()]
			.filter((node) => node.agentId !== this.rootAgentId && !isTerminal(node.state)).length;
		return activeChildren >= 1
			? failure("limit_exceeded", "M1 permits at most one active child per root")
			: { ok: true, value: undefined };
	}

	private async requireNode(agentId: AgentId): Promise<AgentGraphNode> {
		const found = await this.findNode(agentId);
		if (!found.ok) throw new Error(found.error.message);
		const node = found.value;
		if (node === undefined) throw new Error(`agent node not found: ${agentId}`);
		return node;
	}

	private async findNode(agentId: AgentId): Promise<MultiAgentResult<AgentGraphNode | undefined>> {
		const loaded = await this.graph.load();
		if (!loaded.ok) return loaded;
		return { ok: true, value: loaded.value.projection.nodes.get(agentId) };
	}

	private async findTerminalReport(agentId: AgentId): Promise<MultiAgentResult<ChildReport | undefined>> {
		const loaded = await this.graph.load();
		if (!loaded.ok) return loaded;
		for (const record of [...loaded.value.commands.values()].reverse()) {
			const command = record.command;
			if (command.agentId !== agentId || !isTerminalCommand(command)) continue;
			return { ok: true, value: reportFromTerminal(command) };
		}
		return { ok: true, value: undefined };
	}

	private async commitAtHead(
		makeCommand: (head: AgentGraphHead) => AgentGraphCommand,
	): Promise<MultiAgentResult<AgentGraphCommitOutcome>> {
		for (let attempt = 0; attempt < 8; attempt += 1) {
			const loaded = await this.graph.load();
			if (!loaded.ok) return loaded;
			const committed = await this.graph.commit(makeCommand(loaded.value));
			if (!committed.ok) return committed;
			if (committed.value.status !== "conflict") return { ok: true, value: committed.value };
		}
		return failure("store_conflict", "agent graph command exceeded the supervisor retry limit");
	}
}

function deriveChildIdentity(
	request: ValidatedSpawnSubagentInput,
	invocation: SubagentInvocationContext,
): ChildIdentity {
	const identityDigest = runtimeDigest({
		sessionId: invocation.sessionId,
		rootAgentId: invocation.rootAgentId,
		parentAgentId: invocation.parentAgentId,
		source: invocation.source,
		effectId: invocation.effectId,
	});
	const commandId = createRuntimeId("command", `agent-spawn-${identityDigest.digest.slice(0, 64)}`);
	return {
		commandId,
		attemptId: createRuntimeId("attempt", `agent-spawn-${identityDigest.digest.slice(0, 48)}-g${invocation.ownerGeneration}`),
		agentId: createRuntimeId("agent", `child-${identityDigest.digest.slice(0, 64)}`),
		requestDigest: runtimeDigest({ sessionId: invocation.sessionId, rootAgentId: invocation.rootAgentId, parentAgentId: invocation.parentAgentId, request }),
		identityDigest,
	};
}

function stageCommandId(base: string, stage: string): CommandId {
	return createRuntimeId("command", `agent-${runtimeDigest({ base, stage }).digest.slice(0, 64)}`);
}

function terminalType(outcome: ChildReport["outcome"]): AgentTerminalCommand["type"] {
	if (outcome === "completed") return "agent.finished";
	if (outcome === "failed") return "agent.failed";
	return "agent.stopped";
}

function reportFromTerminal(command: AgentTerminalCommand): ChildReport {
	return {
		agentId: command.agentId,
		outcome: command.terminal.outcome,
		report: command.terminal.report,
		reportDigest: { ...command.terminal.reportDigest },
		reportBytes: command.terminal.reportBytes,
		usage: { ...command.terminal.usage },
		...(command.terminal.reasonCode === undefined ? {} : { reasonCode: command.terminal.reasonCode }),
	};
}

function stoppedOrFailedReport(
	agentId: AgentId,
	outcome: ChildReport["outcome"],
	reasonCode: NonNullable<ChildReport["reasonCode"]>,
): ChildReport {
	return {
		agentId,
		outcome,
		report: "",
		reportDigest: runtimeDigest(""),
		reportBytes: 0,
		usage: { modelTurns: 0, toolCalls: 0, activeDurationMs: 0 },
		reasonCode,
	};
}

function stoppedReport(agentId: AgentId, reasonCode: "owner_takeover" | "cancelled", usage: ChildReport["usage"]): ChildReport {
	return {
		agentId,
		outcome: "stopped",
		report: "",
		reportDigest: runtimeDigest(""),
		reportBytes: 0,
		usage: { ...usage },
		reasonCode,
	};
}

function isTerminal(state: AgentGraphNode["state"]): boolean {
	return state === "completed" || state === "failed" || state === "stopped";
}

function isTerminalCommand(command: AgentGraphCommand): command is AgentTerminalCommand {
	return command.type === "agent.finished" || command.type === "agent.failed" || command.type === "agent.stopped";
}

function sameDigest(left: RuntimeDigest, right: RuntimeDigest): boolean {
	return left.algorithm === right.algorithm && left.digest === right.digest;
}

function errorMessage(error: unknown, fallback: string): string {
	return error instanceof Error && error.message.length > 0 ? error.message : fallback;
}

function failure<T>(code: "invalid_request" | "idempotency_conflict" | "limit_exceeded" | "recovery_required" | "runtime_unavailable" | "store_conflict", message: string): MultiAgentResult<T> {
	return { ok: false, error: { code, message } };
}
