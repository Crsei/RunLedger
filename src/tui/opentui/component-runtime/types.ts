/**
 * S6 拆分:component runtime 私有 frame/node 契约与公共类型。
 */

import type {
  InputRenderable,
  MarkdownRenderable,
  Renderable,
  SelectRenderable,
  TextRenderable,
} from "@opentui/core";
import type { DiffRenderable } from "../diff-renderable.ts";
import type { ExecRenderable } from "../exec-renderable.ts";
import type { NoticeRenderable } from "../notice-renderable.ts";
import type { PlanUpdateRenderable } from "../plan-update-renderable.ts";
import type { ExplorationRenderable } from "../exploration-renderable.ts";
import type { PresentationBlock, StatusIndicatorView } from "../../presentation.ts";
import type { StatusLineSegment } from "../../highlight/status-style.ts";
import type { TuiAction } from "../../application/action.ts";
import type { OverlayAnchor, OverlayVariant } from "../../primitives.ts";
import type { TuiPerformanceObserver } from "../performance-observer.ts";
import type { SyntaxHighlightService } from "../../highlight/service.ts";
import type { UiThemeSnapshot } from "../../theme/ui-theme.ts";
import type { SyntaxThemeController } from "../../highlight/theme-controller.ts";
import type { ShimmerStatusLineOptions } from "../shimmer-status-line.ts";
import type { SettledSpan } from "../settled-prefix.ts";

/** 输入区外观(由主题/终端背景计算,帧驱动下发到原生组件)。 */
export interface EditorAppearance {
  readonly backgroundColor: string;
  readonly promptColor: string;
  readonly placeholderColor: string;
}

export interface TranscriptScrollPresentation {
  readonly visible: boolean;
  readonly trackColor: string;
  readonly thumbColor: string;
}

export interface OpenTuiComponentFrame {
  readonly uiTheme?: UiThemeSnapshot;
  /** OSC 11 实测终端背景(#rrggbb);缺省 undefined 时使用主题 background 槽。 */
  readonly terminalBackground?: string;
  readonly body: readonly (string | PresentationBlock)[];
  readonly footer: readonly (string | { readonly kind: "status-line"; readonly segments: readonly StatusLineSegment[] })[];
  readonly overlay?: readonly (string | PresentationBlock)[];
  readonly overlayVariant?: OverlayVariant;
  readonly overlayAnchor?: OverlayAnchor;
  readonly overlayNonCapturing?: boolean;
  readonly editorText: string;
  readonly editorCursorOffset?: number;
  readonly editorHeight?: number;
  readonly editorAppearance?: EditorAppearance;
  readonly statusIndicator?: StatusIndicatorView;
  readonly statusIndicatorShimmer?: ShimmerStatusLineOptions;
  readonly transcriptScrollPresentation?: TranscriptScrollPresentation;
}

export interface OpenTuiComponentRuntimeOptions {
  onInput(data: string): void;
  onPaste?(text: string): void;
  onResize(): void;
  onActions?(actions: readonly TuiAction[]): void;
  onThemeMode?(mode: "dark" | "light"): void;
  /** OSC 10/11 终端色查询回复转发;primitive 解析由上层负责。 */
  onOsc?(sequence: string): void;
  /** 生产组合只传一个 syntaxHighlightService;两个都传时后者被忽略。 */
  syntaxHighlightService?: SyntaxHighlightService;
  createSyntaxHighlightService?: () => SyntaxHighlightService;
  syntaxThemeController?: SyntaxThemeController;
  initialSyntaxThemeName?: string;
  performanceObserver?: TuiPerformanceObserver;
}

export interface OpenTuiComponentRuntime {
  update(frame: OpenTuiComponentFrame): void;
  /** 仅更新时间驱动的状态行与页脚；布局变化时返回 false，由调用方补完整帧。 */
  updateStatusFrame?(frame: Pick<OpenTuiComponentFrame, "statusIndicator" | "statusIndicatorShimmer" | "footer">): boolean;
  /** 主动写出 OSC 52 剪贴板序列；返回 false 表示文本为空（终端是否接受不可观测）。 */
  copyText(text: string): boolean;
  getLastDirtyPartIds(): readonly string[];
  destroy(): void;
}

type BodyRenderable = TextRenderable | MarkdownRenderable | ExecRenderable | DiffRenderable | PlanUpdateRenderable | NoticeRenderable | ExplorationRenderable;
type OverlayRenderable = TextRenderable | InputRenderable | SelectRenderable | ExecRenderable;

export interface KeyedRenderable<T extends BodyRenderable | OverlayRenderable> {
  readonly kind: string;
  readonly renderable: T;
  variant?: "thinking";
  contentKey?: string;
  streaming?: boolean;
}

export interface SettledMarkdownState {
  readonly variant?: "thinking";
  readonly span: SettledSpan;
  readonly renderable: MarkdownRenderable;
}

export type { BodyRenderable, OverlayRenderable, Renderable, ShimmerStatusLineOptions };
