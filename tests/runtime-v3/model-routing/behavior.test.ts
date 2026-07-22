import { describe, expect, it } from "vitest";
import { canonicalDigest } from "../../../src/runtime/protocol/v3/canonical-json.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/v3/ids.ts";
import {
	calculateModelManifestDigest,
	calculateModelProfileDigest,
	loadModelCompatibilityManifest,
	ModelManifestError,
} from "../../../src/runtime/model-routing/manifest-loader.ts";
import { ModelCompatibilityRouter, modelRoutedEventPayload } from "../../../src/runtime/model-routing/router.ts";
import type { ModelCapabilityProfile, ModelCompatibilityManifest, ModelRouteRequest } from "../../../src/runtime/model-routing/types.ts";
import { authorityId, expectedRevision, NOW, principalId, sessionId, tenantId, traceId } from "../plan-context-memory/helpers.ts";

function unsignedProfile(overrides: Partial<ModelCapabilityProfile> = {}): ModelCapabilityProfile {
	const candidate: ModelCapabilityProfile = {
		schemaVersion: 1,
		authorityId,
		tenantId,
		profileId: createRuntimeId("resource", "builder"),
		modelId: "builder-model",
		providerId: "provider-a",
		manifestDigest: "0".repeat(64),
		profileDigest: "0".repeat(64),
		compatibilityHashes: {
			toolHash: canonicalDigest("tool-v1"),
			reasoningHash: canonicalDigest("reasoning-v1"),
			adapterStateHash: canonicalDigest("adapter-state-v1"),
			compactionHash: canonicalDigest("compaction-v1"),
			contextHash: canonicalDigest("context-v1"),
			profileHash: canonicalDigest("profile-v1"),
			regressionHash: canonicalDigest("regression-v1"),
		},
		contextWindow: 128_000,
		maxOutputTokens: 8_192,
		apiProtocol: "responses-v1",
		toolCallReplay: "supported",
		reasoningHistory: "portable",
		midSessionSwitch: "supported",
		imageInput: true,
		compactionStrategy: "summary",
		verifiedAliases: ["builder"],
		capabilityClaims: [],
		regressionSuite: { version: "1", suiteDigest: canonicalDigest("suite"), passed: true, completedAt: NOW },
		status: "verified",
		verifiedByPrincipalId: principalId,
		...overrides,
	};
	return { ...candidate, profileDigest: calculateModelProfileDigest(candidate) };
}

function signedManifest(profiles: readonly ModelCapabilityProfile[]): ModelCompatibilityManifest {
	const draft: ModelCompatibilityManifest = {
		schemaVersion: 1,
		authorityId,
		tenantId,
		manifestId: createRuntimeId("resource", "manifest"),
		revision: 1,
		generatedAt: NOW,
		profiles,
		manifestDigest: "0".repeat(64),
	};
	const manifestDigest = calculateModelManifestDigest(draft);
	return { ...draft, manifestDigest, profiles: profiles.map((profile) => ({ ...profile, manifestDigest })) };
}

function routeRequest(overrides: Partial<ModelRouteRequest> = {}): ModelRouteRequest {
	return {
		schemaVersion: 1,
		authorityId,
		tenantId,
		principalId,
		requestId: createRuntimeId("command", "route"),
		sessionId,
		operation: "switch",
		alias: "builder",
		requiredContextTokens: 16_000,
		requiredOutputTokens: 2_000,
		requiresToolReplay: false,
		requiresReasoningReplay: false,
		requiresImages: false,
		requiredCapabilities: [],
		inputSources: [],
		declassificationReceipts: [],
		expectedRevision,
		...overrides,
	};
}

describe("ModelCompatibilityRouter behavior", () => {
	it("validates profile and manifest digests, then routes deterministically", () => {
		const builder = unsignedProfile();
		const reviewer = unsignedProfile({ profileId: createRuntimeId("resource", "reviewer"), modelId: "review-model", verifiedAliases: ["reviewer"] });
		const manifest = signedManifest([reviewer, builder]);
		const forward = new ModelCompatibilityRouter(manifest).route(routeRequest());
		const reverse = new ModelCompatibilityRouter(signedManifest([builder, reviewer])).route(routeRequest());
		expect(forward).toEqual(reverse);
		expect(forward).toMatchObject({ outcome: "compatible", targetModelId: "builder-model", profileId: builder.profileId });
		expect(forward.inputSources).toEqual([]);
		const event = modelRoutedEventPayload(createRuntimeId("turn", "route"), forward);
		expect(event).toMatchObject({ outcome: "compatible", decisionDigest: forward.decisionDigest });
	});

	it("fails closed on digest drift, unknown alias, and retired profiles", () => {
		const manifest = signedManifest([unsignedProfile()]);
		expect(() => loadModelCompatibilityManifest({ ...manifest, revision: 2 })).toThrowError(
			expect.objectContaining<ModelManifestError>({ code: "manifest_digest_mismatch" }),
		);
		const router = new ModelCompatibilityRouter(manifest);
		expect(router.route(routeRequest({ alias: "searcher" }))).toMatchObject({ outcome: "deny" });
		const retired = unsignedProfile({ status: "retired", verifiedByPrincipalId: undefined });
		expect(new ModelCompatibilityRouter(signedManifest([retired])).route(routeRequest())).toMatchObject({ outcome: "deny" });
	});

	it("rejects missing compatibility hashes and forks on any proven hash mismatch", () => {
		const profile = unsignedProfile();
		const manifest = signedManifest([profile]);
		const { compatibilityHashes: _missing, ...withoutHashes } = profile;
		expect(() => loadModelCompatibilityManifest({ ...manifest, profiles: [withoutHashes] })).toThrowError(
			expect.objectContaining<ModelManifestError>({ code: "invalid_manifest" }),
		);

		const source = unsignedProfile({ profileId: createRuntimeId("resource", "hash-source"), modelId: "hash-source" });
		const target = unsignedProfile({
			profileId: createRuntimeId("resource", "hash-target"),
			modelId: "hash-target",
			compatibilityHashes: { ...source.compatibilityHashes, contextHash: canonicalDigest("context-v2") },
		});
		expect(new ModelCompatibilityRouter(signedManifest([source, target])).route(routeRequest({
			fromModelId: source.modelId,
			targetModelId: target.modelId,
		}))).toMatchObject({ outcome: "fork", mustForkReason: "compatibility_hash_mismatch" });
	});

	it("denies insufficient budgets and forces a fork for provider-private reasoning replay", () => {
		const source = unsignedProfile({ profileId: createRuntimeId("resource", "source"), modelId: "source-model", reasoningHistory: "adapter_private" });
		const target = unsignedProfile({ profileId: createRuntimeId("resource", "target"), modelId: "target-model", providerId: "provider-b", reasoningHistory: "adapter_private" });
		const router = new ModelCompatibilityRouter(signedManifest([source, target]));
		expect(router.route(routeRequest({ targetModelId: "target-model", requiredContextTokens: 999_999 }))).toMatchObject({ outcome: "deny" });
		expect(router.route(routeRequest({
			fromModelId: "source-model",
			targetModelId: "target-model",
			requiresReasoningReplay: true,
		}))).toMatchObject({ outcome: "fork", mustForkReason: "reasoning_history_incompatible" });
	});

	it("only selects tool-off, compaction-capable summarizer aliases", () => {
		const invalid = unsignedProfile({ verifiedAliases: ["summarizer"], toolCallReplay: "supported" });
		expect(new ModelCompatibilityRouter(signedManifest([invalid])).route(routeRequest({ alias: "summarizer", operation: "summarize" }))).toMatchObject({ outcome: "deny" });
		const valid = unsignedProfile({ verifiedAliases: ["summarizer"], toolCallReplay: "unsupported" });
		expect(new ModelCompatibilityRouter(signedManifest([valid])).route(routeRequest({ alias: "summarizer", operation: "summarize" }))).toMatchObject({ outcome: "compatible" });
	});

	it("preserves tainted input and declassification refs byte-for-byte", () => {
		const source = {
			schemaVersion: 1 as const,
			authorityId, tenantId, sourceId: createRuntimeId("inputSource", "issue"), kind: "issue" as const,
			sourceDigest: canonicalDigest("issue"), trust: "tainted" as const, taintLabels: ["external_untrusted"] as const,
			observedAt: NOW,
		};
		const decision = new ModelCompatibilityRouter(signedManifest([unsignedProfile()])).route(routeRequest({ inputSources: [source] }));
		expect(decision.inputSources).toEqual([source]);
	});
});
