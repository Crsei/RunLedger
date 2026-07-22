import type { Static } from "typebox";
import { Check } from "typebox/value";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
	isModelCapabilityProfile,
	isModelCompatibilityManifest,
	isModelRouteDecision,
	isModelRouteRequest,
	modelRouteDecisionPreservesInputSources,
	MAX_MODEL_PROFILES,
	ModelCompatibilityManifestSchema,
	ModelRouteDecisionSchema,
	ModelRouteRequestSchema,
} from "../../../src/runtime/model-routing/schema.ts";
import type {
	ModelCompatibilityManifest,
	ModelRouteDecision,
	ModelRouteRequest,
} from "../../../src/runtime/model-routing/types.ts";
import { runtimeEventPayloadSchema } from "../../../src/runtime/protocol/v3/event-payloads.ts";
import { asRecord, DIGEST, loadContractFixture } from "./helpers.ts";

function fixtures(): { compatible: Record<string, unknown>; fork: Record<string, unknown> } {
	return {
		compatible: asRecord(loadContractFixture("model-routing/compatible.json")),
		fork: asRecord(loadContractFixture("model-routing/incompatible-fork.json")),
	};
}

function firstProfile(manifest: unknown): unknown {
	const profiles = asRecord(manifest).profiles;
	if (!Array.isArray(profiles) || profiles.length === 0) throw new Error("manifest fixture has no profile");
	return profiles[0];
}

describe("Phase 6 model routing contracts", () => {
	it("keeps schema static types aligned with public types", () => {
		expectTypeOf<Static<typeof ModelCompatibilityManifestSchema>>().toEqualTypeOf<ModelCompatibilityManifest>();
		expectTypeOf<Static<typeof ModelRouteRequestSchema>>().toEqualTypeOf<ModelRouteRequest>();
		expectTypeOf<Static<typeof ModelRouteDecisionSchema>>().toEqualTypeOf<ModelRouteDecision>();
	});

	it("round-trips a verified manifest and compatible route", () => {
		const { compatible } = fixtures();
		const manifest = compatible.manifest;
		const request = compatible.request;
		const decision = compatible.decision;
		expect(Check(ModelCompatibilityManifestSchema, manifest)).toBe(true);
		expect(isModelCompatibilityManifest(manifest)).toBe(true);
		expect(isModelCapabilityProfile(firstProfile(manifest))).toBe(true);
		expect(Check(ModelRouteRequestSchema, request)).toBe(true);
		expect(isModelRouteRequest(request)).toBe(true);
		expect(Check(ModelRouteDecisionSchema, decision)).toBe(true);
		expect(isModelRouteDecision(decision)).toBe(true);
		if (!isModelRouteRequest(request) || !isModelRouteDecision(decision)) throw new Error("invalid route fixture");
		expect(modelRouteDecisionPreservesInputSources(request, decision)).toBe(true);
		expect(modelRouteDecisionPreservesInputSources(request, { ...decision, inputSources: [] })).toBe(false);
		expect(isModelRouteDecision(JSON.parse(JSON.stringify(decision)) as unknown)).toBe(true);
	});

	it("represents an incompatible switch only as an explicit fork", () => {
		const { fork } = fixtures();
		expect(isModelRouteDecision(fork)).toBe(true);
		expect(fork.outcome).toBe("fork");
		expect(fork.mustForkReason).toBe("provider_private_state");
		expect(isModelRouteDecision({ ...fork, outcome: "compatible" })).toBe(false);
		expect(isModelRouteDecision({ ...fork, adapterState: { ...asRecord(fork.adapterState), compatible: true } })).toBe(false);
	});

	it("fails closed on unknown versions, fields, scope and bounds", () => {
		const { compatible } = fixtures();
		const manifest = asRecord(compatible.manifest);
		const request = asRecord(compatible.request);
		expect(isModelCompatibilityManifest({ ...manifest, schemaVersion: 2 })).toBe(false);
		expect(isModelCompatibilityManifest({ ...manifest, future: true })).toBe(false);
		expect(isModelRouteRequest({ ...request, future: true })).toBe(false);
		const expectedRevision = asRecord(request.expectedRevision);
		const stream = asRecord(expectedRevision.stream);
		expect(isModelRouteRequest({
			...request,
			expectedRevision: { ...expectedRevision, stream: { ...stream, sessionId: "session_other" } },
		})).toBe(false);
		expect(isModelRouteRequest({
			...request,
			expectedRevision: { ...expectedRevision, stream: { ...stream, streamId: "eventStream_other" } },
		})).toBe(false);
		expect(Check(ModelCompatibilityManifestSchema, { ...manifest, profiles: new Array(MAX_MODEL_PROFILES + 1).fill(firstProfile(manifest)) })).toBe(false);
		const profile = asRecord(firstProfile(manifest));
		const hashes = asRecord(profile.compatibilityHashes);
		for (const required of ["toolHash", "reasoningHash", "adapterStateHash", "compactionHash", "contextHash", "profileHash", "regressionHash"]) {
			const incomplete = { ...hashes };
			delete incomplete[required];
			expect(isModelCapabilityProfile({ ...profile, compatibilityHashes: incomplete }), required).toBe(false);
		}
	});

	it("registers a bounded model route event payload", () => {
		const schema = runtimeEventPayloadSchema("model.routed");
		expect(Check(schema, {
			turnId: "turn_fixture",
			routeRequestId: "command_route",
			decisionId: "receipt_route",
			profileId: "resource_profile",
			manifestDigest: DIGEST,
			profileDigest: DIGEST,
			decisionDigest: DIGEST,
			outcome: "compatible",
		})).toBe(true);
		expect(Check(schema, {
			turnId: "turn_fixture",
			routeRequestId: "command_route-denied",
			decisionId: "receipt_route-denied",
			decisionDigest: DIGEST,
			outcome: "deny",
		})).toBe(true);
		expect(Check(schema, { turnId: "turn_fixture", outcome: "compatible" })).toBe(false);
	});
});
