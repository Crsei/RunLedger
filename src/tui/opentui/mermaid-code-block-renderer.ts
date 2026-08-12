import {
  BoxRenderable,
  createMarkdownCodeBlockRenderer,
  type MarkdownOptions,
  type RenderContext,
  type Renderable,
} from "@opentui/core";
import { mermaidSourceDigest, MermaidProjectionCache } from "../mermaid/cache.ts";
import { inspectMermaidFence } from "../mermaid/fence.ts";
import { parseMermaidSource } from "../mermaid/parse.ts";
import type { MermaidDiagram } from "../mermaid/types.ts";
import { MermaidBlockRenderable } from "./mermaid-block-renderable.ts";
import type { TuiPerformanceObserver } from "./performance-observer.ts";

export interface MermaidCodeBlockRendererOptions {
  readonly performanceObserver?: TuiPerformanceObserver;
  readonly getThemeMode?: () => "dark" | "light";
}

export type MermaidCodeBlockRenderer = NonNullable<MarkdownOptions["renderNode"]> & {
  dispose: () => void;
};

/**
 * 为一个 MarkdownRenderable 创建稳定的 Mermaid code-block renderer。
 * 失败时必须调用 OpenTUI 原生 defaultRender，保留完整 Markdown source。
 */
export function createMermaidCodeBlockRenderer(
  ctx: RenderContext,
  options: MermaidCodeBlockRendererOptions = {},
): MermaidCodeBlockRenderer {
  let nextBlockId = 0;
  const projectionCache = new MermaidProjectionCache();
  const renderNode = createMarkdownCodeBlockRenderer({
    mermaid: (token, context) => {
      const fence = inspectMermaidFence(token.raw);
      if (!fence.ok) return context.defaultRender();

      const parsed = parseMermaidSource(fence.source);
      if (!parsed.ok) return context.defaultRender();

      return new MermaidBlockWithFallbackRenderable(ctx, {
        id: `runledger-mermaid-block-${nextBlockId++}`,
        diagram: parsed.diagram,
        fallbackFactory: context.defaultRender,
        projectionCache,
        sourceDigest: mermaidSourceDigest(fence.source),
        performanceObserver: options.performanceObserver,
        themeMode: options.getThemeMode?.() ?? "dark",
      });
    },
  });
  const disposableRenderNode = renderNode as MermaidCodeBlockRenderer;
  disposableRenderNode.dispose = () => projectionCache.clear();
  return disposableRenderNode;
}

interface MermaidBlockWithFallbackOptions {
  readonly id: string;
  readonly diagram: MermaidDiagram;
  readonly fallbackFactory: () => Renderable | null;
  readonly performanceObserver?: TuiPerformanceObserver;
  readonly projectionCache: MermaidProjectionCache;
  readonly sourceDigest: string;
  readonly themeMode: "dark" | "light";
}

class MermaidBlockWithFallbackRenderable extends BoxRenderable {
  private readonly fallbackFactory: () => Renderable | null;
  private diagram: MermaidBlockRenderable | undefined;
  private fallback: Renderable | undefined;
  private fallbackActive = false;

  constructor(ctx: RenderContext, options: MermaidBlockWithFallbackOptions) {
    super(ctx, {
      id: options.id,
      width: "100%",
      flexDirection: "column",
      flexShrink: 0,
    });
    this.fallbackFactory = options.fallbackFactory;
    this.diagram = new MermaidBlockRenderable(ctx, {
      id: `${options.id}-diagram`,
      width: "100%",
      flexShrink: 0,
      diagram: options.diagram,
      performanceObserver: options.performanceObserver,
      projectionCache: options.projectionCache,
      sourceDigest: options.sourceDigest,
      themeMode: options.themeMode,
      onProjectionFailure: () => this.activateFallback(),
      onProjectionSuccess: () => this.activateDiagram(),
    });
    this.add(this.diagram);
    if (this.fallbackActive) this.diagram.visible = false;
  }

  protected override onResize(width: number, height: number): void {
    super.onResize(width, height);
    if (!this.fallbackActive || this.diagram === undefined) return;
    this.diagram.visible = true;
    if (this.fallback !== undefined) this.fallback.visible = false;
    this.fallbackActive = false;
  }

  private activateFallback(): void {
    const fallback = this.fallback ?? this.fallbackFactory();
    if (fallback === null) return;
    if (this.fallback === undefined) {
      this.fallback = fallback;
      this.add(fallback);
    }
    if (this.diagram !== undefined) this.diagram.visible = false;
    this.fallback.visible = true;
    this.fallbackActive = true;
    this.requestRender();
  }

  private activateDiagram(): void {
    if (!this.fallbackActive || this.diagram === undefined) return;
    this.diagram.visible = true;
    if (this.fallback !== undefined) this.fallback.visible = false;
    this.fallbackActive = false;
    this.requestRender();
  }
}
