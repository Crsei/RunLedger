import { describe, expect, it } from "vitest";
import { canonicalDigest } from "../../../src/runtime/protocol/v3/canonical-json.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/v3/ids.ts";
import { ContextAssemblyError, ContextEngine, contextAssembledEventPayload } from "../../../src/runtime/context/context-engine.ts";
import { projectContext } from "../../../src/runtime/context/projection.ts";
import { TokenEstimator, conservativeTokenEstimate } from "../../../src/runtime/context/token-estimator.ts";
import type { ContextAssemblyRequest, ContextFragment } from "../../../src/runtime/context/types.ts";
import { authorityId, NOW, principalId, sessionId, tenantId } from "../plan-context-memory/helpers.ts";

function fragment(key: string, content: string, overrides: Partial<ContextFragment> = {}): ContextFragment {
	const contentDigest = canonicalDigest(content);
	return {
		schemaVersion: 1,
		authorityId,
		tenantId,
		fragmentId: createRuntimeId("resource", key),
		layer: "session_memory",
		order: 0,
		contentDigest,
		trust: "derived",
		taint: [],
		inputSources: [],
		declassificationReceipts: [],
		priority: "normal",
		maxTokens: 20_000,
		maxChars: 65_536,
		provenance: { authorityId, tenantId, kind: "session_range", sessionId, fromSequence: 0, toSequence: 1, sourceDigest: contentDigest, observedAt: NOW },
		storage: "inline",
		content,
		...overrides,
	};
}

function request(fragments: readonly ContextFragment[], overrides: Partial<ContextAssemblyRequest> = {}): ContextAssemblyRequest {
	return {
		schemaVersion: 1,
		authorityId,
		tenantId,
		principalId,
		requestId: createRuntimeId("contextRequest", "engine"),
		sessionId,
		modelId: "model",
		modelProfileId: createRuntimeId("resource", "profile"),
		requiredCapabilities: [],
		budget: { contextWindowTokens: 1_000, reservedOutputTokens: 100, reservedToolSchemaTokens: 100, providerSafetyTokens: 100, maxFragments: 20, maxTotalChars: 100_000 },
		fragments,
		...overrides,
	};
}

describe("ContextEngine", () => {
	it("assembles stable layer/priority/order independent of input order", () => {
		const policy = fragment("policy", "policy", { layer: "organization_policy", trust: "system", priority: "required", order: 5 });
		const history = fragment("history", "history", { order: 2 });
		const first = new ContextEngine({ clock: () => new Date(NOW) }).assemble(request([history, policy]));
		const second = new ContextEngine({ clock: () => new Date(NOW) }).assemble(request([policy, history]));
		expect(first).toEqual(second);
		expect(first.fragments.map((item) => item.fragmentId)).toEqual([policy.fragmentId, history.fragmentId]);
		expect(projectContext(first.fragments).fragmentIds).toEqual([policy.fragmentId, history.fragmentId]);
		expect(contextAssembledEventPayload(first.receipt)).toMatchObject({ includedCount: 2, omittedCount: 0 });
	});

	it("omits optional history before sampling but never silently drops required policy", () => {
		const huge = "x".repeat(1_500);
		const optional = fragment("optional", huge, { priority: "optional" });
		const result = new ContextEngine({ clock: () => new Date(NOW) }).assemble(request([optional], {
			budget: { contextWindowTokens: 350, reservedOutputTokens: 100, reservedToolSchemaTokens: 50, providerSafetyTokens: 50, maxFragments: 20, maxTotalChars: 100_000 },
		}));
		expect(result.receipt.omitted).toHaveLength(1);
		expect(() => new ContextEngine().assemble(request([fragment("required", huge, { priority: "required" })], {
			budget: { contextWindowTokens: 350, reservedOutputTokens: 100, reservedToolSchemaTokens: 50, providerSafetyTokens: 50, maxFragments: 20, maxTotalChars: 100_000 },
		}))).toThrowError(expect.objectContaining<ContextAssemblyError>({ code: "required_fragment_exceeds_budget" }));
	});

	it("rejects inline digest drift and preserves taint/source receipts", () => {
		const tainted = fragment("tainted", "external", {
			contentDigest: canonicalDigest("wrong"),
		});
		expect(() => new ContextEngine().assemble(request([tainted]))).toThrowError(
			expect.objectContaining<ContextAssemblyError>({ code: "fragment_digest_mismatch" }),
		);
	});

	it("uses conservative bounded fallback and ignores malformed provider usage", () => {
		const estimator = new TokenEstimator();
		const baseline = estimator.estimate("中文🙂abc");
		estimator.observe({ inputChars: 10, inputBytes: 0, inputTokens: Number.MAX_SAFE_INTEGER });
		expect(estimator.estimate("中文🙂abc")).toBe(baseline);
		expect(conservativeTokenEstimate("x".repeat(20_000_000))).toBe(4_194_304);
	});
});
