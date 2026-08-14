/** Bounded multi-agent graph 的 exact command/event payload 合同。 */

import { canonicalJson } from "../protocol/canonical-json.ts";
import { runtimeDigest, type RuntimeDigest } from "../protocol/foundation.ts";
import { isRuntimeDigest } from "../protocol/foundation-schemas.ts";
import { createRuntimeId, isRuntimeId, type AgentId, type CommandId, type EventId } from "../protocol/ids.ts";
import {
	MAX_OBJECTIVE_BYTES,
	MULTI_AGENT_HARD_LIMITS,
	validateBoundedUtf8Text,
} from "./limits.ts";
import {
	SUBAGENT_CAPABILITIES,
	SUBAGENT_ROLES,
	type ChildTerminalReason,
	type MultiAgentResult,
	type SubagentCapability,
	type SubagentRole,
} from "./types.ts";

export const AGENT_GRAPH_SCHEMA = "runledger.agent-graph.current" as const;

export const AGENT_GRAPH_EVENT_TYPES = [
	"agent.root_registered",
	"agent.spawn_requested",
	"agent.spawned",
	"agent.activated",
	"agent.finished",
	"agent.failed",
	"agent.stopped",
	"agent.reconciliation_required",
] as const;
export type AgentGraphEventType = (typeof AGENT_GRAPH_EVENT_TYPES)[number];

export interface AgentSemanticTerminalRecord {
	readonly spawnRequestDigest: RuntimeDigest;
	readonly runtimeDescriptorDigest: RuntimeDigest;
	readonly outcome: "completed" | "failed" | "stopped";
	readonly report: string;
	readonly reportDigest: RuntimeDigest;
	readonly reportBytes: number;
	readonly usage: {
		readonly modelTurns: number;
		readonly toolCalls: number;
		readonly activeDurationMs: number;
	};
	readonly reasonCode?: ChildTerminalReason;
	readonly terminalDigest: RuntimeDigest;
}

interface AgentGraphCommandBase {
	readonly commandId: CommandId;
	readonly requestDigest: RuntimeDigest;
	readonly expectedRevision: number;
	readonly rootAgentId: AgentId;
}

export interface AgentRootRegisteredCommand extends AgentGraphCommandBase {
	readonly type: "agent.root_registered";
	readonly agentId: AgentId;
	readonly policyReceiptDigest: RuntimeDigest;
}

export interface AgentSpawnRequestedCommand extends AgentGraphCommandBase {
	readonly type: "agent.spawn_requested";
	readonly agentId: AgentId;
	readonly parentAgentId: AgentId;
	readonly role: SubagentRole;
	readonly objective: string;
	readonly requestedCapabilities: readonly SubagentCapability[];
	readonly budget: {
		readonly maxModelTurns: number;
		readonly maxToolCalls: number;
		readonly maxActiveDurationMs: number;
	};
	readonly maxReportBytes: number;
}

export interface AgentSpawnedCommand extends AgentGraphCommandBase {
	readonly type: "agent.spawned";
	readonly agentId: AgentId;
	readonly runtimeDescriptorDigest: RuntimeDigest;
}

export interface AgentActivatedCommand extends AgentGraphCommandBase {
	readonly type: "agent.activated";
	readonly agentId: AgentId;
	readonly activationReceiptDigest: RuntimeDigest;
}

export interface AgentTerminalCommand extends AgentGraphCommandBase {
	readonly type: "agent.finished" | "agent.failed" | "agent.stopped";
	readonly agentId: AgentId;
	readonly terminal: AgentSemanticTerminalRecord;
}

export interface AgentReconciliationRequiredCommand extends AgentGraphCommandBase {
	readonly type: "agent.reconciliation_required";
	readonly agentId: AgentId;
	readonly reasonCode: "activation_uncertain" | "owner_takeover";
}

export type AgentGraphCommand =
	| AgentRootRegisteredCommand
	| AgentSpawnRequestedCommand
	| AgentSpawnedCommand
	| AgentActivatedCommand
	| AgentTerminalCommand
	| AgentReconciliationRequiredCommand;

export type AgentGraphEventPayload = {
	readonly schema: typeof AGENT_GRAPH_SCHEMA;
	readonly graphRevision: number;
} & AgentGraphCommand;

export interface AgentGraphEventRecord {
	readonly eventId: EventId;
	readonly eventType: AgentGraphEventType;
	readonly graphRevision: number;
	readonly command: AgentGraphCommand;
}

export interface AgentGraphCommandRecord {
	readonly commandId: CommandId;
	readonly commandDigest: RuntimeDigest;
	readonly eventId: EventId;
	readonly eventType: AgentGraphEventType;
	readonly requestDigest: RuntimeDigest;
	readonly graphRevision: number;
	readonly sessionSequence: number;
	readonly sessionEventHash: string;
	readonly command: AgentGraphCommand;
}

const TERMINAL_REASONS: ReadonlySet<string> = new Set([
	"budget_exhausted",
	"report_limit_exceeded",
	"cancelled",
	"runtime_failed",
	"activation_uncertain",
	"owner_takeover",
]);

const TERMINAL_KEYS = [
	"spawnRequestDigest",
	"runtimeDescriptorDigest",
	"outcome",
	"report",
	"reportDigest",
	"reportBytes",
	"usage",
	"reasonCode",
	"terminalDigest",
] as const;

export function createAgentSemanticTerminalRecord(
	input: Omit<AgentSemanticTerminalRecord, "terminalDigest">,
): AgentSemanticTerminalRecord {
	return Object.freeze({ ...input, terminalDigest: runtimeDigest(input) });
}

export function agentGraphCommandDigest(command: AgentGraphCommand): RuntimeDigest {
	return runtimeDigest(command);
}

export function createAgentGraphEventPayload(command: AgentGraphCommand, graphRevision: number): AgentGraphEventPayload {
	const checked = validateAgentGraphCommand(command);
	if (!checked.ok) throw new Error(`${checked.error.code}: ${checked.error.message}`);
	if (!isSafeRevision(graphRevision) || graphRevision !== command.expectedRevision + 1) {
		throw new Error("graph revision must be the next revision after the command expected revision");
	}
	return Object.freeze({ schema: AGENT_GRAPH_SCHEMA, graphRevision, ...checked.value });
}

export function encodeAgentGraphEventPayload(command: AgentGraphCommand, graphRevision: number): string {
	return canonicalJson(createAgentGraphEventPayload(command, graphRevision));
}

export function decodeAgentGraphEventPayload(
	eventType: unknown,
	value: unknown,
): MultiAgentResult<AgentGraphCommand & { readonly graphRevision: number }> {
	if (!isAgentGraphEventType(eventType)) return failure("invalid_request", "unknown agent graph event type");
	const candidate = parseCandidate(value);
	if (candidate === undefined) return failure("invalid_request", "agent graph payload must be an object or JSON object");
	const expectedKeys = ["schema", "graphRevision", ...commandKeys(eventType)];
	if (!hasExactKeys(candidate, expectedKeys)) return failure("invalid_request", "agent graph payload contains unknown or missing keys");
	if (candidate.schema !== AGENT_GRAPH_SCHEMA) return failure("invalid_request", "agent graph payload schema is unsupported");
	if (!isSafeRevision(candidate.graphRevision)) return failure("invalid_request", "graphRevision must be a non-negative safe integer");
	const { schema: _schema, graphRevision, ...commandValue } = candidate;
	const command = validateAgentGraphCommand(commandValue);
	if (!command.ok) return command;
	if (command.value.type !== eventType) return failure("invalid_request", "payload event type does not match the event envelope");
	if (graphRevision !== command.value.expectedRevision + 1) {
		return failure("invalid_request", "graphRevision must be the next revision after expectedRevision");
	}
	return { ok: true, value: Object.freeze({ ...command.value, graphRevision }) };
}

export function createAgentGraphEvent(
	command: AgentGraphCommand,
	graphRevision: number,
	eventId: EventId = createRuntimeId("event", `agent-graph-${runtimeDigest({ command, graphRevision }).digest.slice(0, 64)}`),
): AgentGraphEventRecord {
	return Object.freeze({
		eventId,
		eventType: command.type,
		graphRevision,
		command: validateOrThrow(command),
	});
}

export function validateAgentGraphCommand(value: unknown): MultiAgentResult<AgentGraphCommand> {
	if (!isRecord(value)) return failure("invalid_request", "agent graph command must be an object");
	if (!isAgentGraphEventType(value.type)) return failure("invalid_request", "unknown agent graph command type", "type");
	if (!hasExactKeys(value, commandKeys(value.type))) {
		return failure("invalid_request", "agent graph command contains unknown or missing keys");
	}
	if (!isRuntimeId(value.commandId, "command")) return failure("invalid_request", "commandId is invalid", "commandId");
	if (!isRuntimeDigest(value.requestDigest)) return failure("invalid_request", "requestDigest is invalid", "requestDigest");
	if (!isSafeRevision(value.expectedRevision)) return failure("invalid_request", "expectedRevision is invalid", "expectedRevision");
	if (!isRuntimeId(value.rootAgentId, "agent")) return failure("invalid_request", "rootAgentId is invalid", "rootAgentId");

	switch (value.type) {
		case "agent.root_registered":
			if (!isRuntimeId(value.agentId, "agent") || value.agentId !== value.rootAgentId) {
				return failure("invalid_request", "root registration agentId must equal rootAgentId", "agentId");
			}
			if (!isRuntimeDigest(value.policyReceiptDigest)) return failure("invalid_request", "policyReceiptDigest is invalid", "policyReceiptDigest");
			return { ok: true, value: freezeCommand(value as unknown as AgentRootRegisteredCommand) };

		case "agent.spawn_requested":
			return validateSpawnRequested(value);

		case "agent.spawned":
			if (!isRuntimeId(value.agentId, "agent")) return failure("invalid_request", "agentId is invalid", "agentId");
			if (!isRuntimeDigest(value.runtimeDescriptorDigest)) return failure("invalid_request", "runtimeDescriptorDigest is invalid", "runtimeDescriptorDigest");
			return { ok: true, value: freezeCommand(value as unknown as AgentSpawnedCommand) };

		case "agent.activated":
			if (!isRuntimeId(value.agentId, "agent")) return failure("invalid_request", "agentId is invalid", "agentId");
			if (!isRuntimeDigest(value.activationReceiptDigest)) return failure("invalid_request", "activationReceiptDigest is invalid", "activationReceiptDigest");
			return { ok: true, value: freezeCommand(value as unknown as AgentActivatedCommand) };

		case "agent.finished":
		case "agent.failed":
		case "agent.stopped": {
			if (!isRuntimeId(value.agentId, "agent")) return failure("invalid_request", "agentId is invalid", "agentId");
			const terminal = validateTerminal(value.terminal);
			if (!terminal.ok) return terminal;
			if (terminal.value.outcome !== terminalOutcome(value.type)) {
				return failure("invalid_request", "terminal outcome does not match the event type", "terminal.outcome");
			}
			return { ok: true, value: freezeCommand({ ...value, terminal: terminal.value } as unknown as AgentTerminalCommand) };
		}

		case "agent.reconciliation_required":
			if (!isRuntimeId(value.agentId, "agent")) return failure("invalid_request", "agentId is invalid", "agentId");
			if (value.reasonCode !== "activation_uncertain" && value.reasonCode !== "owner_takeover") {
				return failure("invalid_request", "reconciliation reasonCode is invalid", "reasonCode");
			}
			return { ok: true, value: freezeCommand(value as unknown as AgentReconciliationRequiredCommand) };
	}
}

export function isAgentGraphEventType(value: unknown): value is AgentGraphEventType {
	return typeof value === "string" && (AGENT_GRAPH_EVENT_TYPES as readonly string[]).includes(value);
}

export function commandKeys(type: AgentGraphEventType): readonly string[] {
	const common = ["type", "commandId", "requestDigest", "expectedRevision", "rootAgentId"];
	switch (type) {
		case "agent.root_registered": return [...common, "agentId", "policyReceiptDigest"];
		case "agent.spawn_requested": return [...common, "agentId", "parentAgentId", "role", "objective", "requestedCapabilities", "budget", "maxReportBytes"];
		case "agent.spawned": return [...common, "agentId", "runtimeDescriptorDigest"];
		case "agent.activated": return [...common, "agentId", "activationReceiptDigest"];
		case "agent.finished":
		case "agent.failed":
		case "agent.stopped": return [...common, "agentId", "terminal"];
		case "agent.reconciliation_required": return [...common, "agentId", "reasonCode"];
	}
}

function validateSpawnRequested(value: Record<string, unknown>): MultiAgentResult<AgentSpawnRequestedCommand> {
	if (!isRuntimeId(value.agentId, "agent") || !isRuntimeId(value.parentAgentId, "agent")) {
		return failure("invalid_request", "agentId and parentAgentId are invalid");
	}
	if (!isSubagentRole(value.role)) return failure("invalid_request", "role is not supported", "role");
	const objective = validateBoundedUtf8Text(value.objective, {
		field: "objective",
		minBytes: 1,
		maxBytes: MAX_OBJECTIVE_BYTES,
		rejectWhitespaceOnly: true,
	});
	if (!objective.ok) return objective;
	if (!Array.isArray(value.requestedCapabilities) || value.requestedCapabilities.length > 8) {
		return failure("invalid_request", "requestedCapabilities must be a bounded array", "requestedCapabilities");
	}
	const capabilities: SubagentCapability[] = [];
	for (const item of value.requestedCapabilities) {
		if (!isSubagentCapability(item)) return failure("invalid_request", "requestedCapabilities contains an unsupported capability", "requestedCapabilities");
		if (capabilities.includes(item)) return failure("invalid_request", "requestedCapabilities must not contain duplicates", "requestedCapabilities");
		capabilities.push(item);
	}
	if (!isRecord(value.budget) || !hasExactKeys(value.budget, ["maxModelTurns", "maxToolCalls", "maxActiveDurationMs"])) {
		return failure("invalid_request", "budget has unknown or missing keys", "budget");
	}
	const budget = {
		maxModelTurns: value.budget.maxModelTurns,
		maxToolCalls: value.budget.maxToolCalls,
		maxActiveDurationMs: value.budget.maxActiveDurationMs,
	};
	for (const [key, ceiling] of [
		["maxModelTurns", MULTI_AGENT_HARD_LIMITS.maxModelTurnsPerAgent],
		["maxToolCalls", MULTI_AGENT_HARD_LIMITS.maxToolCallsPerAgent],
		["maxActiveDurationMs", MULTI_AGENT_HARD_LIMITS.maxActiveDurationMsPerAgent],
	] as const) {
		const candidate = budget[key];
		if (!isPositiveSafeInteger(candidate) || candidate > ceiling) return failure("limit_exceeded", `${key} exceeds the hard ceiling`, `budget.${key}`);
	}
	if (!isPositiveSafeInteger(value.maxReportBytes) || value.maxReportBytes > MULTI_AGENT_HARD_LIMITS.maxReportBytes) {
		return failure("limit_exceeded", "maxReportBytes exceeds the hard ceiling", "maxReportBytes");
	}
	return {
		ok: true,
		value: freezeCommand({
			...value,
			objective: objective.value.value,
			requestedCapabilities: Object.freeze(capabilities),
			budget: Object.freeze(budget),
		} as AgentSpawnRequestedCommand),
	};
}

function validateTerminal(value: unknown): MultiAgentResult<AgentSemanticTerminalRecord> {
	if (!isRecord(value) || !hasExactKeys(value, TERMINAL_KEYS.filter((key) => key !== "reasonCode"), ["reasonCode"])) return failure("invalid_request", "terminal record has unknown or missing keys", "terminal");
	if (!isRuntimeDigest(value.spawnRequestDigest) || !isRuntimeDigest(value.runtimeDescriptorDigest)) {
		return failure("invalid_request", "terminal evidence digests are invalid", "terminal");
	}
	if (value.outcome !== "completed" && value.outcome !== "failed" && value.outcome !== "stopped") return failure("invalid_request", "terminal outcome is invalid", "terminal.outcome");
	const report = validateBoundedUtf8Text(value.report, {
		field: "terminal.report",
		minBytes: 0,
		maxBytes: MULTI_AGENT_HARD_LIMITS.maxReportBytes,
	});
	if (!report.ok) return report;
	if (!isRuntimeDigest(value.reportDigest) || !sameDigest(value.reportDigest, runtimeDigest(report.value.value))) return failure("invalid_request", "reportDigest does not match report", "terminal.reportDigest");
	if (value.reportBytes !== report.value.bytes) return failure("invalid_request", "reportBytes does not match the UTF-8 report size", "terminal.reportBytes");
	if (!isRecord(value.usage) || !hasExactKeys(value.usage, ["modelTurns", "toolCalls", "activeDurationMs"])) return failure("invalid_request", "terminal usage has unknown or missing keys", "terminal.usage");
	const usage = {
		modelTurns: value.usage.modelTurns,
		toolCalls: value.usage.toolCalls,
		activeDurationMs: value.usage.activeDurationMs,
	};
	if (!Object.values(usage).every(isNonNegativeSafeInteger)) return failure("invalid_request", "terminal usage must use non-negative safe integers", "terminal.usage");
	const normalizedUsage = {
		modelTurns: usage.modelTurns as number,
		toolCalls: usage.toolCalls as number,
		activeDurationMs: usage.activeDurationMs as number,
	};
	if (normalizedUsage.modelTurns > MULTI_AGENT_HARD_LIMITS.maxModelTurnsPerAgent || normalizedUsage.toolCalls > MULTI_AGENT_HARD_LIMITS.maxToolCallsPerAgent || normalizedUsage.activeDurationMs > MULTI_AGENT_HARD_LIMITS.maxActiveDurationMsPerAgent) {
		return failure("limit_exceeded", "terminal usage exceeds the hard ceiling", "terminal.usage");
	}
	const reasonCode = value.reasonCode;
	if (reasonCode !== undefined && !isTerminalReason(reasonCode)) return failure("invalid_request", "terminal reasonCode is invalid", "terminal.reasonCode");
	const withoutDigest = {
		spawnRequestDigest: value.spawnRequestDigest,
		runtimeDescriptorDigest: value.runtimeDescriptorDigest,
		outcome: value.outcome,
		report: report.value.value,
		reportDigest: value.reportDigest,
		reportBytes: value.reportBytes,
		usage: normalizedUsage,
		...(reasonCode === undefined ? {} : { reasonCode }),
	};
	if (!isRuntimeDigest(value.terminalDigest) || !sameDigest(value.terminalDigest, runtimeDigest(withoutDigest))) return failure("invalid_request", "terminalDigest does not match the terminal record", "terminal.terminalDigest");
	return { ok: true, value: Object.freeze({ ...withoutDigest, terminalDigest: value.terminalDigest }) as AgentSemanticTerminalRecord };
}

function terminalOutcome(type: AgentTerminalCommand["type"]): AgentSemanticTerminalRecord["outcome"] {
	if (type === "agent.finished") return "completed";
	if (type === "agent.failed") return "failed";
	return "stopped";
}

function validateOrThrow(value: unknown): AgentGraphCommand {
	const result = validateAgentGraphCommand(value);
	if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
	return result.value;
}

function freezeCommand<T extends AgentGraphCommand>(value: T): T {
	return Object.freeze(value);
}

function parseCandidate(value: unknown): Record<string, unknown> | undefined {
	if (typeof value === "string") {
		try {
			const parsed: unknown = JSON.parse(value);
			return isRecord(parsed) ? parsed : undefined;
		} catch {
			return undefined;
		}
	}
	return isRecord(value) ? value : undefined;
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[], optionalKeys: readonly string[] = []): boolean {
	const expected = new Set(keys);
	const optional = new Set(optionalKeys);
	const actual = Object.keys(value);
	return actual.every((key) => expected.has(key) || optional.has(key)) && keys.every((key) => Object.hasOwn(value, key));
}

function sameDigest(left: RuntimeDigest, right: RuntimeDigest): boolean {
	return left.algorithm === right.algorithm && left.digest === right.digest;
}

function isSafeRevision(value: unknown): value is number {
	return isNonNegativeSafeInteger(value);
}

function isPositiveSafeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isSubagentRole(value: unknown): value is SubagentRole {
	return typeof value === "string" && (SUBAGENT_ROLES as readonly string[]).includes(value);
}

function isSubagentCapability(value: unknown): value is SubagentCapability {
	return typeof value === "string" && (SUBAGENT_CAPABILITIES as readonly string[]).includes(value);
}

function isTerminalReason(value: unknown): value is ChildTerminalReason {
	return typeof value === "string" && TERMINAL_REASONS.has(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function failure<T>(code: "invalid_request" | "limit_exceeded", message: string, path?: string): MultiAgentResult<T> {
	return { ok: false, error: { code, message, ...(path === undefined ? {} : { path }) } };
}

export function cloneAgentGraphCommand(command: AgentGraphCommand): AgentGraphCommand {
	return validateOrThrow(JSON.parse(canonicalJson(command)) as unknown);
}
