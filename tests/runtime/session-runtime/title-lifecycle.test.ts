import { describe, expect, it, vi } from "vitest";
import type { Models } from "../../../src/models.ts";
import type { Api, AssistantMessage, Model } from "../../../src/types.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/ids.ts";
import { SessionTitleLifecycle } from "../../../src/runtime/session-runtime/title-lifecycle.ts";

function model(provider: string, id: string): Model<Api> {
	return {
		provider,
		id,
		name: id,
		api: "test-api",
		baseUrl: "https://example.invalid",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8_192,
		maxTokens: 512,
	};
}

function completion(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "test-api",
		provider: "coding-provider",
		model: "coding-model",
		stopReason: "stop",
		timestamp: Date.now(),
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}

function options() {
	return {
		sessionId: createRuntimeId("session", "title-lifecycle"),
		fence: {
			sessionId: createRuntimeId("session", "title-lifecycle"),
			runtimeId: createRuntimeId("runtime", "title-lifecycle"),
			generation: 3,
		},
	};
}

describe("same-model Session title lifecycle", () => {
	it("captures the active coding provider/model and sends no tools or transcript turn", async () => {
		const selected = model("coding-provider", "coding-model");
		const captured: { model?: Model<Api>; context?: { tools?: unknown[]; messages: unknown[] }; options?: Record<string, unknown> } = {};
		const setAutoTitle = vi.fn();
		const completeSimple = vi.fn(async (requestModel: Model<Api>, context: { tools?: unknown[]; messages: unknown[] }, requestOptions: Record<string, unknown>) => {
			captured.model = requestModel;
			captured.context = context;
			captured.options = requestOptions;
			return completion("<title>Fix login button</title>");
		});
		const lifecycle = new SessionTitleLifecycle({
			...options(),
			models: { completeSimple } as unknown as Models,
			getSelection: () => ({ model: selected, thinkingLevel: "medium" }),
			getCurrentTitle: () => undefined,
			setAutoTitle,
		});

		lifecycle.handleAcceptedInput("Fix the login button on mobile");
		await vi.waitFor(() => expect(setAutoTitle).toHaveBeenCalledTimes(1));
		expect(captured.model).toBe(selected);
		expect(captured.context?.tools).toEqual([]);
		expect(captured.context?.messages).toHaveLength(1);
		expect(captured.options).toMatchObject({ maxTokens: 64, temperature: 0, reasoning: "minimal" });
		expect(setAutoTitle).toHaveBeenCalledWith(expect.objectContaining({
			providerId: "coding-provider",
			modelId: "coding-model",
			expectedTitle: null,
		}));
		lifecycle.dispose();
	});

	it("does not call the model for low-signal input or slash commands, then permits a later retry", async () => {
		const completeSimple = vi.fn(async () => completion("<title>Useful task</title>"));
		const setAutoTitle = vi.fn();
		const lifecycle = new SessionTitleLifecycle({
			...options(),
			models: { completeSimple } as unknown as Models,
			getSelection: () => ({ model: model("coding-provider", "coding-model") }),
			getCurrentTitle: () => undefined,
			setAutoTitle,
		});
		lifecycle.handleAcceptedInput("hello");
		lifecycle.handleAcceptedInput("/rename local");
		await Promise.resolve();
		expect(completeSimple).not.toHaveBeenCalled();
		lifecycle.handleAcceptedInput("Implement the retry path");
		await vi.waitFor(() => expect(completeSimple).toHaveBeenCalledTimes(1));
		lifecycle.dispose();
	});

	it("does not persist a title when the completion stop reason is not terminal", async () => {
		const completeSimple = vi.fn(async () => ({ ...completion("<title>Incomplete work</title>"), stopReason: "length" as const }));
		const setAutoTitle = vi.fn();
		const lifecycle = new SessionTitleLifecycle({
			...options(),
			models: { completeSimple } as unknown as Models,
			getSelection: () => ({ model: model("coding-provider", "coding-model") }),
			getCurrentTitle: () => undefined,
			setAutoTitle,
		});

		lifecycle.handleAcceptedInput("Implement the incomplete retry path");
		await vi.waitFor(() => expect(completeSimple).toHaveBeenCalledTimes(1));
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(setAutoTitle).not.toHaveBeenCalled();
		lifecycle.dispose();
	});

	it("marks a later eligible input as retry after the first generation fails", async () => {
		let attempt = 0;
		const completeSimple = vi.fn(async () => {
			attempt += 1;
			if (attempt === 1) throw new Error("temporary title provider failure");
			return completion("<title>Retry the title request</title>");
		});
		const setAutoTitle = vi.fn();
		const onFailure = vi.fn();
		const lifecycle = new SessionTitleLifecycle({
			...options(),
			models: { completeSimple } as unknown as Models,
			getSelection: () => ({ model: model("coding-provider", "coding-model") }),
			getCurrentTitle: () => undefined,
			setAutoTitle,
			onFailure,
		});

		lifecycle.handleAcceptedInput("Generate a title for the first task");
		await vi.waitFor(() => expect(completeSimple).toHaveBeenCalledTimes(1));
		await vi.waitFor(() => expect(onFailure).toHaveBeenCalledWith("provider-error"));
		lifecycle.handleAcceptedInput("Retry title generation for the task");
		await vi.waitFor(() => expect(setAutoTitle).toHaveBeenCalledTimes(1));
		expect(setAutoTitle).toHaveBeenCalledWith(expect.objectContaining({ trigger: "retry" }));
		lifecycle.dispose();
	});

	it("cancels an in-flight title request as soon as the active model selection changes", async () => {
		const first = model("coding-provider", "coding-model");
		const second = model("other-provider", "other-model");
		let selection = first;
		let resolveCompletion: ((message: AssistantMessage) => void) | undefined;
		const completeSimple = vi.fn(() => new Promise<AssistantMessage>((resolve) => {
			resolveCompletion = resolve;
		}));
		const setAutoTitle = vi.fn();
		const onFailure = vi.fn();
		const lifecycle = new SessionTitleLifecycle({
			...options(),
			models: { completeSimple } as unknown as Models,
			getSelection: () => ({ model: selection }),
			getCurrentTitle: () => undefined,
			setAutoTitle,
			onFailure,
		});

		lifecycle.handleAcceptedInput("Create a title while the model is selected");
		await vi.waitFor(() => expect(completeSimple).toHaveBeenCalledTimes(1));
		selection = second;
		(lifecycle as unknown as { selectionChanged(): void }).selectionChanged();
		expect(onFailure).toHaveBeenCalledWith("cancelled");
		resolveCompletion?.(completion("<title>Should be discarded</title>"));
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(setAutoTitle).not.toHaveBeenCalled();
		lifecycle.dispose();
	});

	it("routes the bounded title request through the existing model request router", async () => {
		const route = vi.fn(async () => ({ outcome: "deny", reasonCode: "title_route_denied" }));
		const completeSimple = vi.fn(async () => completion("<title>Should not be sent</title>"));
		const lifecycle = new SessionTitleLifecycle({
			...options(),
			models: { completeSimple } as unknown as Models,
			getSelection: () => ({ model: model("coding-provider", "coding-model") }),
			getCurrentTitle: () => undefined,
			setAutoTitle: vi.fn(),
			modelRequestRouter: { route },
		} as never);

		lifecycle.handleAcceptedInput("Use the governed route for this title");
		await vi.waitFor(() => expect(route).toHaveBeenCalledTimes(1));
		expect(route).toHaveBeenCalledWith(expect.objectContaining({
			requestKind: "auto-title",
			targetProfileId: "coding-provider/coding-model",
			requiresTools: false,
			requiredOutputTokens: 64,
		}));
		expect(completeSimple).not.toHaveBeenCalled();
		lifecycle.dispose();
	});
});
