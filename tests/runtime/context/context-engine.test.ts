import { describe, expect, it } from "vitest";
import { runtimeDigest } from "../../../src/runtime/protocol/foundation.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/ids.ts";
import type { ContextAssemblyRequest, ContextFragment } from "../../../src/runtime/context/types.ts";
import { ContextEngine } from "../../../src/runtime/context/context-engine.ts";
import { isContextAssemblyReceipt } from "../../../src/runtime/context/schema.ts";

const clock = () => new Date("2026-08-04T00:00:00.000Z");

function fragment(
	fragmentId: string,
	layer: ContextFragment["layer"],
	order: number,
	content: string,
	overrides: Partial<ContextFragment> = {},
): ContextFragment {
	const digest = runtimeDigest(content);
	return {
		fragmentId,
		layer,
		order,
		contentRef: {
			subjectKind: "content",
			digest,
			mediaType: "text/plain",
			size: Buffer.byteLength(content, "utf8"),
		},
		contentDigest: digest,
		estimatedTokens: 16,
		trust: layer === "policy" ? "trusted" : "mixed",
		taint: "none",
		priority: layer === "policy" ? "required" : "normal",
		...overrides,
	};
}

function request(fragments: readonly ContextFragment[]): ContextAssemblyRequest {
	return {
		requestId: createRuntimeId("command", "context-engine-test"),
		modelProfileId: "fixture-profile",
		contextWindow: 512,
		outputReserve: 64,
		toolReserve: 64,
		fragments,
		traceId: createRuntimeId("trace", "context-engine-test"),
	};
}

describe("ContextEngine", () => {
	it("orders fragments by layer and keeps the context digest independent of input order", () => {
		const identity = fragment("identity", "identity", 2, "identity");
		const policy = fragment("policy", "policy", 9, "policy");
		const history = fragment("history", "history", 1, "history");
		const engine = new ContextEngine({ clock });

		const first = engine.assemble(request([history, policy, identity]));
		const second = engine.assemble(request([identity, history, policy]));

		expect(first.fragments.map((item) => item.fragmentId)).toEqual(["identity", "policy", "history"]);
		expect(second.fragments.map((item) => item.fragmentId)).toEqual(["identity", "policy", "history"]);
		expect(first.receipt.contextDigest).toEqual(second.receipt.contextDigest);
		expect(first.receipt).toEqual(second.receipt);
		expect(isContextAssemblyReceipt(first.receipt)).toBe(true);
	});

	it("keeps protected policy in budget and records omitted history diagnostics", () => {
		const policy = fragment("policy", "policy", 0, "policy", { estimatedTokens: 30, priority: "normal" });
		const history = fragment("history", "history", 0, "history", { estimatedTokens: 100 });
		const result = new ContextEngine({ clock }).assemble({
			...request([history, policy]),
			contextWindow: 140,
			outputReserve: 40,
			toolReserve: 20,
		});

		expect(result.fragments.map((item) => item.fragmentId)).toEqual(["policy"]);
		expect(result.receipt.omittedFragments).toEqual([
			{ fragmentId: "history", reasonCode: "budget_exceeded" },
		]);
		expect(result.receipt.diagnostics).toEqual([
			expect.objectContaining({ code: "context_budget_exceeded", severity: "warning" }),
		]);
	});

	it("reports an oversized tool result as a structured omission", () => {
		const toolResult = fragment("tool-result", "history", 0, "tool result", {
			taint: "tool_output",
			estimatedTokens: 80,
		});
		const result = new ContextEngine({ clock }).assemble(
			request([toolResult]),
			{ fragmentHardCaps: new Map([["tool-result", 16]]) },
		);

		expect(result.fragments).toHaveLength(0);
		expect(result.receipt.omittedFragments).toEqual([
			{ fragmentId: "tool-result", reasonCode: "oversized_tool_result" },
		]);
		expect(result.receipt.diagnostics).toEqual([
			expect.objectContaining({ code: "oversized_tool_result", severity: "warning" }),
		]);
	});

	it("rejects a descriptor whose content reference digest drifted", () => {
		const policy = fragment("policy", "policy", 0, "policy");
		const drifted = {
			...policy,
			contentRef: { ...policy.contentRef, digest: runtimeDigest("different") },
		};

		expect(() => new ContextEngine({ clock }).assemble(request([drifted]))).toThrowError(
			expect.objectContaining({ code: "fragment_digest_mismatch" }),
		);
	});

	it("does not silently omit a protected fragment that cannot fit", () => {
		const policy = fragment("policy", "policy", 0, "policy", { estimatedTokens: 100, priority: "normal" });

		expect(() => new ContextEngine({ clock }).assemble({
			...request([policy]),
			contextWindow: 140,
			outputReserve: 40,
			toolReserve: 20,
		})).toThrowError(expect.objectContaining({ code: "required_fragment_exceeds_budget" }));
	});

	it("returns a structured diagnostic when the request has no valid input budget", () => {
		let failure: unknown;
		try {
			new ContextEngine({ clock }).assemble({
				...request([]),
				contextWindow: 100,
				outputReserve: 80,
				toolReserve: 30,
			});
		} catch (error) {
			failure = error;
		}

		expect(failure).toMatchObject({
			code: "invalid_budget",
			diagnostics: [expect.objectContaining({ code: "missing_context_budget", severity: "error" })],
		});
	});

	it("bounds diagnostic receipts to the current contract maximum", () => {
		const fragments = Array.from({ length: 70 }, (_, index) => fragment(
			`history-${index}`,
			"history",
			0,
			`history-${index}`,
			{ estimatedTokens: 100, priority: "optional" },
		));
		const result = new ContextEngine({ clock }).assemble({
			...request(fragments),
			contextWindow: 100,
			outputReserve: 50,
			toolReserve: 40,
		});

		expect(result.receipt.diagnostics.length).toBeLessThanOrEqual(64);
		expect(isContextAssemblyReceipt(result.receipt)).toBe(true);
	});
});
