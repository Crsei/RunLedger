/** 模型可见的有界子 Agent 委托工具。 */

import { Type } from "typebox";
import type { Static } from "typebox";
import type { AgentTool, AgentToolResult } from "../types.ts";
import type { ToolContext } from "../tool-context.ts";
import { isRuntimeId, type AgentId, type SessionId, type ToolCallId } from "../protocol/ids.ts";
import {
	MAX_OBJECTIVE_BYTES,
	MULTI_AGENT_HARD_LIMITS,
	MAX_REQUESTED_CAPABILITIES,
	validateSpawnSubagentRequest,
} from "./limits.ts";
import { SUBAGENT_CAPABILITIES, SUBAGENT_ROLES, type ChildReport, type MultiAgentPolicy, type MultiAgentResult, type SubagentInvocationContext, type ValidatedSpawnSubagentInput } from "./types.ts";
import { runtimeDigest } from "../protocol/foundation.ts";

const roleSchema = Type.Unsafe({ type: "string", enum: [...SUBAGENT_ROLES] });
const capabilitySchema = Type.Unsafe({ type: "string", enum: [...SUBAGENT_CAPABILITIES] });

export const spawnAgentSchema = Type.Object({
	role: roleSchema,
	objective: Type.String({ minLength: 1, maxLength: MAX_OBJECTIVE_BYTES }),
	requestedCapabilities: Type.Optional(Type.Array(capabilitySchema, { maxItems: MAX_REQUESTED_CAPABILITIES })),
	budget: Type.Optional(Type.Object({
		maxModelTurns: Type.Optional(Type.Integer({ minimum: 1, maximum: MULTI_AGENT_HARD_LIMITS.maxModelTurnsPerAgent })),
		maxToolCalls: Type.Optional(Type.Integer({ minimum: 1, maximum: MULTI_AGENT_HARD_LIMITS.maxToolCallsPerAgent })),
		maxActiveDurationMs: Type.Optional(Type.Integer({ minimum: 1, maximum: MULTI_AGENT_HARD_LIMITS.maxActiveDurationMsPerAgent })),
	}, { additionalProperties: false })),
	output: Type.Optional(Type.Object({
		kind: Type.Literal("report"),
		maxBytes: Type.Optional(Type.Integer({ minimum: 1, maximum: MULTI_AGENT_HARD_LIMITS.maxReportBytes })),
	}, { additionalProperties: false })),
}, { additionalProperties: false });

export type SpawnAgentToolInput = Static<typeof spawnAgentSchema>;

export interface SpawnAgentDomainPort {
	spawn(input: ValidatedSpawnSubagentInput, invocation: SubagentInvocationContext): Promise<MultiAgentResult<ChildReport>>;
}

export interface SpawnAgentToolOptions {
	readonly domain: SpawnAgentDomainPort;
	readonly policy: MultiAgentPolicy;
	/** Optional composition assertion; the trusted ToolContext remains authoritative. */
	readonly sessionId?: SessionId;
	readonly rootAgentId: AgentId;
	readonly ownerGeneration: number | (() => number);
}

export interface SpawnAgentToolDetails {
	readonly code?: string;
	readonly message?: string;
	readonly report?: ChildReport;
}

export function createSpawnAgentTool(options: SpawnAgentToolOptions): AgentTool<typeof spawnAgentSchema, SpawnAgentToolDetails> {
	return {
		name: "spawn_agent",
		label: "spawn_agent",
		description: "启动一个有界、只读的子 Agent 并等待其结构化报告。",
		parameters: spawnAgentSchema,
		isConcurrencySafe: () => false,
		isDestructive: () => false,
		execute: async (toolCallId, params, signal, _onUpdate, context): Promise<AgentToolResult<SpawnAgentToolDetails>> => {
			const trusted = trustedInvocation(options, toolCallId, signal, context);
			if (!trusted.ok) return toolError(trusted.error.code, trusted.error.message);
			const validated = validateSpawnSubagentRequest(params, options.policy);
			if (!validated.ok) return toolError(validated.error.code, validated.error.message);
			const result = await options.domain.spawn(validated.value, trusted.value);
			if (!result.ok) return toolError(result.error.code, result.error.message);
			return {
				content: [{ type: "text", text: JSON.stringify(result.value) }],
				details: { report: result.value },
			};
		},
	};
}

function trustedInvocation(
	options: SpawnAgentToolOptions,
	toolCallId: string,
	signal: AbortSignal | undefined,
	context: ToolContext | undefined,
): MultiAgentResult<SubagentInvocationContext> {
	if (context === undefined) return { ok: false, error: { code: "invalid_request", message: "spawn_agent requires trusted ToolContext" } };
	if (!isRuntimeId(context.sessionId, "session") || (options.sessionId !== undefined && context.sessionId !== options.sessionId)) {
		return { ok: false, error: { code: "invalid_request", message: "spawn_agent ToolContext session identity is invalid" } };
	}
	if (context.toolCallId.length === 0 || context.toolCallId !== toolCallId && toolCallId.length === 0) {
		return { ok: false, error: { code: "invalid_request", message: "spawn_agent ToolContext tool identity is invalid" } };
	}
	const trustedToolCallId = context.toolCallId as ToolCallId;
	const ownerGeneration = typeof options.ownerGeneration === "function" ? options.ownerGeneration() : options.ownerGeneration;
	if (!Number.isSafeInteger(ownerGeneration) || ownerGeneration < 1) {
		return { ok: false, error: { code: "runtime_unavailable", message: "spawn_agent owner generation is unavailable" } };
	}
	return {
		ok: true,
		value: {
			sessionId: context.sessionId as SessionId,
			ownerGeneration,
			rootAgentId: options.rootAgentId,
			parentAgentId: options.rootAgentId,
			source: "model_tool",
			effectId: deriveToolEffectId(context.sessionId as SessionId, trustedToolCallId),
			toolCallId: trustedToolCallId,
			signal: signal ?? context.signal,
		},
	};
}

export function deriveToolEffectId(sessionId: SessionId, toolCallId: string): string {
	return `effect_${runtimeDigest({ scope: "agent.spawn", sessionId, toolCallId }).digest}`;
}

function toolError(code: string, message: string): AgentToolResult<SpawnAgentToolDetails> {
	return {
		content: [{ type: "text", text: `${code}: ${message}` }],
		details: { code, message },
		isError: true,
	};
}
