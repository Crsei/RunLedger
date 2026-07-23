import { canonicalDigest } from "../protocol/v3/canonical-json.ts";
import { createRuntimeId } from "../protocol/v3/ids.ts";
import type { ContextAssemblyRequest, ContextFragment, ContextLayer, ContextTrust } from "./types.ts";
import { ContextEngine, type AssembledContext } from "./context-engine.ts";

export interface RuntimeContextSource {
	layer: ContextLayer;
	key: string;
	content: string;
	trust: ContextTrust;
	priority: ContextFragment["priority"];
	maxTokens: number;
}

export type RuntimeContextRequestBase = Omit<ContextAssemblyRequest, "fragments">;

function sourceFragment(
	base: RuntimeContextRequestBase,
	source: RuntimeContextSource,
	order: number,
	expectedSequence: number,
	observedAt: string,
): ContextFragment {
	const contentDigest = canonicalDigest(source.content);
	return {
		schemaVersion: 1,
		authorityId: base.authorityId,
		tenantId: base.tenantId,
		fragmentId: createRuntimeId("resource", `ctx-${canonicalDigest({ layer: source.layer, key: source.key }).slice(0, 48)}`),
		layer: source.layer,
		order,
		contentDigest,
		trust: source.trust,
		taint: [],
		inputSources: [],
		declassificationReceipts: [],
		priority: source.priority,
		maxTokens: source.maxTokens,
		maxChars: Math.min(65_536, source.content.length),
		provenance: {
			authorityId: base.authorityId,
			tenantId: base.tenantId,
			kind: "session_range",
			sessionId: base.sessionId,
			fromSequence: expectedSequence,
			toSequence: expectedSequence,
			sourceDigest: contentDigest,
			observedAt,
		},
		storage: "inline",
		content: source.content,
	};
}

/** 行为 seam 的扩展 metadata，不属于 public ContextAssemblyRequest。 */
export interface RuntimeContextAdapterInput {
	request: RuntimeContextRequestBase;
	sources: readonly RuntimeContextSource[];
	expectedSequence?: number;
	observedAt: string;
}

export function assembleRuntimeContext(
	input: RuntimeContextAdapterInput,
	engine: ContextEngine = new ContextEngine(),
): AssembledContext {
	const fragments = input.sources.map((source, index) =>
		sourceFragment(input.request, source, index, input.expectedSequence ?? 0, input.observedAt),
	);
	return engine.assemble({ ...input.request, fragments });
}
