import { canonicalDigest } from "../protocol/v3/canonical-json.ts";
import type { RuntimeEventPayloadMap } from "../protocol/v3/event-payloads.ts";
import { createRuntimeId, type CheckpointId } from "../protocol/v3/ids.ts";
import { inputSourcesAllowedAtSink } from "../protocol/v3/taint.ts";
import { CONTEXT_LAYERS, type ContextAssemblyReceipt, type ContextAssemblyRequest, type ContextFragment, type ContextOmissionDiagnostic } from "./types.ts";
import { isContextAssemblyRequest } from "./schema.ts";
import { TokenEstimator } from "./token-estimator.ts";

const PRIORITY_ORDER = { required: 0, high: 1, normal: 2, optional: 3 } as const;

export class ContextAssemblyError extends Error {
	public readonly code: "invalid_request" | "required_fragment_exceeds_budget" | "fragment_digest_mismatch" | "taint_rejected";

	public constructor(code: ContextAssemblyError["code"], message: string) {
		super(message);
		this.name = "ContextAssemblyError";
		this.code = code;
	}
}

export interface AssembledContext {
	fragments: readonly ContextFragment[];
	receipt: ContextAssemblyReceipt;
}

export interface ContextEngineOptions {
	estimator?: TokenEstimator;
	clock?: () => Date;
	checkpointId?: CheckpointId;
}

function fragmentText(fragment: ContextFragment): string {
	return fragment.storage === "inline" ? fragment.content : (fragment.excerpt ?? "");
}

function compareFragments(left: ContextFragment, right: ContextFragment): number {
	return (
		CONTEXT_LAYERS.indexOf(left.layer) - CONTEXT_LAYERS.indexOf(right.layer) ||
		PRIORITY_ORDER[left.priority] - PRIORITY_ORDER[right.priority] ||
		left.order - right.order ||
		left.fragmentId.localeCompare(right.fragmentId) ||
		left.contentDigest.localeCompare(right.contentDigest)
	);
}

function omission(fragment: ContextFragment, reason: ContextOmissionDiagnostic["reason"]): ContextOmissionDiagnostic {
	return {
		fragmentId: fragment.fragmentId,
		layer: fragment.layer,
		reason,
		diagnosticDigest: canonicalDigest({ fragmentId: fragment.fragmentId, layer: fragment.layer, reason }),
	};
}

export class ContextEngine {
	readonly #estimator: TokenEstimator;
	readonly #clock: () => Date;
	readonly #checkpointId: CheckpointId | undefined;

	public constructor(options: ContextEngineOptions = {}) {
		this.#estimator = options.estimator ?? new TokenEstimator();
		this.#clock = options.clock ?? (() => new Date());
		this.#checkpointId = options.checkpointId;
	}

	public assemble(request: ContextAssemblyRequest): AssembledContext {
		if (!isContextAssemblyRequest(request)) {
			throw new ContextAssemblyError("invalid_request", "context assembly request failed schema, scope, or budget validation");
		}
		const ordered = request.fragments.slice().sort(compareFragments);
		const included: ContextFragment[] = [];
		const includedReceipts: ContextAssemblyReceipt["included"][number][] = [];
		const omitted: ContextOmissionDiagnostic[] = [];
		const availableTokens = request.budget.contextWindowTokens -
			request.budget.reservedOutputTokens -
			request.budget.reservedToolSchemaTokens -
			request.budget.providerSafetyTokens;
		let usedTokens = 0;
		let usedChars = 0;

		for (const fragment of ordered) {
			const text = fragmentText(fragment);
			if (fragment.storage === "inline" && canonicalDigest(text) !== fragment.contentDigest) {
				throw new ContextAssemblyError("fragment_digest_mismatch", `fragment ${fragment.fragmentId} content digest mismatch`);
			}
			if (!inputSourcesAllowedAtSink(fragment.inputSources, "context", fragment.declassificationReceipts, this.#clock())) {
				if (fragment.priority === "required") {
					throw new ContextAssemblyError("taint_rejected", `required fragment ${fragment.fragmentId} lacks a valid context declassification receipt`);
				}
				omitted.push(omission(fragment, "taint_rejected"));
				continue;
			}
			const estimatedTokens = this.#estimator.estimate(text);
			const exceedsOwnCap = estimatedTokens > fragment.maxTokens || text.length > fragment.maxChars;
			const exceedsTotal = usedTokens + estimatedTokens > availableTokens || usedChars + text.length > request.budget.maxTotalChars;
			if (exceedsOwnCap || exceedsTotal) {
				if (fragment.priority === "required") {
					throw new ContextAssemblyError(
						"required_fragment_exceeds_budget",
						`required fragment ${fragment.fragmentId} cannot fit the declared context budget`,
					);
				}
				omitted.push(omission(fragment, exceedsOwnCap ? "fragment_cap_exceeded" : "budget_exceeded"));
				continue;
			}
			included.push(fragment);
			includedReceipts.push({
				authorityId: fragment.authorityId,
				tenantId: fragment.tenantId,
				fragmentId: fragment.fragmentId,
				contentDigest: fragment.contentDigest,
				layer: fragment.layer,
				estimatedTokens,
				includedChars: text.length,
				inputSources: fragment.inputSources,
				declassificationReceipts: fragment.declassificationReceipts,
			});
			usedTokens += estimatedTokens;
			usedChars += text.length;
		}

		const contextDigest = canonicalDigest(includedReceipts.map((entry) => ({
			fragmentId: entry.fragmentId,
			contentDigest: entry.contentDigest,
			layer: entry.layer,
			estimatedTokens: entry.estimatedTokens,
		})));
		const receiptSeed = canonicalDigest({ requestId: request.requestId, contextDigest, omitted });
		const receipt: ContextAssemblyReceipt = {
			schemaVersion: 1,
			authorityId: request.authorityId,
			tenantId: request.tenantId,
			principalId: request.principalId,
			requestId: request.requestId,
			receiptId: createRuntimeId("receipt", `context-${receiptSeed.slice(0, 48)}`),
			sessionId: request.sessionId,
			modelId: request.modelId,
			modelProfileId: request.modelProfileId,
			budget: request.budget,
			included: includedReceipts,
			omitted,
			estimatedInputTokens: usedTokens,
			contextDigest,
			...(this.#checkpointId === undefined ? {} : { projectionCheckpointId: this.#checkpointId }),
			assembledAt: this.#clock().toISOString(),
		};
		return { fragments: included, receipt };
	}
}

export function contextAssembledEventPayload(
	receipt: ContextAssemblyReceipt,
): RuntimeEventPayloadMap["context.assembled"] {
	return {
		requestId: receipt.requestId,
		receiptId: receipt.receiptId,
		modelId: receipt.modelId,
		modelProfileId: receipt.modelProfileId,
		contextDigest: receipt.contextDigest,
		receiptDigest: canonicalDigest(receipt),
		includedCount: receipt.included.length,
		omittedCount: receipt.omitted.length,
	};
}
