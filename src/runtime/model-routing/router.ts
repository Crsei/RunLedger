import { canonicalDigest } from "../protocol/v3/canonical-json.ts";
import type { RuntimeEventPayloadMap } from "../protocol/v3/event-payloads.ts";
import { createRuntimeId, type TurnId } from "../protocol/v3/ids.ts";
import { compareAdapterState } from "./adapter-state.ts";
import { loadModelCompatibilityManifest } from "./manifest-loader.ts";
import { profileProvidesCapabilities, resolveModelProfiles } from "./profiles.ts";
import { isModelRouteRequest } from "./schema.ts";
import type {
	ModelCapabilityProfile,
	ModelCompatibilityManifest,
	ModelRouteDecision,
	ModelRouteDiagnostic,
	ModelRouteDiagnosticCode,
	ModelRouteRequest,
	ModelSwitchConversionDisposition,
	ModelSwitchConversionDispositions,
	ModelSwitchConversionReceipt,
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
		schemaVersion: 2 as const,
		authorityId: request.authorityId,
		tenantId: request.tenantId,
		principalId: request.principalId,
		requestId: request.requestId,
		inputSources: request.inputSources,
		declassificationReceipts: request.declassificationReceipts,
	};
}

function adapterConversionDisposition(
	dispositions: readonly ModelSwitchConversionDisposition[],
): ModelSwitchConversionDisposition {
	if (dispositions.includes("denied")) return "denied";
	if (dispositions.includes("fork_required")) return "fork_required";
	if (dispositions.includes("dropped")) return "dropped";
	if (dispositions.includes("unproven")) return "unproven";
	return "preserved";
}

function switchDispositions(
	request: ModelRouteRequest,
	source: ModelCapabilityProfile | undefined,
	target: ModelCapabilityProfile,
	adapterState: ReturnType<typeof compareAdapterState> | undefined,
): ModelSwitchConversionDispositions {
	if (source === undefined) {
		return {
			reasoning: "not_applicable",
			image: "not_applicable",
			toolCallIds: "not_applicable",
			adapterPrivateState: "not_applicable",
			cache: "not_applicable",
			transport: "not_applicable",
			context: "not_applicable",
			compaction: "not_applicable",
		};
	}
	if (source.profileId === target.profileId) {
		return {
			reasoning: request.requiresReasoningReplay ? "preserved" : "not_applicable",
			image: request.requiresImages ? "preserved" : "not_applicable",
			toolCallIds: request.requiresToolReplay ? "preserved" : "not_applicable",
			adapterPrivateState: "preserved",
			cache: "preserved",
			transport: "preserved",
			context: "preserved",
			compaction: "preserved",
		};
	}
	const adapterDispositions = adapterState === undefined
		? ["unproven" as const]
		: [adapterState.reasoningState, adapterState.toolReplayState, adapterState.cacheState].map(
			(value): ModelSwitchConversionDisposition =>
				value === "preserve"
					? "preserved"
					: value === "drop"
						? "dropped"
						: value === "deny"
							? "denied"
							: value,
		);
	return {
		reasoning: request.requiresReasoningReplay
			? source.compatibilityHashes.reasoningHash === target.compatibilityHashes.reasoningHash &&
					source.reasoningHistory === "portable" &&
					target.reasoningHistory === "portable"
				? "preserved"
				: "fork_required"
			: "not_applicable",
		image: request.requiresImages
			? source.imageInput && target.imageInput
				? "preserved"
				: "denied"
			: "not_applicable",
		toolCallIds: request.requiresToolReplay
			? source.compatibilityHashes.toolHash === target.compatibilityHashes.toolHash &&
					source.toolCallReplay !== "unsupported" &&
					target.toolCallReplay !== "unsupported"
				? "preserved"
				: "fork_required"
			: "not_applicable",
		adapterPrivateState: adapterConversionDisposition(adapterDispositions),
		cache: adapterState === undefined
			? "unproven"
			: adapterState.cacheState === "preserve"
				? "preserved"
				: adapterState.cacheState === "drop"
					? "dropped"
					: adapterState.cacheState === "deny"
						? "denied"
						: adapterState.cacheState,
		transport: source.apiProtocol === target.apiProtocol ? "preserved" : "unproven",
		context: source.compatibilityHashes.contextHash === target.compatibilityHashes.contextHash
			? "preserved"
			: "fork_required",
		compaction: source.compatibilityHashes.compactionHash === target.compatibilityHashes.compactionHash
			? "preserved"
			: "fork_required",
	};
}

function conversionIsLossless(dispositions: ModelSwitchConversionDispositions): boolean {
	return Object.values(dispositions).every(
		(value) =>
			value === "preserved" ||
			value === "converted_lossless" ||
			value === "not_applicable",
	);
}

function conversionReceipt(
	request: ModelRouteRequest,
	source: ModelCapabilityProfile | undefined,
	target: ModelCapabilityProfile,
	adapterState: ReturnType<typeof compareAdapterState> | undefined,
): ModelSwitchConversionReceipt {
	const dispositions = switchDispositions(request, source, target, adapterState);
	const lineageDigest = canonicalDigest({
		inputSources: request.inputSources,
		declassificationReceipts: request.declassificationReceipts,
	});
	const conversionEvidenceDigest = canonicalDigest({
		sourceCompatibilityHashes: source?.compatibilityHashes ?? null,
		targetCompatibilityHashes: target.compatibilityHashes,
		dispositions,
	});
	const identityDigest = canonicalDigest({
		requestId: request.requestId,
		sourceProfileId: source?.profileId ?? null,
		targetProfileId: target.profileId,
		conversionEvidenceDigest,
	});
	const body = {
		schemaVersion: 2 as const,
		authorityId: request.authorityId,
		tenantId: request.tenantId,
		principalId: request.principalId,
		receiptId: createRuntimeId("receipt", `model-conversion-${identityDigest.slice(0, 48)}`),
		requestId: request.requestId,
		...(source === undefined
			? {}
			: {
					sourceProfileId: source.profileId,
					sourceProfileDigest: source.profileDigest,
				}),
		targetProfileId: target.profileId,
		targetProfileDigest: target.profileDigest,
		manifestDigest: target.manifestDigest,
		dispositions,
		inputLineageDigest: lineageDigest,
		outputLineageDigest: lineageDigest,
		conversionEvidenceDigest,
	};
	return { ...body, receiptDigest: canonicalDigest(body) };
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
		if (!isModelRouteRequest(request)) {
			throw new TypeError("model route request failed exact v2 schema or stream binding validation");
		}
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
		const conversion = conversionReceipt(request, source, target, adapterState);
		const losslessConversion = conversionIsLossless(conversion.dispositions);
		const routed = {
			...base(request),
			targetModelId: target.modelId,
			profileId: target.profileId,
			manifestDigest: target.manifestDigest,
			profileDigest: target.profileDigest,
			...(adapterState === undefined ? {} : { adapterState }),
			conversionReceipt: conversion,
		};
		const privateReplayRequiresFork = source !== undefined && source.profileId !== target.profileId && (
			(request.requiresReasoningReplay && (
				source.reasoningHistory !== "portable" || target.reasoningHistory !== "portable"
			)) ||
			(request.requiresToolReplay && source.toolCallReplay !== target.toolCallReplay)
		);
		if (
			adapterState !== undefined &&
			(!adapterState.compatible || privateReplayRequiresFork || hashMismatches.length > 0 || !losslessConversion)
		) {
			const mustForkReason = adapterState.reasoningState === "deny" || adapterState.toolReplayState === "deny"
				? "mid_session_switch_unsupported" as const
				: request.requiresReasoningReplay && source?.reasoningHistory !== "portable"
					? "reasoning_history_incompatible" as const
					: hashMismatches.length > 0
						? "compatibility_hash_mismatch" as const
						: !losslessConversion
							? "conversion_lossy_or_unproven" as const
							: "tool_replay_incompatible" as const;
			return finalizeDecision(request, {
				...routed,
				outcome: "fork",
				mustForkReason,
				diagnostics: [
					...(!adapterState.compatible || privateReplayRequiresFork ? [diagnostic("adapter_state_private")] : []),
					...hashMismatches.map((key) => diagnostic("compatibility_hash_mismatch", key)),
					...(!losslessConversion
						? [diagnostic(
								Object.values(conversion.dispositions).includes("unproven")
									? "conversion_unproven"
									: "conversion_lossy",
							)]
						: []),
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
			routeContractVersion: 2,
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
		routeContractVersion: 2,
		profileId: decision.profileId,
		manifestDigest: decision.manifestDigest,
		profileDigest: decision.profileDigest,
		conversionReceiptId: decision.conversionReceipt.receiptId,
		conversionReceiptDigest: decision.conversionReceipt.receiptDigest,
	};
}
