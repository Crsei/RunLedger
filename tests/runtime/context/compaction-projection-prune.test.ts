import { describe, expect, it } from "vitest";
import type { AssistantMessage, Message, ToolCall, ToolResultMessage } from "../../../src/types.ts";
import { historyDigest } from "../../../src/runtime/context/compaction/history.ts";
import { parseCompactionSettings } from "../../../src/runtime/context/compaction/settings.ts";
import { collectUselessToolCallIds, planProjectionPrune, SUPERSEDED_NOTICE, USELESS_NOTICE } from "../../../src/runtime/context/compaction/projection-prune.ts";

function pair(id: string, args: ToolCall["arguments"] = { path: "file.ts" }, result: Partial<ToolResultMessage<unknown>> = {}, name = "read"): Message[] {
	const call: AssistantMessage = { role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }], provider: "fixture", model: "fixture", api: "openai-completions", timestamp: 0, stopReason: "toolUse",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
	return [call, { role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text: "old output ".repeat(200) }], isError: false, timestamp: 0, ...result }];
}
const config = { pruneSuperseded: true, dropUseless: false };
describe("deterministic projection pruning", () => {
	it("replaces only obsolete text, preserving raw history and call/result identity", () => {
		const messages = [...pair("old"), ...pair("new")]; const before = JSON.stringify(messages);
		const projected = planProjectionPrune(messages, config);
		expect(projected.replacements).toMatchObject([{ index: 1, toolCallId: "old", reason: "superseded-read" }]);
		expect(projected.estimatedTokensSaved).toBeGreaterThan(50);
		expect(projected.messages[1]).toMatchObject({ toolCallId: "old", toolName: "read", content: [{ type: "text", text: SUPERSEDED_NOTICE }] });
		expect(projected.messages[0]).toBe(messages[0]); expect(projected.messages[3]).toBe(messages[3]);
		expect(JSON.stringify(messages)).toBe(before);
		expect(planProjectionPrune(projected.messages, config).messages).toEqual(projected.messages);
		expect(JSON.stringify(planProjectionPrune(JSON.parse(before) as Message[], config).messages)).toBe(JSON.stringify(projected.messages));
	});
	it("preserves committed prefixes and their digest", () => {
		const messages = [...pair("prefix"), ...pair("old"), ...pair("new")]; const digest = historyDigest(messages.slice(0, 2));
		const output = planProjectionPrune(messages, { ...config, protectedPrefixCount: 2 });
		expect(output.replacements.map((item) => item.index)).toEqual([3]);
		expect(output.messages[1]).toBe(messages[1]); expect(historyDigest(output.messages.slice(0, 2))).toEqual(digest);
	});
	it("does not substitute a different range or presentation", () => {
		for (const args of [{ path: "file.ts", offset: 2 }, { path: "file.ts", limit: 50 }, { path: "file.ts", lineNumbers: false }, { path: "other.ts" }]) {
			const messages = [...pair("old"), ...pair("new", args)]; expect(planProjectionPrune(messages, config).messages).toBe(messages);
		}
	});
	it("preserves instructions, plan references, URLs, images and errors", () => {
		for (const path of ["SKILL.md", "nested/AGENTS.md", "https://example.com/file", "active-plan.ts"]) {
			const messages = [...pair("old", { path }), ...pair("new", { path })];
			expect(planProjectionPrune(messages, { ...config, protectedReferences: ["Review active-plan.ts"] }).messages).toBe(messages);
		}
		for (const result of [{ isError: true }, { content: [{ type: "image" as const, data: "AA==", mimeType: "image/png" }] }, { addedToolNames: ["new_tool"] }]) {
			const messages = [...pair("old", undefined, result), ...pair("new")]; expect(planProjectionPrune(messages, config).messages).toBe(messages);
		}
		const failedNew = [...pair("old"), ...pair("new", undefined, { isError: true })]; expect(planProjectionPrune(failedNew, config).messages).toBe(failedNew);
	});
	it("refuses ambiguous pairing and avoids replacements without net gain", () => {
		for (const messages of [[...pair("duplicate"), ...pair("duplicate")], [...pair("old").reverse(), ...pair("new")], [...pair("old", undefined, { toolName: "write" }), ...pair("new")], [...pair("old", undefined, { content: [{ type: "text", text: "tiny" }] }), ...pair("new")]]) {
			expect(planProjectionPrune(messages, config).messages).toBe(messages);
		}
	});
	it("requires explicit strict useless hints and protects capability results", () => {
		const hints = collectUselessToolCallIds([{ role: "toolResult", content: [
			{ type: "toolResult", toolCallId: "yes", toolName: "bash", content: [{ type: "text", text: "output" }], details: { useless: true } },
			{ type: "toolResult", toolCallId: "string", toolName: "bash", content: [], details: { useless: "true" } },
			{ type: "toolResult", toolCallId: "error", toolName: "bash", content: [], details: { useless: true }, isError: true },
		] }]);
		expect(hints).toEqual(["yes"]);
		const messages = pair("yes", {}, {}, "bash");
		expect(planProjectionPrune(messages, { ...config, uselessToolCallIds: hints }).messages).toBe(messages);
		expect(planProjectionPrune(messages, { ...config, dropUseless: true, uselessToolCallIds: hints }).messages[1]).toMatchObject({ content: [{ type: "text", text: USELESS_NOTICE }] });
		for (const name of ["Skill", "plan_read", "memory_get"]) {
			const protectedMessages = pair("yes", {}, {}, name);
			expect(planProjectionPrune(protectedMessages, { ...config, dropUseless: true, uselessToolCallIds: hints }).messages).toBe(protectedMessages);
		}
	});
	it("defaults to supersede only and validates both switches", () => {
		expect(parseCompactionSettings(undefined)).toMatchObject(config);
		for (const key of ["pruneSuperseded", "dropUseless"]) expect(() => parseCompactionSettings({ [key]: "true" })).toThrow();
		const messages = [...pair("old"), ...pair("new")];
		expect(planProjectionPrune(messages, { pruneSuperseded: false, dropUseless: false }).messages).toBe(messages);
	});
});
