/**
 * RunLedger TUI 模块 barrel。
 *
 * 对照 development-doc/tui/01-architecture.md §6 与 pi-tui(@earendil-works/pi-tui@0.80.10):
 *   本 barrel re-export pi-tui 的子集——本期 M0–M7 真正会用到的运行时基石类与辅助类型,
 *   并接入本期 stub(feature-adapters.ts / runtime/repl-handle.ts)。
 *
 * 选取规则:
 *   1. 文档 02 §1–§11 组件规格涉及的类(TUI / Container / Editor / Markdown / Loader / SelectList 等);
 *   2. 文档 04 §1 渲染流程涉及的差分渲染入口 TUI / Component / Focusable / OverlayHandle / OverlayOptions;
 *   3. 文档 06 §4 键位 Manager/类型(Key / KeybindingsManager / KeybindingsConfig / parseKey / matchesKey);
 *   4. 文档 05 §3 主题可视宽度(visibleWidth / wrapTextWithAnsi / hyperlink);
 *   5. 不引入 Image / 终端图像协议相关 allocateImageId / encodeKitty 等(本期不用图形)。
 *
 * 本期 tui barrel 不被 src/index.ts 顶级 re-export,只在 tui 内部用 M1+ 各组件相互 import。
 * 待所有 11 个业务组件落地后,再单独评估是否把 tui barrel 接入顶级 index。
 */

// TUI 核心:运行时 + 容器 + 核心组件
export {
	TUI,
	type Component,
	type Focusable,
	type OverlayAnchor,
	type OverlayHandle,
	type OverlayMargin,
	type OverlayOptions,
	type OverlayUnfocusOptions,
	type SizeValue,
	Container,
	CURSOR_MARKER,
	isFocusable,
} from "@earendil-works/pi-tui";

// 文本与可视组件
export { Box } from "@earendil-works/pi-tui";
export { Editor, type EditorOptions, type EditorTheme } from "@earendil-works/pi-tui";
export { Input } from "@earendil-works/pi-tui";
export { Text } from "@earendil-works/pi-tui";
export { TruncatedText } from "@earendil-works/pi-tui";
export { Spacer } from "@earendil-works/pi-tui";
export { type DefaultTextStyle, Markdown, type MarkdownOptions, type MarkdownTheme } from "@earendil-works/pi-tui";

// 识别与状态指示
export { Loader, type LoaderIndicatorOptions } from "@earendil-works/pi-tui";
export { CancellableLoader } from "@earendil-works/pi-tui";

// 列表 / 选择
export {
	type SelectItem,
	SelectList,
	type SelectListLayoutOptions,
	type SelectListTheme,
	type SelectListTruncatePrimaryContext,
} from "@earendil-works/pi-tui";
export { type SettingItem, SettingsList, type SettingsListTheme } from "@earendil-works/pi-tui";

// 终端与 stdin 处理
export { StdinBuffer, type StdinBufferEventMap, type StdinBufferOptions } from "@earendil-works/pi-tui";
export { ProcessTerminal, type Terminal } from "@earendil-works/pi-tui";
// M6:OSC 11 探测(注意 isOsc11BackgroundColorResponse 未在 pi-tui 顶层 re-export)
export {
  parseOsc11BackgroundColor,
  parseTerminalColorSchemeReport,
  type RgbColor,
} from "@earendil-works/pi-tui";

// 键位与焦点
export {
	type Keybinding,
	type KeybindingConflict,
	type KeybindingDefinition,
	type KeybindingDefinitions,
	type Keybindings,
	type KeybindingsConfig,
	KeybindingsManager,
	setKeybindings,
	TUI_KEYBINDINGS,
} from "@earendil-works/pi-tui";
export {
	Key,
	type KeyEventType,
	type KeyId,
	isKeyRelease,
	isKeyRepeat,
	isKittyProtocolActive,
	matchesKey,
	parseKey,
	setKittyProtocolActive,
} from "@earendil-works/pi-tui";
export { getKeybindings } from "@earendil-works/pi-tui";

// ANSI / 可视宽度工具
export { sliceByColumn, truncateToWidth, visibleWidth, wrapTextWithAnsi, hyperlink } from "@earendil-works/pi-tui";

// 终端能力探测(本期不用图像,但 detect/get/reset 在 ANSI 协议探测时会用)
export {
	detectCapabilities,
	getCapabilities,
	resetCapabilitiesCache,
	setCapabilities,
	type CellDimensions,
	type TerminalCapabilities,
} from "@earendil-works/pi-tui";

// 本期内部 stub 接入点(本期 no-op)
export type { VoiceAdapter } from "./feature-adapters.ts";
export { voiceAdapter, PROACTIVE_NO_OP_SUBSCRIBE, PROACTIVE_FALSE, PROACTIVE_NULL } from "./feature-adapters.ts";

export type { ReplHandle, ReplResult } from "./runtime/repl-handle.ts";
export { getReplHandle, setReplHandle } from "./runtime/repl-handle.ts";

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
export { detectScheme, classifyByRgb, type TerminalColorScheme } from "./theme/osc-detector.ts";
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
