export {
  Box,
  Container,
  CURSOR_MARKER,
  Editor,
  Key,
  KeybindingsManager,
  Markdown,
  ProcessTerminal,
  SelectList,
  Spacer,
  TUI,
  TUI_KEYBINDINGS,
  getKeybindings,
  hyperlink,
  isFocusable,
  isKeyRelease,
  isKeyRepeat,
  isKittyProtocolActive,
  isNavigationKey,
  matchesKey,
  parseKey,
  parseOsc11BackgroundColor,
  parseTerminalColorSchemeReport,
  setKeybindings,
  setKittyProtocolActive,
  sliceByColumn,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type DefaultTextStyle,
  type EditorOptions,
  type EditorTheme,
  type Focusable,
  type Keybinding,
  type KeybindingConflict,
  type KeybindingDefinition,
  type KeybindingDefinitions,
  type KeybindingsConfig,
  type KeyEventType,
  type KeyId,
  type MarkdownOptions,
  type MarkdownTheme,
  type OverlayAnchor,
  type OverlayHandle,
  type OverlayMargin,
  type OverlayOptions,
  type OverlayUnfocusOptions,
  type RgbColor,
  type RenderPreparationListener,
  type SelectItem,
  type SelectListLayoutOptions,
  type SelectListTheme,
  type SelectListTruncatePrimaryContext,
  type SizeValue,
  type Terminal,
  type TUIOptions,
} from "./primitives.ts";

export {
  type TimelinePatch,
} from "./opentui/delta-coalescer.ts";
export {
  DeltaCoalescer,
  type AppendTextDelta,
  type CoalescedDelta,
  type DeltaCoalescerOptions,
  type DeltaCoalescerStats,
  type DeltaPressureLevel,
  type DeltaPressureSnapshot,
  type ReplaceStatusDelta,
  type StreamingDelta,
  type TerminalDelta,
} from "./opentui/delta-coalescer.ts";
export {
  FrameScheduler,
  type FrameBacklogLimits,
  type FrameBacklogSnapshot,
  type FrameClock,
  type FrameReason,
  type FrameSchedulerOptions,
} from "./opentui/frame-scheduler.ts";
export {
  RenderCache,
  type RenderCacheKey,
  type RenderCacheOptions,
  type RenderCacheSnapshot,
} from "./opentui/render-cache.ts";
export {
  HeightIndex,
  type ScrollAnchor,
  type ViewportWindowRequest,
  type ViewportWindowResult,
} from "./opentui/viewport-window.ts";
export {
  TuiPerformanceObserver,
  type CoalescedObservation,
  type NativeFrameObservation,
  type ProjectionObservation,
  type QueueDepthObservation,
  type QueuePressureLevel,
  type QueuedDeltaObservation,
  type TuiPerformanceSnapshot,
} from "./opentui/performance-observer.ts";
export {
  decideMarkdownProjection,
  markdownFallbackNotice,
  type MarkdownProjectionDecision,
  type MarkdownProjectionMode,
  type MarkdownProjectionReason,
  type MarkdownStreamingBudget,
} from "./opentui/markdown-budget.ts";

// Framework-neutral passive data contracts. These exports intentionally carry no runtime values.
export type * from "./application/types.ts";
export type * from "./presentation/types.ts";
export type * from "./presentation/tools/types.ts";
export type * from "./timeline/types.ts";
export type * from "./commands/types.ts";
export type * from "./sessions/types.ts";
export type * from "./providers/types.ts";
export type * from "./auth/types.ts";
export type * from "./models/types.ts";
export type * from "./thinking/types.ts";
export type * from "./prompts/types.ts";
export type * from "./keymap/types.ts";
export type * from "./queue/types.ts";
export type * from "./approval/types.ts";
export type * from "./task-goal/types.ts";
export type * from "./goal-plan/types.ts";
export type * from "./agents/types.ts";
export type * from "./extensions/types.ts";
export type * from "./runtime-snapshot/types.ts";
export type * from "./security-mode/types.ts";
export type * from "./shutdown/types.ts";
export type * from "./workspace/types.ts";
export type * from "./update/types.ts";
export type {
  ProcessPassiveSnapshot,
  ProcessPassiveOutputPage,
  ProcessPassiveResult,
  ProcessPassiveOutputResult,
  ProcessPassiveMutationResult,
  ProcessPassiveWorkflowState,
  ProcessPassivePort,
} from "./process/types.ts";

export type { ProcessOverlayItem, ProcessOverlayState, ProcessOverlayAction } from "./process/types.ts";
export { createInitialProcessOverlayState, processOverlayReducer } from "./process/reducer.ts";
export { renderProcessOverlay } from "./process/presentation.ts";
export type { ProcessOverlayHostClient, ProcessOverlayController } from "./process/controller-adapter.ts";
export { createProcessOverlayController } from "./process/controller-adapter.ts";
export type { ProcessOverlayMutationResult } from "./process/controller-adapter.ts";
export { ProcessOverlayComponent } from "./process/overlay-component.ts";
export type { ManagedProcessOverlayFrame, ManagedProcessOverlayOptions, ManagedProcessOverlayRuntime } from "./opentui/process-overlay.ts";
export { createManagedProcessOverlayFromRenderer } from "./opentui/process-overlay.ts";

// 当前仍由 production composition 使用的业务组件
export { LoadedResourcesComponent, type LoadedResourceKind, type LoadedResourceEntry, type LoadedResourcesComponentProps } from "./components/loaded-resources.ts";
export { ChatContainer } from "./components/chat-container.ts";

// M2 主题工厂
export { makeMarkdownTheme, makeSelectListTheme, makeEditorTheme } from "./theme/factories.ts";

// M6 ANSI helpers + OSC detector + app-keys
export {
  wrapFg,
  wrapBg,
  wrapBold,
  wrapItalic,
  wrapUnderline,
  wrapStrikethrough,
  rgbToAnsi256,
  ansi256ToAnsi16,
  type StyleFn,
} from "./theme/ansi.ts";

export { AbortButtonComponent, type AbortButtonComponentProps } from "./components/abort-button.ts";

// M4 状态指示器
export { StatusComponent, type StatusComponentProps } from "./components/status.ts";

// M5 选择器与模态
export { SelectorModal, type SelectorModalProps } from "./components/selector-modal.ts";
export { SlashCommandSelector, type SlashCommandSelectorProps } from "./components/slash-command-selector.ts";
export { PromptSelector, type PromptSelectorProps } from "./components/prompt-selector.ts";
export { McpServerSelector, type McpServerSelectorProps } from "./components/mcp-server-selector.ts";
export { ImagePasteOverlay, type ImagePasteOverlayProps } from "./components/image-paste-overlay.ts";
