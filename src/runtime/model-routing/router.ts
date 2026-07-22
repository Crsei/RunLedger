import { canonicalDigest } from "../protocol/v3/canonical-json.ts";
import type { RuntimeEventPayloadMap } from "../protocol/v3/event-payloads.ts";
import { createRuntimeId, type TurnId } from "../protocol/v3/ids.ts";
import { compareAdapterState } from "./adapter-state.ts";
import { loadModelCompatibilityManifest } from "./manifest-loader.ts";
import { profileProvidesCapabilities, resolveModelProfiles } from "./profiles.ts";
import type {
	ModelCapabilityProfile,
	ModelCompatibilityManifest,
	ModelRouteDecision,
	ModelRouteDiagnostic,
	ModelRouteDiagnosticCode,
	ModelRouteRequest,
} from "./types.ts";

function diagnostic(code: ModelRouteDiagnosticCode, capability?: string): ModelRouteDiagnostic {
	const message = capability === undefined ? { code } : { code, capability };
	return {
		code,
		severity: code === "adapter_state_private" ? "warning" : "error",
		messageDigest: canonicalDigest(message),
		...(capability === undefined ? {} : { capability }),
	};
}

type DecisionWithoutDigests =
	| Omit<Extract<ModelRouteDecision, { outcome: "compatible" }>, "decisionId" | "decisionDigest">
	| Omit<Extract<ModelRouteDecision, { outcome: "fork" }>, "decisionId" | "decisionDigest">
	| Omit<Extract<ModelRouteDecision, { outcome: "deny" }>, "decisionId" | "decisionDigest">;

function finalizeDecision(
	request: ModelRouteRequest,
	body: DecisionWithoutDigests,
): ModelRouteDecision {
	const identityDigest = canonicalDigest({ requestId: request.requestId, body });
	const withId = {
		...body,
		decisionId: createRuntimeId("receipt", `route-${identityDigest.slice(0, 48)}`),
	};
	return { ...withId, decisionDigest: canonicalDigest(withId) } as ModelRouteDecision;
}

function base(request: ModelRouteRequest) {
	return {
		schemaVersion: 1 as const,
		authorityId: request.authorityId,
		tenantId: request.tenantId,
		principalId: request.principalId,
		requestId: request.requestId,
		inputSources: request.inputSources,
		declassificationReceipts: request.declassificationReceipts,
	};
}

function deny(
	request: ModelRouteRequest,
	reason: string,
	diagnostics: readonly ModelRouteDiagnostic[],
	missingCapabilities: readonly string[] = [],
	profile?: ModelCapabilityProfile,
): ModelRouteDecision {
	return finalizeDecision(request, {
		...base(request),
		outcome: "deny",
		...(profile === undefined
			? {}
			: {
					targetModelId: profile.modelId,
					profileId: profile.profileId,
					manifestDigest: profile.manifestDigest,
					profileDigest: profile.profileDigest,
				}),
		diagnostics,
		reason,
		missingCapabilities: [...missingCapabilities].sort(),
	});
}

function selectTarget(
	manifest: ModelCompatibilityManifest,
	request: ModelRouteRequest,
): ModelCapabilityProfile | undefined {
	const candidates = resolveModelProfiles(manifest, request.alias);
	return candidates.find((profile) =>
		(request.targetProfileId === undefined || profile.profileId === request.targetProfileId) &&
		(request.targetModelId === undefined || profile.modelId === request.targetModelId),
	);
}

function capabilityDiagnostics(
	request: ModelRouteRequest,
	profile: ModelCapabilityProfile,
): ModelRouteDiagnostic[] {
	const result: ModelRouteDiagnostic[] = [];
	if (profile.contextWindow < request.requiredContextTokens) result.push(diagnostic("insufficient_context_window"));
	if (profile.maxOutputTokens < request.requiredOutputTokens) result.push(diagnostic("insufficient_output_budget"));
	if (request.requiresToolReplay && profile.toolCallReplay === "unsupported") result.push(diagnostic("tool_replay_incompatible"));
	if (request.requiresReasoningReplay && profile.reasoningHistory === "unsupported") result.push(diagnostic("reasoning_history_incompatible"));
	if (request.requiresImages && !profile.imageInput) result.push(diagnostic("image_input_incompatible"));
	if (request.checkpointStrategy !== undefined && profile.compactionStrategy !== request.checkpointStrategy) {
		result.push(diagnostic("compaction_incompatible"));
	}
	if (request.operation === "summarize" && (profile.toolCallReplay !== "unsupported" || profile.compactionStrategy === "none")) {
		result.push(diagnostic("compaction_incompatible", "summarizer_tools_off"));
	}
	if (!profileProvidesCapabilities(profile, request.requiredCapabilities)) {
		result.push(...request.requiredCapabilities.map((claim) => diagnostic("capability_mismatch", claim.name)));
	}
	return result;
}

function compatibilityHashMismatches(
	source: ModelCapabilityProfile,
	target: ModelCapabilityProfile,
): readonly (keyof ModelCapabilityProfile["compatibilityHashes"])[] {
	const keys = [
		"toolHash",
		"reasoningHash",
		"adapterStateHash",
		"compactionHash",
		"contextHash",
		"profileHash",
		"regressionHash",
	] as const;
	return keys.filter((key) => source.compatibilityHashes[key] !== target.compatibilityHashes[key]);
}

export class ModelCompatibilityRouter {
	readonly #manifest: ModelCompatibilityManifest;

	public constructor(manifest: ModelCompatibilityManifest | unknown) {
		this.#manifest = loadModelCompatibilityManifest(manifest);
	}

	public route(request: ModelRouteRequest): ModelRouteDecision {
		if (request.authorityId !== this.#manifest.authorityId || request.tenantId !== this.#manifest.tenantId) {
			return deny(request, "request scope does not match compatibility manifest", [diagnostic("scope_mismatch")]);
		}
		const target = selectTarget(this.#manifest, request);
		if (target === undefined) {
			return deny(request, "no verified profile satisfies the requested alias and target", [diagnostic("unknown_profile")]);
		}
		const diagnostics = capabilityDiagnostics(request, target);
		if (diagnostics.length > 0) {
			return deny(
				request,
				"target profile does not satisfy the complete route request",
				diagnostics,
				diagnostics.filter((item) => item.capability !== undefined).map((item) => item.capability as string),
				target,
			);
		}

		const sourceRequested = request.fromProfileId !== undefined || request.fromModelId !== undefined;
		const source = sourceRequested
			? this.#manifest.profiles.find((profile) =>
				(request.fromProfileId === undefined || profile.profileId === request.fromProfileId) &&
				(request.fromModelId === undefined || profile.modelId === request.fromModelId),
			)
			: undefined;
		if (sourceRequested && (source === undefined || source.status !== "verified")) {
			return deny(request, "current model profile is unknown or unverified", [diagnostic("unknown_profile")], [], target);
		}
		const adapterState = source === undefined || source.profileId === target.profileId
			? undefined
			: compareAdapterState(source, target);
		const hashMismatches = source === undefined || source.profileId === target.profileId
			? []
			: compatibilityHashMismatches(source, target);
		const routed = {
			...base(request),
			targetModelId: target.modelId,
			profileId: target.profileId,
			manifestDigest: target.manifestDigest,
			profileDigest: target.profileDigest,
			...(adapterState === undefined ? {} : { adapterState }),
		};
		const privateReplayRequiresFork = source !== undefined && source.profileId !== target.profileId && (
			(request.requiresReasoningReplay && (
				source.reasoningHistory !== "portable" || target.reasoningHistory !== "portable"
			)) ||
			(request.requiresToolReplay && source.toolCallReplay !== target.toolCallReplay)
		);
		if (adapterState !== undefined && (!adapterState.compatible || privateReplayRequiresFork || hashMismatches.length > 0)) {
			const mustForkReason = adapterState.reasoningState === "deny" || adapterState.toolReplayState === "deny"
				? "mid_session_switch_unsupported" as const
				: request.requiresReasoningReplay && source?.reasoningHistory !== "portable"
					? "reasoning_history_incompatible" as const
					: hashMismatches.length > 0
						? "compatibility_hash_mismatch" as const
						: "tool_replay_incompatible" as const;
			return finalizeDecision(request, {
				...routed,
				outcome: "fork",
				mustForkReason,
				diagnostics: [
					...(!adapterState.compatible || privateReplayRequiresFork ? [diagnostic("adapter_state_private")] : []),
					...hashMismatches.map((key) => diagnostic("compatibility_hash_mismatch", key)),
				],
				reason: hashMismatches.length > 0
					? "compatibility hashes differ and require an audited session fork"
					: "provider-private state requires an audited session fork",
			});
		}
		return finalizeDecision(request, {
			...routed,
			outcome: "compatible",
			diagnostics: adapterState === undefined ? [] : [diagnostic("adapter_state_private")],
			reason: "verified profile satisfies route request",
		});
	}
}

export function modelRoutedEventPayload(
	turnId: TurnId,
	decision: ModelRouteDecision,
): RuntimeEventPayloadMap["model.routed"] {
	if (decision.outcome === "deny") {
		return {
			turnId,
			routeRequestId: decision.requestId,
			decisionId: decision.decisionId,
			decisionDigest: decision.decisionDigest,
			outcome: "deny",
			...(decision.profileId === undefined ? {} : { profileId: decision.profileId }),
			...(decision.manifestDigest === undefined ? {} : { manifestDigest: decision.manifestDigest }),
			...(decision.profileDigest === undefined ? {} : { profileDigest: decision.profileDigest }),
		};
	}
	return {
		turnId,
		routeRequestId: decision.requestId,
		decisionId: decision.decisionId,
		decisionDigest: decision.decisionDigest,
		outcome: decision.outcome,
		profileId: decision.profileId,
		manifestDigest: decision.manifestDigest,
		profileDigest: decision.profileDigest,
	};
}
