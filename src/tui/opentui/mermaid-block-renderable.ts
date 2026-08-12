import {
  RGBA,
  StyledText,
  TextRenderable,
  type RenderContext,
  type TextOptions,
} from "@opentui/core";
import { displayWidth, graphemes } from "../mermaid/display-width.ts";
import {
  makeMermaidCacheKeyFromDigest,
  mermaidWidthBucket,
  type MermaidProjectionCache,
} from "../mermaid/cache.ts";
import { MERMAID_LIMITS } from "../mermaid/limits.ts";
import { renderMermaidDiagram } from "../mermaid/render.ts";
import type {
  MermaidDiagram,
  MermaidProjectionResult,
  MermaidSemanticClass,
} from "../mermaid/types.ts";
import type { TuiPerformanceObserver } from "./performance-observer.ts";

export type MermaidThemeMode = "dark" | "light";

export type MermaidBlockRenderableOptions = Omit<TextOptions, "content"> & {
  readonly diagram: MermaidDiagram;
  readonly projectionCache?: MermaidProjectionCache;
  readonly sourceDigest?: string;
  readonly performanceObserver?: TuiPerformanceObserver;
  readonly onProjectionFailure?: () => void;
  readonly onProjectionSuccess?: () => void;
  readonly themeMode?: MermaidThemeMode;
};

const darkColors: Record<MermaidSemanticClass, string> = {
  border: "#565f89",
  nodeText: "#d4d4d4",
  edge: "#7aa2f7",
  edgeLabel: "#e0af68",
  title: "#bb9af7",
};

const lightColors: Record<MermaidSemanticClass, string> = {
  border: "#6b7280",
  nodeText: "#111827",
  edge: "#2563eb",
  edgeLabel: "#92400e",
  title: "#7c3aed",
};

/**
 * OpenTUI 原生 TextRenderable 接缝。source/IR 在 Markdown parser 边界生成，
 * 此类只负责按实际宽度投影、重测高度和把语义 span 映射为 StyledText。
 */
export class MermaidBlockRenderable extends TextRenderable {
  readonly diagramKind: MermaidDiagram["kind"];
  readonly diagram: MermaidDiagram;
  private projection: MermaidProjectionResult | undefined;
  private themeMode: MermaidThemeMode;
  private widthBucket = 0;
  private updating = false;
  private readonly onProjectionFailure: (() => void) | undefined;
  private readonly onProjectionSuccess: (() => void) | undefined;
  private readonly projectionCache: MermaidProjectionCache | undefined;
  private readonly sourceDigest: string | undefined;
  private readonly performanceObserver: TuiPerformanceObserver | undefined;

  constructor(ctx: RenderContext, options: MermaidBlockRenderableOptions) {
    const {
      diagram,
      onProjectionFailure,
      onProjectionSuccess,
      performanceObserver,
      projectionCache,
      sourceDigest,
      themeMode = "dark",
      ...renderableOptions
    } = options;
    const externalOnSizeChange = renderableOptions.onSizeChange;
    super(ctx, {
      ...renderableOptions,
      onSizeChange: undefined,
      selectable: true,
      content: new StyledText([]),
    });
    this.diagram = diagram;
    this.diagramKind = diagram.kind;
    this.themeMode = themeMode;
    this.onProjectionFailure = onProjectionFailure;
    this.onProjectionSuccess = onProjectionSuccess;
    this.performanceObserver = performanceObserver;
    this.projectionCache = projectionCache;
    this.sourceDigest = sourceDigest;
    this.onSizeChange = () => {
      this.updateForMeasuredWidth();
      externalOnSizeChange?.call(this);
    };
    this.updateProjection(MERMAID_LIMITS.widthBucket * 10);
  }

  protected override onResize(_width: number, _height: number): void {
    super.onResize(_width, _height);
    this.onSizeChange?.();
  }

  get renderedWidthBucket(): number {
    return this.widthBucket;
  }

  get renderedProjection(): MermaidProjectionResult | undefined {
    return this.projection;
  }

  setThemeMode(mode: MermaidThemeMode): void {
    if (mode === this.themeMode) return;
    this.themeMode = mode;
    if (this.projection?.ok) this.content = styledTextForProjection(this.projection, this.themeMode);
    this.requestRender();
  }

  private updateForMeasuredWidth(): void {
    if (this.updating) return;
    const measuredWidth = Math.max(1, Math.floor(this.width));
    const bucket = mermaidWidthBucket(measuredWidth);
    if (bucket === this.widthBucket) return;
    this.updateProjection(bucket);
  }

  private updateProjection(width: number): void {
    if (this.updating) return;
    this.updating = true;
    try {
      const startedAt = performance.now();
      const cacheKey = this.projectionCache !== undefined && this.sourceDigest !== undefined
        ? makeMermaidCacheKeyFromDigest(this.sourceDigest, width)
        : undefined;
      const cached = cacheKey === undefined ? undefined : this.projectionCache?.get(cacheKey);
      const cacheHit = cached !== undefined;
      const projected = cached ?? renderMermaidDiagram(this.diagram, width);
      if (!cacheHit && cacheKey !== undefined) this.projectionCache?.set(cacheKey, projected);
      this.performanceObserver?.recordMermaidProjection({
        durationMs: Math.max(0, performance.now() - startedAt),
        cacheHit,
        fallback: !projected.ok,
      });
      if (this.projectionCache !== undefined) this.performanceObserver?.recordMermaidCache(this.projectionCache.snapshot());
      this.projection = projected;
      this.widthBucket = width;
      if (projected.ok) {
        this.content = styledTextForProjection(projected, this.themeMode);
        this.height = Math.max(1, projected.height);
        this.onProjectionSuccess?.();
      } else {
        this.content = new StyledText([]);
        this.height = 1;
        this.onProjectionFailure?.();
      }
      this.requestRender();
    } finally {
      this.updating = false;
    }
  }
}

function styledTextForProjection(projection: Extract<MermaidProjectionResult, { readonly ok: true }>, mode: MermaidThemeMode): StyledText {
  const colors = mode === "dark" ? darkColors : lightColors;
  const chunks: Array<{ __isChunk: true; text: string; fg?: RGBA }> = [];
  projection.lines.forEach((line, lineIndex) => {
    if (lineIndex > 0) chunks.push({ __isChunk: true, text: "\n" });
    let column = 0;
    let activeClass: MermaidSemanticClass | undefined;
    let activeText = "";
    const flush = (): void => {
      if (activeText.length === 0) return;
      chunks.push({
        __isChunk: true,
        text: activeText,
        ...(activeClass === undefined ? {} : { fg: RGBA.fromHex(colors[activeClass]) }),
      });
      activeText = "";
    };
    for (const grapheme of graphemes(line.text)) {
      const width = displayWidth(grapheme);
      const span = line.spans.find((candidate) => candidate.start <= column && column < candidate.end);
      const className = span?.className;
      if (className !== activeClass) {
        flush();
        activeClass = className;
      }
      activeText += grapheme;
      column += width;
    }
    flush();
  });
  return new StyledText(chunks);
}
