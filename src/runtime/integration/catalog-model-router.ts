/** Provider catalog -> 有界 Compatibility Manifest 的生产路由适配。 */

import type { Api, Model } from "../../types.ts";
import { canonicalDigest } from "../protocol/v3/canonical-json.ts";
import {
	createRuntimeId,
	type AuthorityId,
	type PrincipalId,
	type ResourceId,
	type TenantId,
} from "../protocol/v3/ids.ts";
import {
	calculateModelManifestDigest,
	calculateModelProfileEvidenceDigest,
	calculateModelProfileDigest,
} from "../model-routing/manifest-loader.ts";
import { ModelCompatibilityRouter } from "../model-routing/router.ts";
import type {
	ModelCapabilityProfile,
	ModelCompatibilityManifest,
	ModelRouteDecision,
	ModelRouteRequest,
} from "../model-routing/types.ts";
import {
	PI_AI_CATALOG_DIGEST,
	PI_AI_PARITY_MANIFEST_DIGEST,
	PI_AI_UPSTREAM_COMMIT,
	RUNLEDGER_PARITY_BASE_COMMIT,
} from "../model-routing/types.ts";
import type { ModelCompatibilityRoutePort } from "./governed-model-request.ts";

export interface CatalogModelRegressionEvidence {
	/** 构建/发布门所执行的 suite 版本。 */
	version: string;
	suiteDigest: string;
	passed: boolean;
	completedAt: string;
}

export interface CatalogModelRouterOptions {
	authorityId: AuthorityId;
	tenantId: TenantId;
	principalId: PrincipalId;
	models: readonly Model<Api>[];
	regression: CatalogModelRegressionEvidence;
}

function modelKey(model: Model<Api>): string {
	return `${model.provider}/${model.id}`;
}

function stableProfileId(model: Model<Api>): ResourceId {
	return createRuntimeId("resource", `model-profile-${canonicalDigest({
		provider: model.provider,
		model: model.id,
		api: model.api,
	}).slice(0, 48)}`);
}

function profileDraft(
	model: Model<Api>,
	options: CatalogModelRouterOptions,
): ModelCapabilityProfile {
	const compatibilityHashes = {
		toolHash: canonicalDigest({ toolCallReplay: "supported" }),
		reasoningHash: canonicalDigest({ reasoningHistory: model.reasoning ? "adapter_private" : "portable" }),
		adapterStateHash: canonicalDigest({ providerId: model.provider, apiProtocol: model.api, midSessionSwitch: "fork_required" }),
		compactionHash: canonicalDigest({ strategy: "summary", apiProtocol: model.api }),
		contextHash: canonicalDigest({ contextWindow: model.contextWindow, maxTokens: model.maxTokens, input: model.input }),
		profileHash: canonicalDigest({ providerId: model.provider, modelId: model.id, apiProtocol: model.api }),
		regressionHash: canonicalDigest(options.regression),
	};
	const unsignedEvidence = {
		piAiParityManifestDigest: PI_AI_PARITY_MANIFEST_DIGEST,
		catalogDigest: PI_AI_CATALOG_DIGEST,
		upstreamCommit: PI_AI_UPSTREAM_COMMIT,
		runLedgerBaseCommit: RUNLEDGER_PARITY_BASE_COMMIT,
		catalogEntryDigest: canonicalDigest({
			provider: model.provider,
			id: model.id,
			api: model.api,
			reasoning: model.reasoning,
			input: model.input,
			contextWindow: model.contextWindow,
			maxTokens: model.maxTokens,
		}),
		compatibilityEvidenceDigest: canonicalDigest(compatibilityHashes),
		evidenceDigest: "0".repeat(64),
	};
	const evidence = {
		...unsignedEvidence,
		evidenceDigest: calculateModelProfileEvidenceDigest(unsignedEvidence),
	};
	const draft: ModelCapabilityProfile = {
		schemaVersion: 2,
		authorityId: options.authorityId,
		tenantId: options.tenantId,
		profileId: stableProfileId(model),
		modelId: modelKey(model),
		providerId: model.provider,
		manifestDigest: "0".repeat(64),
		profileDigest: "0".repeat(64),
		evidence,
		compatibilityHashes,
		contextWindow: Math.max(1, Math.trunc(model.contextWindow)),
		maxOutputTokens: Math.max(1, Math.trunc(model.maxTokens)),
		apiProtocol: model.api,
		toolCallReplay: "supported",
		// Reasoning signatures/state are provider-private unless a future verified
		// conversion receipt explicitly proves portability.
		reasoningHistory: model.reasoning ? "adapter_private" : "portable",
		// A different profile always needs an audited fork. Re-selecting this exact
		// profile remains compatible because the router does not compare it to itself.
		midSessionSwitch: "fork_required",
		imageInput: model.input.includes("image"),
		compactionStrategy: "summary",
		verifiedAliases: ["builder", "searcher", "reviewer", "security_reviewer"],
		capabilityClaims: [],
		regressionSuite: {
			version: options.regression.version,
			suiteDigest: options.regression.suiteDigest,
			passed: options.regression.passed,
			completedAt: options.regression.completedAt,
		},
		status: options.regression.passed ? "verified" : "unknown",
		...(options.regression.passed ? { verifiedByPrincipalId: options.principalId } : {}),
	};
	return { ...draft, profileDigest: calculateModelProfileDigest(draft) };
}

function boundedManifest(
	options: CatalogModelRouterOptions,
	profiles: readonly ModelCapabilityProfile[],
): ModelCompatibilityManifest {
	const ordered = profiles.slice().sort((left, right) => left.profileId.localeCompare(right.profileId));
	const draft: ModelCompatibilityManifest = {
		schemaVersion: 2,
		authorityId: options.authorityId,
		tenantId: options.tenantId,
		manifestId: createRuntimeId("resource", `catalog-model-manifest-${canonicalDigest({
			authorityId: options.authorityId,
			tenantId: options.tenantId,
			profiles: ordered.map((profile) => profile.profileId),
		}).slice(0, 48)}`),
		revision: 1,
		generatedAt: options.regression.completedAt,
		piAiParityManifestDigest: PI_AI_PARITY_MANIFEST_DIGEST,
		catalogDigest: PI_AI_CATALOG_DIGEST,
		upstreamCommit: PI_AI_UPSTREAM_COMMIT,
		runLedgerBaseCommit: RUNLEDGER_PARITY_BASE_COMMIT,
		profiles: ordered,
		manifestDigest: "0".repeat(64),
	};
	const manifestDigest = calculateModelManifestDigest(draft);
	return {
		...draft,
		manifestDigest,
		profiles: ordered.map((profile) => ({ ...profile, manifestDigest })),
	};
}

/**
 * Catalog 可大于单个 contract manifest 的 512-profile 上限。每次 route 只装载
 * exact source + target 两个 profile，再交给标准 ModelCompatibilityRouter；因此
 * 不会为了目录规模放宽 schema，也不会按 display name 猜测模型。
 */
export class CatalogModelCompatibilityRouter implements ModelCompatibilityRoutePort {
	readonly #options: CatalogModelRouterOptions;
	readonly #byModelId = new Map<string, ModelCapabilityProfile>();
	readonly #byProfileId = new Map<ResourceId, ModelCapabilityProfile>();

	public constructor(options: CatalogModelRouterOptions) {
		if (!/^[a-f0-9]{64}$/u.test(options.regression.suiteDigest)) {
			throw new TypeError("catalog model regression suite digest is invalid");
		}
		const completedAt = new Date(options.regression.completedAt);
		if (!Number.isFinite(completedAt.getTime()) || completedAt.toISOString() !== options.regression.completedAt) {
			throw new TypeError("catalog model regression completion time is invalid");
		}
		this.#options = options;
		for (const model of options.models) {
			const key = modelKey(model);
			if (this.#byModelId.has(key)) throw new TypeError(`duplicate catalog model identity ${key}`);
			const profile = profileDraft(model, options);
			this.#byModelId.set(key, profile);
			this.#byProfileId.set(profile.profileId, profile);
		}
	}

	public route(request: ModelRouteRequest): ModelRouteDecision {
		const target = request.targetProfileId
			? this.#byProfileId.get(request.targetProfileId)
			: request.targetModelId
				? this.#byModelId.get(request.targetModelId)
				: [...this.#byModelId.values()].find((profile) => profile.verifiedAliases.includes(request.alias));
		const source = request.fromProfileId
			? this.#byProfileId.get(request.fromProfileId)
			: request.fromModelId
				? this.#byModelId.get(request.fromModelId)
				: undefined;
		const profiles = [source, target].filter(
			(profile, index, all): profile is ModelCapabilityProfile =>
				profile !== undefined && all.findIndex((candidate) => candidate?.profileId === profile.profileId) === index,
		);
		return new ModelCompatibilityRouter(boundedManifest(this.#options, profiles)).route(request);
	}
}

export function catalogModelId(model: Model<Api>): string {
	return modelKey(model);
}
