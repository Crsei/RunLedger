/** Model Compatibility manifest loader 与确定性 route/fork/deny 行为。 */

import { runtimeDigest, type RuntimeContentRef, type RuntimeDigest } from "../protocol/foundation.ts";
import { isRuntimeDigest } from "../protocol/foundation-schemas.ts";
import { createRuntimeId } from "../protocol/ids.ts";
import { isModelCapabilityProfile, isModelRouteRequest } from "./schema.ts";
import type { ModelCapabilityProfile, ModelRouteDecision, ModelRouteDiagnostic, ModelRouteRequest } from "./types.ts";

export interface ModelCompatibilityManifestDocument {
	readonly version: 1;
	readonly profiles: readonly ModelCapabilityProfile[];
	readonly aliases: Readonly<Record<string, string>>;
	readonly manifestDigest: RuntimeDigest;
}

export interface ModelCompatibilityManifestError {
	readonly code: "invalid_manifest" | "digest_mismatch" | "duplicate_profile" | "alias_target_missing";
	readonly message: string;
}

export type ModelCompatibilityManifestResult =
	| { readonly ok: true; readonly value: ModelCompatibilityManifestDocument }
	| { readonly ok: false; readonly error: ModelCompatibilityManifestError };

function failure(code: ModelCompatibilityManifestError["code"], message: string): ModelCompatibilityManifestResult {
	return { ok: false, error: { code, message } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
	const actual = Object.keys(value).sort();
	const expected = [...keys].sort();
	return actual.length === expected.length && actual.every((item, index) => item === expected[index]);
}

function manifestBody(value: Pick<ModelCompatibilityManifestDocument, "version" | "profiles" | "aliases">): Pick<ModelCompatibilityManifestDocument, "version" | "profiles" | "aliases"> {
	return { version: value.version, profiles: value.profiles, aliases: value.aliases };
}

function sameDigest(left: RuntimeDigest, right: RuntimeDigest): boolean {
	return left.algorithm === right.algorithm && left.digest === right.digest;
}

/** 只接受当前 manifest；损坏或未知字段不会回退到内置 profile。 */
export function loadModelCompatibilityManifest(value: unknown): ModelCompatibilityManifestResult {
	if (!isRecord(value) || !exactKeys(value, ["aliases", "manifestDigest", "profiles", "version"]) || value.version !== 1 || !isRuntimeDigest(value.manifestDigest) || !Array.isArray(value.profiles) || !isRecord(value.aliases)) {
		return failure("invalid_manifest", "model compatibility manifest failed exact validation");
	}
	if (value.profiles.length > 4_096) return failure("invalid_manifest", "model compatibility manifest exceeds profile bound");
	const profiles: ModelCapabilityProfile[] = [];
	const profileIds = new Set<string>();
	for (const candidate of value.profiles) {
		if (!isModelCapabilityProfile(candidate)) return failure("invalid_manifest", "model compatibility profile failed exact validation");
		if (profileIds.has(candidate.profileId)) return failure("duplicate_profile", `duplicate model profile: ${candidate.profileId}`);
		profileIds.add(candidate.profileId);
		profiles.push(candidate);
	}
	const aliases: Record<string, string> = {};
	const aliasEntries = Object.entries(value.aliases);
	if (aliasEntries.length > 4_096) return failure("invalid_manifest", "model compatibility alias bound exceeded");
	for (const [alias, target] of aliasEntries) {
		if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u.test(alias) || typeof target !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u.test(target)) {
			return failure("invalid_manifest", "model compatibility alias is invalid");
		}
		if (!profileIds.has(target)) return failure("alias_target_missing", `model compatibility alias target is missing: ${target}`);
		aliases[alias] = target;
	}
	const body = manifestBody({ version: 1, profiles, aliases });
	if (!sameDigest(value.manifestDigest, runtimeDigest(body))) return failure("digest_mismatch", "model compatibility manifest digest does not match its content");
	return { ok: true, value: { ...body, manifestDigest: value.manifestDigest } };
}

function diagnostic(code: string, message: string, severity: ModelRouteDiagnostic["severity"] = "error"): ModelRouteDiagnostic {
	return { code, severity, message };
}

function routeDigestBody(decision: Omit<ModelRouteDecision, "decisionDigest">): Omit<ModelRouteDecision, "decisionDigest"> {
	return decision;
}

function makeDecision(input: {
	readonly request: ModelRouteRequest;
	readonly profile?: ModelCapabilityProfile;
	readonly outcome: ModelRouteDecision["outcome"];
	readonly reasonCode: string;
	readonly diagnostics: readonly ModelRouteDiagnostic[];
	readonly conversionRef?: RuntimeContentRef;
	readonly forkSessionId?: ReturnType<typeof createRuntimeId<"session">>;
}): ModelRouteDecision {
	const profile = input.profile;
	const base: Omit<ModelRouteDecision, "decisionDigest"> = {
		requestId: input.request.requestId,
		outcome: input.outcome,
		targetProviderId: profile?.providerId ?? "unknown",
		targetModelId: profile?.modelId ?? "unknown",
		targetProfileId: profile?.profileId ?? input.request.targetProfileId,
		manifestDigest: profile?.manifestDigest ?? runtimeDigest("model-profile-unavailable"),
		reasonCode: input.reasonCode,
		diagnostics: input.diagnostics,
		...(input.conversionRef === undefined ? {} : { conversionRef: input.conversionRef }),
		...(input.forkSessionId === undefined ? {} : { forkSessionId: input.forkSessionId }),
	};
	return { ...base, decisionDigest: runtimeDigest(routeDigestBody(base)) };
}

function forkId(request: ModelRouteRequest, target: ModelCapabilityProfile): ReturnType<typeof createRuntimeId<"session">> {
	return createRuntimeId("session", runtimeDigest({ requestId: request.requestId, targetProfileId: target.profileId, contextDigest: request.contextDigest, planDigest: request.planDigest }).digest.slice(0, 48));
}

function capabilityFailure(request: ModelRouteRequest, profile: ModelCapabilityProfile, reasonCode: string, message: string): ModelRouteDecision {
	return makeDecision({ request, profile, outcome: "deny", reasonCode, diagnostics: [diagnostic(reasonCode, message)] });
}

export class ModelCompatibilityRouter {
	readonly #manifest: ModelCompatibilityManifestDocument;
	readonly #profiles: ReadonlyMap<string, ModelCapabilityProfile>;

	public constructor(manifest: ModelCompatibilityManifestDocument) {
		const checked = loadModelCompatibilityManifest(manifest);
		if (!checked.ok) throw new Error(`${checked.error.code}: ${checked.error.message}`);
		this.#manifest = checked.value;
		this.#profiles = new Map(checked.value.profiles.map((profile) => [profile.profileId, profile]));
	}

	public manifest(): ModelCompatibilityManifestDocument {
		return this.#manifest;
	}

	public route(request: ModelRouteRequest): ModelRouteDecision {
		if (!isModelRouteRequest(request)) {
			return makeDecision({ request, outcome: "deny", reasonCode: "invalid_request", diagnostics: [diagnostic("invalid_request", "model route request failed exact validation")] });
		}
		const resolvedTarget = this.#manifest.aliases[request.targetProfileId] ?? request.targetProfileId;
		const target = this.#profiles.get(resolvedTarget);
		if (!target) return makeDecision({ request, outcome: "deny", reasonCode: "profile_unknown", diagnostics: [diagnostic("profile_unknown", `model profile is not verified: ${request.targetProfileId}`)] });
		if (target.status === "retired") return capabilityFailure(request, target, "profile_retired", "model profile is retired");
		if (target.status !== "verified") return capabilityFailure(request, target, "profile_unverified", "model profile is not verified");
		if (request.requiredContextTokens + request.requiredOutputTokens > target.contextWindow) return capabilityFailure(request, target, "context_window_insufficient", "requested context and output exceed the target context window");
		if (request.requiredOutputTokens > target.maxOutputTokens) return capabilityFailure(request, target, "output_budget_insufficient", "requested output exceeds the target output budget");
		if (request.requiresTools && target.toolProtocol === "none") return capabilityFailure(request, target, "tools_unsupported", "target model cannot replay tool calls");
		if (request.requiresImages && !target.imageInput) return capabilityFailure(request, target, "images_unsupported", "target model cannot accept image input");
		if ((request.operation === "summarize" || request.operation === "compact") && target.toolProtocol !== "none") return capabilityFailure(request, target, "summarizer_tools_enabled", "summarizer profile must disable tools");
		if ((request.operation === "summarize" || request.operation === "compact") && target.compaction === "none") return capabilityFailure(request, target, "compaction_unsupported", "target profile cannot produce a compaction replacement");
		if (request.requiresReasoningReplay && target.reasoningProtocol === "none") {
			if (target.conversionRef !== undefined && request.operation === "switch") return makeDecision({ request, profile: target, outcome: "fork", reasonCode: "reasoning_conversion_required", diagnostics: [diagnostic("reasoning_conversion_required", "reasoning history requires a fresh compatible session")], conversionRef: target.conversionRef, forkSessionId: forkId(request, target) });
			return capabilityFailure(request, target, "reasoning_replay_unsupported", "target model cannot replay the current reasoning protocol");
		}
		if (request.sourceProfileId !== undefined) {
			const sourceId = this.#manifest.aliases[request.sourceProfileId] ?? request.sourceProfileId;
			const source = this.#profiles.get(sourceId);
			if (!source || source.status !== "verified") return capabilityFailure(request, target, "source_profile_unverified", "source model profile is not verified");
			const protocolChanged = source.reasoningProtocol !== target.reasoningProtocol || source.toolProtocol !== target.toolProtocol || source.imageInput !== target.imageInput;
			if (protocolChanged) {
				if (target.conversionRef !== undefined && request.operation === "switch") return makeDecision({ request, profile: target, outcome: "fork", reasonCode: "adapter_conversion_required", diagnostics: [diagnostic("adapter_conversion_required", "provider-private state is not transferable in-place")], conversionRef: target.conversionRef, forkSessionId: forkId(request, target) });
				return capabilityFailure(request, target, "protocol_incompatible", "source and target provider protocols are incompatible");
			}
		}
		return makeDecision({ request, profile: target, outcome: "compatible", reasonCode: "compatible", diagnostics: [diagnostic("compatible", "target profile satisfies the requested capabilities", "info")] });
	}
}
