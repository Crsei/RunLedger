import { runtimeDigest } from "../protocol/foundation.ts";
import type { ContextFragment } from "./types.ts";
import { sortContextFragments } from "./context-engine.ts";

type ContextDigest = ContextFragment["contentDigest"];

function escapeXml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&apos;");
}

function sameDigest(left: ContextDigest, right: ContextDigest): boolean {
	return left.algorithm === right.algorithm && left.digest === right.digest;
}

export interface ContextProjection {
	readonly content: string;
	readonly projectionDigest: ContextDigest;
	readonly fragmentIds: readonly string[];
	readonly contentRefs: readonly ContextFragment["contentRef"][];
}

/** 只投影 ContextEngine 已选择的 descriptors；正文由 adapter 以受控 map 提供。 */
export function projectContext(
	fragments: readonly ContextFragment[],
	contentByFragmentId: Readonly<Record<string, string>> = {},
): ContextProjection {
	const ordered = sortContextFragments(fragments);
	const sections = ordered.map((fragment) => {
		const hasContent = Object.hasOwn(contentByFragmentId, fragment.fragmentId);
		const content = hasContent ? contentByFragmentId[fragment.fragmentId] ?? "" : "";
		if (hasContent && !sameDigest(runtimeDigest(content), fragment.contentDigest)) throw new Error(`context fragment ${fragment.fragmentId} content digest mismatch`);
		return `<context-fragment id="${escapeXml(fragment.fragmentId)}" layer="${escapeXml(fragment.layer)}" trust="${escapeXml(fragment.trust)}" taint="${escapeXml(fragment.taint)}" priority="${escapeXml(fragment.priority)}" digest="${escapeXml(fragment.contentDigest.digest)}">\n${escapeXml(content)}\n</context-fragment>`;
	});
	const content = sections.join("\n\n");
	const fragmentIds = ordered.map((fragment) => fragment.fragmentId);
	const contentRefs = ordered.map((fragment) => fragment.contentRef);
	return {
		content,
		projectionDigest: runtimeDigest({ fragmentIds, content, contentRefs }),
		fragmentIds,
		contentRefs,
	};
}
