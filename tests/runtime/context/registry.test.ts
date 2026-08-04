import { describe, expect, it } from "vitest";
import { runtimeDigest } from "../../../src/runtime/protocol/foundation.ts";
import { ContextFragmentRegistry } from "../../../src/runtime/context/context-engine.ts";
import type { ContextFragment } from "../../../src/runtime/context/types.ts";

function fragment(fragmentId: string, layer: ContextFragment["layer"], content: string): ContextFragment {
	const digest = runtimeDigest(content);
	return {
		fragmentId,
		layer,
		order: 0,
		contentRef: { subjectKind: "content", digest, mediaType: "text/plain", size: content.length },
		contentDigest: digest,
		estimatedTokens: 8,
		trust: "trusted",
		taint: "none",
		priority: "normal",
	};
}

describe("ContextFragmentRegistry", () => {
	it("produces stable list and digest regardless of registration order", () => {
		const policy = fragment("policy", "policy", "policy");
		const history = fragment("history", "history", "history");
		const first = new ContextFragmentRegistry();
		first.registerAll([history, policy]);
		const second = new ContextFragmentRegistry();
		second.registerAll([policy, history]);

		expect(first.list().map((item) => item.fragmentId)).toEqual(["policy", "history"]);
		expect(first.digest()).toEqual(second.digest());
	});

	it("rejects a stable ID being reused for a different descriptor", () => {
		const registry = new ContextFragmentRegistry();
		registry.register(fragment("policy", "policy", "first"));

		expect(() => registry.register(fragment("policy", "policy", "changed"))).toThrow(
			/different digest/,
		);
	});
});
