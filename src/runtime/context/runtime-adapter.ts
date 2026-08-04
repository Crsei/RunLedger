import { runtimeDigest } from "../protocol/foundation.ts";
import type { ContextAssemblyRequest, ContextFragment } from "./types.ts";
import { ContextEngine, type AssembledContext } from "./context-engine.ts";
import { TokenEstimator } from "./token-estimator.ts";

type ContextSubjectKind = ContextFragment["contentRef"]["subjectKind"];

export interface RuntimeContextSource {
	readonly layer: ContextFragment["layer"];
	readonly key: string;
	readonly content: string;
	readonly trust: ContextFragment["trust"];
	readonly taint?: ContextFragment["taint"];
	readonly priority: ContextFragment["priority"];
	readonly maxTokens?: number;
	readonly maxChars?: number;
	readonly estimatedTokens?: number;
	readonly mediaType?: string;
	readonly subjectKind?: ContextSubjectKind;
	readonly fragmentId?: string;
}

export type RuntimeContextRequestBase = Omit<ContextAssemblyRequest, "fragments">;

export interface RuntimeContextAdapterInput {
	readonly request: RuntimeContextRequestBase;
	readonly sources: readonly RuntimeContextSource[];
	readonly sourceHead?: AssembledContext["receipt"]["sourceHead"];
	readonly expectedSequence?: number;
	readonly observedAt?: string;
}

export interface RuntimeAssembledContext extends AssembledContext {
	readonly contentByFragmentId: Readonly<Record<string, string>>;
}

export class RuntimeContextAdapterError extends Error {
	public constructor(message: string) {
		super(message);
		this.name = "RuntimeContextAdapterError";
	}
}

function sourceFragment(
	source: RuntimeContextSource,
	tokenEstimator: TokenEstimator,
): { fragment: ContextFragment; hardTokenCap?: number; hardCharCap?: number } {
	if (source.key.length === 0) throw new RuntimeContextAdapterError("context source key must not be empty");
	const contentDigest = runtimeDigest(source.content);
	const fragmentId = source.fragmentId ?? `context-${runtimeDigest({ layer: source.layer, key: source.key }).digest.slice(0, 48)}`;
	const contentRef = {
		subjectKind: source.subjectKind ?? "content",
		digest: contentDigest,
		mediaType: source.mediaType ?? "text/plain",
		size: Buffer.byteLength(source.content, "utf8"),
	} as const;
	const estimatedTokens = source.estimatedTokens ?? tokenEstimator.estimate(source.content);
	const fragment: ContextFragment = {
		fragmentId,
		layer: source.layer,
		// source 数组不是排序 authority；同层由 fragmentId 的稳定 tie-break 决定。
		order: 0,
		contentRef,
		contentDigest,
		estimatedTokens,
		trust: source.trust,
		taint: source.taint ?? "none",
		priority: source.priority,
	};
	return {
		fragment,
		...(source.maxTokens === undefined ? {} : { hardTokenCap: source.maxTokens }),
		...(source.maxChars === undefined ? {} : { hardCharCap: source.maxChars }),
	};
}

export function assembleRuntimeContext(
	input: RuntimeContextAdapterInput,
	engine: ContextEngine = new ContextEngine(),
): RuntimeAssembledContext {
	const tokenEstimator = new TokenEstimator();
	const fragments: ContextFragment[] = [];
	const contentByFragmentId: Record<string, string> = {};
	const hardTokenCaps = new Map<string, number>();
	const hardCharCaps = new Map<string, number>();
	const seenIds = new Set<string>();

	for (const source of input.sources) {
		const built = sourceFragment(source, tokenEstimator);
		if (seenIds.has(built.fragment.fragmentId)) {
			throw new RuntimeContextAdapterError(`context source produced duplicate fragment ${built.fragment.fragmentId}`);
		}
		seenIds.add(built.fragment.fragmentId);
		fragments.push(built.fragment);
		contentByFragmentId[built.fragment.fragmentId] = source.content;
		if (built.hardTokenCap !== undefined) hardTokenCaps.set(built.fragment.fragmentId, built.hardTokenCap);
		if (built.hardCharCap !== undefined) hardCharCaps.set(built.fragment.fragmentId, built.hardCharCap);
	}

	const assembled = engine.assemble(
		{ ...input.request, fragments },
		{
			contentByFragmentId,
			fragmentHardCaps: hardTokenCaps,
			fragmentHardCharCaps: hardCharCaps,
			...(input.sourceHead === undefined ? {} : { sourceHead: input.sourceHead }),
		},
	);
	return { ...assembled, contentByFragmentId };
}
