import { canonicalDigest } from "../protocol/v3/canonical-json.ts";
import type { ContextFragment } from "./types.ts";

export interface ContextProjection {
	content: string;
	projectionDigest: string;
	fragmentIds: readonly string[];
}

/** 只投影 ContextEngine 已批准的 fragments；调用点不再追加隐藏 prompt。 */
export function projectContext(fragments: readonly ContextFragment[]): ContextProjection {
	const sections = fragments.map((fragment) => {
		const content = fragment.storage === "inline" ? fragment.content : (fragment.excerpt ?? "");
		return `<context-fragment id="${fragment.fragmentId}" layer="${fragment.layer}" digest="${fragment.contentDigest}">\n${content}\n</context-fragment>`;
	});
	const content = sections.join("\n\n");
	return {
		content,
		projectionDigest: canonicalDigest({ fragmentIds: fragments.map((fragment) => fragment.fragmentId), content }),
		fragmentIds: fragments.map((fragment) => fragment.fragmentId),
	};
}
