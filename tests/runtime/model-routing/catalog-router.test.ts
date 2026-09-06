import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createCatalogModelRouter } from "../../../src/runtime/model-routing/catalog-router.ts";
import { createCliSessionModelRequestRouterFactory } from "../../../src/cli/session-model-router.ts";
import { createModels, createProvider } from "../../../src/models.ts";
import { buildRunledgerLayout } from "../../../src/runtime/contracts/storage-layout.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/ids.ts";
import { runtimeDigest } from "../../../src/runtime/protocol/foundation.ts";
import type { ModelRouteRequest } from "../../../src/runtime/model-routing/types.ts";
import type { Api, Model } from "../../../src/types.ts";

const model: Model<Api> = {
	provider: "deepseek", id: "deepseek-v4-pro", api: "openai-completions", name: "Pro", baseUrl: "http://localhost",
	reasoning: true, input: ["text"], contextWindow: 8_192, maxTokens: 1_024,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
function request(overrides: Partial<ModelRouteRequest> = {}): ModelRouteRequest {
	return {
		requestId: createRuntimeId("command", "catalog-request"), operation: "request", requestKind: "interactive",
		targetProfileId: "deepseek/deepseek-v4-pro", contextDigest: runtimeDigest("context"),
		planDigest: runtimeDigest("plan"), resourceDigest: runtimeDigest("tools"),
		requiredContextTokens: 100, requiredOutputTokens: 1_024, requiresTools: true,
		requiresReasoningReplay: true, requiresImages: false, traceId: createRuntimeId("trace", "catalog-request"),
		...overrides,
	};
}
function registry() {
	const models = createModels();
	const unusedStream = () => { throw new Error("routing test must not dispatch"); };
	models.setProvider(createProvider({ id: "deepseek", models: [model], auth: {}, api: { stream: unusedStream, streamSimple: unusedStream } }));
	return models;
}

describe("catalog model admission", () => {
	it("uses the live catalog even with a missing or corrupt user compatibility manifest", async () => {
		const home = await mkdtemp(join(tmpdir(), "runledger-catalog-admission-"));
		try {
			const layout = buildRunledgerLayout(home, "posix");
			const models = registry();
			for (const corrupt of [false, true]) {
				if (corrupt) {
					await mkdir(join(layout.state, "model-compatibility"), { recursive: true });
					await writeFile(join(layout.state, "model-compatibility", "manifest.json"), "{broken");
				}
				const factory = await createCliSessionModelRequestRouterFactory({
					layout, models, authorityId: createRuntimeId("authority", "test"), tenantId: createRuntimeId("tenant", "test"),
				});
				expect(factory.isModelSelectable(model)).toBe(true);
				const router = factory.forSession({ sessionId: createRuntimeId("session", `catalog-${corrupt}`), workspaceStorageKey: `ws-${"b".repeat(64)}` });
				await expect(router.route(request())).resolves.toMatchObject({ outcome: "compatible", targetModelId: model.id });
			}
		} finally { await rm(home, { recursive: true, force: true }); }
	});

	it("denies invalid catalog limits without failing receipt digest creation", () => {
		const router = createCatalogModelRouter({ getModel: () => ({ ...model, contextWindow: Number.NaN }) });
		expect(router.route(request())).toMatchObject({ outcome: "deny", reasonCode: "model_metadata_invalid" });
	});

	it("allows foreign history conversion but rejects unknown models and insufficient budgets", () => {
		const router = createCatalogModelRouter(registry());
		expect(router.route(request({ sourceProfileId: "retired-provider/old", requiresImages: true }))).toMatchObject({ outcome: "compatible" });
		expect(router.route(request({ targetProfileId: "deepseek/missing" }))).toMatchObject({ outcome: "deny", reasonCode: "model_unknown" });
		expect(router.route(request({ requiredOutputTokens: 1_025 }))).toMatchObject({ outcome: "deny", reasonCode: "output_budget_insufficient" });
		expect(router.route(request({ requiredContextTokens: 8_000 }))).toMatchObject({ outcome: "deny", reasonCode: "context_window_insufficient" });
	});
});
