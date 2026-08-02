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
  type SelectItem,
  type SelectListLayoutOptions,
  type SelectListTheme,
  type SelectListTruncatePrimaryContext,
  type SizeValue,
  type Terminal,
} from "./primitives.ts";

// 本期内部 stub 接入点(本期 no-op)
export type { VoiceAdapter } from "./feature-adapters.ts";
export { voiceAdapter, PROACTIVE_NO_OP_SUBSCRIBE, PROACTIVE_FALSE, PROACTIVE_NULL } from "./feature-adapters.ts";

export type { ReplHandle, ReplResult } from "./runtime/repl-handle.ts";
export { getReplHandle, setReplHandle } from "./runtime/repl-handle.ts";

// OpenTUI runtime owner。
export type {
  OpenTuiRuntime,
  OpenTuiRuntimeOptions,
  OpenTuiScreenSnapshot,
} from "./opentui/runtime.ts";
export { createOpenTuiRuntime } from "./opentui/runtime.ts";

// M2 业务组件
export { LoadedResourcesComponent, type LoadedResourceKind, type LoadedResourceEntry, type LoadedResourcesComponentProps } from "./components/loaded-resources.ts";
export { UserMessageComponent, type UserMessageComponentProps } from "./components/user-message.ts";
export { AssistantMessageComponent, extractToolCalls, type AssistantMessageComponentProps } from "./components/assistant-message.ts";
export { CustomMessageComponent, type CustomMessageComponentProps } from "./components/custom-message.ts";
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
export { createAppKeyListener, type AppKeyCallbacks, type InputListener } from "./keybindings/app-keys.ts";

// M3 工具调用相关组件
export { ToolCallComponent, type ToolCallStatus, type ToolCallComponentProps } from "./components/tool-call.ts";
export { ToolResultComponent, type ToolResultComponentProps } from "./components/tool-result.ts";
export { BackgroundTaskComponent, type BackgroundTaskStatus, type BackgroundTaskComponentProps } from "./components/background-task.ts";
export { AbortButtonComponent, type AbortButtonComponentProps } from "./components/abort-button.ts";
export { DiffPreviewComponent, type DiffVerb, type DiffStatus, type DiffPreviewComponentProps } from "./components/diff-preview.ts";

// M5 新增 BashExecution 组件
export { BashExecutionComponent, type BashExecStatus, type BashExecutionComponentProps } from "./components/bash-execution.ts";

// M4 状态指示器
export { StatusComponent, type StatusComponentProps } from "./components/status.ts";

// M5 选择器与模态
export { SelectorModal, type SelectorModalProps } from "./components/selector-modal.ts";
export { SlashCommandSelector, type SlashCommandSelectorProps } from "./components/slash-command-selector.ts";
export { PromptSelector, type PromptSelectorProps } from "./components/prompt-selector.ts";
export { McpServerSelector, type McpServerSelectorProps } from "./components/mcp-server-selector.ts";
export { ImagePasteOverlay, type ImagePasteOverlayProps } from "./components/image-paste-overlay.ts";
