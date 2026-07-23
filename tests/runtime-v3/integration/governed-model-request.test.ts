import { describe, expect, it, vi } from "vitest";
import type { Api, Model } from "../../../src/types.ts";
import { canonicalDigest } from "../../../src/runtime/protocol/v3/canonical-json.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/v3/ids.ts";
import { createSessionEventStreamRef } from "../../../src/runtime/protocol/v3/events.ts";
import { ContextEngine } from "../../../src/runtime/context/context-engine.ts";
import type { ContextFragment } from "../../../src/runtime/context/types.ts";
import {
	calculateModelManifestDigest,
	calculateModelProfileEvidenceDigest,
	calculateModelProfileDigest,
} from "../../../src/runtime/model-routing/manifest-loader.ts";
import { ModelCompatibilityRouter } from "../../../src/runtime/model-routing/router.ts";
import type {
	ModelCapabilityProfile,
	ModelCompatibilityManifest,
	ModelRouteDecision,
} from "../../../src/runtime/model-routing/types.ts";
import {
	PI_AI_CATALOG_DIGEST,
	PI_AI_PARITY_MANIFEST_DIGEST,
	PI_AI_UPSTREAM_COMMIT,
	RUNLEDGER_PARITY_BASE_COMMIT,
} from "../../../src/runtime/model-routing/types.ts";
import {
	GovernedModelRequestCoordinator,
	GovernedModelRequestError,
	type GovernedContextFragmentProvider,
	type GovernedModelRequestEventPort,
} from "../../../src/runtime/integration/governed-model-request.ts";
import type { ContextAssemblyReceipt } from "../../../src/runtime/context/types.ts";
import type { ModelRequestPreparationInput } from "../../../src/runtime/types.ts";

const NOW = "2026-07-22T00:00:00.000Z";
const authorityId = createRuntimeId("authority", "model-integration");
const tenantId = createRuntimeId("tenant", "model-integration");
const principalId = createRuntimeId("principal", "model-integration");
const sessionId = createRuntimeId("session", "model-integration");
const turnId = createRuntimeId("turn", "model-integration");

function model(id = "builder"): Model<Api> {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider: "fixture",
		baseUrl: "https://example.invalid",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 16_384,
		maxTokens: 2_048,
	};
}

function unsignedProfile(id = "builder", overrides: Partial<ModelCapabilityProfile> = {}): ModelCapabilityProfile {
	const candidateWithoutEvidence: ModelCapabilityProfile = {
		schemaVersion: 2,
		authorityId,
		tenantId,
		profileId: createRuntimeId("resource", `profile-${id}`),
		modelId: `fixture/${id}`,
		providerId: "fixture",
		manifestDigest: "0".repeat(64),
		profileDigest: "0".repeat(64),
		evidence: {
			piAiParityManifestDigest: PI_AI_PARITY_MANIFEST_DIGEST,
			catalogDigest: PI_AI_CATALOG_DIGEST,
			upstreamCommit: PI_AI_UPSTREAM_COMMIT,
			runLedgerBaseCommit: RUNLEDGER_PARITY_BASE_COMMIT,
			catalogEntryDigest: canonicalDigest("pending"),
			compatibilityEvidenceDigest: canonicalDigest("pending"),
			evidenceDigest: canonicalDigest("pending"),
		},
		compatibilityHashes: {
			toolHash: canonicalDigest("tool-v1"),
			reasoningHash: canonicalDigest("reasoning-v1"),
			adapterStateHash: canonicalDigest("adapter-state-v1"),
			compactionHash: canonicalDigest("compaction-v1"),
			contextHash: canonicalDigest("context-v1"),
			profileHash: canonicalDigest("profile-v1"),
			regressionHash: canonicalDigest("regression-v1"),
		},
		contextWindow: 16_384,
		maxOutputTokens: 2_048,
		apiProtocol: "openai-completions",
		toolCallReplay: "supported",
		reasoningHistory: "portable",
		midSessionSwitch: "supported",
		imageInput: true,
		compactionStrategy: "summary",
		verifiedAliases: ["builder"],
		capabilityClaims: [],
		regressionSuite: { version: "1", suiteDigest: canonicalDigest(`suite-${id}`), passed: true, completedAt: NOW },
		status: "verified",
		verifiedByPrincipalId: principalId,
		...overrides,
	};
	const unsignedEvidence = {
		piAiParityManifestDigest: PI_AI_PARITY_MANIFEST_DIGEST,
		catalogDigest: PI_AI_CATALOG_DIGEST,
		upstreamCommit: PI_AI_UPSTREAM_COMMIT,
		runLedgerBaseCommit: RUNLEDGER_PARITY_BASE_COMMIT,
		catalogEntryDigest: canonicalDigest({
			providerId: candidateWithoutEvidence.providerId,
			modelId: candidateWithoutEvidence.modelId,
			apiProtocol: candidateWithoutEvidence.apiProtocol,
		}),
		compatibilityEvidenceDigest: canonicalDigest(candidateWithoutEvidence.compatibilityHashes),
		evidenceDigest: "0".repeat(64),
	};
	const candidate = {
		...candidateWithoutEvidence,
		evidence: {
			...unsignedEvidence,
			evidenceDigest: calculateModelProfileEvidenceDigest(unsignedEvidence),
		},
	};
	return { ...candidate, profileDigest: calculateModelProfileDigest(candidate) };
}

function manifest(profiles: readonly ModelCapabilityProfile[]): ModelCompatibilityManifest {
	const draft: ModelCompatibilityManifest = {
		schemaVersion: 2,
		authorityId,
		tenantId,
		manifestId: createRuntimeId("resource", "model-integration-manifest"),
		revision: 1,
		generatedAt: NOW,
		piAiParityManifestDigest: PI_AI_PARITY_MANIFEST_DIGEST,
		catalogDigest: PI_AI_CATALOG_DIGEST,
		upstreamCommit: PI_AI_UPSTREAM_COMMIT,
		runLedgerBaseCommit: RUNLEDGER_PARITY_BASE_COMMIT,
		profiles,
		manifestDigest: "0".repeat(64),
	};
	const manifestDigest = calculateModelManifestDigest(draft);
	return { ...draft, manifestDigest, profiles: profiles.map((profile) => ({ ...profile, manifestDigest })) };
}

function fragment(key: string, content: string, order: number): ContextFragment {
	const contentDigest = canonicalDigest(content);
	return {
		schemaVersion: 1,
		authorityId,
		tenantId,
		fragmentId: createRuntimeId("resource", `fragment-${key}`),
		layer: key === "base" ? "organization_policy" : "session_memory",
		order,
		contentDigest,
		trust: key === "base" ? "system" : "derived",
		taint: [],
		inputSources: [],
		declassificationReceipts: [],
		priority: key === "base" ? "required" : "high",
		maxTokens: 4_096,
		maxChars: 65_536,
		provenance: {
			authorityId,
			tenantId,
			kind: "session_range",
			sessionId,
			fromSequence: 0,
			toSequence: 0,
			sourceDigest: contentDigest,
			observedAt: NOW,
		},
		storage: "inline",
		content,
	};
}

function input(selected = model()): ModelRequestPreparationInput {
	return {
		turn: 1,
		turnId,
		model: selected,
		context: { systemPrompt: "governed base prompt", messages: [], tools: [] },
		messages: [],
	};
}

class RecordingEvents implements GovernedModelRequestEventPort {
	readonly records: Array<{ type: "route"; decision: ModelRouteDecision } | { type: "context"; receipt: ContextAssemblyReceipt }> = [];
	public async recordModelRoute(_turnId: typeof turnId, decision: ModelRouteDecision): Promise<void> {
		this.records.push({ type: "route", decision });
	}
	public async recordContextAssembly(receipt: ContextAssemblyReceipt): Promise<void> {
		this.records.push({ type: "context", receipt });
	}
}

function baseProvider(extra: readonly ContextFragment[] = []): GovernedContextFragmentProvider {
	return {
		load: ({ input: request }) => ({
			fragments: [fragment("base", request.context.systemPrompt ?? "", 0), ...extra],
			consumedSystemPromptDigest: canonicalDigest(request.context.systemPrompt ?? ""),
		}),
	};
}

function coordinator(options: {
	profiles?: readonly ModelCapabilityProfile[];
	providers?: readonly GovernedContextFragmentProvider[];
	events?: RecordingEvents;
	onForkRequired?: (decision: Extract<ModelRouteDecision, { outcome: "fork" }>) => Promise<void> | void;
} = {}): { coordinator: GovernedModelRequestCoordinator; events: RecordingEvents } {
	const events = options.events ?? new RecordingEvents();
	return {
		events,
		coordinator: new GovernedModelRequestCoordinator({
			identity: { authorityId, tenantId, principalId, sessionId },
			router: new ModelCompatibilityRouter(manifest(options.profiles ?? [unsignedProfile()])),
			events,
			expectedRevision: () => ({
				stream: createSessionEventStreamRef({ authorityId, tenantId }, sessionId),
				sequence: 1,
				eventHash: "a".repeat(64),
			}),
			fragmentProviders: options.providers ?? [baseProvider([fragment("plan", "approved plan", 1)])],
			contextEngine: new ContextEngine({ clock: () => new Date(NOW) }),
			traceIdFactory: () => createRuntimeId("trace", "model-integration"),
			resolveModel: (id) => id === "fixture/builder" ? model() : id === "fixture/reviewer" ? model("reviewer") : undefined,
			...(options.onForkRequired ? { onForkRequired: options.onForkRequired } : {}),
		}),
	};
}

describe("GovernedModelRequestCoordinator", () => {
	it("durably routes and assembles all prompt fragments before returning a provider request", async () => {
		const runtime = coordinator();
		const prepared = await runtime.coordinator.prepare(input());
		expect(runtime.events.records.map((record) => record.type)).toEqual(["route", "context"]);
		expect(prepared.model.id).toBe("builder");
		expect(prepared.context.systemPrompt).toContain("governed base prompt");
		expect(prepared.context.systemPrompt).toContain("approved plan");
		expect(runtime.events.records[1]).toMatchObject({ type: "context", receipt: { included: [{ layer: "organization_policy" }, { layer: "session_memory" }] } });
	});

	it("records a denied route but never loads context or returns a model request", async () => {
		const load = vi.fn<GovernedContextFragmentProvider["load"]>();
		const runtime = coordinator({ profiles: [unsignedProfile("builder", { status: "retired", verifiedByPrincipalId: undefined })], providers: [{ load }] });
		await expect(runtime.coordinator.prepare(input())).rejects.toMatchObject<GovernedModelRequestError>({ code: "route_denied" });
		expect(load).not.toHaveBeenCalled();
		expect(runtime.events.records).toHaveLength(1);
		expect(runtime.events.records[0]).toMatchObject({ type: "route", decision: { outcome: "deny" } });
	});

	it("rejects a hidden or multiply consumed system prompt before context receipt", async () => {
		const noConsumer: GovernedContextFragmentProvider = { load: () => ({ fragments: [] }) };
		const runtime = coordinator({ providers: [noConsumer] });
		await expect(runtime.coordinator.prepare(input())).rejects.toMatchObject<GovernedModelRequestError>({ code: "system_prompt_unclassified" });
		expect(runtime.events.records.map((record) => record.type)).toEqual(["route"]);
	});

	it("requires an audited fork for provider-private reasoning instead of switching in-session", async () => {
		const builder = unsignedProfile("builder", { reasoningHistory: "adapter_private" });
		const reviewer = unsignedProfile("reviewer", { reasoningHistory: "adapter_private" });
		const onForkRequired = vi.fn();
		const runtime = coordinator({ profiles: [builder, reviewer], onForkRequired });
		await runtime.coordinator.prepare(input());
		const next = input(model("reviewer"));
		next.messages = [{
			role: "assistant",
			content: [{ type: "thinking", thinking: "private", thinkingSignature: "sig" }],
			api: "openai-completions",
			provider: "fixture",
			model: "builder",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: "stop",
			timestamp: 0,
		}];
		await expect(runtime.coordinator.prepare(next)).rejects.toMatchObject<GovernedModelRequestError>({ code: "fork_required" });
		expect(onForkRequired).toHaveBeenCalledOnce();
		expect(runtime.events.records.at(-1)).toMatchObject({ type: "route", decision: { outcome: "fork" } });
	});

	it("fails before provider preparation when a durable route receipt cannot be written", async () => {
		const events: RecordingEvents = new RecordingEvents();
		events.recordModelRoute = async () => { throw new Error("event store unavailable"); };
		const runtime = coordinator({ events });
		await expect(runtime.coordinator.prepare(input())).rejects.toThrow("event store unavailable");
		expect(events.records).toHaveLength(0);
	});
});
