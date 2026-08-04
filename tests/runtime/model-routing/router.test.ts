import { describe, expect, it } from "vitest";
import { createRuntimeId, runtimeDigest } from "../../../src/runtime/contracts/public.ts";
import {
	ModelCompatibilityRouter,
	loadModelCompatibilityManifest,
	type ModelCompatibilityManifestDocument,
} from "../../../src/runtime/model-routing/router.ts";
import type { ModelCapabilityProfile, ModelRouteRequest } from "../../../src/runtime/model-routing/types.ts";

function profile(overrides: Partial<ModelCapabilityProfile> = {}): ModelCapabilityProfile {
	return {
		profileId: "provider/model",
		providerId: "provider",
		modelId: "model",
		manifestVersion: "1",
		manifestDigest: runtimeDigest("provider/model/manifest"),
		contextWindow: 16_000,
		maxOutputTokens: 2_000,
		reasoningProtocol: "native",
		toolProtocol: "json",
		imageInput: false,
		compaction: "summary",
		status: "verified",
		...overrides,
	};
}

function request(overrides: Partial<ModelRouteRequest> = {}): ModelRouteRequest {
	return {
		requestId: createRuntimeId("command", "route-request"),
		operation: "switch",
		targetProfileId: "provider/model",
		contextDigest: runtimeDigest("context"),
		planDigest: runtimeDigest("plan"),
		resourceDigest: runtimeDigest("resources"),
		requiredContextTokens: 4_000,
		requiredOutputTokens: 500,
		requiresTools: true,
		requiresReasoningReplay: true,
		requiresImages: false,
		traceId: createRuntimeId("trace", "route-trace"),
		...overrides,
	};
}

function manifest(profiles: readonly ModelCapabilityProfile[], aliases: Readonly<Record<string, string>> = {}): ModelCompatibilityManifestDocument {
	const body = { version: 1 as const, profiles, aliases };
	return { ...body, manifestDigest: runtimeDigest(body) };
}

describe("ModelCompatibilityRouter", () => {
	it("resolves aliases deterministically and returns an auditable compatible decision", () => {
		const loaded = loadModelCompatibilityManifest(manifest([profile()], { default: "provider/model" }));
		expect(loaded.ok).toBe(true);
		if (!loaded.ok) return;
		const decision = new ModelCompatibilityRouter(loaded.value).route(request({ targetProfileId: "default" }));
		expect(decision.outcome).toBe("compatible");
		expect(decision.targetProviderId).toBe("provider");
		expect(decision.reasonCode).toBe("compatible");
		const { decisionDigest: _decisionDigest, ...decisionBody } = decision;
		expect(decision.decisionDigest).toEqual(runtimeDigest(decisionBody));
	});

	it("fails closed for unknown, retired, and capability-incompatible profiles", () => {
		const router = new ModelCompatibilityRouter(manifest([
			profile({ profileId: "retired/model", modelId: "retired", status: "retired" }),
		]));
		expect(router.route(request({ targetProfileId: "missing/model" })).outcome).toBe("deny");
		expect(router.route(request({ targetProfileId: "retired/model" })).outcome).toBe("deny");
		expect(router.route(request({ targetProfileId: "retired/model", requiresImages: true })).reasonCode).toBe("profile_retired");
	});

	it("forks only when a declared conversion ref can carry incompatible state", () => {
		const source = profile({
			profileId: "source/model",
			modelId: "source",
		});
		const target = profile({
			profileId: "target/model",
			modelId: "target",
			reasoningProtocol: "none",
			conversionRef: { subjectKind: "content", digest: runtimeDigest("conversion"), mediaType: "application/json", size: 10 },
		});
		const router = new ModelCompatibilityRouter(manifest([source, target]));
		const decision = router.route(request({ targetProfileId: "target/model", sourceProfileId: "source/model" }));
		expect(decision.outcome).toBe("fork");
		expect(decision.forkSessionId).toMatch(/^session_/u);
		expect(decision.conversionRef).toEqual(target.conversionRef);
	});

	it("rejects a summarizer that advertises tools or no compaction protocol", () => {
		const router = new ModelCompatibilityRouter(manifest([
			profile({ profileId: "summary/bad-tools", toolProtocol: "json" }),
			profile({ profileId: "summary/no-compact", toolProtocol: "none", compaction: "none" }),
		]));
		expect(router.route(request({ operation: "summarize", targetProfileId: "summary/bad-tools", requiresTools: false, requiresReasoningReplay: false })).reasonCode).toBe("summarizer_tools_enabled");
		expect(router.route(request({ operation: "summarize", targetProfileId: "summary/no-compact", requiresTools: false, requiresReasoningReplay: false })).reasonCode).toBe("compaction_unsupported");
	});

	it("rejects malformed or digest-tampered manifests without fallback", () => {
		const value = manifest([profile()]);
		expect(loadModelCompatibilityManifest({ ...value, manifestDigest: runtimeDigest("tampered") }).ok).toBe(false);
		expect(loadModelCompatibilityManifest({ version: 1, profiles: [], aliases: {}, manifestDigest: runtimeDigest("x"), unknown: true }).ok).toBe(false);
	});
});
