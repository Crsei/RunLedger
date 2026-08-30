/**
 * OpenTUI component runtime —— 公共入口 facade。
 *
 * S6 拆分后实现位于 `component-runtime/`:
 * - `component-runtime/index.ts`   createOpenTuiComponentRuntime(FromRenderer) factory;
 * - `component-runtime/frame-runtime.ts` frame apply/schedule/dispose 状态机;
 * - `component-runtime/transcript-runtime.ts` block 身份/diff/scroll/窗口纯函数;
 * - `component-runtime/overlay-runtime.ts` text/input/command/select overlay 注册表;
 * - `component-runtime/footer-editor-runtime.ts` editor/footer/status indicator 原语;
 * - `component-runtime/highlight-admission.ts` settled markdown/highlight budget;
 * - `component-runtime/input-normalization.ts` key → normalized input;
 * - `component-runtime/types.ts` 公共与私有 frame/node 契约。
 *
 * 本文件只重导出,不复制实现;公共 import 路径不变。
 */

export {
  createOpenTuiComponentRuntime,
  createOpenTuiComponentRuntimeFromRenderer,
  type OpenTuiComponentFrame,
  type OpenTuiComponentRuntime,
  type OpenTuiComponentRuntimeOptions,
  type EditorAppearance,
  type TranscriptScrollPresentation,
} from "./component-runtime/index.ts";
export { statusIndicatorPlainText } from "./component-runtime/footer-editor-runtime.ts";
