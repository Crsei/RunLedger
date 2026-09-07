import { createRuntimeId } from "../../../src/runtime/protocol/ids.ts";
import { runtimeDigest } from "../../../src/runtime/protocol/foundation.ts";
import type { SkillDescriptor } from "../../../src/extensions/skills/types.ts";
import { describe, expect, it } from "vitest";
import { mockModel } from "../../../src/runtime/providers/mock-stream.ts";
import { defaultConvertToLlm } from "../../../src/runtime/agent-loop.ts";
import { assembleAgentModelContext } from "../../../src/runtime/context/model-request-adapter.ts";
import { skillCatalogPromptFragment } from "../../../src/extensions/skills/renderer.ts";
import type { AgentMessage, LlmContext } from "../../../src/runtime/types.ts";

function user(text: string): AgentMessage {
	return { role: "user", content: [{ type: "text", text }] };
}

function assistant(text: string): AgentMessage {
	return { role: "assistant", content: [{ type: "text", text }], stopReason: "stop" };
}

describe("Host model request context adapter", () => {
	it("sends only the ContextEngine projection and returns a bounded receipt", async () => {
		const messages = [user("first"), user("second")];
		const context: LlmContext = {
			systemPrompt: "immutable system policy",
			messages: await defaultConvertToLlm(messages),
			tools: [],
		};

		const assembled = assembleAgentModelContext({
			model: mockModel,
			context,
			turn: 1,
			sessionId: "session-adapter-test",
		});

		expect(assembled.context.systemPrompt).toBe(context.systemPrompt);
		expect(assembled.context.messages).toEqual(context.messages);
		expect(assembled.receipt.fragmentIds.length).toBeGreaterThan(0);
		expect(assembled.receipt.estimatedInputTokens).toBeGreaterThan(0);
		expect(assembled.receipt.reservedOutputTokens).toBe(mockModel.maxTokens);
		expect(assembled.receipt.diagnostics).toEqual([]);
	});

	it("makes the receipt digest independent of provider-added message timestamps", async () => {
		const messages = [user("same input")];
		const first = assembleAgentModelContext({
			model: mockModel,
			context: { systemPrompt: "system", messages: await defaultConvertToLlm(messages), tools: [] },
			turn: 1,
			sessionId: "session-adapter-test",
		});
		await new Promise((resolve) => setTimeout(resolve, 2));
		const second = assembleAgentModelContext({
			model: mockModel,
			context: { systemPrompt: "system", messages: await defaultConvertToLlm(messages), tools: [] },
			turn: 1,
			sessionId: "session-adapter-test",
		});

		expect(first.receipt.contextDigest).toEqual(second.receipt.contextDigest);
		expect(first.receipt.projectionDigest).toEqual(second.receipt.projectionDigest);
	});

	it("uses a distinct request identity when a later prompt changes the projected context", async () => {
		const first = assembleAgentModelContext({
			model: mockModel,
			context: { systemPrompt: "system", messages: await defaultConvertToLlm([user("first")]), tools: [] },
			turn: 1,
			sessionId: "session-adapter-multiple-prompts",
		});
		const second = assembleAgentModelContext({
			model: mockModel,
			context: { systemPrompt: "system", messages: await defaultConvertToLlm([user("first"), assistant("reply"), user("second")]), tools: [] },
			turn: 1,
			sessionId: "session-adapter-multiple-prompts",
		});

		expect(second.receipt.requestId).not.toBe(first.receipt.requestId);
	});

	it("overlays Host domain sources (Plan Mode / approved memory) into the same projection", async () => {
		const context: LlmContext = {
			systemPrompt: "system",
			messages: await defaultConvertToLlm([user("hello")]),
			tools: [],
		};
		const assembled = assembleAgentModelContext({
			model: mockModel,
			context,
			turn: 1,
			sessionId: "session-adapter-test",
			sources: [
				{
					fragmentId: "plan-mode-3",
					key: "plan-mode",
					layer: "mode",
					content: "plan mode: active\nrevision: 3",
					trust: "trusted",
					priority: "required",
				},
				{
					fragmentId: "memory-abc",
					key: "memory-abc",
					layer: "memory",
					content: "[workspace memory-abc] release process",
					trust: "trusted",
					taint: "external",
					priority: "optional",
				},
			],
		});

		expect(assembled.receipt.fragmentIds).toContain("plan-mode-3");
		expect(assembled.receipt.fragmentIds).toContain("memory-abc");
		expect(assembled.context.systemPrompt).toContain("system");
		expect(assembled.context.systemPrompt).toContain("plan mode: active\nrevision: 3");
		expect(assembled.context.systemPrompt).toContain("[workspace memory-abc] release process");
		expect(assembled.context.messages).toEqual(context.messages);
		expect(assembled.receipt.diagnostics).toEqual([]);
	});

	it("projects the bounded Skill catalog fragment into the provider-facing request without bodies or hidden skills", async () => {
		const context: LlmContext = {
			systemPrompt: "system",
			messages: await defaultConvertToLlm([user("hello")]),
			tools: [],
		};
		const descriptorBase = {
			kind: "skill" as const,
			identity: { kind: "skill" as const, qualifiedId: "skill:user:fixture:plain", version: "1", source: "user" as const, digest: "a".repeat(64) },
			resource: { resourceId: createRuntimeId("resource", "a"), kind: "skill" as const, qualifiedId: "skill:user:fixture:plain", version: "1", source: "user" as const, digest: runtimeDigest("a") },
			provenance: { source: "user" as const, sourceLocatorDigest: runtimeDigest("b") },
			displayName: "plain",
			description: "plain skill",
			sourcePath: "/fixture/plain/SKILL.md",
			priority: 100,
			enabled: true,
			trusted: true,
			ready: true,
			trust: "trusted" as const,
			activation: "ready" as const,
			diagnostics: [],
			capabilities: [],
		};
		const skills: SkillDescriptor[] = [
			{
				descriptor: { ...descriptorBase },
				frontmatter: { name: "plain", description: "plain skill", userInvocable: true, disableModelInvocation: false, metadata: {} },
				rootPath: "/fixture/plain",
				skillFile: "/fixture/plain/SKILL.md",
				bodyDigest: "c".repeat(64),
				resourceSet: { qualifiedId: "skill:user:fixture:plain", metadata: {} as never, body: {} as never, budget: { maxBytes: 1, maxEntries: 1 } },
				sourceRoot: { source: "user" as const, sourceKey: "user:fixture", rootPath: "/fixture", priority: 100 },
				priority: 100,
				trustBinding: { identity: {} as never, canonicalPath: "/fixture/plain", binding: {} as never, principalId: createRuntimeId("principal", "a") },
			},
			{
				descriptor: { ...descriptorBase, identity: { ...descriptorBase.identity, qualifiedId: "skill:user:fixture:hidden" }, displayName: "hidden", description: "hidden skill" },
				frontmatter: { name: "hidden", description: "hidden skill", userInvocable: true, disableModelInvocation: true, metadata: {} },
				rootPath: "/fixture/hidden",
				skillFile: "/fixture/hidden/SKILL.md",
				bodyDigest: "d".repeat(64),
				resourceSet: { qualifiedId: "skill:user:fixture:hidden", metadata: {} as never, body: {} as never, budget: { maxBytes: 1, maxEntries: 1 } },
				sourceRoot: { source: "user" as const, sourceKey: "user:fixture", rootPath: "/fixture", priority: 100 },
				priority: 100,
				trustBinding: { identity: {} as never, canonicalPath: "/fixture/hidden", binding: {} as never, principalId: createRuntimeId("principal", "a") },
			},
		];
		const fragmentId = `skill-catalog-${"e".repeat(32)}`;
		const content = skillCatalogPromptFragment(skills, 20_000);
		const assembled = assembleAgentModelContext({
			model: mockModel,
			context,
			turn: 1,
			sessionId: "session-adapter-skill",
			sources: [{ fragmentId, key: "skill-catalog", layer: "resources", content, trust: "trusted", taint: "none", priority: "normal" }],
		});
		expect(assembled.receipt.fragmentIds).toContain(fragmentId);
		expect(assembled.context.systemPrompt).toContain("name=plain;qualifiedId=skill:user:fixture:plain");
		expect(assembled.context.systemPrompt).not.toContain("hidden");
		expect(assembled.context.systemPrompt).not.toContain("SKILL.md body");
		expect(assembled.context.messages).toEqual(context.messages);
	});

	it("keeps the assembled projection deterministic when domain sources repeat", async () => {
		const context: LlmContext = {
			systemPrompt: "system",
			messages: await defaultConvertToLlm([user("hello")]),
			tools: [],
		};
		const base = {
			model: mockModel,
			context,
			turn: 2,
			sessionId: "session-adapter-test",
			sources: [
				{
					fragmentId: "plan-mode-4",
					key: "plan-mode",
					layer: "mode" as const,
					content: "plan mode: active",
					trust: "trusted" as const,
					priority: "required" as const,
				},
			],
		};
		const first = assembleAgentModelContext(base);
		const second = assembleAgentModelContext(base);
		expect(first.receipt.projectionDigest).toEqual(second.receipt.projectionDigest);
	});
});

describe("Plan 14 recent complete request context", () => {
  it("retains recent numeric history instead of lexicographic fragment IDs", async () => {
    const messages = await defaultConvertToLlm(Array.from({ length: 14 }, (_, index) => [user(`entry-${index}: ${"x".repeat(150)}`), assistant(`reply-${index}`)]).flat());
    const assembled = assembleAgentModelContext({
      model: { ...mockModel, contextWindow: 650, maxTokens: 64 },
      context: { messages, tools: [] }, sessionId: "recent", turn: 1,
    });
    const text = JSON.stringify(assembled.context.messages);
    expect(text).toContain("entry-13:");
    expect(text).toContain("entry-12:");
    expect(text).not.toContain("entry-0:");
    const selected = assembled.context.messages.map((message) => messages.indexOf(message));
    expect(selected).toEqual([...selected].sort((a, b) => a - b));
  });

  it("omits a whole oversized tool group and retains the task plus its steering correction", async () => {
    const messages = await defaultConvertToLlm([
      user("original task: inspect only"),
      { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id: "large", name: "read", arguments: { payload: "x".repeat(5_000) } }] },
      { role: "toolResult", content: [{ type: "toolResult", toolCallId: "large", toolName: "read", content: [{ type: "text", text: "old result" }], isError: false }] },
      user("correction: do not modify files"),
    ]);
    const original = structuredClone(messages);
    const assembled = assembleAgentModelContext({
      model: { ...mockModel, contextWindow: 650, maxTokens: 64 },
      context: { messages, tools: [] }, sessionId: "group", turn: 1,
    });
    expect(assembled.context.messages).toEqual([messages[0], messages[3]]);
    expect(messages).toEqual(original);
  });

  it("fails explicitly when the required latest call and result group cannot fit", async () => {
    const messages = await defaultConvertToLlm([
      user("do the task"),
      { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id: "large", name: "read", arguments: { payload: "x".repeat(5_000) } }] },
      { role: "toolResult", content: [{ type: "toolResult", toolCallId: "large", toolName: "read", content: [{ type: "text", text: "last result" }], isError: false }] },
    ]);
    expect(() => assembleAgentModelContext({
      model: { ...mockModel, contextWindow: 650, maxTokens: 64 },
      context: { messages, tools: [] }, sessionId: "required-group", turn: 1,
    })).toThrow(/budget/);
  });

  it("budgets target image conversion instead of the omitted base64 source", () => {
    const assembled = assembleAgentModelContext({
      model: { ...mockModel, input: ["text"], contextWindow: 650, maxTokens: 64 },
      context: { messages: [{ role: "user", timestamp: 1, content: [{ type: "image", mimeType: "image/png", data: "A".repeat(50_000) }] }], tools: [] },
      sessionId: "image-conversion", turn: 1,
    });
    expect(assembled.context.messages).toHaveLength(1);
    expect(assembled.receipt.estimatedInputTokens).toBeLessThan(200);
  });

  it("rejects an actual tool schema that cannot fit instead of assuming a fixed reserve", () => {
    expect(() => assembleAgentModelContext({
      model: { ...mockModel, contextWindow: 5_000, maxTokens: 64 },
      context: { messages: [], tools: [{ name: "huge", label: "Huge", execute: async () => ({ content: [], details: {} }), description: "x".repeat(30_000), parameters: { type: "object", properties: {} } }] },
      sessionId: "tool-schema", turn: 1,
    })).toThrow(/budget/);
  });
});
