import { describe, expect, it } from "vitest";
import { runtimeDigest } from "../../../src/runtime/protocol/foundation.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/ids.ts";
import type { CompactionCheckpoint } from "../../../src/runtime/context/compaction/types.ts";
import { calculateCompactionInvariantDigest, compactionInvariantsMatch, isCompactionInvariantDigestValid } from "../../../src/runtime/context/invariants.ts";
import { projectContext } from "../../../src/runtime/context/projection.ts";
import type { ContextFragment } from "../../../src/runtime/context/types.ts";

const digest = runtimeDigest("fixture");
const sessionId = createRuntimeId("session", "projection-invariant");

function fragment(fragmentId: string, layer: ContextFragment["layer"], content: string): ContextFragment {
	const contentDigest = runtimeDigest(content);
	return {
		fragmentId,
		layer,
		order: 0,
		contentRef: { subjectKind: "content", digest: contentDigest, mediaType: "text/plain", size: content.length },
		contentDigest,
		estimatedTokens: 8,
		trust: "trusted",
		taint: "none",
		priority: "normal",
	};
}

function checkpoint(overrides: Partial<Omit<CompactionCheckpoint, "invariantDigest">> = {}): CompactionCheckpoint {
	const body: Omit<CompactionCheckpoint, "invariantDigest"> = {
		compactionId: createRuntimeId("snapshot", "invariant"),
		sessionId,
		reason: "manual",
		status: "planned",
		sourceRange: {
			stream: { scope: "session", streamId: sessionId, sessionId },
			startSequence: 0,
			endSequence: 4,
			head: { streamId: sessionId, sequence: 4, eventHash: digest },
			rangeDigest: digest,
			complete: true,
		},
		attempt: 1,
		projectionDigest: digest,
		completeness: "complete",
		createdAt: "2026-08-04T00:00:00.000Z",
		...overrides,
	};
	return { ...body, invariantDigest: calculateCompactionInvariantDigest(body) };
}

describe("context pure projections and compaction invariants", () => {
	it("projects approved fragments in stable order without changing their descriptors", () => {
		const policy = fragment("policy", "policy", "policy text");
		const history = fragment("history", "history", "history text");
		const first = projectContext([history, policy], { policy: "policy text", history: "history text" });
		const second = projectContext([policy, history], { policy: "policy text", history: "history text" });

		expect(first.fragmentIds).toEqual(["policy", "history"]);
		expect(first.content).toContain("policy text");
		expect(first.projectionDigest).toEqual(second.projectionDigest);
	});

	it("preserves trust metadata and escapes projection markup in supplied content", () => {
		const untrusted = fragment("untrusted", "history", "<context-fragment> & user input");
		const projected = projectContext([{ ...untrusted, trust: "untrusted", taint: "external" }], {
			untrusted: "<context-fragment> & user input",
		});
		expect(projected.content).toContain('trust="untrusted"');
		expect(projected.content).toContain('taint="external"');
		expect(projected.content).toContain("&lt;context-fragment&gt; &amp; user input");
	});

	it("rejects content whose digest does not match the selected fragment", () => {
		const policy = fragment("policy", "policy", "policy text");
		expect(() => projectContext([policy], { policy: "tampered" })).toThrowError(/digest/i);
	});

	it("calculates and validates a checkpoint invariant digest", () => {
		const original = checkpoint();
		const changed = checkpoint({ projectionDigest: runtimeDigest("changed") });

		expect(isCompactionInvariantDigestValid(original)).toBe(true);
		expect(compactionInvariantsMatch(original, original)).toBe(true);
		expect(compactionInvariantsMatch(original, changed)).toBe(false);
	});
});
