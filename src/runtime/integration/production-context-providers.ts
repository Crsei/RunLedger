/** 五层 ContextEngine 的生产 fragment providers。 */

import { canonicalDigest } from "../protocol/v3/canonical-json.ts";
import {
	createRuntimeId,
	type PrincipalId,
	type ResourceId,
	type SessionId,
} from "../protocol/v3/ids.ts";
import type { DeclassificationReceiptRef, InputSourceRef } from "../protocol/v3/taint.ts";
import { isWorkspaceBindingRef, type WorkspaceBindingRef } from "../protocol/v3/workspace.ts";
import type { ContextFragment, ContextTaint } from "../context/types.ts";
import { MAX_CONTEXT_FRAGMENT_CHARS } from "../context/schema.ts";
import type { MemoryService } from "../context/memory/service.ts";
import type { MemoryScopeRef } from "../context/memory/types.ts";
import { isApprovedPlanRef } from "../modes/plan/schema.ts";
import type { ApprovedPlanRef } from "../modes/plan/types.ts";
import type {
	GovernedContextFragmentProvider,
	GovernedContextFragmentRequest,
	GovernedContextFragmentResult,
} from "./governed-model-request.ts";

function boundedText(value: string, maxChars: number): string {
	return value.replaceAll("\u0000", "").slice(0, maxChars);
}

function sessionFragment(options: {
	request: GovernedContextFragmentRequest;
	key: string;
	content: string;
	layer: ContextFragment["layer"];
	trust: ContextFragment["trust"];
	priority: ContextFragment["priority"];
	order: number;
	maxTokens: number;
	maxChars: number;
	taint?: readonly ContextTaint[];
	inputSources?: readonly InputSourceRef[];
	declassificationReceipts?: readonly DeclassificationReceiptRef[];
}): ContextFragment {
	const content = boundedText(options.content, options.maxChars);
	const contentDigest = canonicalDigest(content);
	return {
		schemaVersion: 1,
		authorityId: options.request.route.authorityId,
		tenantId: options.request.route.tenantId,
		fragmentId: createRuntimeId("resource", `context-${canonicalDigest({
			requestId: options.request.contextRequestId,
			key: options.key,
			contentDigest,
		}).slice(0, 48)}`),
		layer: options.layer,
		order: options.order,
		contentDigest,
		trust: options.trust,
		taint: options.taint ?? [],
		inputSources: options.inputSources ?? [],
		declassificationReceipts: options.declassificationReceipts ?? [],
		priority: options.priority,
		maxTokens: options.maxTokens,
		maxChars: options.maxChars,
			provenance: {
				authorityId: options.request.route.authorityId,
				tenantId: options.request.route.tenantId,
				kind: "session_range",
				sessionId: options.request.sessionId,
			fromSequence: 0,
			toSequence: Math.max(0, options.request.input.turn),
			sourceDigest: contentDigest,
			observedAt: new Date().toISOString(),
		},
		storage: "inline",
		content,
	};
}

/** 原始 systemPrompt 的唯一消费者；消除隐式字符串拼接旁路。 */
export class BasePromptContextProvider implements GovernedContextFragmentProvider {
	readonly #principalId: PrincipalId;

	public constructor(principalId: PrincipalId) {
		this.#principalId = principalId;
	}

	public load(request: GovernedContextFragmentRequest): GovernedContextFragmentResult {
		const content = request.input.context.systemPrompt ?? "";
		if (content.length === 0) return { fragments: [] };
		if (content.length > MAX_CONTEXT_FRAGMENT_CHARS) {
			throw new Error("base system prompt exceeds the governed context fragment bound");
		}
		const contentDigest = canonicalDigest(content);
		const fragment: ContextFragment = {
			schemaVersion: 1,
			authorityId: request.route.authorityId,
			tenantId: request.route.tenantId,
			fragmentId: createRuntimeId("resource", `base-prompt-${contentDigest.slice(0, 48)}`),
			layer: "organization_policy",
			order: 0,
			contentDigest,
			trust: "system",
			taint: [],
			inputSources: [],
			declassificationReceipts: [],
			priority: "required",
			// Fragment 上限是 validation cap，不是预算估算；按字符数给出保守
			// 上界，真正的模型预算仍由 ContextEngine/TokenEstimator 决定。
			maxTokens: Math.max(1, content.length),
			maxChars: Math.max(1, content.length),
			provenance: {
				authorityId: request.route.authorityId,
				tenantId: request.route.tenantId,
				kind: "principal",
				principalId: this.#principalId,
				sourceDigest: contentDigest,
				observedAt: new Date().toISOString(),
			},
			storage: "inline",
			content,
		};
		return { fragments: [fragment], consumedSystemPromptDigest: contentDigest };
	}
}

export interface ApprovedPlanContextDocument {
	ref: ApprovedPlanRef;
	body: string;
	inputSources: readonly InputSourceRef[];
	declassificationReceipts: readonly DeclassificationReceiptRef[];
}

export class ApprovedPlanContextProvider implements GovernedContextFragmentProvider {
	readonly #load: () => Promise<ApprovedPlanContextDocument | undefined>;

	public constructor(load: () => Promise<ApprovedPlanContextDocument | undefined>) {
		this.#load = load;
	}

	public async load(request: GovernedContextFragmentRequest): Promise<GovernedContextFragmentResult> {
		const document = await this.#load();
		if (!document) return { fragments: [] };
		if (!isApprovedPlanRef(document.ref) || canonicalDigest(document.body) !== document.ref.contentDigest) {
			throw new Error("approved plan context failed identity or digest validation");
		}
		const content = boundedText(document.body, MAX_CONTEXT_FRAGMENT_CHARS);
		const contentDigest = canonicalDigest(content);
		return {
			fragments: [{
				schemaVersion: 1,
				authorityId: document.ref.authorityId,
				tenantId: document.ref.tenantId,
				fragmentId: createRuntimeId("resource", `approved-plan-${document.ref.planId.slice(-32)}-${document.ref.revision}`),
				layer: "session_memory",
				order: 10,
				contentDigest,
				trust: "user_approved",
				taint: document.inputSources.length > 0 ? ["mutable_source"] : [],
				inputSources: document.inputSources,
				declassificationReceipts: document.declassificationReceipts,
				priority: "required",
				maxTokens: MAX_CONTEXT_FRAGMENT_CHARS,
				maxChars: MAX_CONTEXT_FRAGMENT_CHARS,
				provenance: {
					authorityId: document.ref.authorityId,
					tenantId: document.ref.tenantId,
					kind: "artifact",
					artifact: document.ref.artifact,
					sourceDigest: document.ref.contentDigest,
					observedAt: document.ref.approvalReceipt.decidedAt,
				},
				storage: "inline",
				content,
			}],
		};
	}
}

export class WorkspaceContextProvider implements GovernedContextFragmentProvider {
	readonly #workspace: WorkspaceBindingRef;

	public constructor(workspace: WorkspaceBindingRef) {
		if (!isWorkspaceBindingRef(workspace)) throw new TypeError("workspace context binding is invalid");
		this.#workspace = workspace;
	}

	public load(request: GovernedContextFragmentRequest): GovernedContextFragmentResult {
		const content = JSON.stringify({
			workspaceId: this.#workspace.workspaceId,
			repositoryId: this.#workspace.repositoryId,
			bindingKind: this.#workspace.bindingKind,
			canonicalCwd: this.#workspace.canonicalCwd,
			effectiveCwd: this.#workspace.effectiveCwd,
			branch: this.#workspace.branch,
			baseCommit: this.#workspace.baseCommit,
			headCommit: this.#workspace.headCommit,
		});
		const contentDigest = canonicalDigest(content);
		return {
			fragments: [{
				schemaVersion: 1,
				authorityId: this.#workspace.authorityId,
				tenantId: this.#workspace.tenantId,
				fragmentId: createRuntimeId("resource", `workspace-context-${contentDigest.slice(0, 48)}`),
				layer: "workspace_knowledge",
				order: 20,
				contentDigest,
				trust: "system",
				taint: [],
				inputSources: [],
				declassificationReceipts: [],
				priority: "required",
				maxTokens: 1_024,
				maxChars: 8_192,
				provenance: {
					authorityId: this.#workspace.authorityId,
					tenantId: this.#workspace.tenantId,
					kind: "workspace",
					workspace: this.#workspace,
					sourceDigest: contentDigest,
					observedAt: new Date().toISOString(),
				},
				storage: "inline",
				content,
			}],
		};
	}
}

export class SessionProjectionContextProvider implements GovernedContextFragmentProvider {
	readonly #sessionId: SessionId;

	public constructor(sessionId: SessionId) {
		this.#sessionId = sessionId;
	}

	public load(request: GovernedContextFragmentRequest): GovernedContextFragmentResult {
		const content = JSON.stringify({
			sessionId: this.#sessionId,
			turn: request.input.turn,
			messageCount: request.input.messages.length,
			toolResultCount: request.input.messages.filter((message) => message.role === "toolResult").length,
			constraint: "Canonical conversation messages remain the only session history body.",
		});
		return {
			fragments: [sessionFragment({
				request,
				key: `session-${this.#sessionId}`,
				content,
				layer: "session_memory",
				trust: "system",
				priority: "high",
				order: 30,
				maxTokens: 1_024,
				maxChars: 8_192,
			})],
		};
	}
}

export class MemoryContextProvider implements GovernedContextFragmentProvider {
	readonly #service: MemoryService;
	readonly #scopes: readonly MemoryScopeRef[];
	readonly #declassificationReceipts: () => readonly DeclassificationReceiptRef[];

	public constructor(options: {
		service: MemoryService;
		scopes: readonly MemoryScopeRef[];
		declassificationReceipts?: () => readonly DeclassificationReceiptRef[];
	}) {
		this.#service = options.service;
		this.#scopes = options.scopes;
		this.#declassificationReceipts = options.declassificationReceipts ?? (() => []);
	}

	public async load(request: GovernedContextFragmentRequest): Promise<GovernedContextFragmentResult> {
		const latestUser = [...request.input.messages].reverse().find((message) => message.role === "user");
		const query = latestUser?.role === "user"
			? latestUser.content.map((part) => part.text).join(" ").slice(0, 4_096)
			: "current session goal";
		const searched = await this.#service.search({
			query,
			scopes: this.#scopes,
			traceId: request.traceId,
			maxResults: 8,
			maxSnippetChars: 2_048,
			maxTotalTokens: 4_096,
		});
		const injected = await this.#service.injection({
			search: searched.receipt,
			records: searched.records,
			contextRequestId: request.contextRequestId,
			declassificationReceipts: this.#declassificationReceipts(),
			traceId: request.traceId,
			maxChars: 16_384,
			maxTokens: 4_096,
		});
		return { fragments: injected.fragment ? [injected.fragment] : [] };
	}
}

/** 外部/仓库 instruction 必须携带真实 source 与 context 去污收据。 */
export class ClassifiedTextContextProvider implements GovernedContextFragmentProvider {
	readonly #key: string;
	readonly #content: string;
	readonly #source: InputSourceRef;
	readonly #receipts: readonly DeclassificationReceiptRef[];
	readonly #layer: ContextFragment["layer"];
	readonly #priority: ContextFragment["priority"];

	public constructor(options: {
		key: string;
		content: string;
		source: InputSourceRef;
		declassificationReceipts: readonly DeclassificationReceiptRef[];
		layer?: ContextFragment["layer"];
		priority?: ContextFragment["priority"];
	}) {
		this.#key = options.key;
		this.#content = options.content;
		this.#source = options.source;
		this.#receipts = options.declassificationReceipts;
		this.#layer = options.layer ?? "workspace_knowledge";
		this.#priority = options.priority ?? "optional";
	}

	public load(request: GovernedContextFragmentRequest): GovernedContextFragmentResult {
		return {
			fragments: [sessionFragment({
				request,
				key: this.#key,
				content: this.#content,
				layer: this.#layer,
				trust: "untrusted",
				priority: this.#priority,
				order: 40,
				maxTokens: 16_384,
				maxChars: 65_536,
				taint: ["external_input", "mutable_source", "unverified"],
				inputSources: [this.#source],
				declassificationReceipts: this.#receipts,
			})],
		};
	}
}

/** 用户层受信 instruction；仍保留 exact source identity，而非拼进 base prompt。 */
export class TrustedTextContextProvider implements GovernedContextFragmentProvider {
	readonly #key: string;
	readonly #content: string;
	readonly #source: InputSourceRef;
	readonly #principalId: PrincipalId;
	readonly #layer: ContextFragment["layer"];

	public constructor(options: {
		key: string;
		content: string;
		source: InputSourceRef;
		principalId: PrincipalId;
		layer?: ContextFragment["layer"];
	}) {
		if (options.source.trust !== "trusted" || options.source.taintLabels.length > 0) {
			throw new TypeError("trusted context source must be untainted");
		}
		this.#key = options.key;
		this.#content = options.content;
		this.#source = options.source;
		this.#principalId = options.principalId;
		this.#layer = options.layer ?? "user_memory";
	}

	public load(request: GovernedContextFragmentRequest): GovernedContextFragmentResult {
		const content = boundedText(this.#content, MAX_CONTEXT_FRAGMENT_CHARS);
		const contentDigest = canonicalDigest(content);
		return {
			fragments: [{
				schemaVersion: 1,
				authorityId: request.route.authorityId,
				tenantId: request.route.tenantId,
				fragmentId: createRuntimeId("resource", `trusted-context-${canonicalDigest({ key: this.#key, contentDigest }).slice(0, 48)}`),
				layer: this.#layer,
				order: 5,
				contentDigest,
				trust: "user_approved",
				taint: [],
				inputSources: [this.#source],
				declassificationReceipts: [],
				priority: "high",
				maxTokens: MAX_CONTEXT_FRAGMENT_CHARS,
				maxChars: MAX_CONTEXT_FRAGMENT_CHARS,
				provenance: {
					authorityId: request.route.authorityId,
					tenantId: request.route.tenantId,
					kind: "principal",
					principalId: this.#principalId,
					sourceDigest: this.#source.sourceDigest,
					observedAt: this.#source.observedAt,
				},
				storage: "inline",
				content,
			}],
		};
	}
}

export function contextProviderIdentity(provider: GovernedContextFragmentProvider): ResourceId {
	return createRuntimeId("resource", `context-provider-${canonicalDigest(provider.constructor.name).slice(0, 48)}`);
}
