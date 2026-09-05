/**
 * S6 拆分:OpenTUI component runtime 公共入口(factory facade)。
 *
 * 工厂负责 renderable 树装配、输入/resize/theme/frame 事件接线与销毁权;
 * update() 的投影状态机在 `frame-runtime.ts`。公共类型经 types.ts 重导出。
 */

import {
  BoxRenderable,
  ScrollBoxRenderable,
  TextRenderable,
  createCliRenderer,
  type CliRenderer,
} from "@opentui/core";
import { appInputForKeypress, normalizeAppInput } from "../../input/normalize-action.ts";
import { loadNativeSyntaxAddon } from "../../highlight/native-loader.ts";
import { SyntaxHighlightService } from "../../highlight/service.ts";
import { BUILTIN_SYNTAX_THEME_NAMES, SyntaxThemeController } from "../../highlight/theme-controller.ts";
import { createMermaidCodeBlockRenderer } from "../mermaid-code-block-renderer.ts";
import type { MermaidThemeMode } from "../mermaid-block-renderable.ts";
import { createSyntectCodeBlockRenderer } from "../syntect-code-block-renderer.ts";
import { normalizedInputFor } from "./input-normalization.ts";
import { OpenTuiFrameRuntime } from "./frame-runtime.ts";
import { RunLedgerTextareaRenderable } from "./footer-editor-runtime.ts";
import type { OpenTuiComponentRuntime, OpenTuiComponentRuntimeOptions } from "./types.ts";

/** 把 pure component snapshot 挂载到一个已存在的 OpenTUI renderer。 */
export function createOpenTuiComponentRuntimeFromRenderer(
  renderer: CliRenderer,
  options: OpenTuiComponentRuntimeOptions,
): OpenTuiComponentRuntime {
  const screen = new BoxRenderable(renderer, {
    id: "runledger-screen",
    width: "100%",
    height: "100%",
    flexDirection: "column",
  });
  const transcript = new ScrollBoxRenderable(renderer, {
    id: "runledger-transcript",
    width: "100%",
    flexGrow: 1,
    minHeight: 1,
    stickyScroll: true,
    stickyStart: "bottom",
    viewportCulling: true,
    viewportOptions: { paddingRight: 0 },
    verticalScrollbarOptions: {
      paddingLeft: 1,
      visible: false,
    },
    contentOptions: { flexDirection: "column", minHeight: 0 },
  });
  const newContent = new TextRenderable(renderer, {
    id: "runledger-new-content",
    width: "100%",
    height: 0,
    flexShrink: 0,
    content: "",
  });
  const statusIndicator = new TextRenderable(renderer, {
    id: "runledger-status-indicator",
    width: "100%",
    height: 0,
    flexShrink: 0,
    content: "",
  });
  // 对齐 codex ChatComposer:输入区保持 3 行总高度,输入行上下各留 1 行;
  // footer 是紧随 composer 的独立区域,不覆盖输入区背景。
  const editorRow = new BoxRenderable(renderer, {
    id: "runledger-editor-row",
    width: "100%",
    height: 3,
    flexShrink: 0,
    flexDirection: "row",
    paddingTop: 1,
    paddingRight: 1,
    paddingBottom: 1,
  });
  const editorPrompt = new TextRenderable(renderer, {
    id: "runledger-editor-prompt",
    width: 2,
    height: 1,
    flexShrink: 0,
    content: "› ",
  });
  const editor = new RunLedgerTextareaRenderable(renderer, {
    id: "runledger-editor",
    width: "100%",
    flexGrow: 1,
    flexShrink: 1,
    placeholder: "Message RunLedger…",
    wrapMode: "word",
  });
  editorRow.add(editorPrompt);
  editorRow.add(editor);
  const footer = new TextRenderable(renderer, {
    id: "runledger-footer",
    width: "100%",
    flexShrink: 0,
    content: "",
  });
  screen.add(transcript);
  screen.add(newContent);
  screen.add(statusIndicator);
  screen.add(editorRow);
  screen.add(footer);
  renderer.root.add(screen);
  editor.focus();

  const nativeSyntax = options.syntaxHighlightService === undefined && options.createSyntaxHighlightService === undefined
    ? loadNativeSyntaxAddon()
    : undefined;
  const ownsSyntaxHighlightService = options.syntaxHighlightService === undefined;
  const syntaxHighlightService = options.syntaxHighlightService
    ?? options.createSyntaxHighlightService?.()
    ?? new SyntaxHighlightService({
      addon: nativeSyntax?.ok === true ? nativeSyntax.addon : undefined,
      performanceObserver: options.performanceObserver,
    });
  let mermaidThemeMode: MermaidThemeMode = renderer.themeMode ?? "dark";
  const syntaxThemeController = options.syntaxThemeController ?? new SyntaxThemeController({
    availableThemes: BUILTIN_SYNTAX_THEME_NAMES,
    configuredName: options.initialSyntaxThemeName,
    terminalMode: mermaidThemeMode,
  });
  const mermaidRenderNode = createMermaidCodeBlockRenderer(renderer, {
    performanceObserver: options.performanceObserver,
    getThemeMode: () => mermaidThemeMode,
  });
  const codeBlockRenderNode = createSyntectCodeBlockRenderer(renderer, {
    highlightService: syntaxHighlightService,
    mermaidRenderNode,
    themeController: syntaxThemeController,
  });
  const frameRuntime = new OpenTuiFrameRuntime({
    renderer,
    screen,
    transcript,
    newContent,
    statusIndicator,
    editorRow,
    editorPrompt,
    editor,
    footer,
    codeBlockRenderNode,
    syntaxHighlightService,
    syntaxThemeController,
    options,
  });

  let previousNativeCellsUpdated = 0;
  const copySelection = (selectedText: string | undefined): boolean => {
    if (selectedText === undefined || selectedText.length === 0) return false;
    renderer.copyToClipboardOSC52(selectedText);
    return true;
  };
  const onSelection = (): void => {
    copySelection(renderer.getSelection()?.getSelectedText());
  };
  renderer.on("selection", onSelection);
  const scrollTranscriptForWheel: NonNullable<typeof editorRow.onMouseScroll> = (event) => {
    const direction = event.scroll?.direction;
    if (direction !== "up" && direction !== "down") return;
    const delta = Math.max(1, event.scroll?.delta ?? 1);
    frameRuntime.scrollBy(direction === "up" ? -delta : delta);
  };
  editorRow.onMouseScroll = scrollTranscriptForWheel;
  newContent.onMouseScroll = scrollTranscriptForWheel;
  footer.onMouseScroll = scrollTranscriptForWheel;
  renderer.keyInput.on("keypress", (key) => {
    key.preventDefault();
    key.stopPropagation();
    const input = normalizedInputFor(key);
    const appInput = appInputForKeypress(input);
    if (appInput !== undefined) options.onActions?.(normalizeAppInput(appInput));
    if (input === "ctrl+c") {
      if (copySelection(renderer.getSelection()?.getSelectedText())) return;
    }
    if (input === "pageUp" || input === "pageDown") {
      frameRuntime.scrollBy(input === "pageUp" ? -1 : 1, "viewport");
      return;
    }
    options.onInput(input);
  });
  renderer.keyInput.on("paste", (event) => {
    event.preventDefault();
    event.stopPropagation();
    const text = new TextDecoder().decode(event.bytes);
    options.onActions?.(normalizeAppInput({ kind: "paste", text }));
    if (options.onPaste !== undefined) options.onPaste(text);
    else options.onInput(text);
  });
  // OpenTUI 自身会查询终端默认色(OSC 10/11);把回复原样转发给上层解析,
  // 避免本适配层与 primitives 互相引用。
  const unsubscribeOsc = renderer.subscribeOsc((sequence) => options.onOsc?.(sequence));
  const onResize = (columns: number, rows: number): void => {
    options.onActions?.(normalizeAppInput({ kind: "resize", columns, rows }));
    options.onResize();
  };
  const onFocus = (): void => { options.onActions?.(normalizeAppInput({ kind: "focus", focused: true })); };
  const onBlur = (): void => { options.onActions?.(normalizeAppInput({ kind: "focus", focused: false })); };
  renderer.on("resize", onResize);
  renderer.on("focus", onFocus);
  renderer.on("blur", onBlur);
  const onThemeMode = (mode: "dark" | "light"): void => {
    mermaidThemeMode = mode;
    frameRuntime.applyThemeMode(mode);
    options.onThemeMode?.(mode);
  };
  renderer.on("theme_mode", onThemeMode);
  const onFrame = (): void => {
    const stats = renderer.getNativeStats();
    const cellsUpdated = Math.max(0, stats.cellsUpdated - previousNativeCellsUpdated);
    previousNativeCellsUpdated = stats.cellsUpdated;
    options.performanceObserver?.recordNativeFrame({
      durationMs: Math.max(0, stats.nativeLastFrameTime),
      cellsUpdated,
    });
    frameRuntime.updateHighlightAdmission();
  };
  renderer.on("frame", onFrame);

  return {
    update: (frame) => frameRuntime.update(frame),
    getLastDirtyPartIds: () => frameRuntime.getLastDirtyPartIds(),
    destroy: () => {
      renderer.off("frame", onFrame);
      renderer.off("selection", onSelection);
      renderer.off("resize", onResize);
      renderer.off("focus", onFocus);
      renderer.off("blur", onBlur);
      renderer.off("theme_mode", onThemeMode);
      unsubscribeOsc();
      codeBlockRenderNode.dispose();
      if (ownsSyntaxHighlightService) syntaxHighlightService.destroy();
      frameRuntime.disposeNodes();
      renderer.destroy();
      frameRuntime.destroyStyles();
    },
  };
}

/** 生产路径只创建一个 OpenTUI renderer，并把销毁权交给 runtime owner。 */
export async function createOpenTuiComponentRuntime(
  options: OpenTuiComponentRuntimeOptions,
): Promise<OpenTuiComponentRuntime> {
  const renderer: CliRenderer = await createCliRenderer({
    screenMode: "alternate-screen",
    exitOnCtrlC: false,
    consoleMode: "disabled",
    openConsoleOnError: false,
  });
  // OpenTUI 的 SHOW_CONSOLE 会在构造期直接显示覆盖层，需显式清除。
  renderer.console.hide();
  return createOpenTuiComponentRuntimeFromRenderer(renderer, options);
}

export type { OpenTuiComponentFrame, OpenTuiComponentRuntime, OpenTuiComponentRuntimeOptions, EditorAppearance, TranscriptScrollPresentation } from "./types.ts";
