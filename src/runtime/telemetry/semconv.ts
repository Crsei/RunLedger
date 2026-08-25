/**
 * GenAI 语义约定属性常量(RunLedger 移植版)。
 *
 * 移植自 oh-my-pi `packages/agent/src/telemetry.ts` 的 `const enum` 常量,
 * 按 D7 决策转为 `as const` 对象 + 类型提取,满足 `erasableSyntaxOnly`。
 * 属性命名空间与 oh-my-pi 逐字一致(D1):
 *   - `gen_ai.*`  GenAI 语义约定(https://opentelemetry.io/docs/specs/semconv/gen-ai/)
 *   - `pi.gen_ai.*` 项目扩展属性(run summary / dashboard / cost hint)
 */

/** GenAI semantic-convention attribute keys grouped by operation. */
export const GenAIAttr = {
	// Common identifiers
	ProviderName: "gen_ai.provider.name",
	OperationName: "gen_ai.operation.name",
	ConversationId: "gen_ai.conversation.id",
	OutputType: "gen_ai.output.type",
	// Agent identity
	AgentId: "gen_ai.agent.id",
	AgentName: "gen_ai.agent.name",
	AgentDescription: "gen_ai.agent.description",
	// Request shape
	RequestModel: "gen_ai.request.model",
	RequestMaxTokens: "gen_ai.request.max_tokens",
	RequestTemperature: "gen_ai.request.temperature",
	RequestTopP: "gen_ai.request.top_p",
	RequestTopK: "gen_ai.request.top_k",
	RequestFrequencyPenalty: "gen_ai.request.frequency_penalty",
	RequestPresencePenalty: "gen_ai.request.presence_penalty",
	RequestStopSequences: "gen_ai.request.stop_sequences",
	RequestSeed: "gen_ai.request.seed",
	RequestChoiceCount: "gen_ai.request.choice.count",
	RequestStream: "gen_ai.request.stream",
	// Response shape
	ResponseModel: "gen_ai.response.model",
	ResponseId: "gen_ai.response.id",
	ResponseFinishReasons: "gen_ai.response.finish_reasons",
	ResponseTimeToFirstChunk: "gen_ai.response.time_to_first_chunk",
	// Usage
	UsageInputTokens: "gen_ai.usage.input_tokens",
	UsageOutputTokens: "gen_ai.usage.output_tokens",
	UsageCacheReadInputTokens: "gen_ai.usage.cache_read.input_tokens",
	UsageCacheCreationInputTokens: "gen_ai.usage.cache_creation.input_tokens",
	UsageReasoningOutputTokens: "gen_ai.usage.reasoning.output_tokens",
	// Tools
	ToolCallId: "gen_ai.tool.call.id",
	ToolName: "gen_ai.tool.name",
	ToolDescription: "gen_ai.tool.description",
	ToolType: "gen_ai.tool.type",
	ToolCallArguments: "gen_ai.tool.call.arguments",
	ToolCallResult: "gen_ai.tool.call.result",
	ToolDefinitions: "gen_ai.tool.definitions",
	// Content capture (opt-in)
	InputMessages: "gen_ai.input.messages",
	OutputMessages: "gen_ai.output.messages",
	SystemInstructions: "gen_ai.system_instructions",
	// Errors
	ErrorType: "error.type",
} as const;

export type GenAIAttr = (typeof GenAIAttr)[keyof typeof GenAIAttr];

/** OpenAI semantic-convention attribute keys. */
export const OpenAIAttr = {
	RequestServiceTier: "openai.request.service_tier",
	ResponseServiceTier: "openai.response.service_tier",
} as const;

export type OpenAIAttr = (typeof OpenAIAttr)[keyof typeof OpenAIAttr];

/** Project extension attributes. Kept out of the reserved `gen_ai.*` namespace. */
export const PiGenAIAttr = {
	AgentStepNumber: "pi.gen_ai.agent.step.number",
	AgentStepCount: "pi.gen_ai.agent.step.count",
	RequestReasoningEffort: "pi.gen_ai.request.reasoning.effort",
	RequestToolChoice: "pi.gen_ai.request.tool.choice",
	RequestAvailableTools: "pi.gen_ai.request.available_tools",
	RequestMessages: "pi.gen_ai.request.messages",
	ResponseText: "pi.gen_ai.response.text",
	ResponseToolCalls: "pi.gen_ai.response.tool_calls",
	ResponseUpstreamProvider: "pi.gen_ai.response.upstream_provider",
	UsageTotalTokens: "pi.gen_ai.usage.total_tokens",
	UsageServerSideTools: "pi.gen_ai.usage.server_tool_requests",
	CostEstimatedUsd: "pi.gen_ai.cost.estimated_usd",
	CostInputUsd: "pi.gen_ai.cost.input_usd",
	CostOutputUsd: "pi.gen_ai.cost.output_usd",
	CostUnavailableReason: "pi.gen_ai.cost.unavailable_reason",
	ToolStatus: "pi.gen_ai.tool.status",
	ToolCallIntent: "pi.gen_ai.tool.call.intent",
	HandoffFromAgentName: "pi.gen_ai.handoff.from_agent.name",
	HandoffFromAgentId: "pi.gen_ai.handoff.from_agent.id",
	HandoffToAgentName: "pi.gen_ai.handoff.to_agent.name",
	HandoffToAgentId: "pi.gen_ai.handoff.to_agent.id",
	// Marks chat spans emitted outside the agent loop (compaction, handoff, branch
	// summary, image inspection, …). Lets dashboards split oneshot cost / latency
	// from main-turn cost without overloading the semconv `gen_ai.operation.name`.
	OneshotKind: "pi.gen_ai.oneshot.kind",
	// Gateway / proxy (LiteLLM, Helicone, Portkey, …) — populated when a known
	// gateway header pattern is detected on the upstream response. The base
	// `gen_ai.provider.name` continues to track the *upstream* provider (e.g.
	// `anthropic`) that the gateway routed to.
	GatewayName: "pi.gen_ai.gateway.name",
	GatewayEndpoint: "pi.gen_ai.gateway.endpoint",
	GatewayCallId: "pi.gen_ai.gateway.call_id",
	GatewayRoutedTo: "pi.gen_ai.gateway.routed_to",
	/** Cloudflare AI Gateway response-cache status (`cf-aig-cache-status`), never prompt-cache. */
	GatewayResponseCacheStatus: "pi.gen_ai.gateway.response_cache.status",
} as const;

export type PiGenAIAttr = (typeof PiGenAIAttr)[keyof typeof PiGenAIAttr];

/** Aggregate `pi.gen_ai.agent.*` attributes stamped on the `invoke_agent` span. */
export const PiGenAIAggregateAttr = {
	ChatsCount: "pi.gen_ai.agent.chats.count",
	ChatsTotalLatencyMs: "pi.gen_ai.agent.chats.total_latency_ms",
	ChatsStopReasonPrefix: "pi.gen_ai.agent.chats.stop_reason.",
	ToolsCount: "pi.gen_ai.agent.tools.count",
	ToolsOkCount: "pi.gen_ai.agent.tools.ok.count",
	ToolsErrorCount: "pi.gen_ai.agent.tools.error.count",
	ToolsSkippedCount: "pi.gen_ai.agent.tools.skipped.count",
	ToolsBlockedCount: "pi.gen_ai.agent.tools.blocked.count",
	ToolsTimeoutCount: "pi.gen_ai.agent.tools.timeout.count",
	ToolsAbortedCount: "pi.gen_ai.agent.tools.aborted.count",
	ToolsTotalLatencyMs: "pi.gen_ai.agent.tools.total_latency_ms",
	ToolsInvoked: "pi.gen_ai.agent.tools.invoked",
	ToolsAvailable: "pi.gen_ai.agent.tools.available",
	ToolsUnused: "pi.gen_ai.agent.tools.unused",
	UsageInputTokensTotal: "pi.gen_ai.agent.usage.input_tokens.total",
	UsageOutputTokensTotal: "pi.gen_ai.agent.usage.output_tokens.total",
	UsageCacheReadInputTokensTotal: "pi.gen_ai.agent.usage.cache_read.input_tokens.total",
	UsageCacheCreationInputTokensTotal: "pi.gen_ai.agent.usage.cache_creation.input_tokens.total",
	UsageReasoningOutputTokensTotal: "pi.gen_ai.agent.usage.reasoning.output_tokens.total",
	UsageTotalTokensTotal: "pi.gen_ai.agent.usage.total_tokens.total",
	CostEstimatedUsdTotal: "pi.gen_ai.agent.cost.estimated_usd.total",
	ErrorsCount: "pi.gen_ai.agent.errors.count",
} as const;

export type PiGenAIAggregateAttr = (typeof PiGenAIAggregateAttr)[keyof typeof PiGenAIAggregateAttr];

/** GenAI operation names — values for {@link GenAIAttr.OperationName}. */
export const GenAIOperation = {
	Chat: "chat",
	ExecuteTool: "execute_tool",
	InvokeAgent: "invoke_agent",
	Handoff: "handoff",
	GenerateContent: "generate_content",
	TextCompletion: "text_completion",
	CreateAgent: "create_agent",
	Embeddings: "embeddings",
} as const;

export type GenAIOperationName = (typeof GenAIOperation)[keyof typeof GenAIOperation];
