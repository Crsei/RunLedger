import { describe, expect, it } from "vitest";
import { createExtensionApi, ExtensionRuntimeNotInitializedError } from "../../../src/extensions/host/runtime-api.ts";
import type { ExtensionActionRequest } from "../../../src/extensions/host/runtime-api.ts";
import { EXTENSION_DEFAULT_HOST_LIMITS } from "../../../src/contracts/extensions/registry.ts";

function apiWithLimits(limits = EXTENSION_DEFAULT_HOST_LIMITS) {
	return createExtensionApi({ limits });
}

describe("extension runtime API registration/action split", () => {
	it("rejects every action until initialize has bound a dispatcher", async () => {
		const runtime = apiWithLimits();
		const notInitialized = [
			() => runtime.api.sendMessage("hello"),
			() => runtime.api.sendUserMessage("hello"),
			() => runtime.api.appendEntry({ kind: "note" }),
			() => runtime.api.setActiveTools(["bash"]),
			() => runtime.api.setModel({ providerId: "p", modelId: "m" }),
			() => runtime.api.setThinkingLevel("high"),
			() => runtime.api.setSessionName("name"),
			() => runtime.api.exec({ command: "ls" }),
			() => runtime.api.emitIntent({ kind: "notify", level: "info", text: "hi" }),
		];
		for (const action of notInitialized) {
			await expect(action()).rejects.toBeInstanceOf(ExtensionRuntimeNotInitializedError);
		}
	});

	it("forwards bound actions to the owner dispatcher and returns its receipt", async () => {
		const seen: ExtensionActionRequest[] = [];
		const runtime = apiWithLimits();
		runtime.initialize({
			dispatch: async (request) => {
				seen.push(request);
				return { ok: true, value: { committed: true } };
			},
		});
		await expect(runtime.api.setModel({ providerId: "openai", modelId: "gpt" })).resolves.toEqual({ ok: true, value: { committed: true } });
		expect(seen).toEqual([{ action: "set-model", payload: { providerId: "openai", modelId: "gpt" } }]);
	});

	it("propagates owner rejection without throwing", async () => {
		const runtime = apiWithLimits();
		runtime.initialize({ dispatch: async () => ({ ok: false, code: "model_unavailable", message: "no credentials" }) });
		await expect(runtime.api.setModel({ providerId: "openai", modelId: "gpt" })).resolves.toEqual({ ok: false, code: "model_unavailable", message: "no credentials" });
	});

	it("routes intents through the intent action instead of a UI handle", async () => {
		const seen: ExtensionActionRequest[] = [];
		const runtime = apiWithLimits();
		runtime.initialize({ dispatch: async (request) => { seen.push(request); return { ok: true }; } });
		await runtime.api.emitIntent({ kind: "status", level: "info", key: "phase", text: "running" });
		await runtime.api.requestUserDecision("proceed?", ["yes", "no"]);
		expect(seen[0]?.action).toBe("intent");
		expect(seen[0]?.intent).toEqual({ kind: "status", level: "info", key: "phase", text: "running" });
		expect(seen[1]?.intent?.kind).toBe("decision-request");
		await expect(runtime.api.emitIntent({ kind: "dialog", level: "info", text: "x" } as never)).resolves.toEqual({ ok: false, code: "invalid_intent", message: "intent does not match the extension contract" });
		await expect(runtime.api.requestUserDecision("q", [])).resolves.toEqual({ ok: false, code: "invalid_options", message: "decision request requires 1..8 options" });
	});

	it("validates and bounds registrations at registration time", () => {
		const runtime = apiWithLimits();
		runtime.api.registerTool({ name: "sample_tool", description: "reads", parameters: { type: "object" }, approvalClass: "read-only", handler: () => ({ ok: true }) });
		expect(runtime.api.registrations.tools.map((tool) => tool.name)).toEqual(["sample_tool"]);
		expect(() => runtime.api.registerTool({ name: "sample_tool", description: "again", parameters: {}, approvalClass: "read-only", handler: () => undefined })).toThrow(/duplicate tool registration/u);
		expect(() => runtime.api.registerTool({ name: "9bad", description: "x", parameters: {}, approvalClass: "read-only", handler: () => undefined })).toThrow(/does not match the extension contract/u);
		// handler 是必需的：没有它 owner 侧永远调不动这个工具。
		expect(() => runtime.api.registerTool({ name: "no_handler", description: "x", parameters: {}, approvalClass: "read-only" } as never)).toThrow(/requires a handler/u);
		expect(runtime.toolHandlerFor("sample_tool")).toBeTypeOf("function");
		expect(() => runtime.api.registerCommand({ name: "cmd", description: "x", argumentHint: "y" })).not.toThrow();
		expect(() => runtime.api.registerFlag({ name: "flag", description: "x", type: "string" })).not.toThrow();
	});

	it("only accepts events from the frozen projection whitelist", () => {
		const runtime = apiWithLimits();
		runtime.api.on("PreToolUse", () => undefined);
		runtime.api.on("PreToolUse", () => undefined);
		expect(runtime.handlersFor("PreToolUse")).toHaveLength(2);
		expect(runtime.api.registrations.subscriptions).toEqual([{ name: "PreToolUse" }]);
		expect(() => runtime.api.on("ToolCall", () => undefined)).toThrow(/not in the extension projection whitelist/u);
		expect(runtime.handlersFor("ToolCall")).toEqual([]);
	});

	it("stops accepting registrations beyond the configured per-kind limit", () => {
		const runtime = apiWithLimits({ ...EXTENSION_DEFAULT_HOST_LIMITS, maxRegistrationsPerKind: 1 });
		runtime.api.registerFlag({ name: "one", description: "x", type: "boolean" });
		expect(() => runtime.api.registerFlag({ name: "two", description: "x", type: "boolean" })).toThrow(/flag registration limit reached/u);
	});
});
