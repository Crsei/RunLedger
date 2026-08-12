import type { MarkdownOptions, RenderContext } from "@opentui/core";
import type { SyntaxHighlightService } from "../highlight/service.ts";
import type { SyntaxThemeController } from "../highlight/theme-controller.ts";
import type { MermaidCodeBlockRenderer } from "./mermaid-code-block-renderer.ts";
import { SyntectCodeBlockRenderable } from "./syntect-code-block-renderable.ts";

export interface SyntectCodeBlockRendererOptions {
	readonly highlightService: SyntaxHighlightService;
	readonly mermaidRenderNode: MermaidCodeBlockRenderer;
	readonly themeController: SyntaxThemeController;
}

export type SyntectCodeBlockRenderer = NonNullable<MarkdownOptions["renderNode"]> & {
	readonly codeBlockOnly: true;
	dispose: () => void;
};

/** Mermaid 拥有第一优先级；其余有 language token 的 fence 才进入 syntect。 */
export function createSyntectCodeBlockRenderer(
	ctx: RenderContext,
	options: SyntectCodeBlockRendererOptions,
): SyntectCodeBlockRenderer {
	let nextBlockId = 0;
	const renderNode: NonNullable<MarkdownOptions["renderNode"]> = (token, context) => {
		const mermaid = options.mermaidRenderNode(token, context);
		if (mermaid !== undefined && mermaid !== null) return mermaid;
		if (token.type !== "code") return undefined;
		const language = languageToken(token.lang ?? "");
		if (language === undefined) return context.defaultRender();
		return new SyntectCodeBlockRenderable(ctx, {
			id: `runledger-syntect-block-${nextBlockId++}`,
			width: "100%",
			flexShrink: 0,
			source: token.text,
			language,
			highlightService: options.highlightService,
			themeController: options.themeController,
		});
	};
	const composite = renderNode as SyntectCodeBlockRenderer;
	Object.defineProperty(composite, "codeBlockOnly", { value: true, enumerable: true });
	composite.dispose = () => options.mermaidRenderNode.dispose();
	return composite;
}

/** Codex markdown info string：只取逗号、space、Tab 前的第一段。 */
export function languageToken(infoString: string): string | undefined {
	const token = infoString.trim().split(/[, \t]/u, 1)[0];
	return token === undefined || token.length === 0 ? undefined : token;
}
