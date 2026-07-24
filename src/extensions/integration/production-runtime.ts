/** ExtensionManager 到共享 Agent Runtime 的生产组合桥。 */

import { Type, type TSchema } from "typebox";
import { canonicalDigest, canonicalJson } from "../../runtime/protocol/v3/canonical-json.ts";
import { createRuntimeId } from "../../runtime/protocol/v3/ids.ts";
import type { AgentTool, AgentToolResult, ToolExecutionAuthorizationGrant, ToolExecutionAuthorizationResult, ToolExecutionGatewayPort, ToolExecutionGatewayRequest } from "../../runtime/types.ts";
import type { ToolContext } from "../../runtime/tool-context.ts";
import type { Tool } from "../../types.ts";
import type { ToolRegistry } from "../../runtime/tool-registry.ts";
import { validateToolArguments } from "../../utils/validation.ts";
import { hookRunAudit } from "../hooks/audit.ts";
import type { HookDispatchResult, HookEnvelope, HookEvent } from "../hooks/types.ts";
import type { McpManagerResult } from "../mcp/connection-manager.ts";
import type { McpNormalizedResult, McpToolDefinition } from "../mcp/types.ts";
import { skillInvocationAudit } from "../skills/audit.ts";
import type { SkillLoadResult } from "../skills/skill-tool.ts";
import type { SkillDescriptor, SkillTrigger } from "../skills/types.ts";
import { buildExtensionSnapshot, type ExtensionSnapshot } from "../snapshot.ts";
import type {
	ExtensionLifecycleAudit,
	ExtensionResourceDescriptor,
	ExtensionSource,
} from "../types.ts";
import { snapshotAudit } from "./runtime-audit-adapter.ts";

const EXTENSION_TOOL_NAMESPACE = "extensions";

const SkillInputSchema = Type.Object({
	name: Type.String({ minLength: 1, maxLength: 512 }),
	argument: Type.Optional(Type.String({ maxLength: 32_768 })),
}, { additionalProperties: false });

const McpSearchInputSchema = Type.Object({
	query: Type.String({ maxLength: 8_192 }),
	limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
}, { additionalProperties: false });

const McpCallInputSchema = Type.Object({
	serverId: Type.String({ minLength: 1, maxLength: 1_024 }),
	toolName: Type.String({ minLength: 1, maxLength: 256 }),
	input: Type.Unknown(),
}, { additionalProperties: false });

export interface ProductionExtensionMcpCatalogPort {
	list(): readonly McpToolDefinition[];
	pinned(): readonly McpToolDefinition[];
}

export interface ProductionExtensionMcpPort {
	search(query: string, limit?: number): readonly McpToolDefinition[];
	call(serverId: string, rawToolName: string, input: unknown, signal?: AbortSignal): Promise<McpManagerResult<McpNormalizedResult>>;
	catalog(): ProductionExtensionMcpCatalogPort;
}

export interface ProductionExtensionSkillCatalogPort {
	list(): readonly SkillDescriptor[];
}

export interface ProductionExtensionHookDispatcherPort {
	dispatch(envelope: HookEnvelope, signal?: AbortSignal): Promise<HookDispatchResult>;
}

export interface ProductionExtensionManagerSnapshot {
	snapshot: ExtensionSnapshot;
	skills: readonly SkillDescriptor[];
	hooks: readonly import("../hooks/types.ts").HookDescriptor[];
	skillCatalog: ProductionExtensionSkillCatalogPort;
	hookDispatcher: ProductionExtensionHookDispatcherPort;
	mcp: ProductionExtensionMcpPort;
}

export type ProductionExtensionReloadResult =
	| { status: "applied"; current: ProductionExtensionManagerSnapshot }
	| { status: "pending"; current?: ProductionExtensionManagerSnapshot }
	| { status: "failed"; reason: string; retained?: ProductionExtensionManagerSnapshot };

/** ExtensionManager 的最小结构端口，测试与生产都不需要触碰其私有状态。 */
export interface ProductionExtensionManagerPort {
	current(): ProductionExtensionManagerSnapshot | undefined;
	beginTurn(): ProductionExtensionManagerSnapshot;
	endTurn(): Promise<ProductionExtensionReloadResult | undefined>;
	requestReload(): ProductionExtensionReloadResult;
	reload(signal?: AbortSignal): Promise<ProductionExtensionReloadResult>;
	close(): Promise<void>;
}

export interface ProductionExtensionSkillResolverPort {
	load(value: string, trigger?: SkillTrigger): Promise<SkillLoadResult>;
}

export interface V2ExtensionLedgerAuditPort {
	mode: "v2";
	appendCustom(audit: ExtensionLifecycleAudit): Promise<boolean>;
}

export interface V3ExtensionCanonicalAuditPort {
	mode: "v3";
	appendCanonical(audit: ExtensionLifecycleAudit): Promise<boolean>;
}

/** 判别式 union 防止 v3 session 同时向 v2 与 v3 双写。 */
export type ProductionExtensionAuditPort = V2ExtensionLedgerAuditPort | V3ExtensionCanonicalAuditPort;

export interface ProductionExtensionWatcherPort {
	start(paths: readonly string[]): Promise<void>;
	close(): Promise<void>;
}

export interface ProductionExtensionCloserPort {
	close(): Promise<void>;
}

export interface ProductionExtensionRuntimeOptions {
	manager: ProductionExtensionManagerPort;
	registry: ToolRegistry;
	gateway: ToolExecutionGatewayPort;
	audit: ProductionExtensionAuditPort;
	sessionId: string;
	cwd: string;
	source?: ExtensionSource;
	namespace?: string;
	createSkillResolver?: (snapshot: ProductionExtensionManagerSnapshot) => ProductionExtensionSkillResolverPort;
	watcher?: ProductionExtensionWatcherPort;
	watchPaths?: readonly string[];
	pluginRuntime?: ProductionExtensionCloserPort;
	hookRuntime?: ProductionExtensionCloserPort;
	now?: () => Date;
}

export interface ProductionExtensionCatalog {
	snapshotId: ExtensionSnapshot["snapshotId"];
	generation: number;
	createdAt: string;
	/** TUI/CLI 只读投影；执行仍只按 exact identity + active generation 路由。 */
	resources: readonly ExtensionResourceDescriptor[];
	skills: readonly SkillDescriptor[];
	mcpTools: readonly McpToolDefinition[];
	pinnedTools: readonly McpToolDefinition[];
	diagnostics: ExtensionSnapshot["diagnostics"];
	counts: ExtensionSnapshot["counts"];
}

export type ProductionExtensionStartResult =
	| { status: "ready"; snapshotId: ExtensionSnapshot["snapshotId"]; generation: number }
	| { status: "failed"; reason: string };

export type ProductionHookPhaseResult =
	| {
		status: "allowed";
		input: unknown;
		additionalContext?: string;
		dispatch: HookDispatchResult;
		snapshotId: ExtensionSnapshot["snapshotId"];
		generation: number;
	}
	| {
		status: "blocked";
		reason: string;
		dispatch?: HookDispatchResult;
		snapshotId?: ExtensionSnapshot["snapshotId"];
		generation?: number;
	};

export type ProductionPreToolUseResult =
	| {
		status: "authorized";
		input: unknown;
		grant: ToolExecutionAuthorizationGrant;
		authorization: Extract<ToolExecutionAuthorizationResult, { status: "authorized" }>;
		dispatch: HookDispatchResult;
		snapshotId: ExtensionSnapshot["snapshotId"];
		generation: number;
	}
	| {
		status: "blocked";
		reason: string;
		authorization?: ToolExecutionAuthorizationResult;
		dispatch?: HookDispatchResult;
		snapshotId?: ExtensionSnapshot["snapshotId"];
		generation?: number;
	};

interface ActiveGeneration {
	view: ProductionExtensionManagerSnapshot;
	tools: readonly AgentTool[];
	toolNames: readonly string[];
}

function toolError(message: string, details: Readonly<Record<string, unknown>> = {}): AgentToolResult<Readonly<Record<string, unknown>>> {
	return {
		content: [{ type: "text", text: message }],
		details: { ...details, reason: message },
		isError: true,
		terminate: false,
	};
}

function normalizedMcpContent(result: McpNormalizedResult): AgentToolResult<Readonly<Record<string, unknown>>> {
	const content: AgentToolResult["content"] = [];
	for (const item of result.content) {
		if (item.type === "text" && item.text !== undefined) {
			content.push({ type: "text", text: item.text });
			continue;
		}
		if (item.type === "image" && item.dataBase64 && item.mediaType) {
			content.push({ type: "image", data: item.dataBase64, mimeType: item.mediaType });
			continue;
		}
		content.push({ type: "text", text: canonicalJson(item) });
	}
	if (content.length === 0) content.push({ type: "text", text: "MCP tool returned no content" });
	return {
		content,
		details: {
			contentDigest: result.contentDigest,
			originalBytes: result.originalBytes,
			truncated: result.truncated,
			...(result.spill ? { spill: result.spill } : {}),
		},
		isError: result.isError,
		terminate: false,
	};
}

function validateSnapshotView(view: ProductionExtensionManagerSnapshot, previousGeneration?: number): string | undefined {
	const snapshot = view.snapshot;
	let rebuilt: ExtensionSnapshot;
	try {
		rebuilt = buildExtensionSnapshot({
			snapshotId: snapshot.snapshotId,
			generation: snapshot.generation,
			createdAt: snapshot.createdAt,
			descriptors: snapshot.descriptors,
			diagnostics: snapshot.diagnostics,
		});
	} catch (error) {
		return error instanceof Error ? error.message : "extension snapshot validation failed";
	}
	if (rebuilt.digest !== snapshot.digest || rebuilt.snapshotId !== snapshot.snapshotId || canonicalDigest(rebuilt.counts) !== canonicalDigest(snapshot.counts)) {
		return "extension snapshot digest or counts are invalid";
	}
	if (previousGeneration !== undefined && snapshot.generation <= previousGeneration) {
		return "extension snapshot generation did not increase";
	}
	const descriptors = new Map(snapshot.descriptors.map((descriptor) => [descriptor.identity.qualifiedId, descriptor]));
	for (const skill of view.skills) {
		const descriptor = descriptors.get(skill.descriptor.identity.qualifiedId);
		if (!descriptor || descriptor.kind !== "skill" || descriptor.manifest.combinedDigest !== skill.descriptor.manifest.combinedDigest) return "skill catalog is not bound to the snapshot";
	}
	for (const hook of view.hooks) {
		const descriptor = descriptors.get(hook.descriptor.identity.qualifiedId);
		if (!descriptor || descriptor.kind !== "hook" || descriptor.manifest.combinedDigest !== hook.descriptor.manifest.combinedDigest) return "hook catalog is not bound to the snapshot";
	}
	for (const tool of view.mcp.catalog().pinned()) {
		const descriptor = snapshot.descriptors.find((candidate) => candidate.kind === "mcp-tool" && candidate.runtimeName === tool.runtimeName);
		if (!descriptor || !descriptor.enabled || descriptor.trust !== "trusted" || descriptor.activation !== "ready" || !descriptor.tool) return `pinned MCP tool is not ready in the snapshot: ${tool.runtimeName}`;
	}
	return undefined;
}

function prepareAndValidateToolInput(request: ToolExecutionGatewayRequest, input: unknown): unknown {
	const prepared = request.tool.prepareArguments ? request.tool.prepareArguments(input) : input;
	return validateToolArguments(request.tool as unknown as Tool, {
		type: "toolCall",
		id: request.providerToolCallId,
		name: request.tool.name,
		arguments: prepared as Record<string, unknown>,
	}) as unknown;
}

/**
 * 生产 Extension bridge 只持有一代已验证快照。所有 registry 变更均同步完成，
 * reload 的异步发现发生在交换之前；旧工具对象即使被外部缓存也会被 generation guard 拒绝。
 */
export class ProductionExtensionRuntime {
	readonly #options: ProductionExtensionRuntimeOptions;
	readonly #namespace: string;
	readonly #now: () => Date;
	#active?: ActiveGeneration;
	#state: "new" | "ready" | "failed" | "closing" | "closed" = "new";
	#auditHealthy = true;
	#eventSequence = 0;
	#turns = 0;
	readonly #hookControllers = new Set<AbortController>();
	readonly #hookTasks = new Set<Promise<ProductionHookPhaseResult>>();

	public constructor(options: ProductionExtensionRuntimeOptions) {
		this.#options = options;
		this.#namespace = options.namespace ?? EXTENSION_TOOL_NAMESPACE;
		this.#now = options.now ?? (() => new Date());
	}

	public async start(signal?: AbortSignal): Promise<ProductionExtensionStartResult> {
		if (this.#state === "ready" && this.#active) return { status: "ready", snapshotId: this.#active.view.snapshot.snapshotId, generation: this.#active.view.snapshot.generation };
		if (this.#state !== "new") return { status: "failed", reason: "extension runtime cannot be restarted after shutdown" };
		if (this.#options.audit.mode !== "v3") {
			this.#state = "failed";
			return {
				status: "failed",
				reason: "Extension activation requires governed Runtime v3; v2 supports discovery/list only",
			};
		}
		let current = this.#options.manager.current();
		if (!current) {
			let loaded: ProductionExtensionReloadResult;
			try {
				loaded = await this.#options.manager.reload(signal);
			} catch (error) {
				return { status: "failed", reason: error instanceof Error ? error.message : "extension manager initialization failed" };
			}
			if (loaded.status !== "applied") return { status: "failed", reason: loaded.status === "failed" ? loaded.reason : "extension manager initialization remained pending" };
			current = loaded.current;
		}
		const installed = await this.#install(current);
		if (!installed.ok) {
			this.#failClosed();
			return { status: "failed", reason: installed.reason };
		}
		try {
			if (this.#options.watcher) await this.#options.watcher.start(this.#options.watchPaths ?? []);
		} catch (error) {
			this.#failClosed();
			await this.#options.manager.close().catch(() => undefined);
			return { status: "failed", reason: error instanceof Error ? error.message : "extension watcher failed to start" };
		}
		this.#state = "ready";
		return { status: "ready", snapshotId: current.snapshot.snapshotId, generation: current.snapshot.generation };
	}

	public catalog(): ProductionExtensionCatalog | undefined {
		const current = this.#active?.view;
		if (!current) return undefined;
		return {
			snapshotId: current.snapshot.snapshotId,
			generation: current.snapshot.generation,
			createdAt: current.snapshot.createdAt,
			resources: current.snapshot.descriptors.map((descriptor) => structuredClone(descriptor)),
			skills: current.skillCatalog.list(),
			mcpTools: current.mcp.catalog().list(),
			pinnedTools: current.mcp.catalog().pinned(),
			diagnostics: structuredClone(current.snapshot.diagnostics),
			counts: structuredClone(current.snapshot.counts),
		};
	}

	public beginTurn(): ProductionExtensionStartResult {
		if (this.#state !== "ready" || !this.#active) return { status: "failed", reason: "extension runtime is not ready" };
		let pinned: ProductionExtensionManagerSnapshot;
		try {
			pinned = this.#options.manager.beginTurn();
		} catch (error) {
			return { status: "failed", reason: error instanceof Error ? error.message : "extension turn could not start" };
		}
		if (pinned.snapshot.snapshotId !== this.#active.view.snapshot.snapshotId || pinned.snapshot.generation !== this.#active.view.snapshot.generation) {
			return { status: "failed", reason: "extension turn pinned a stale or uninstalled generation" };
		}
		this.#turns += 1;
		return { status: "ready", snapshotId: pinned.snapshot.snapshotId, generation: pinned.snapshot.generation };
	}

	public async endTurn(): Promise<ProductionExtensionReloadResult | undefined> {
		if (this.#turns > 0) this.#turns -= 1;
		let result: ProductionExtensionReloadResult | undefined;
		try {
			result = await this.#options.manager.endTurn();
		} catch (error) {
			return { status: "failed", reason: error instanceof Error ? error.message : "extension turn could not end", ...(this.#active ? { retained: this.#active.view } : {}) };
		}
		if (result?.status !== "applied") return result;
		const installed = await this.#install(result.current);
		if (!installed.ok) {
			this.#failClosed();
			return { status: "failed", reason: installed.reason };
		}
		return result;
	}

	public requestReload(): ProductionExtensionReloadResult {
		return this.#options.manager.requestReload();
	}

	public async reload(signal?: AbortSignal): Promise<ProductionExtensionReloadResult> {
		if (this.#state !== "ready") return { status: "failed", reason: "extension runtime is not ready" };
		let result: ProductionExtensionReloadResult;
		try {
			result = await this.#options.manager.reload(signal);
		} catch (error) {
			return { status: "failed", reason: error instanceof Error ? error.message : "extension reload failed", ...(this.#active ? { retained: this.#active.view } : {}) };
		}
		if (result.status !== "applied") return result;
		const installed = await this.#install(result.current);
		if (!installed.ok) {
			this.#failClosed();
			return { status: "failed", reason: installed.reason };
		}
		return result;
	}

	public sessionStart(payload: Readonly<Record<string, unknown>> = {}, signal?: AbortSignal): Promise<ProductionHookPhaseResult> {
		return this.#dispatchLifecycle("SessionStart", payload, signal);
	}

	public userPromptSubmit(prompt: string, signal?: AbortSignal): Promise<ProductionHookPhaseResult> {
		return this.#dispatchLifecycle("UserPromptSubmit", { prompt, input: prompt }, signal);
	}

	public postToolUse(input: { toolName: string; toolInput: unknown; result: unknown; isError: boolean }, signal?: AbortSignal): Promise<ProductionHookPhaseResult> {
		return this.#dispatchLifecycle("PostToolUse", { toolName: input.toolName, input: input.toolInput, result: input.result, isError: input.isError }, signal);
	}

	/** AgentLoop 的 beforeToolCall seam；这里只运行 Hook，最终授权仍由 AgentLoop 的 Gateway 阶段完成。 */
	public preToolUseHook(input: { toolName: string; toolInput: unknown }, signal?: AbortSignal): Promise<ProductionHookPhaseResult> {
		return this.#dispatch("PreToolUse", { toolName: input.toolName, input: input.toolInput }, signal);
	}

	public sessionEnd(payload: Readonly<Record<string, unknown>> = {}, signal?: AbortSignal): Promise<ProductionHookPhaseResult> {
		return this.#dispatchLifecycle("SessionEnd", payload, signal);
	}

	/** PreToolUse 是唯一允许 updatedInput 的阶段；授权只观察重校验后的最终输入。 */
	public async preToolUse(request: ToolExecutionGatewayRequest, signal?: AbortSignal): Promise<ProductionPreToolUseResult> {
		const phase = await this.#dispatch("PreToolUse", { toolName: request.tool.name, input: request.arguments }, signal);
		if (phase.status === "blocked") return phase;
		let input: unknown;
		try {
			input = prepareAndValidateToolInput(request, phase.input);
		} catch (error) {
			return {
				status: "blocked",
				reason: `PreToolUse updatedInput failed schema validation: ${error instanceof Error ? error.message : String(error)}`,
				dispatch: phase.dispatch,
				snapshotId: phase.snapshotId,
				generation: phase.generation,
			};
		}
		let authorization: ToolExecutionAuthorizationResult;
		try {
			authorization = await this.#options.gateway.authorize({ ...request, arguments: input }, signal);
		} catch (error) {
			return {
				status: "blocked",
				reason: `tool gateway authorization is unavailable: ${error instanceof Error ? error.message : String(error)}`,
				dispatch: phase.dispatch,
				snapshotId: phase.snapshotId,
				generation: phase.generation,
			};
		}
		if (authorization.status !== "authorized") {
			return {
				status: "blocked",
				reason: authorization.reason,
				authorization,
				dispatch: phase.dispatch,
				snapshotId: phase.snapshotId,
				generation: phase.generation,
			};
		}
		return {
			status: "authorized",
			input,
			grant: authorization.grant,
			authorization,
			dispatch: phase.dispatch,
			snapshotId: phase.snapshotId,
			generation: phase.generation,
		};
	}

	public async close(): Promise<void> {
		if (this.#state === "closed" || this.#state === "closing") return;
		this.#state = "closing";
		this.#removeActiveTools();
		await this.#options.watcher?.close().catch(() => undefined);
		for (const controller of this.#hookControllers) controller.abort("extension runtime shutdown");
		await Promise.allSettled([...this.#hookTasks]);
		await this.#options.manager.close().catch(() => undefined);
		await this.#options.pluginRuntime?.close().catch(() => undefined);
		await this.#options.hookRuntime?.close().catch(() => undefined);
		this.#active = undefined;
		this.#state = "closed";
	}

	async #install(view: ProductionExtensionManagerSnapshot): Promise<{ ok: true } | { ok: false; reason: string }> {
		const invalid = validateSnapshotView(view, this.#active?.view.snapshot.generation);
		if (invalid) return { ok: false, reason: invalid };
		let tools: readonly AgentTool[];
		try {
			tools = this.#buildTools(view);
		} catch (error) {
			return { ok: false, reason: error instanceof Error ? error.message : "extension tools could not be composed" };
		}
		const toolNames = tools.map((tool) => tool.name);
		if (new Set(toolNames).size !== toolNames.length) return { ok: false, reason: "extension tool names are not unique" };
		const owned = new Set(this.#active?.tools ?? []);
		const foreignNames = new Set(this.#options.registry.list().filter((tool) => !owned.has(tool)).map((tool) => tool.name));
		const conflict = toolNames.find((name) => foreignNames.has(name));
		if (conflict) return { ok: false, reason: `extension tool name conflicts with the existing registry: ${conflict}` };
		if (!(await this.#writeAudit(snapshotAudit(view.snapshot, this.#options.sessionId)))) return { ok: false, reason: "durable extension snapshot audit failed" };
		const previous = this.#active;
		for (const name of previous?.toolNames ?? []) this.#options.registry.unregister(name, this.#namespace);
		const registered: string[] = [];
		for (const tool of tools) {
			if (!this.#options.registry.register(tool, { namespace: this.#namespace, version: String(view.snapshot.generation) })) {
				for (const name of registered) this.#options.registry.unregister(name, this.#namespace);
				for (const oldTool of previous?.tools ?? []) this.#options.registry.register(oldTool, { namespace: this.#namespace, version: String(previous?.view.snapshot.generation ?? 0) });
				return { ok: false, reason: `extension registry swap failed for tool: ${tool.name}` };
			}
			registered.push(tool.name);
		}
		this.#active = { view, tools, toolNames };
		this.#auditHealthy = true;
		return { ok: true };
	}

	#buildTools(view: ProductionExtensionManagerSnapshot): readonly AgentTool[] {
		const tools: AgentTool[] = [];
		const readySkills = view.skills.filter((skill) => skill.descriptor.enabled && skill.descriptor.trust === "trusted" && skill.descriptor.activation === "ready");
		if (readySkills.length > 0) {
			const resolver = this.#options.createSkillResolver?.(view);
			if (!resolver) throw new Error("ready Skills require a production Skill resolver");
			tools.push(this.#skillTool(view, resolver));
		}
		const readyMcpDescriptors = view.snapshot.descriptors.filter((descriptor) => descriptor.kind === "mcp-tool" && descriptor.enabled && descriptor.trust === "trusted" && descriptor.activation === "ready" && descriptor.tool);
		if (readyMcpDescriptors.length > 0) {
			tools.push(this.#mcpSearchTool(view), this.#mcpCallTool(view));
			for (const tool of view.mcp.catalog().pinned()) tools.push(this.#pinnedMcpTool(view, tool));
		}
		return tools;
	}

	#skillTool(view: ProductionExtensionManagerSnapshot, resolver: ProductionExtensionSkillResolverPort): AgentTool<typeof SkillInputSchema, Readonly<Record<string, unknown>>> {
		const generation = view.snapshot.generation;
		const snapshotId = view.snapshot.snapshotId;
		const runtime = this;
		return {
			name: "Skill",
			label: "Skill",
			description: "Load one exact trusted Skill body from the active extension snapshot.",
			parameters: SkillInputSchema,
			governedExecution: "tool-context",
			isReadOnly: () => true,
			isConcurrencySafe: () => true,
			async execute(_toolCallId, input, _signal, _onUpdate, context) {
				const blocked = runtime.#toolGuard(generation, snapshotId, context);
				if (blocked) return toolError(blocked);
				const invocation = input.argument ? `${input.name} ${input.argument}` : input.name;
				const loaded = await resolver.load(invocation, "model-tool");
				if (!loaded.ok) return toolError(loaded.message, { code: loaded.code });
				const skill = view.skills.find((candidate) => candidate.descriptor.identity.qualifiedId === loaded.value.skillId);
				if (!skill) return toolError("Skill resolver returned an identity outside the active snapshot");
				const durable = await runtime.#writeAudit(skillInvocationAudit({
					skill,
					sessionId: runtime.#options.sessionId,
					snapshotId,
					trigger: loaded.value.trigger,
					...(loaded.value.argument ? { argument: loaded.value.argument } : {}),
					occurredAt: runtime.#now().toISOString(),
				}));
				if (!durable) return toolError("durable Skill invocation audit failed");
				return {
					content: [{ type: "text", text: loaded.value.body }],
					details: { skillId: loaded.value.skillId, bodyDigest: loaded.value.bodyDigest, allowedTools: loaded.value.allowedTools },
					terminate: false,
				};
			},
		};
	}

	#mcpSearchTool(view: ProductionExtensionManagerSnapshot): AgentTool<typeof McpSearchInputSchema, Readonly<Record<string, unknown>>> {
		const generation = view.snapshot.generation;
		const snapshotId = view.snapshot.snapshotId;
		const runtime = this;
		return {
			name: "McpSearch",
			label: "MCP Search",
			description: "Search the bounded MCP tool catalog without executing a remote tool.",
			parameters: McpSearchInputSchema,
			governedExecution: "tool-context",
			isReadOnly: () => true,
			isConcurrencySafe: () => true,
			async execute(_toolCallId, input, _signal, _onUpdate, context) {
				const blocked = runtime.#toolGuard(generation, snapshotId, context);
				if (blocked) return toolError(blocked);
				const matches = view.mcp.search(input.query, input.limit).map(({ serverId, rawName, qualifiedName, runtimeName, description, inputSchema, annotations }) => ({ serverId, rawName, qualifiedName, runtimeName, description, inputSchema, annotations }));
				return { content: [{ type: "text", text: canonicalJson(matches) }], details: { count: matches.length }, terminate: false };
			},
		};
	}

	#mcpCallTool(view: ProductionExtensionManagerSnapshot): AgentTool<typeof McpCallInputSchema, Readonly<Record<string, unknown>>> {
		const generation = view.snapshot.generation;
		const snapshotId = view.snapshot.snapshotId;
		const runtime = this;
		return {
			name: "McpCall",
			label: "MCP Call",
			description: "Call one exact trusted MCP server and tool from the active snapshot.",
			parameters: McpCallInputSchema,
			governedExecution: "tool-context",
			isReadOnly: () => false,
			isConcurrencySafe: () => false,
			async execute(_toolCallId, input, signal, _onUpdate, context) {
				const blocked = runtime.#toolGuard(generation, snapshotId, context);
				if (blocked) return toolError(blocked);
				const result = await view.mcp.call(input.serverId, input.toolName, input.input, signal);
				return result.ok ? normalizedMcpContent(result.value) : toolError(result.message, { code: result.code });
			},
		};
	}

	#pinnedMcpTool(view: ProductionExtensionManagerSnapshot, definition: McpToolDefinition): AgentTool<TSchema, Readonly<Record<string, unknown>>> {
		const generation = view.snapshot.generation;
		const snapshotId = view.snapshot.snapshotId;
		const runtime = this;
		if (typeof definition.inputSchema !== "object" || definition.inputSchema === null || Array.isArray(definition.inputSchema)) throw new Error(`pinned MCP tool schema is invalid: ${definition.runtimeName}`);
		const parameters = structuredClone(definition.inputSchema) as TSchema;
		return {
			name: definition.runtimeName,
			label: definition.rawName,
			description: definition.description,
			parameters,
			governedExecution: "tool-context",
			isReadOnly: () => definition.annotations.readOnly,
			isConcurrencySafe: () => definition.annotations.concurrencySafe,
			isDestructive: () => definition.annotations.destructive,
			async execute(_toolCallId, input, signal, _onUpdate, context) {
				const blocked = runtime.#toolGuard(generation, snapshotId, context);
				if (blocked) return toolError(blocked);
				const result = await view.mcp.call(definition.serverId, definition.rawName, input, signal);
				return result.ok ? normalizedMcpContent(result.value) : toolError(result.message, { code: result.code });
			},
		};
	}

	#toolGuard(generation: number, snapshotId: ExtensionSnapshot["snapshotId"], context?: ToolContext): string | undefined {
		if (this.#state !== "ready" || !this.#active) return "extension runtime is not ready";
		if (this.#active.view.snapshot.generation !== generation || this.#active.view.snapshot.snapshotId !== snapshotId) return "extension tool belongs to a stale snapshot generation";
		if (this.#turns <= 0) return "extension tool execution requires an active pinned turn";
		if (!this.#auditHealthy) return "extension audit sink is unavailable";
		if (!context) return "governed ToolContext is required for extension execution";
		return undefined;
	}

	#dispatchLifecycle(event: Exclude<HookEvent, "PreToolUse">, payload: Readonly<Record<string, unknown>>, signal?: AbortSignal): Promise<ProductionHookPhaseResult> {
		return this.#dispatch(event, payload, signal).then((result) => {
			if (result.status === "blocked") return result;
			if (result.dispatch.inputUpdated) {
				return {
					status: "blocked" as const,
					reason: `updatedInput is not permitted for ${event}; only PreToolUse can replace tool arguments`,
					dispatch: result.dispatch,
					snapshotId: result.snapshotId,
					generation: result.generation,
				};
			}
			return result;
		});
	}

	#dispatch(event: HookEvent, payload: Readonly<Record<string, unknown>>, signal?: AbortSignal): Promise<ProductionHookPhaseResult> {
		if (this.#state !== "ready" || !this.#active) return Promise.resolve({ status: "blocked", reason: "extension runtime is not ready" });
		if (!this.#auditHealthy) return Promise.resolve({ status: "blocked", reason: "extension audit sink is unavailable" });
		const view = this.#active.view;
		const controller = new AbortController();
		const abort = () => controller.abort(signal?.reason ?? "hook dispatch aborted");
		signal?.addEventListener("abort", abort, { once: true });
		if (signal?.aborted) abort();
		this.#hookControllers.add(controller);
		const task = this.#dispatchTracked(view, event, payload, controller.signal).finally(() => {
			signal?.removeEventListener("abort", abort);
			this.#hookControllers.delete(controller);
		});
		this.#hookTasks.add(task);
		void task.then(
			() => this.#hookTasks.delete(task),
			() => this.#hookTasks.delete(task),
		);
		return task;
	}

	async #dispatchTracked(view: ProductionExtensionManagerSnapshot, event: HookEvent, payload: Readonly<Record<string, unknown>>, signal: AbortSignal): Promise<ProductionHookPhaseResult> {
		const occurredAt = this.#now().toISOString();
		this.#eventSequence += 1;
		const eventId = createRuntimeId("event", canonicalDigest({ snapshotId: view.snapshot.snapshotId, event, occurredAt, sequence: this.#eventSequence }).slice(0, 48));
		let dispatch: HookDispatchResult;
		try {
			dispatch = await view.hookDispatcher.dispatch({
				schemaVersion: 1,
				event,
				eventId,
				timestamp: occurredAt,
				sessionId: this.#options.sessionId,
				cwd: this.#options.cwd,
				snapshotId: view.snapshot.snapshotId,
				source: this.#options.source ?? "session",
				payload,
			}, signal);
		} catch (error) {
			return { status: "blocked", reason: error instanceof Error ? error.message : "hook dispatch failed", snapshotId: view.snapshot.snapshotId, generation: view.snapshot.generation };
		}
		for (const outcome of dispatch.outcomes) {
			const hook = view.hooks.find((candidate) => candidate.event === event && candidate.descriptor.identity.qualifiedId === outcome.hookId);
			if (!hook) {
				this.#auditHealthy = false;
				return { status: "blocked", reason: "hook outcome is not bound to the active snapshot", dispatch, snapshotId: view.snapshot.snapshotId, generation: view.snapshot.generation };
			}
			const durable = await this.#writeAudit(hookRunAudit({ hook, outcome, sessionId: this.#options.sessionId, snapshotId: view.snapshot.snapshotId, eventId, occurredAt }));
			if (!durable) return { status: "blocked", reason: "durable hook audit failed", dispatch, snapshotId: view.snapshot.snapshotId, generation: view.snapshot.generation };
		}
		if (dispatch.decision === "deny") return { status: "blocked", reason: dispatch.reason ?? "hook denied operation", dispatch, snapshotId: view.snapshot.snapshotId, generation: view.snapshot.generation };
		return { status: "allowed", input: dispatch.input, ...(dispatch.additionalContext ? { additionalContext: dispatch.additionalContext } : {}), dispatch, snapshotId: view.snapshot.snapshotId, generation: view.snapshot.generation };
	}

	async #writeAudit(audit: ExtensionLifecycleAudit): Promise<boolean> {
		try {
			if (this.#options.audit.mode !== "v3") return false;
			const durable = await this.#options.audit.appendCanonical(audit);
			if (!durable) this.#auditHealthy = false;
			return durable;
		} catch {
			this.#auditHealthy = false;
			return false;
		}
	}

	#removeActiveTools(): void {
		for (const name of this.#active?.toolNames ?? []) this.#options.registry.unregister(name, this.#namespace);
	}

	#failClosed(): void {
		this.#removeActiveTools();
		this.#active = undefined;
		this.#auditHealthy = false;
		this.#state = "failed";
	}
}
