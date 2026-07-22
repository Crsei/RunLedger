/** Model route -> governed context -> provider request 的唯一生产准备路径。 */

import { canonicalDigest } from "../protocol/v3/canonical-json.ts";
import type { CapabilityClaim } from "../protocol/v3/capability.ts";
import type { ExpectedRevision } from "../protocol/v3/events.ts";
import {
	createRuntimeId,
	type AuthorityId,
	type ContextRequestId,
	type PrincipalId,
	type ResourceId,
	type SessionId,
	type TenantId,
	type TraceId,
	type TurnId,
} from "../protocol/v3/ids.ts";
import type { DeclassificationReceiptRef, InputSourceRef } from "../protocol/v3/taint.ts";
import type { WorkspaceBindingRef } from "../protocol/v3/workspace.ts";
import {
	ContextEngine,
	type AssembledContext,
} from "../context/context-engine.ts";
import { projectContext } from "../context/projection.ts";
import {
	MAX_CONTEXT_FRAGMENTS,
	MAX_CONTEXT_TOKENS,
	MAX_CONTEXT_TOTAL_CHARS,
} from "../context/schema.ts";
import type {
	ContextAssemblyBudget,
	ContextAssemblyReceipt,
	ContextFragment,
} from "../context/types.ts";
import type {
	ModelCapabilityAlias,
	ModelRouteDecision,
	ModelRouteRequest,
} from "../model-routing/types.ts";
import type {
	AgentMessage,
	LlmContext,
	ModelRequestPreparationInput,
	ModelRequestPreparationResult,
} from "../types.ts";
import type { Api, Model } from "../../types.ts";

export interface GovernedModelIdentity {
	authorityId: AuthorityId;
	tenantId: TenantId;
	principalId: PrincipalId;
	sessionId: SessionId;
}

export interface GovernedModelRequestEventPort {
	recordModelRoute(turnId: TurnId, decision: ModelRouteDecision): Promise<void>;
	recordContextAssembly(receipt: ContextAssemblyReceipt): Promise<void>;
}

/** 允许 production catalog 按请求装载有界 manifest；行为仍由同一 router contract 决定。 */
export interface ModelCompatibilityRoutePort {
	route(request: ModelRouteRequest): ModelRouteDecision;
}

export interface GovernedContextFragmentRequest {
	input: ModelRequestPreparationInput;
	contextRequestId: ContextRequestId;
	sessionId: SessionId;
	route: Extract<ModelRouteDecision, { outcome: "compatible" }>;
	traceId: TraceId;
}

export interface GovernedContextFragmentResult {
	fragments: readonly ContextFragment[];
	/** 非空原始 systemPrompt 必须被且仅被一个 provider 显式收编。 */
	consumedSystemPromptDigest?: string;
}

export interface GovernedContextFragmentProvider {
	load(
		request: GovernedContextFragmentRequest,
		signal?: AbortSignal,
	): GovernedContextFragmentResult | Promise<GovernedContextFragmentResult>;
}

export interface ModelRouteLineage {
	inputSources: readonly InputSourceRef[];
	declassificationReceipts: readonly DeclassificationReceiptRef[];
}

export interface GovernedModelRequestCoordinatorOptions {
	identity: GovernedModelIdentity;
	router: ModelCompatibilityRoutePort;
	events: GovernedModelRequestEventPort;
	expectedRevision: () => ExpectedRevision;
	fragmentProviders: readonly GovernedContextFragmentProvider[];
	resolveModel?: (modelId: string) => Model<Api> | undefined;
	modelId?: (model: Model<Api>) => string;
	alias?: ModelCapabilityAlias | ((input: ModelRequestPreparationInput) => ModelCapabilityAlias);
	requiredCapabilities?: readonly CapabilityClaim[] | ((input: ModelRequestPreparationInput) => readonly CapabilityClaim[]);
	routeLineage?: ModelRouteLineage | ((input: ModelRequestPreparationInput) => ModelRouteLineage);
	workspace?: WorkspaceBindingRef;
	contextEngine?: ContextEngine;
	contextBudget?: (model: Model<Api>, input: ModelRequestPreparationInput) => ContextAssemblyBudget;
	traceIdFactory?: () => TraceId;
	onForkRequired?: (decision: Extract<ModelRouteDecision, { outcome: "fork" }>) => Promise<void> | void;
}

export class GovernedModelRequestError extends Error {
	public readonly code:
		| "missing_turn_identity"
		| "route_denied"
		| "fork_required"
		| "model_unresolved"
		| "system_prompt_unclassified"
		| "duplicate_fragment"
		| "invalid_scope";

	public constructor(code: GovernedModelRequestError["code"], message: string) {
		super(message);
		this.name = "GovernedModelRequestError";
		this.code = code;
	}
}

function modelKey(model: Model<Api>): string {
	return `${model.provider}/${model.id}`;
}

function approximateTokens(value: string): number {
	return Math.max(0, Math.ceil(value.length / 4));
}

function defaultContextBudget(model: Model<Api>, input: ModelRequestPreparationInput): ContextAssemblyBudget {
	const contextWindowTokens = Math.max(1, Math.min(MAX_CONTEXT_TOKENS, Math.trunc(model.contextWindow)));
	const toolChars = JSON.stringify((input.context.tools ?? []).map((tool) => ({ name: tool.name, parameters: tool.parameters }))).length;
	let providerSafetyTokens = Math.min(1_024, Math.floor(contextWindowTokens * 0.02));
	let reservedToolSchemaTokens = Math.min(approximateTokens("x".repeat(toolChars)), Math.floor(contextWindowTokens * 0.1));
	let reservedOutputTokens = Math.min(Math.max(0, Math.trunc(model.maxTokens)), Math.floor(contextWindowTokens * 0.25));
	while (providerSafetyTokens + reservedToolSchemaTokens + reservedOutputTokens >= contextWindowTokens) {
		if (reservedOutputTokens > 0) reservedOutputTokens -= 1;
		else if (reservedToolSchemaTokens > 0) reservedToolSchemaTokens -= 1;
		else if (providerSafetyTokens > 0) providerSafetyTokens -= 1;
		else break;
	}
	return {
		contextWindowTokens,
		reservedOutputTokens,
		reservedToolSchemaTokens,
		providerSafetyTokens,
		maxFragments: MAX_CONTEXT_FRAGMENTS,
		maxTotalChars: MAX_CONTEXT_TOTAL_CHARS,
	};
}

function hasToolReplay(messages: readonly AgentMessage[]): boolean {
	return messages.some((message) => message.role === "toolResult");
}

function hasReasoningReplay(messages: readonly AgentMessage[]): boolean {
	return messages.some((message) =>
		message.role === "assistant" && message.content.some((content) => content.type === "thinking"),
	);
}

function hasImages(context: LlmContext): boolean {
	return context.messages.some((message) =>
		"content" in message && Array.isArray(message.content) && message.content.some((content) => content.type === "image"),
	);
}

function requiredTokens(context: LlmContext): number {
	return approximateTokens(`${context.systemPrompt ?? ""}\n${JSON.stringify(context.messages)}`);
}

function scopeMatches(identity: GovernedModelIdentity, value: { authorityId: string; tenantId: string }): boolean {
	return identity.authorityId === value.authorityId && identity.tenantId === value.tenantId;
}

function assertScope(
	identity: GovernedModelIdentity,
	capabilities: readonly CapabilityClaim[],
	lineage: ModelRouteLineage,
	workspace?: WorkspaceBindingRef,
): void {
	if (
		capabilities.some((claim) => !scopeMatches(identity, claim)) ||
		lineage.inputSources.some((source) => !scopeMatches(identity, source)) ||
		lineage.declassificationReceipts.some((receipt) => !scopeMatches(identity, receipt)) ||
		(workspace !== undefined && !scopeMatches(identity, workspace))
	) throw new GovernedModelRequestError("invalid_scope", "model request inputs cross authority or tenant scope");
}

function routeRequest(
	identity: GovernedModelIdentity,
	input: ModelRequestPreparationInput,
	options: {
		modelId: string;
		alias: ModelCapabilityAlias;
		currentProfileId?: ResourceId;
		requiredCapabilities: readonly CapabilityClaim[];
		lineage: ModelRouteLineage;
		workspace?: WorkspaceBindingRef;
		expectedRevision: ExpectedRevision;
	},
): ModelRouteRequest {
	const seed = canonicalDigest({
		sessionId: identity.sessionId,
		turnId: input.turnId,
		modelRequestId: input.modelRequestId ?? null,
		modelId: options.modelId,
	});
	return {
		schemaVersion: 1,
		authorityId: identity.authorityId,
		tenantId: identity.tenantId,
		principalId: identity.principalId,
		requestId: createRuntimeId("command", `model-route-${seed.slice(0, 48)}`),
		sessionId: identity.sessionId,
		operation: "switch",
		alias: options.alias,
		...(options.currentProfileId ? { fromProfileId: options.currentProfileId } : {}),
		targetModelId: options.modelId,
		requiredContextTokens: requiredTokens(input.context),
		requiredOutputTokens: Math.max(0, Math.trunc(input.model.maxTokens)),
		requiresToolReplay: hasToolReplay(input.messages),
		requiresReasoningReplay: hasReasoningReplay(input.messages),
		requiresImages: hasImages(input.context),
		requiredCapabilities: options.requiredCapabilities,
		inputSources: options.lineage.inputSources,
		declassificationReceipts: options.lineage.declassificationReceipts,
		...(options.workspace ? { workspace: options.workspace } : {}),
		expectedRevision: options.expectedRevision,
	};
}

function contextSystemPrompt(assembled: AssembledContext): string | undefined {
	const projected = projectContext(assembled.fragments).content;
	return projected.length === 0 ? undefined : projected;
}

export class GovernedModelRequestCoordinator {
	readonly #identity: GovernedModelIdentity;
	readonly #router: ModelCompatibilityRoutePort;
	readonly #events: GovernedModelRequestEventPort;
	readonly #expectedRevision: () => ExpectedRevision;
	readonly #fragmentProviders: readonly GovernedContextFragmentProvider[];
	readonly #resolveModel?: GovernedModelRequestCoordinatorOptions["resolveModel"];
	readonly #modelId: NonNullable<GovernedModelRequestCoordinatorOptions["modelId"]>;
	readonly #alias: NonNullable<GovernedModelRequestCoordinatorOptions["alias"]>;
	readonly #requiredCapabilities: NonNullable<GovernedModelRequestCoordinatorOptions["requiredCapabilities"]>;
	readonly #routeLineage: NonNullable<GovernedModelRequestCoordinatorOptions["routeLineage"]>;
	readonly #workspace?: WorkspaceBindingRef;
	readonly #contextEngine: ContextEngine;
	readonly #contextBudget: NonNullable<GovernedModelRequestCoordinatorOptions["contextBudget"]>;
	readonly #traceIdFactory: () => TraceId;
	readonly #onForkRequired?: GovernedModelRequestCoordinatorOptions["onForkRequired"];
	#currentProfileId: ResourceId | undefined;

	public constructor(options: GovernedModelRequestCoordinatorOptions) {
		this.#identity = options.identity;
		this.#router = options.router;
		this.#events = options.events;
		this.#expectedRevision = options.expectedRevision;
		this.#fragmentProviders = options.fragmentProviders;
		this.#resolveModel = options.resolveModel;
		this.#modelId = options.modelId ?? modelKey;
		this.#alias = options.alias ?? "builder";
		this.#requiredCapabilities = options.requiredCapabilities ?? [];
		this.#routeLineage = options.routeLineage ?? { inputSources: [], declassificationReceipts: [] };
		this.#workspace = options.workspace;
		this.#contextEngine = options.contextEngine ?? new ContextEngine();
		this.#contextBudget = options.contextBudget ?? defaultContextBudget;
		this.#traceIdFactory = options.traceIdFactory ?? (() => createRuntimeId("trace"));
		this.#onForkRequired = options.onForkRequired;
	}

	public async prepare(
		input: ModelRequestPreparationInput,
		signal?: AbortSignal,
	): Promise<ModelRequestPreparationResult> {
		if (!input.turnId) {
			throw new GovernedModelRequestError("missing_turn_identity", "governed model preparation requires a durable turn id");
		}
		const alias = typeof this.#alias === "function" ? this.#alias(input) : this.#alias;
		const capabilities = typeof this.#requiredCapabilities === "function"
			? this.#requiredCapabilities(input)
			: this.#requiredCapabilities;
		const lineage = typeof this.#routeLineage === "function" ? this.#routeLineage(input) : this.#routeLineage;
		assertScope(this.#identity, capabilities, lineage, this.#workspace);
		const request = routeRequest(this.#identity, input, {
			modelId: this.#modelId(input.model),
			alias,
			...(this.#currentProfileId ? { currentProfileId: this.#currentProfileId } : {}),
			requiredCapabilities: capabilities,
			lineage,
			...(this.#workspace ? { workspace: this.#workspace } : {}),
			expectedRevision: this.#expectedRevision(),
		});
		const decision = this.#router.route(request);
		await this.#events.recordModelRoute(input.turnId, decision);
		if (decision.outcome === "deny") {
			throw new GovernedModelRequestError("route_denied", decision.reason);
		}
		if (decision.outcome === "fork") {
			await this.#onForkRequired?.(decision);
			throw new GovernedModelRequestError("fork_required", decision.reason);
		}

		const currentKey = this.#modelId(input.model);
		const selectedModel = decision.targetModelId === currentKey
			? input.model
			: this.#resolveModel?.(decision.targetModelId);
		if (!selectedModel || this.#modelId(selectedModel) !== decision.targetModelId) {
			throw new GovernedModelRequestError("model_unresolved", "routed model cannot be resolved to an exact provider model");
		}
		const contextRequestId = createRuntimeId(
			"contextRequest",
			`model-${canonicalDigest({ route: decision.decisionDigest, turnId: input.turnId }).slice(0, 48)}`,
		);
		const traceId = this.#traceIdFactory();
		const loaded = await Promise.all(this.#fragmentProviders.map((provider) =>
			provider.load({ input, contextRequestId, sessionId: this.#identity.sessionId, route: decision, traceId }, signal),
		));
		const fragments = loaded.flatMap((result) => result.fragments);
		const fragmentIds = new Set(fragments.map((fragment) => fragment.fragmentId));
		if (fragmentIds.size !== fragments.length) {
			throw new GovernedModelRequestError("duplicate_fragment", "context fragment ids must be unique across providers");
		}
		const systemPrompt = input.context.systemPrompt ?? "";
		if (systemPrompt.length > 0) {
			const digest = canonicalDigest(systemPrompt);
			const consumers = loaded.filter((result) => result.consumedSystemPromptDigest === digest).length;
			if (consumers !== 1) {
				throw new GovernedModelRequestError(
					"system_prompt_unclassified",
					"the original system prompt must be classified and consumed by exactly one context provider",
				);
			}
		}
		const assembled = this.#contextEngine.assemble({
			schemaVersion: 1,
			authorityId: this.#identity.authorityId,
			tenantId: this.#identity.tenantId,
			principalId: this.#identity.principalId,
			requestId: contextRequestId,
			sessionId: this.#identity.sessionId,
			modelId: decision.targetModelId,
			modelProfileId: decision.profileId,
			...(this.#workspace ? { workspace: this.#workspace } : {}),
			requiredCapabilities: capabilities,
			budget: this.#contextBudget(selectedModel, input),
			fragments,
		});
		await this.#events.recordContextAssembly(assembled.receipt);
		this.#currentProfileId = decision.profileId;
		return {
			model: selectedModel,
			context: {
				...(contextSystemPrompt(assembled) ? { systemPrompt: contextSystemPrompt(assembled) } : {}),
				messages: input.context.messages,
				tools: input.context.tools,
			},
		};
	}
}
