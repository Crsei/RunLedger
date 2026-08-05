/**
 * Production summarizer adapter 测试 —— router alias 校验、模型调用、
 * 输出有界与非空校验、typed 失败（不静默降级）。
 */

import { describe, expect, it } from "vitest";
import { createRuntimeId, runtimeDigest } from "../../src/runtime/contracts/public.ts";
import {
	ModelCompatibilityRouter,
	loadModelCompatibilityManifest,
	type ModelCompatibilityManifestDocument,
} from "../../src/runtime/model-routing/router.ts";
import type { ModelCapabilityProfile } from "../../src/runtime/model-routing/types.ts";
import {
	createProductionSummarizer,
	SUMMARIZER_ALIAS,
	type ProductionSummarizer,
} from "../../src/cli/runtime-host-summarizer.ts";
import type { Models } from "../../src/models.ts";
import type { Api, AssistantMessage, Context, Model } from "../../src/types.ts";

function profile(overrides: Partial<ModelCapabilityProfile> = {}): ModelCapabilityProfile {
	return {
		profileId: "summarizer-llm",
		providerId: "provider",
		modelId: "summary-model",
		manifestVersion: "1",
		manifestDigest: runtimeDigest("summarizer/manifest"),
		contextWindow: 32_000,
		maxOutputTokens: 4_000,
		reasoningProtocol: "none",
		toolProtocol: "none",
		imageInput: false,
		compaction: "summary",
		status: "verified",
		...overrides,
	};
}

function manifest(profiles: readonly ModelCapabilityProfile[], aliases: Readonly<Record<string, string>> = {}): ModelCompatibilityManifestDocument {
	const body = { version: 1 as const, profiles, aliases };
	return { ...body, manifestDigest: runtimeDigest(body) };
}

function mockModels(reply: string | Error, available = true): Models {
	const model: Model<Api> = {
		id: "summary-model",
		provider: "provider",
		api: "openai",
		maxTokens: 4_000,
	};
	return {
		getModel: (provider: string, id: string) => (available && provider === "provider" && id === "summary-model" ? model : undefined),
		completeSimple: async (_model, _context) => {
			if (reply instanceof Error) throw reply;
			const message: AssistantMessage = {
				role: "assistant",
				content: [{ type: "text", text: reply }],
				api: "openai",
				provider: "provider",
				model: "summary-model",
				stopReason: "stop",
				timestamp: Date.now(),
				usage: { input: 10, output: 5 },
			};
			return message;
		},
	} as unknown as Models;
}

function router(aliases: Readonly<Record<string, string>> = { [SUMMARIZER_ALIAS]: "summarizer-llm" }): ModelCompatibilityRouter {
	const loaded = loadModelCompatibilityManifest(manifest([profile()], aliases));
	if (!loaded.ok) throw new Error(loaded.error.code);
	return new ModelCompatibilityRouter(loaded.value);
}

describe("createProductionSummarizer", () => {
	it("routes through the summarizer alias and returns the model summary with a digest", async () => {
		const summarizer = createProductionSummarizer({ models: mockModels("The agent wrote src/app.ts and ran the tests."), router: router() });
		const result = await summarizer({ transcript: "user: write app\ntool: wrote src/app.ts\n", sessionId: "session-summarizer" });

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.summary).toContain("src/app.ts");
		expect(result.summaryDigest).toEqual(runtimeDigest(result.summary));
		expect(result.route.outcome).toBe("compatible");
		expect(result.route.targetProfileId).toBe("summarizer-llm");
	});

	it("fails typed when the summarizer alias is missing from the manifest", async () => {
		const summarizer = createProductionSummarizer({ models: mockModels("summary"), router: router({}) });
		const result = await summarizer({ transcript: "transcript", sessionId: "session-summarizer" });

		expect(result).toMatchObject({ ok: false, code: "summarizer_route_denied" });
	});

	it("fails typed when the summarizer profile is incompatible", async () => {
		// summarizer profile 打开 tools → router 拒绝（summarizer_tools_enabled）。
		const summarizer = createProductionSummarizer({ models: mockModels("summary"), router: routerWithToolsProfile() });
		const result = await summarizer({ transcript: "transcript", sessionId: "session-summarizer" });

		expect(result).toMatchObject({ ok: false, code: "summarizer_route_denied" });
	});

	it("fails typed when the model is not loaded", async () => {
		const summarizer = createProductionSummarizer({ models: mockModels("summary", false), router: router() });
		const result = await summarizer({ transcript: "transcript", sessionId: "session-summarizer" });

		expect(result).toMatchObject({ ok: false, code: "summarizer_model_unavailable" });
	});

	it("caps the output at the configured byte bound", async () => {
		const summarizer = createProductionSummarizer({
			models: mockModels("x".repeat(2_000)),
			router: router(),
			maxSummaryChars: 64,
		});
		const result = await summarizer({ transcript: "transcript", sessionId: "session-summarizer" });

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.summary.length).toBe(64);
	});

	it("fails typed on an empty model reply instead of fabricating a summary", async () => {
		const summarizer = createProductionSummarizer({ models: mockModels("   "), router: router() });
		const result = await summarizer({ transcript: "transcript", sessionId: "session-summarizer" });

		expect(result).toMatchObject({ ok: false, code: "summarizer_output_invalid" });
	});

	it("propagates model request failures as typed errors", async () => {
		const summarizer = createProductionSummarizer({ models: mockModels(new Error("provider timeout")), router: router() });
		const result = await summarizer({ transcript: "transcript", sessionId: "session-summarizer" });

		expect(result).toMatchObject({ ok: false, code: "summarizer_request_failed" });
	});
});

function routerWithToolsProfile(): ModelCompatibilityRouter {
	const withTools = profile({ profileId: "summarizer-llm", toolProtocol: "json" });
	const loaded = loadModelCompatibilityManifest(manifest([withTools], { [SUMMARIZER_ALIAS]: "summarizer-llm" }));
	if (!loaded.ok) throw new Error(loaded.error.code);
	return new ModelCompatibilityRouter(loaded.value);
}
