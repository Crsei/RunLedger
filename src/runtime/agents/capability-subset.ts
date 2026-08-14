/** Session production tool 来源到 child 只读 capability 的受限投影。 */

import { runtimeDigest, type RuntimeDigest } from "../protocol/foundation.ts";
import { createRuntimeId, type SessionId } from "../protocol/ids.ts";
import type { ExecutionEnv } from "../execution-env.ts";
import type {
	AgentTool,
	AgentToolCall,
	AgentContext,
	AssistantAgentMessage,
	ToolAuthorizationPolicy,
} from "../types.ts";
import type { MultiAgentResult, SubagentCapability } from "./types.ts";
import { SUBAGENT_CAPABILITIES } from "./types.ts";

export const CHILD_CAPABILITY_TOOL_NAMES: Readonly<Record<SubagentCapability, readonly string[]>> = Object.freeze({
	"workspace.read": Object.freeze(["read"]),
	"workspace.search": Object.freeze(["grep", "find", "glob"]),
	"workspace.list": Object.freeze(["ls"]),
});

export interface SessionProductionToolSource {
	readonly origin: "session-production";
	readonly sessionId: SessionId;
	readonly cwd: string;
	readonly executionEnv: ExecutionEnv;
	readonly authorizationPolicy: ToolAuthorizationPolicy;
	readonly tools: readonly AgentTool[];
}

export interface ChildCapabilitySubset {
	readonly sessionId: SessionId;
	readonly cwd: string;
	readonly executionEnv: ExecutionEnv;
	readonly authorizationPolicy: ToolAuthorizationPolicy;
	readonly capabilities: readonly SubagentCapability[];
	readonly tools: readonly AgentTool[];
	readonly toolManifestDigest: RuntimeDigest;
}

const registeredProductionSources = new WeakSet<object>();

/** 只有 Session Domain production composition 应调用此注册函数。 */
export function createSessionProductionToolSource(input: Omit<SessionProductionToolSource, "origin">): SessionProductionToolSource {
	const source = Object.freeze({ origin: "session-production" as const, ...input });
	registeredProductionSources.add(source);
	return source;
}

export async function deriveGovernedChildCapabilitySubset(
	source: unknown,
	requestedCapabilities: readonly SubagentCapability[],
): Promise<MultiAgentResult<ChildCapabilitySubset>> {
	if (!isRegisteredProductionSource(source)) return failure("runtime_unavailable", "child tools must come from the registered Session production composition");
	const capabilities = normalizeCapabilities(requestedCapabilities);
	if (!capabilities.ok) return capabilities;

	const tools: AgentTool[] = [];
	for (const capability of capabilities.value) {
		for (const name of CHILD_CAPABILITY_TOOL_NAMES[capability]) {
			const tool = source.tools.find((candidate) => candidate.name === name);
			if (tool === undefined) return failure("runtime_unavailable", `production child tool is unavailable: ${name}`);
			if (tools.some((candidate) => candidate.name === tool.name)) continue;
			if (!isReadOnlyTool(tool)) return failure("runtime_unavailable", `child tool is not explicitly read-only: ${name}`);
			if (!hasRepositoryReadClaim(tool)) return failure("runtime_unavailable", `child tool has no compatible repository_read claim: ${name}`);
			const authorization = await authorizeForSubset(source.authorizationPolicy, source.sessionId, tool);
			if (!authorization.ok) return authorization;
			tools.push(tool);
		}
	}

	return {
		ok: true,
		value: Object.freeze({
			sessionId: source.sessionId,
			cwd: source.cwd,
			executionEnv: source.executionEnv,
			authorizationPolicy: source.authorizationPolicy,
			capabilities: Object.freeze(capabilities.value),
			tools: Object.freeze(tools),
			toolManifestDigest: runtimeDigest(tools.map((tool) => ({
				name: tool.name,
				description: tool.description,
				parameters: tool.parameters,
			}))),
		}),
	};
}

function normalizeCapabilities(value: readonly SubagentCapability[]): MultiAgentResult<readonly SubagentCapability[]> {
	const candidates = value.length === 0 ? [...SUBAGENT_CAPABILITIES] : [...value];
	const normalized: SubagentCapability[] = [];
	for (const capability of candidates) {
		if (!(SUBAGENT_CAPABILITIES as readonly string[]).includes(capability)) {
			return failure("invalid_request", `unsupported child capability: ${String(capability)}`);
		}
		if (!normalized.includes(capability)) normalized.push(capability);
	}
	return { ok: true, value: Object.freeze(normalized) };
}

function isReadOnlyTool(tool: AgentTool): boolean {
	try {
		return tool.isReadOnly?.() === true;
	} catch {
		return false;
	}
}

function hasRepositoryReadClaim(tool: AgentTool): boolean {
	return tool.capabilityClaims?.some((claim) =>
		claim.name === "repository_read" &&
		claim.resourceKind === "filesystem" &&
		claim.scope === "invocation",
	) === true;
}

async function authorizeForSubset(
	policy: ToolAuthorizationPolicy,
	sessionId: SessionId,
	tool: AgentTool,
): Promise<MultiAgentResult<void>> {
	const toolCallId = createRuntimeId("toolCall", `child-capability-${tool.name}`);
	const toolCall = {
		type: "toolCall" as const,
		id: toolCallId,
		name: tool.name,
		arguments: {},
	} as AgentToolCall;
	const assistantMessage: AssistantAgentMessage = {
		role: "assistant",
		content: [],
		stopReason: "stop",
	};
	const context: AgentContext = { messages: [], tools: [tool] };
	const decision = await policy.authorize({
		assistantMessage,
		toolCall,
		args: {},
		tool,
		context,
	}, new AbortController().signal);
	if (decision.decision !== "allow") return failure("runtime_unavailable", `Session Security denied child tool ${tool.name}: ${decision.reason}`);
	void sessionId;
	return { ok: true, value: undefined };
}

function isRegisteredProductionSource(value: unknown): value is SessionProductionToolSource {
	return typeof value === "object" && value !== null && registeredProductionSources.has(value);
}

function failure<T>(code: "invalid_request" | "runtime_unavailable", message: string): MultiAgentResult<T> {
	return { ok: false, error: { code, message } };
}
