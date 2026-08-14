/** Bounded multi-agent graph 的纯状态投影与唯一转移表。 */

import { runtimeDigest, type RuntimeDigest } from "../protocol/foundation.ts";
import type { AgentId } from "../protocol/ids.ts";
import { MULTI_AGENT_HARD_LIMITS } from "./limits.ts";
import {
	validateAgentGraphCommand,
	type AgentGraphCommand,
	type AgentReconciliationRequiredCommand,
	type AgentSemanticTerminalRecord,
	type AgentSpawnRequestedCommand,
	type AgentTerminalCommand,
} from "./graph-events.ts";
import type { MultiAgentLimits, MultiAgentResult, SubagentCapability, SubagentRole } from "./types.ts";

export type AgentNodeRole = "root" | SubagentRole;

export interface AgentGraphNode {
	readonly agentId: AgentId;
	readonly rootAgentId: AgentId;
	readonly parentAgentId?: AgentId;
	readonly role: AgentNodeRole;
	readonly state: "requested" | "prepared" | "running" | "completed" | "failed" | "stopped" | "recovery_required";
	readonly createdSequence: number;
	readonly requestDigest: RuntimeDigest;
	readonly objectiveDigest?: RuntimeDigest;
	readonly policyReceiptDigest?: RuntimeDigest;
	readonly requestedCapabilities: readonly SubagentCapability[];
	readonly budget?: {
		readonly maxModelTurns: number;
		readonly maxToolCalls: number;
		readonly maxActiveDurationMs: number;
	};
	readonly maxReportBytes?: number;
	readonly runtimeDescriptorDigest?: RuntimeDigest;
	readonly activationReceiptDigest?: RuntimeDigest;
	readonly reportDigest?: RuntimeDigest;
	readonly reportBytes?: number;
	readonly usage: {
		readonly modelTurns: number;
		readonly toolCalls: number;
		readonly activeDurationMs: number;
	};
	readonly reasonCode?: string;
	readonly terminalDigest?: RuntimeDigest;
}

export interface AgentGraphProjection {
	readonly revision: number;
	readonly rootAgentId?: AgentId;
	readonly policyReceiptDigest?: RuntimeDigest;
	readonly limits: MultiAgentLimits;
	readonly nodes: ReadonlyMap<AgentId, AgentGraphNode>;
}

export interface AgentNodeInspection {
	readonly agentId: AgentId;
	readonly rootAgentId: AgentId;
	readonly parentAgentId?: AgentId;
	readonly role: AgentNodeRole;
	readonly state: AgentGraphNode["state"];
	readonly createdSequence: number;
	readonly objectiveDigest?: RuntimeDigest;
	readonly reportDigest?: RuntimeDigest;
	readonly reportBytes?: number;
	readonly usage: AgentGraphNode["usage"];
	readonly reasonCode?: string;
}

export interface AgentGraphInspection {
	readonly revision: number;
	readonly rootAgentId: AgentId;
	readonly policyReceiptDigest: RuntimeDigest;
	readonly counts: {
		readonly totalAgents: number;
		readonly nonTerminalChildren: number;
		readonly remainingLifetimeSlots: number;
	};
	readonly nodes: readonly AgentNodeInspection[];
}

const TERMINAL_STATES: ReadonlySet<AgentGraphNode["state"]> = new Set(["completed", "failed", "stopped"]);

export function createEmptyAgentGraphProjection(limits: MultiAgentLimits = MULTI_AGENT_HARD_LIMITS): AgentGraphProjection {
	return {
		revision: 0,
		limits: Object.freeze({ ...limits }),
		nodes: new Map<AgentId, AgentGraphNode>(),
	};
}

export function applyAgentGraphCommand(
	state: AgentGraphProjection,
	command: AgentGraphCommand,
	graphRevision: number,
): MultiAgentResult<AgentGraphProjection> {
	const checked = validateAgentGraphCommand(command);
	if (!checked.ok) return checked;
	if (!Number.isSafeInteger(graphRevision) || graphRevision < 1 || graphRevision !== state.revision + 1) {
		return failure("store_conflict", "graph revision is not the next durable revision");
	}
	if (command.expectedRevision !== state.revision) {
		return failure("store_conflict", "command expected revision does not match the graph head");
	}

	if (command.type === "agent.root_registered") return registerRoot(state, command, graphRevision);
	if (state.rootAgentId === undefined || state.policyReceiptDigest === undefined) return failure("invalid_request", "agent graph root is not registered");
	if (command.rootAgentId !== state.rootAgentId) return failure("invalid_request", "command rootAgentId does not match the graph");
	if (command.type === "agent.spawn_requested") return requestChild(state, command, graphRevision);

	const current = state.nodes.get(command.agentId);
	if (current === undefined) return failure("invalid_request", "agent node does not exist", "agentId");
	if (current.state === "completed" || current.state === "failed" || current.state === "stopped") {
		return failure("invalid_request", "terminal agent cannot change state", "agentId");
	}

	switch (command.type) {
		case "agent.spawned":
			return transitionNode(state, current, "requested", "prepared", graphRevision, { runtimeDescriptorDigest: command.runtimeDescriptorDigest });
		case "agent.activated":
			return transitionNode(state, current, "prepared", "running", graphRevision, { activationReceiptDigest: command.activationReceiptDigest });
		case "agent.reconciliation_required":
			return reconcileNode(state, current, command, graphRevision);
		case "agent.finished":
			return finishNode(state, current, command, "running", "completed", graphRevision);
		case "agent.failed":
			return finishNode(state, current, command, new Set(["requested", "prepared", "running"]), "failed", graphRevision);
		case "agent.stopped":
			return finishNode(state, current, command, new Set(["requested", "prepared", "running", "recovery_required"]), "stopped", graphRevision);
	}
}

export function inspectAgentGraph(state: AgentGraphProjection): AgentGraphInspection {
	if (state.rootAgentId === undefined || state.policyReceiptDigest === undefined) throw new Error("cannot inspect an unregistered agent graph");
	const nodes = [...state.nodes.values()]
		.sort((left, right) => left.createdSequence - right.createdSequence || left.agentId.localeCompare(right.agentId))
		.map((node): AgentNodeInspection => ({
			agentId: node.agentId,
			rootAgentId: node.rootAgentId,
			...(node.parentAgentId === undefined ? {} : { parentAgentId: node.parentAgentId }),
			role: node.role,
			state: node.state,
			createdSequence: node.createdSequence,
			...(node.objectiveDigest === undefined ? {} : { objectiveDigest: { ...node.objectiveDigest } }),
			...(node.reportDigest === undefined ? {} : { reportDigest: { ...node.reportDigest } }),
			...(node.reportBytes === undefined ? {} : { reportBytes: node.reportBytes }),
			usage: { ...node.usage },
			...(node.reasonCode === undefined ? {} : { reasonCode: node.reasonCode }),
		}));
	const nonTerminalChildren = nodes.filter((node) => node.agentId !== state.rootAgentId && !TERMINAL_STATES.has(node.state)).length;
	return {
		revision: state.revision,
		rootAgentId: state.rootAgentId,
		policyReceiptDigest: { ...state.policyReceiptDigest },
		counts: {
			totalAgents: nodes.length,
			nonTerminalChildren,
			remainingLifetimeSlots: Math.max(0, state.limits.maxTotalAgents - nodes.length),
		},
		nodes,
	};
}

export function cloneAgentGraphProjection(state: AgentGraphProjection): AgentGraphProjection {
	return {
		revision: state.revision,
		...(state.rootAgentId === undefined ? {} : { rootAgentId: state.rootAgentId }),
		...(state.policyReceiptDigest === undefined ? {} : { policyReceiptDigest: { ...state.policyReceiptDigest } }),
		limits: { ...state.limits },
		nodes: new Map([...state.nodes.entries()].map(([id, node]) => [id, cloneNode(node)])),
	};
}

function registerRoot(
	state: AgentGraphProjection,
		command: Extract<AgentGraphCommand, { type: "agent.root_registered" }>,
		graphRevision: number,
): MultiAgentResult<AgentGraphProjection> {
	if (state.rootAgentId !== undefined || state.nodes.size !== 0) return failure("invalid_request", "agent graph root can only be registered once");
	if (command.agentId !== command.rootAgentId) return failure("invalid_request", "root agent identity is inconsistent");
	const node: AgentGraphNode = {
		agentId: command.agentId,
		rootAgentId: command.rootAgentId,
		role: "root",
		state: "running",
		createdSequence: graphRevision,
		requestDigest: { ...command.requestDigest },
		policyReceiptDigest: { ...command.policyReceiptDigest },
		requestedCapabilities: [],
		usage: { modelTurns: 0, toolCalls: 0, activeDurationMs: 0 },
	};
	return {
		ok: true,
		value: {
			revision: graphRevision,
			rootAgentId: command.rootAgentId,
			policyReceiptDigest: { ...command.policyReceiptDigest },
			limits: state.limits,
			nodes: new Map([[command.agentId, node]]),
		},
	};
}

function requestChild(
	state: AgentGraphProjection,
		command: AgentSpawnRequestedCommand,
		graphRevision: number,
	): MultiAgentResult<AgentGraphProjection> {
	if (state.nodes.has(command.agentId)) return failure("invalid_request", "agentId is already present in the graph", "agentId");
	if (command.parentAgentId !== state.rootAgentId) return failure("invalid_request", "M1 children must be direct root children", "parentAgentId");
	const parent = state.nodes.get(command.parentAgentId);
	if (parent === undefined || parent.state !== "running" || parent.role !== "root") return failure("invalid_request", "parent agent is not an active root");
	const childCount = [...state.nodes.values()].filter((node) => node.agentId !== state.rootAgentId).length;
	if (childCount >= state.limits.maxChildrenPerRoot || state.nodes.size >= state.limits.maxTotalAgents) return failure("limit_exceeded", "agent graph hard limit is exhausted");
	if (command.budget.maxModelTurns > state.limits.maxModelTurnsPerAgent || command.budget.maxToolCalls > state.limits.maxToolCallsPerAgent || command.budget.maxActiveDurationMs > state.limits.maxActiveDurationMsPerAgent || command.maxReportBytes > state.limits.maxReportBytes) {
		return failure("limit_exceeded", "child request widens the effective graph limits");
	}
	const node: AgentGraphNode = {
		agentId: command.agentId,
		rootAgentId: state.rootAgentId!,
		parentAgentId: command.parentAgentId,
		role: command.role,
		state: "requested",
		createdSequence: graphRevision,
		requestDigest: { ...command.requestDigest },
		objectiveDigest: runtimeDigest(command.objective),
		requestedCapabilities: [...command.requestedCapabilities],
		budget: { ...command.budget },
		maxReportBytes: command.maxReportBytes,
		usage: { modelTurns: 0, toolCalls: 0, activeDurationMs: 0 },
	};
	const nodes = new Map(state.nodes);
	nodes.set(node.agentId, node);
	return { ok: true, value: { ...state, revision: graphRevision, nodes } };
}

function transitionNode(
	state: AgentGraphProjection,
	node: AgentGraphNode,
	from: AgentGraphNode["state"],
	to: AgentGraphNode["state"],
	graphRevision: number,
	changes: Partial<Pick<AgentGraphNode, "runtimeDescriptorDigest" | "activationReceiptDigest">>,
): MultiAgentResult<AgentGraphProjection> {
	if (node.state !== from) return failure("invalid_request", `agent transition requires state ${from}`);
	return replaceNode(state, node, { state: to, ...changes }, graphRevision);
}

function reconcileNode(
	state: AgentGraphProjection,
	node: AgentGraphNode,
	command: AgentReconciliationRequiredCommand,
	graphRevision: number,
): MultiAgentResult<AgentGraphProjection> {
	if (node.state !== "prepared" && node.state !== "running") return failure("invalid_request", "only prepared or running agents require reconciliation");
	return replaceNode(state, node, { state: "recovery_required", reasonCode: command.reasonCode }, graphRevision);
}

function finishNode(
	state: AgentGraphProjection,
	node: AgentGraphNode,
	command: AgentTerminalCommand,
	allowedFrom: AgentGraphNode["state"] | ReadonlySet<AgentGraphNode["state"]>,
	to: AgentGraphNode["state"],
	graphRevision: number,
): MultiAgentResult<AgentGraphProjection> {
	const allowed = allowedFrom instanceof Set ? allowedFrom.has(node.state) : node.state === allowedFrom;
	if (!allowed) return failure("invalid_request", `agent transition cannot move from ${node.state} to ${to}`);
	const terminal = command.terminal;
	if (!sameDigest(terminal.spawnRequestDigest, node.requestDigest)) return failure("invalid_request", "terminal record is not bound to the spawn request");
	if (node.runtimeDescriptorDigest !== undefined && !sameDigest(terminal.runtimeDescriptorDigest, node.runtimeDescriptorDigest)) return failure("invalid_request", "terminal record is not bound to the runtime descriptor");
	if (node.maxReportBytes !== undefined && terminal.reportBytes > node.maxReportBytes) return failure("limit_exceeded", "terminal report exceeds the requested report limit");
	if (terminal.outcome !== terminalOutcome(command.type)) return failure("invalid_request", "terminal outcome does not match the event type");
	const changes: Partial<AgentGraphNode> = {
		state: to,
		reportDigest: { ...terminal.reportDigest },
		reportBytes: terminal.reportBytes,
		usage: { ...terminal.usage },
		reasonCode: terminal.reasonCode,
		terminalDigest: { ...terminal.terminalDigest },
	};
	return replaceNode(state, node, changes, graphRevision);
}

function replaceNode(
	state: AgentGraphProjection,
	node: AgentGraphNode,
	changes: Partial<AgentGraphNode>,
	graphRevision: number,
): MultiAgentResult<AgentGraphProjection> {
	const nodes = new Map(state.nodes);
	nodes.set(node.agentId, { ...node, ...changes });
	return { ok: true, value: { ...state, revision: graphRevision, nodes } };
}

function cloneNode(node: AgentGraphNode): AgentGraphNode {
	return {
		...node,
		requestDigest: { ...node.requestDigest },
		...(node.objectiveDigest === undefined ? {} : { objectiveDigest: { ...node.objectiveDigest } }),
		...(node.policyReceiptDigest === undefined ? {} : { policyReceiptDigest: { ...node.policyReceiptDigest } }),
		requestedCapabilities: [...node.requestedCapabilities],
		...(node.budget === undefined ? {} : { budget: { ...node.budget } }),
		...(node.runtimeDescriptorDigest === undefined ? {} : { runtimeDescriptorDigest: { ...node.runtimeDescriptorDigest } }),
		...(node.activationReceiptDigest === undefined ? {} : { activationReceiptDigest: { ...node.activationReceiptDigest } }),
		...(node.reportDigest === undefined ? {} : { reportDigest: { ...node.reportDigest } }),
		usage: { ...node.usage },
		...(node.terminalDigest === undefined ? {} : { terminalDigest: { ...node.terminalDigest } }),
	};
}

function sameDigest(left: RuntimeDigest, right: RuntimeDigest): boolean {
	return left.algorithm === right.algorithm && left.digest === right.digest;
}

function terminalOutcome(type: AgentTerminalCommand["type"]): AgentSemanticTerminalRecord["outcome"] {
	if (type === "agent.finished") return "completed";
	if (type === "agent.failed") return "failed";
	return "stopped";
}

function failure<T>(code: "invalid_request" | "limit_exceeded" | "store_conflict", message: string, path?: string): MultiAgentResult<T> {
	return { ok: false, error: { code, message, ...(path === undefined ? {} : { path }) } };
}
