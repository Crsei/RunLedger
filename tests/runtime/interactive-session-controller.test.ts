import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AuthInteraction, ProviderAuth } from "../../src/auth/types.ts";
import { createModels, createProvider } from "../../src/models.ts";
import { InteractiveSessionController } from "../../src/runtime/interactive-session-controller.ts";
import { buildRunledgerLayout } from "../../src/runtime/contracts/storage-layout.ts";
import { MemoryLedger } from "../../src/runtime/ledger/memory-ledger.ts";
import type { SessionReplay } from "../../src/storage/session-codec.ts";
import { loadProjectSettings, saveProjectSettings } from "../../src/storage/settings-manager.ts";
import type { Api, AssistantMessage, AssistantMessageEventStream, Context, Model } from "../../src/types.ts";
import { createAssistantMessageEventStream } from "../../src/utils/event-stream.ts";
import type { ExtensionHookRuntime } from "../../src/extensions/turn-lifecycle.ts";
import { Type } from "typebox";
import type { AgentEvent, AgentTool } from "../../src/runtime/types.ts";
import type { ToolCall } from "../../src/types.ts";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "runledger-controller-"));
  cleanup.push(dir);
  return dir;
}

function model(provider: string, id: string): Model<Api> {
  return {
    id,
    name: `${provider} ${id}`,
    api: "mock",
    provider,
    baseUrl: "http://localhost",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8192,
    maxTokens: 1024,
  };
}

function stopStream(requestModel: Model<Api>, context: Context): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  queueMicrotask(() => {
    const user = [...context.messages].reverse().find((message) => message.role === "user");
    const input = user && typeof user.content !== "string"
      ? user.content.filter((part) => part.type === "text").map((part) => part.text).join("")
      : "";
    const usage: AssistantMessage["usage"] = {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
    const message: AssistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: `reply:${input}` }],
      api: requestModel.api,
      provider: requestModel.provider,
      model: requestModel.id,
      usage,
      stopReason: "stop",
      timestamp: Date.now(),
    };
    stream.push({ type: "start", partial: { ...message, content: [] } });
    stream.push({ type: "done", reason: "stop", message });
    stream.end(message);
  });
  return stream;
}

function apiKeyAuth(): ProviderAuth {
  return {
    apiKey: {
      name: "Fixture API key",
      login: async (interaction) => ({ type: "api_key", key: await interaction.prompt({
        type: "secret",
        message: "API key",
      }) }),
      check: async ({ credential }) => credential?.key
        ? { source: "auth.json", type: "api_key" }
        : undefined,
      resolve: async ({ credential }) => credential?.key
        ? { auth: { apiKey: credential.key }, source: "auth.json" }
        : undefined,
    },
  };
}

function fixtureModels(onStream?: () => void) {
  const models = createModels();
  const p1 = model("p1", "m1");
  const p2 = model("p2", "m2");
  for (const entry of [["p1", p1], ["p2", p2]] as const) {
    models.setProvider(createProvider({
      id: entry[0],
      name: entry[0].toUpperCase(),
      auth: apiKeyAuth(),
      models: [entry[1]],
      api: {
        stream: (requestModel, context) => {
          onStream?.();
          return stopStream(requestModel, context);
        },
        streamSimple: (requestModel, context) => {
          onStream?.();
          return stopStream(requestModel, context);
        },
      },
    }));
  }
  return { models, p1, p2 };
}

const EMPTY_REPLAY: SessionReplay = {
  messages: [],
  config: {},
  auditEntries: [],
  warnings: [],
};

const INTERACTION: AuthInteraction = {
  prompt: async () => "fixture-secret",
  notify: () => {},
};

describe("InteractiveSessionController", () => {
	it("defaults an explicitly selected model to medium thinking", async () => {
		const cwd = await tempDir();
		const { models, p1 } = fixtureModels();
		const controller = await InteractiveSessionController.create({
			cwd,
			layout: buildRunledgerLayout(join(cwd, "home"), "posix"),
			systemPrompt: "test",
			models,
			settings: {},
			replay: EMPTY_REPLAY,
			ledger: new MemoryLedger(),
			tools: [],
		});

		await controller.selectModel(p1);

		expect(controller.currentSelection.thinkingLevel).toBe("medium");
		controller.dispose();
	});

	it("falls back to high when the selected model does not support medium thinking", async () => {
		const cwd = await tempDir();
		const models = createModels();
		const highOnly = {
			...model("p1", "high-only"),
			thinkingLevelMap: { medium: null },
		} satisfies Model<Api>;
		models.setProvider(createProvider({
			id: "p1",
			name: "P1",
			auth: apiKeyAuth(),
			models: [highOnly],
			api: { stream: stopStream, streamSimple: stopStream },
		}));
		const controller = await InteractiveSessionController.create({
			cwd,
			layout: buildRunledgerLayout(join(cwd, "home"), "posix"),
			systemPrompt: "test",
			models,
			settings: {},
			replay: EMPTY_REPLAY,
			ledger: new MemoryLedger(),
			tools: [],
		});

		await controller.selectModel(highOnly);

		expect(controller.currentSelection.thinkingLevel).toBe("high");
		controller.dispose();
	});

	it("uses medium thinking when startup selects a model without an explicit thinking setting", async () => {
		const cwd = await tempDir();
		const { models, p1 } = fixtureModels();
		const controller = await InteractiveSessionController.create({
			cwd,
			layout: buildRunledgerLayout(join(cwd, "home"), "posix"),
			systemPrompt: "test",
			models,
			settings: { provider: p1.provider, model: p1.id },
			replay: EMPTY_REPLAY,
			ledger: new MemoryLedger(),
			tools: [],
		});

		expect(controller.currentSelection.thinkingLevel).toBe("medium");
		controller.dispose();
	});

	it("passes the Session Runtime active-time authority into the Agent loop", async () => {
		const cwd = await tempDir();
		const models = createModels();
		const selected = model("active-budget-provider", "active-budget-model");
		let modelCalls = 0;
		const stream = (): AssistantMessageEventStream => {
			modelCalls += 1;
			throw new Error("provider called after active-duration exhaustion");
		};
		models.setProvider(createProvider({
			id: selected.provider,
			name: "Active Budget Provider",
			auth: apiKeyAuth(),
			models: [selected],
			api: { stream, streamSimple: stream },
		}));
		const controller = await InteractiveSessionController.create({
			cwd,
			layout: buildRunledgerLayout(join(cwd, "home"), "posix"),
			systemPrompt: "test",
			models,
			settings: { provider: selected.provider, model: selected.id },
			replay: EMPTY_REPLAY,
			ledger: new MemoryLedger(),
			tools: [],
			runBudget: {
				maxModelTurns: 8,
				maxToolTurns: 8,
				maxActiveDurationMs: 10,
				maxRepeatedFailureFingerprint: 3,
				maxApprovalExpirations: 2,
			},
			runBudgetUsage: { activeDurationMs: () => 10 },
		});
		const events: AgentEvent[] = [];
		controller.subscribe((event) => { events.push(event); });
		await controller.login(selected.provider, "api_key", INTERACTION);

		await expect(controller.prompt("already exhausted")).resolves.toBeUndefined();
		expect(modelCalls).toBe(0);
		expect(events.at(-1)).toMatchObject({ type: "agent_end", terminationReason: "active_duration_limit" });
		controller.dispose();
	});

	it("enforces the production default run budget", async () => {
		const cwd = await tempDir();
		const models = createModels();
		const selected = model("budget-provider", "budget-model");
		let modelCalls = 0;
		let toolCalls = 0;
		const loopingStream = (): AssistantMessageEventStream => {
			modelCalls += 1;
			if (modelCalls > 16) throw new Error("production default run budget was omitted");
			const call: ToolCall = { type: "toolCall", id: `controller-budget-${modelCalls}`, name: "budget-loop", arguments: {} };
			const usage: AssistantMessage["usage"] = {
				input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			};
			const message: AssistantMessage = {
				role: "assistant", content: [call], api: selected.api, provider: selected.provider, model: selected.id,
				usage, stopReason: "toolUse", timestamp: Date.now(),
			};
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => {
				stream.push({ type: "start", partial: { ...message, content: [] } });
				stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: call, partial: message });
				stream.push({ type: "done", reason: "toolUse", message });
				stream.end(message);
			});
			return stream;
		};
		models.setProvider(createProvider({
			id: "budget-provider",
			name: "Budget Provider",
			auth: apiKeyAuth(),
			models: [selected],
			api: { stream: loopingStream, streamSimple: loopingStream },
		}));
		const parameters = Type.Object({});
		const tool: AgentTool<typeof parameters> = {
			name: "budget-loop",
			label: "budget-loop",
			description: "production budget fixture",
			parameters,
			execute: async () => {
				toolCalls += 1;
				return { content: [{ type: "text", text: "continue" }], details: {} };
			},
		};
		const controller = await InteractiveSessionController.create({
			cwd,
			layout: buildRunledgerLayout(join(cwd, "home"), "posix"),
			systemPrompt: "test",
			models,
			settings: { provider: selected.provider, model: selected.id },
			replay: EMPTY_REPLAY,
			ledger: new MemoryLedger(),
			tools: [tool],
		});
		const events: AgentEvent[] = [];
		controller.subscribe((event) => { events.push(event); });
		await controller.login(selected.provider, "api_key", INTERACTION);

		await expect(controller.prompt("loop until bounded")).resolves.toBeUndefined();
		expect(modelCalls).toBe(16);
		expect(toolCalls).toBe(16);
		expect(events.at(-1)).toMatchObject({ type: "agent_end", stopReason: "length", terminationReason: "tool_turn_limit" });
		controller.dispose();
	});

	it("refuses to construct production stdlib tools without a Host ExecutionEnv", async () => {
		const cwd = await tempDir();
		const { models, p1 } = fixtureModels();
		await expect(InteractiveSessionController.create({
			cwd,
			layout: buildRunledgerLayout(join(cwd, "home"), "posix"),
			systemPrompt: "test",
			models,
			settings: { provider: "p1", model: "m1" },
			replay: EMPTY_REPLAY,
			ledger: new MemoryLedger(),
		})).rejects.toThrow("governed ExecutionEnv is required for production stdlib tools");
	});

	it("applies a Host UserPromptSubmit hook before sending the model request", async () => {
		const cwd = await tempDir();
		const { models, p1 } = fixtureModels();
		const hookRuntime: ExtensionHookRuntime = {
			run: async (input) => ({
				decision: "allow",
				blocked: false,
				finalInput: input.event === "UserPromptSubmit" ? { text: "rewritten by hook" } : input.input,
				requiresRevalidation: input.event === "UserPromptSubmit",
				requiresAuthorization: false,
				additionalContext: [],
			}),
		};
		const controller = await InteractiveSessionController.create({
			cwd,
			layout: buildRunledgerLayout(join(cwd, "home"), "posix"),
			systemPrompt: "test",
			models,
			settings: {},
			replay: EMPTY_REPLAY,
			ledger: new MemoryLedger(),
			tools: [],
			extensionHookRuntime: hookRuntime,
			extensionHookSnapshotId: () => "snapshot_hook-controller",
		});
		await controller.login("p1", "api_key", INTERACTION);
		await controller.selectModel(p1);
		await controller.prompt("original prompt");
		expect(controller.messages.at(-1)).toMatchObject({ content: [{ type: "text", text: "reply:rewritten by hook" }] });
		controller.dispose();
	});

	it("admits the extension turn before binding UserPromptSubmit to its snapshot", async () => {
		const cwd = await tempDir();
		const order: string[] = [];
		let snapshotId: string | undefined;
		const { models, p1 } = fixtureModels(() => order.push("model"));
		const controller = await InteractiveSessionController.create({
			cwd,
			layout: buildRunledgerLayout(join(cwd, "home"), "posix"),
			systemPrompt: "test",
			models,
			settings: {},
			replay: EMPTY_REPLAY,
			ledger: new MemoryLedger(),
			tools: [],
			extensionHookRuntime: {
				run: async (input) => {
					order.push(`hook:${input.snapshotId}`);
					return {
						decision: "allow",
						blocked: false,
						finalInput: input.input,
						requiresRevalidation: false,
						requiresAuthorization: false,
						additionalContext: [],
					};
				},
			},
			extensionHookSnapshotId: () => snapshotId,
			extensionTurnAdmission: async () => {
				order.push("admit");
				snapshotId = "snapshot_admitted-turn";
			},
		});
		await controller.login("p1", "api_key", INTERACTION);
		await controller.selectModel(p1);

		await controller.prompt("ordered prompt");

		expect(order).toEqual(["admit", "hook:snapshot_admitted-turn", "model"]);
		controller.dispose();
	});

	it("aborts an admitted extension turn when UserPromptSubmit denies the prompt", async () => {
		const cwd = await tempDir();
		let snapshotId: string | undefined;
		const order: string[] = [];
		const { models, p1 } = fixtureModels(() => order.push("model"));
		const controller = await InteractiveSessionController.create({
			cwd,
			layout: buildRunledgerLayout(join(cwd, "home"), "posix"),
			systemPrompt: "test",
			models,
			settings: {},
			replay: EMPTY_REPLAY,
			ledger: new MemoryLedger(),
			tools: [],
			extensionHookRuntime: {
				run: async () => {
					order.push("hook");
					return {
						decision: "deny",
						blocked: true,
						finalInput: { text: "denied prompt" },
						requiresRevalidation: false,
						requiresAuthorization: true,
						additionalContext: [],
					};
				},
			},
			extensionHookSnapshotId: () => snapshotId,
			extensionTurnAdmission: async () => {
				order.push("admit");
				snapshotId = "snapshot_denied-turn";
			},
			extensionTurnAbort: async () => {
				order.push("abort");
			},
		});
		await controller.login("p1", "api_key", INTERACTION);
		await controller.selectModel(p1);

		await expect(controller.prompt("denied prompt")).rejects.toThrow("UserPromptSubmit hook denied the prompt");

		expect(order).toEqual(["admit", "hook", "abort"]);
		controller.dispose();
	});

	it("选择优先级为 CLI override > session > settings，并解析 provider/model 形式", async () => {
    const cwd = await tempDir();
    const { models, p2 } = fixtureModels();
    const controller = await InteractiveSessionController.create({
      cwd,
      layout: buildRunledgerLayout(join(cwd, "home"), "posix"),
      systemPrompt: "test",
      models,
      settings: { provider: "p1", model: "m1", thinkingLevel: "low" },
      replay: {
        ...EMPTY_REPLAY,
        config: { provider: "p1", model: "m1", thinkingLevel: "medium" },
      },
      ledger: new MemoryLedger(),
      overrides: { model: "p2/m2", thinkingLevel: "high" },
      tools: [],
    });

    expect(controller.currentSelection).toEqual({ provider: "p2", model: p2, thinkingLevel: "high" });
    controller.dispose();
  });

  it("API key login、模型/thinking 持久化、真实对话与 logout 前置检查贯通", async () => {
    const cwd = await tempDir();
    const { models, p1 } = fixtureModels();
    const ledger = new MemoryLedger();
    const controller = await InteractiveSessionController.create({
      cwd,
      layout: buildRunledgerLayout(join(cwd, "home"), "posix"),
      systemPrompt: "test",
      models,
      settings: {},
      replay: EMPTY_REPLAY,
      ledger,
      tools: [],
    });

    expect(controller.currentSelection.model).toBeUndefined();
    await controller.login("p1", "api_key", INTERACTION);
    const statuses = await controller.getProviderStatuses();
    expect(statuses.find((status) => status.id === "p1")).toMatchObject({
      configured: true,
      source: "auth.json",
      authTypes: ["api_key"],
      interactiveAuthTypes: ["api_key"],
    });

    await controller.selectModel(p1);
    expect(await controller.setThinkingLevel("high")).toBe("high");
    await controller.prompt("hello controller");
    expect(controller.messages.at(-1)).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "reply:hello controller" }],
    });

    expect(await loadProjectSettings({ layout: buildRunledgerLayout(join(cwd, "home"), "posix") })).toMatchObject({
      provider: "p1",
      model: "m1",
      thinkingLevel: "high",
    });
    const configEntries = ledger.entries().filter((entry) =>
      entry.type === "custom" && entry.payload.kind === "runtime.config"
    );
    expect(configEntries.map((entry) => entry.payload.source)).toEqual(["model", "thinking"]);

    await controller.logout("p1");
    await expect(controller.prompt("must authenticate again")).rejects.toThrow("not configured");
    controller.dispose();
  });

	it("preserves a concurrently saved syntax theme when model selection persists", async () => {
		const cwd = await tempDir();
		const layout = buildRunledgerLayout(join(cwd, "home"), "posix");
		const { models, p1 } = fixtureModels();
		const controller = await InteractiveSessionController.create({
			cwd,
			layout,
			systemPrompt: "test",
			models,
			settings: { theme: "dracula" },
			replay: EMPTY_REPLAY,
			ledger: new MemoryLedger(),
			tools: [],
		});
		await saveProjectSettings({ layout }, { theme: "ansi" });
		await controller.selectModel(p1);
		expect(await loadProjectSettings({ layout })).toMatchObject({ theme: "ansi", provider: "p1", model: "m1" });
		controller.dispose();
	});

  it("resolves the full catalog model on selectModel even when the wire passes a minimal shape", async () => {
    const cwd = await tempDir();
    const { models, p1 } = fixtureModels();
    const controller = await InteractiveSessionController.create({
      cwd,
      layout: buildRunledgerLayout(join(cwd, "home"), "posix"),
      systemPrompt: "test",
      models,
      settings: {},
      replay: EMPTY_REPLAY,
      ledger: new MemoryLedger(),
      tools: [],
    });
    // 命令面 select_model 只传 { provider, id }(无 baseUrl/compat 等字段)。
    await controller.selectModel({ provider: "p1", id: "m1" } as Model<Api>);
    expect(controller.currentSelection.model?.baseUrl).toBe(p1.baseUrl);
    expect(controller.currentSelection.model?.provider).toBe("p1");
    controller.dispose();
  });

	it("runs idle recap through the active model without mutating the interactive transcript", async () => {
		const cwd = await tempDir();
		const { models, p1 } = fixtureModels();
		const initialMessages: AgentTool[] = [];
		const controller = await InteractiveSessionController.create({
			cwd,
			layout: buildRunledgerLayout(join(cwd, "home"), "posix"),
			systemPrompt: "test system",
			models,
			settings: { provider: p1.provider, model: p1.id },
			replay: {
				...EMPTY_REPLAY,
				messages: [{ role: "user", content: [{ type: "text", text: "ship the feature" }] }],
			},
			ledger: new MemoryLedger(),
			tools: initialMessages,
		});
		await controller.login(p1.provider, "api_key", INTERACTION);
		const before = controller.messages;
		const events: AgentEvent[] = [];
		controller.subscribe((event) => events.push(event));

		const result = await (controller as unknown as {
			runEphemeralTurn(input: { promptText: string; requestId: string; signal: AbortSignal }): Promise<string | undefined>;
		}).runEphemeralTurn({
			promptText: "User stepped away; returning. Summarize the next action in plain text.",
			requestId: "idle-recap-controller-fixture",
			signal: new AbortController().signal,
		});

		expect(result).toContain("Summarize the next action");
		expect(controller.messages).toEqual(before);
		expect(events).toEqual([]);
		controller.dispose();
	});
});
