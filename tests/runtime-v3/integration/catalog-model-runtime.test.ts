import { describe, expect, it } from "vitest";
import type { Api, Model } from "../../../src/types.ts";
import { canonicalDigest } from "../../../src/runtime/protocol/v3/canonical-json.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/v3/ids.ts";
import type { ContextAssemblyReceipt } from "../../../src/runtime/context/types.ts";
import type { ModelRouteDecision } from "../../../src/runtime/model-routing/types.ts";
import {
	CatalogModelCompatibilityRouter,
} from "../../../src/runtime/integration/catalog-model-router.ts";
import {
	GovernedModelRequestCoordinator,
	type GovernedModelRequestEventPort,
} from "../../../src/runtime/integration/governed-model-request.ts";
import {
	BasePromptContextProvider,
	ClassifiedTextContextProvider,
	SessionProjectionContextProvider,
} from "../../../src/runtime/integration/production-context-providers.ts";

const NOW = "2026-07-22T00:00:00.000Z";
const authorityId = createRuntimeId("authority", "catalog-runtime");
const tenantId = createRuntimeId("tenant", "catalog-runtime");
const principalId = createRuntimeId("principal", "catalog-runtime");
const sessionId = createRuntimeId("session", "catalog-runtime");
const turnId = createRuntimeId("turn", "catalog-runtime");

function model(index: number, reasoning = false): Model<Api> {
	return {
		id: `model-${index}`,
		name: `Model ${index}`,
		api: "openai-completions",
		provider: "fixture",
		baseUrl: "https://example.invalid",
		reasoning,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 16_384,
		maxTokens: 1_024,
	};
}

class RecordingEvents implements GovernedModelRequestEventPort {
	public readonly routes: ModelRouteDecision[] = [];
	public readonly contexts: ContextAssemblyReceipt[] = [];
	public async recordModelRoute(_turnId: typeof turnId, decision: ModelRouteDecision): Promise<void> {
		this.routes.push(decision);
	}
	public async recordContextAssembly(receipt: ContextAssemblyReceipt): Promise<void> {
		this.contexts.push(receipt);
	}
}

function coordinator(models: readonly Model<Api>[], extra = new Array<InstanceType<typeof ClassifiedTextContextProvider>>()) {
	const events = new RecordingEvents();
	const byId = new Map(models.map((candidate) => [`${candidate.provider}/${candidate.id}`, candidate]));
	const runtime = new GovernedModelRequestCoordinator({
		identity: { authorityId, tenantId, principalId, sessionId },
		router: new CatalogModelCompatibilityRouter({
			authorityId,
			tenantId,
			principalId,
			models,
			regression: {
				version: "fixture-v1",
				suiteDigest: canonicalDigest("fixture-suite"),
				passed: true,
				completedAt: NOW,
			},
		}),
		events,
		expectedRevision: () => ({ sessionId, sequence: 1, eventHash: "a".repeat(64) }),
		fragmentProviders: [
			new BasePromptContextProvider(principalId),
			...extra,
			new SessionProjectionContextProvider(sessionId),
		],
		resolveModel: (id) => byId.get(id),
	});
	return { runtime, events };
}

function input(selected: Model<Api>) {
	return {
		turn: 1,
		turnId,
		model: selected,
		context: { systemPrompt: "trusted base", messages: [], tools: [] },
		messages: [],
	};
}

describe("catalog governed model runtime", () => {
	it("routes an exact model beyond the single-manifest profile limit", async () => {
		const models = Array.from({ length: 600 }, (_, index) => model(index));
		const { runtime, events } = coordinator(models);
		const prepared = await runtime.prepare(input(models[599]!));
		expect(prepared.model.id).toBe("model-599");
		expect(events.routes).toHaveLength(1);
		expect(events.routes[0]).toMatchObject({ outcome: "compatible", targetModelId: "fixture/model-599" });
		expect(events.contexts[0]?.included.map((fragment) => fragment.layer)).toEqual([
			"organization_policy",
			"session_memory",
		]);
	});

	it("requires a fork before switching to another catalog profile", async () => {
		const models = [model(1, true), model(2, true)];
		const { runtime, events } = coordinator(models);
		await runtime.prepare(input(models[0]!));
		await expect(runtime.prepare(input(models[1]!))).rejects.toMatchObject({ code: "fork_required" });
		expect(events.routes.at(-1)).toMatchObject({ outcome: "fork", targetModelId: "fixture/model-2" });
	});

	it("records but omits repository instruction without context declassification", async () => {
		const sourceDigest = canonicalDigest("repo instruction");
		const external = new ClassifiedTextContextProvider({
			key: "repository-agents",
			content: "repo instruction",
			source: {
				schemaVersion: 1,
				authorityId,
				tenantId,
				sourceId: createRuntimeId("inputSource", "repository-agents"),
				kind: "instruction",
				sourceDigest,
				trust: "tainted",
				taintLabels: ["executable_instruction"],
				observedAt: NOW,
			},
			declassificationReceipts: [],
		});
		const { runtime, events } = coordinator([model(1)], [external]);
		const prepared = await runtime.prepare(input(model(1)));
		expect(prepared.context.systemPrompt).not.toContain("repo instruction");
		expect(events.contexts[0]?.omitted).toEqual([
			expect.objectContaining({ layer: "workspace_knowledge", reason: "taint_rejected" }),
		]);
	});

	it("does not verify catalog profiles when the declared regression gate failed", async () => {
		const selected = model(1);
		const router = new CatalogModelCompatibilityRouter({
			authorityId,
			tenantId,
			principalId,
			models: [selected],
			regression: {
				version: "fixture-v1",
				suiteDigest: canonicalDigest("failed-suite"),
				passed: false,
				completedAt: NOW,
			},
		});
		const request = {
			schemaVersion: 1 as const,
			authorityId,
			tenantId,
			principalId,
			requestId: createRuntimeId("command", "failed-suite"),
			sessionId,
			operation: "switch" as const,
			alias: "builder" as const,
			targetModelId: "fixture/model-1",
			requiredContextTokens: 1,
			requiredOutputTokens: 1,
			requiresToolReplay: false,
			requiresReasoningReplay: false,
			requiresImages: false,
			requiredCapabilities: [],
			inputSources: [],
			declassificationReceipts: [],
			expectedRevision: { sessionId, sequence: 0, eventHash: "b".repeat(64) },
		};
		expect(router.route(request)).toMatchObject({ outcome: "deny" });
	});
});
