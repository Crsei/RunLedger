import { describe, expect, it } from "vitest";
import { createRuntimeId } from "../../../src/runtime/protocol/ids.ts";
import {
	assembleRuntimeContext,
	type RuntimeContextRequestBase,
	type RuntimeContextSource,
} from "../../../src/runtime/context/runtime-adapter.ts";

const request: RuntimeContextRequestBase = {
	requestId: createRuntimeId("command", "runtime-adapter-test"),
	modelProfileId: "fixture-profile",
	contextWindow: 512,
	outputReserve: 64,
	toolReserve: 64,
	traceId: createRuntimeId("trace", "runtime-adapter-test"),
};

const sources: readonly RuntimeContextSource[] = [
	{ key: "history", layer: "history", content: "recent history", trust: "mixed", taint: "user_input", priority: "normal" },
	{ key: "policy", layer: "policy", content: "immutable policy", trust: "trusted", taint: "none", priority: "required" },
];

describe("runtime context adapter", () => {
	it("turns source content into stable contract fragments before assembly", () => {
		const first = assembleRuntimeContext({ request, sources });
		const second = assembleRuntimeContext({ request, sources: [...sources].reverse() });

		expect(first.fragments.map((fragment) => fragment.layer)).toEqual(["policy", "history"]);
		expect(first.fragments.map((fragment) => fragment.fragmentId)).toEqual(
			second.fragments.map((fragment) => fragment.fragmentId),
		);
		expect(first.receipt.contextDigest).toEqual(second.receipt.contextDigest);
		expect(first.receipt.estimatedInputTokens).toBeGreaterThan(0);
	});

	it("carries source hard caps into bounded oversized-tool diagnostics", () => {
		const result = assembleRuntimeContext({
			request,
			sources: [{
				key: "tool-result",
				layer: "history",
				content: "tool output that must be offloaded",
				trust: "mixed",
				taint: "tool_output",
				priority: "normal",
				maxTokens: 1,
			}],
		});

		expect(result.receipt.omittedFragments[0]).toMatchObject({ reasonCode: "oversized_tool_result" });
		expect(result.receipt.diagnostics[0]).toMatchObject({ code: "oversized_tool_result" });
	});
});
