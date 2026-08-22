import {
  BoxRenderable,
  CodeRenderable,
  InputRenderable,
  MarkdownRenderable,
  ScrollBoxRenderable,
  SelectRenderable,
  StyledText,
  TextRenderable,
  TextareaRenderable,
  createCliRenderer,
  type CliRenderer,
  type KeyEvent,
  type MouseEvent,
  type Renderable,
} from "@opentui/core";
import stringWidth from "string-width";
import { ansiToStyledText } from "./ansi-styled-text.ts";
import type { TuiPerformanceObserver } from "./performance-observer.ts";
import { createRunLedgerSyntaxStyle } from "./syntax-style.ts";
import { createMermaidCodeBlockRenderer } from "./mermaid-code-block-renderer.ts";
import { MermaidBlockRenderable, type MermaidThemeMode } from "./mermaid-block-renderable.ts";
import type { PresentationBlock, StatusIndicatorView } from "../presentation.ts";
import { appInputForKeypress, normalizeAppInput } from "../input/normalize-action.ts";
import type { TuiAction } from "../application/action.ts";
import type { OverlayAnchor, OverlayVariant } from "../primitives.ts";
import { loadNativeSyntaxAddon } from "../highlight/native-loader.ts";
import { SyntaxHighlightService } from "../highlight/service.ts";
import { BUILTIN_SYNTAX_THEME_NAMES, SyntaxThemeController } from "../highlight/theme-controller.ts";
import { createSyntectCodeBlockRenderer } from "./syntect-code-block-renderer.ts";
import { SyntectCodeBlockRenderable, type HighlightAdmission } from "./syntect-code-block-renderable.ts";
import { ExecRenderable, plainExecText } from "./exec-renderable.ts";
import { stripShellLoginWrapper } from "./exec-renderable.ts";
import { DiffRenderable, diffPlainText } from "./diff-renderable.ts";
import { PlanUpdateRenderable, planUpdatePlainText } from "./plan-update-renderable.ts";
import { NoticeRenderable, noticePlainText } from "./notice-renderable.ts";
import { formatSeparatorLabel, STATUS_DETAILS_PREFIX } from "./block-layout.ts";
import { statusLineToStyledText } from "../highlight/status-style.ts";
import { displayWidth, graphemes, truncateDisplayWidth, wrapDisplayWidth } from "../mermaid/display-width.ts";
import { freezeStreamPrefix, type SettledSpan } from "./settled-prefix.ts";
import { splitClosedStreamingTable } from "./streaming-table-split.ts";
import { BodySignatureTracker } from "./body-signature.ts";
import { settled, type PresentationPart } from "../timeline/part-stability.ts";
import { shimmerStatusLine, type ShimmerStatusLineOptions } from "./shimmer-status-line.ts";

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
  body: readonly (string | PresentationBlock)[];
  editorText: string;
  /** 自有 Editor 模型投影出的 UTF-16 光标 offset;缺省保持文本末尾。 */
  editorCursorOffset?: number;
  /** 输入区高度(随内容增长);缺省保持 3(与既有测试默认一致)。 */
  editorHeight?: number;
  /** 输入区外观;缺省不铺背景 / 不染色(测试与未接线环境保持原样)。 */
  editorAppearance?: EditorAppearance;
  /** 主对话内建 scrollbar 的纯 presentation；缺省保持 hidden。 */
  transcriptScrollPresentation?: TranscriptScrollPresentation;
  /** editor 上方的运行中状态指示行；undefined 时占用零高度。 */
  statusIndicator?: StatusIndicatorView;
  /** 纯文本测量完成后应用的状态行渐变参数。 */
  statusIndicatorShimmer?: ShimmerStatusLineOptions;
  footer: readonly (string | Extract<PresentationBlock, { readonly kind: "status-line" }>)[];
  overlay?: readonly (string | PresentationBlock)[];
  /** overlay 定位锚点;当前仅区分 bottom-left(贴合编辑器)与其余(居中)。 */
  overlayAnchor?: OverlayAnchor;
  /** transcript overlay 使用全屏 surface；普通 modal 保持既有布局。 */
  overlayVariant?: OverlayVariant;
  /** nonCapturing 弹窗(如 slash 补全):贴编辑器上方、全宽、单行行内展示。 */
  overlayNonCapturing?: boolean;
}

export interface OpenTuiComponentRuntimeOptions {
  onInput(data: string): void;
  onResize(): void;
  onActions?(actions: readonly TuiAction[]): void;
  onThemeMode?(mode: "dark" | "light"): void;
  /** 终端回复的原始 OSC 序列(含 OSC 11 背景色);由调用方解析。 */
  onOsc?(sequence: string): void;
  performanceObserver?: TuiPerformanceObserver;
  /** Effective presentation setting; false keeps Mermaid fences on native Markdown rendering. */
  renderMermaid?: boolean;
  syntaxHighlightService?: SyntaxHighlightService;
  /** 构造 runtime-owned highlighter 的测试/组合接缝；销毁语义与默认 native loader 路径一致。 */
  createSyntaxHighlightService?: () => SyntaxHighlightService;
  syntaxThemeController?: SyntaxThemeController;
  initialSyntaxThemeName?: string;
}

/** OpenTUI 0.4.x visualCol 按字符计；终端光标必须按实际 cell 宽度投影。 */
class RunLedgerTextareaRenderable extends TextareaRenderable {
  protected override renderCursor(_buffer: Parameters<TextareaRenderable["render"]>[0]): void {
    if (!this._showCursor || !this.focused) return;
    const visualCursor = this.editorView.getVisualCursor();
    const logicalLine = this.plainText.split("\n")[visualCursor.logicalRow] ?? "";
    const logicalPrefix = logicalLine.slice(0, visualCursor.logicalCol);
    const visualLineStartColumn = this.editorView.getLineInfo().lineStartCols[visualCursor.visualRow] ?? 0;
    const cursorColumn = Math.max(0, stringWidth(logicalPrefix) - visualLineStartColumn);
    this.ctx.setCursorPosition(
      this.screenX + cursorColumn + 1,
      this.screenY + visualCursor.visualRow + 1,
      true,
    );
    this.ctx.setCursorStyle({ ...this._cursorStyle, color: this._cursorColor });
  }
}

export interface OpenTuiComponentRuntime {
  update(frame: OpenTuiComponentFrame): void;
  getLastDirtyPartIds(): readonly string[];
  destroy(): void;
}

type BodyRenderable = TextRenderable | MarkdownRenderable | ExecRenderable | DiffRenderable | PlanUpdateRenderable | NoticeRenderable;
type OverlayRenderable = TextRenderable | InputRenderable | SelectRenderable | ExecRenderable;
interface KeyedRenderable<T extends BodyRenderable | OverlayRenderable> {
  readonly kind: string;
  readonly renderable: T;
  contentKey?: string;
  streaming?: boolean;
}

interface SettledMarkdownState {
  readonly span: SettledSpan;
  readonly renderable: MarkdownRenderable;
}

function normalizedInputFor(key: KeyEvent): string {
  const aliases: Record<string, string> = {
    return: "enter",
    pageup: "pageUp",
    pagedown: "pageDown",
  };
  const name = aliases[key.name.toLowerCase()] ?? key.name.toLowerCase();
  const namedKeys = new Set([
    "enter", "escape", "tab", "backspace", "delete", "home", "end",
    "pageUp", "pageDown", "up", "down", "left", "right",
  ]);
  const modifiers: string[] = [];
  if (key.ctrl) modifiers.push("ctrl");
  if (key.meta || key.option) modifiers.push("alt");
  if (key.super) modifiers.push("super");
  if (key.shift && (modifiers.length > 0 || namedKeys.has(name))) modifiers.push("shift");
  if (modifiers.length > 0) return `${modifiers.join("+")}+${name}`;
  if (namedKeys.has(name)) return name;
  return key.sequence || key.raw;
}

function safeRenderableId(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/gu, "-");
}

/** 24-bit 精确色的 `›` prompt StyledText(不经 16 色降级,与主题 hex 一致)。 */
function promptStyledText(hex: string): StyledText {
  const match = /^#?([0-9a-fA-F]{6})$/.exec(hex);
  if (!match) return ansiToStyledText("› ");
  const value = match[1]!;
  const r = Number.parseInt(value.slice(0, 2), 16);
  const g = Number.parseInt(value.slice(2, 4), 16);
  const b = Number.parseInt(value.slice(4, 6), 16);
  return ansiToStyledText(`\x1b[1m\x1b[38;2;${r};${g};${b}m›\x1b[22m\x1b[39m `);
}

function blockKey(block: PresentationBlock, index: number): string {
  return block.id ?? `${block.kind}-${index}`;
}

function blockText(block: PresentationBlock): string {
  if (block.kind === "select") return [block.title, ...block.options.map((option) => option.label)].join("\n");
  if (block.kind === "input") return `${block.title}\n${block.message}\n${block.value}`;
  if (block.kind === "separator") return block.content ?? formatSeparatorLabel(block.label, block.metrics);
  if (block.kind === "command") return `$ ${stripCommandForPlaintext(block.command)}`;
  if (block.kind === "exec") return plainExecText(block);
  if (block.kind === "diff") return `${diffPlainText(block)}\u0000syntax=${block.syntaxHighlight !== false}\u0000streaming=${block.streaming === true}`;
  if (block.kind === "status-line") return block.segments.map((segment) => segment.text).join(block.separator ?? " · ");
  if (block.kind === "plan-update") return planUpdatePlainText(block);
  if (block.kind === "notice") return noticePlainText(block);
  return block.content;
}

function overlayBlockHeight(block: PresentationBlock): number {
  if (block.kind === "select") {
    return 1 + (block.query === undefined ? 0 : 1) + overlaySelectHeight(block.options);
  }
  if (block.kind === "input") return 3;
  return blockText(block).split("\n").length;
}

function toPresentationBlock(rawBlock: string | PresentationBlock): PresentationBlock {
  return typeof rawBlock === "string" ? { kind: "text", content: rawBlock } : rawBlock;
}

function renderableId(prefix: string, key: string): string {
  return `${prefix}-${safeRenderableId(key)}`;
}

function stripCommandForPlaintext(command: string): string {
  return stripShellLoginWrapper(command);
}

function blockCharacterCount(block: string | PresentationBlock): number {
  if (typeof block === "string") return block.length;
  return block.kind === "select"
    ? block.title.length + block.options.reduce((total, option) => total + option.label.length, 0)
    : block.kind === "input"
    ? block.title.length + block.message.length + block.value.length
    : block.kind === "separator"
    ? (block.content ?? formatSeparatorLabel(block.label, block.metrics)).length
    : block.kind === "command"
    ? block.command.length + 2
    : block.kind === "exec"
    ? plainExecText(block).length
    : block.kind === "diff"
    ? diffPlainText(block).length
    : block.kind === "status-line"
    ? block.segments.reduce((total, segment) => total + segment.text.length, 0)
    : block.kind === "plan-update"
    ? planUpdatePlainText(block).length
    : block.kind === "notice"
    ? noticePlainText(block).length
    : block.content.length;
}

function frameCharacterCount(frame: OpenTuiComponentFrame): number {
  return frame.body.reduce((total, block) => total + blockCharacterCount(block), 0)
    + frame.editorText.length
    + (frame.statusIndicator === undefined ? 0 : statusIndicatorPlainText(frame.statusIndicator).length)
    + frame.footer.reduce((total, line) => total + (typeof line === "string" ? line.length : line.segments.reduce((sum, segment) => sum + segment.text.length, 0)), 0)
    + (frame.overlay?.reduce((total, block) => total + blockCharacterCount(block), 0) ?? 0);
}

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
  // 输入区 = 左 gutter(prompt 2 列)+ textarea,上下留白各 1 行(codex composer
  // inset(top=1, left=LIVE_PREFIX_COLS, bottom=1, right=1) 的 row 布局复刻)。
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

  let overlay: BoxRenderable | undefined;
  let bodyNodes = new Map<string, KeyedRenderable<BodyRenderable>>();
  let settledMarkdownStates = new Map<string, SettledMarkdownState>();
  let overlayNodes = new Map<string, KeyedRenderable<OverlayRenderable>>();
  let previousBodySignature: readonly string[] = [];
  const bodySignatureTracker = new BodySignatureTracker();
  let lastDirtyPartIds: readonly string[] = [];
  let pendingNewContent = 0;
  let syntaxStyle = createRunLedgerSyntaxStyle();
  let mermaidThemeMode: MermaidThemeMode = renderer.themeMode ?? "dark";
  const mermaidRenderNode = createMermaidCodeBlockRenderer(renderer, {
    performanceObserver: options.performanceObserver,
    renderMermaid: options.renderMermaid,
    getThemeMode: () => mermaidThemeMode,
  });
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
  const syntaxThemeController = options.syntaxThemeController ?? new SyntaxThemeController({
    availableThemes: BUILTIN_SYNTAX_THEME_NAMES,
    configuredName: options.initialSyntaxThemeName,
    terminalMode: mermaidThemeMode,
  });
  const codeBlockRenderNode = createSyntectCodeBlockRenderer(renderer, {
    highlightService: syntaxHighlightService,
    mermaidRenderNode,
    themeController: syntaxThemeController,
  });
  let previousNativeCellsUpdated = 0;
  let requestedEditorHeight = 3;
  let lastEditorHeight = 3;
  let lastEditorAppearance: EditorAppearance | undefined;
  let lastTranscriptScrollPresentation: TranscriptScrollPresentation | undefined;
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
    transcript.scrollBy(direction === "up" ? -delta : delta);
    updateNewContentIndicator();
    renderer.requestRender();
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
      transcript.scrollBy(input === "pageUp" ? -1 : 1, "viewport");
      updateNewContentIndicator();
      renderer.requestRender();
      return;
    }
    options.onInput(input);
  });
  renderer.keyInput.on("paste", (event) => {
    event.preventDefault();
    event.stopPropagation();
    const text = new TextDecoder().decode(event.bytes);
    options.onActions?.(normalizeAppInput({ kind: "paste", text }));
    options.onInput(text);
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
    syntaxThemeController.setTerminalMode(mode);
    const previousStyle = syntaxStyle;
    syntaxStyle = createRunLedgerSyntaxStyle();
    for (const node of bodyNodes.values()) {
      if (node.renderable instanceof MarkdownRenderable) node.renderable.syntaxStyle = syntaxStyle;
      updateMermaidTheme(node.renderable, mode);
    }
    for (const state of settledMarkdownStates.values()) {
      state.renderable.syntaxStyle = syntaxStyle;
      updateMermaidTheme(state.renderable, mode);
    }
    previousStyle.destroy();
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
    updateTranscriptHighlightAdmission(transcript, bodyNodes, settledMarkdownStates);
  };
  renderer.on("frame", onFrame);

  return {
    update: (frame) => {
      const projectionStartedAt = Date.now();
      const requestedScrollPresentation = frame.transcriptScrollPresentation ?? {
        visible: false,
        trackColor: "",
        thumbColor: "",
      };
      const scrollPresentation: TranscriptScrollPresentation = {
        ...requestedScrollPresentation,
        visible: requestedScrollPresentation.visible
          && !(frame.overlay !== undefined && frame.overlayNonCapturing !== true),
      };
      if (lastTranscriptScrollPresentation === undefined
        || lastTranscriptScrollPresentation.visible !== scrollPresentation.visible) {
        transcript.viewportOptions = { paddingRight: scrollPresentation.visible ? 1 : 0 };
        transcript.verticalScrollBar.visible = scrollPresentation.visible;
      }
      if (lastTranscriptScrollPresentation === undefined
        || lastTranscriptScrollPresentation.trackColor !== scrollPresentation.trackColor
        || lastTranscriptScrollPresentation.thumbColor !== scrollPresentation.thumbColor) {
        transcript.verticalScrollbarOptions = {
          paddingLeft: 1,
          trackOptions: {
            ...(scrollPresentation.trackColor.length > 0
              ? { backgroundColor: scrollPresentation.trackColor }
              : {}),
            ...(scrollPresentation.thumbColor.length > 0
              ? { foregroundColor: scrollPresentation.thumbColor }
              : {}),
          },
        };
      }
      lastTranscriptScrollPresentation = scrollPresentation;
      const nextBodyNodes = new Map<string, KeyedRenderable<BodyRenderable>>();
      const nextSettledMarkdownStates = new Map<string, SettledMarkdownState>();
      const desiredBodyNodes: BodyRenderable[] = [];
      const bodyBlocks = frame.body.length > 0
        ? frame.body.map(toPresentationBlock)
        : [{ id: "empty", kind: "text" as const, content: "" }];
      const keyedBodyBlocks: Array<{ readonly block: PresentationBlock; readonly key: string }> = [];
      const usedBodyKeys = new Set<string>();
      for (const [index, block] of bodyBlocks.entries()) {
        const key = blockKey(block, index);
        const uniqueKey = usedBodyKeys.has(key) ? `${key}-${index}` : key;
        usedBodyKeys.add(uniqueKey);
        keyedBodyBlocks.push({ block, key: uniqueKey });
      }
      const bodySignatureSnapshot = bodySignatureTracker.update(keyedBodyBlocks.map(({ block, key }) => ({
        key,
        ...(block.partId === undefined ? {} : { partId: block.partId }),
        kind: block.kind,
        streaming: block.kind === "markdown" ? block.streaming : block.kind === "diff" ? block.streaming === true : false,
        ...(block.contentGeneration === undefined ? {} : { contentGeneration: block.contentGeneration }),
        ...(block.finalized === undefined ? {} : { finalized: block.finalized }),
        contentKey: isSettledPresentationBlock(block) ? "" : blockSignatureText(block),
      })));
      const bodySignature = bodySignatureSnapshot.signature;
      const bodyChanged = bodySignatureSnapshot.changed;
      lastDirtyPartIds = bodySignatureSnapshot.changedKeys;
      const wasFollowing = isAtBottom(transcript);
      if (previousBodySignature.length > 0 && bodyChanged) {
        if (bodySignature.length < previousBodySignature.length) pendingNewContent = 0;
        else if (wasFollowing) pendingNewContent = 0;
        else pendingNewContent += Math.max(1, bodySignature.length - previousBodySignature.length);
      }
      previousBodySignature = bodySignature;
      for (const { block, key } of keyedBodyBlocks) {
        const previous = bodyNodes.get(key);
        const expectedKind = block.kind;
        const previousSettled = settledMarkdownStates.get(key);
        const markdownBlock = block.kind === "markdown" ? block : undefined;
        const settledSpan = markdownBlock?.streaming === true
          ? chooseSettledMarkdownSpan(
            markdownBlock.content,
            previousSettled?.span,
            splitClosedStreamingTable(markdownBlock.content),
          )
          : undefined;
        const splitMarkdown = markdownBlock !== undefined
          && settledSpan !== undefined
          && settledSpan.end > 0
          && settledSpan.end < markdownBlock.content.length;
        let settledRenderable: MarkdownRenderable | undefined;
        if (splitMarkdown && settledSpan !== undefined) {
          settledRenderable = previousSettled?.renderable ?? new MarkdownRenderable(renderer, {
            id: renderableId("runledger-block", `${key}-settled`),
            width: "100%",
            flexShrink: 0,
            content: settledSpan.prefixText,
            streaming: true,
            syntaxStyle,
            internalBlockMode: "top-level",
            renderNode: codeBlockRenderNode,
          });
          if (settledRenderable.content !== settledSpan.prefixText) {
            settledRenderable.content = "";
            settledRenderable.content = settledSpan.prefixText;
          }
          settledRenderable.streaming = false;
          finalizeMarkdownChildren(settledRenderable);
          nextSettledMarkdownStates.set(key, { span: settledSpan, renderable: settledRenderable });
        }
        const markdownContent = splitMarkdown && settledSpan !== undefined && markdownBlock !== undefined
          ? markdownBlock.content.slice(settledSpan.end)
          : undefined;
        const contentKey = block.kind === "markdown"
          ? markdownContent ?? block.content
          : blockText(block);
        let current = previous;
        if (current?.kind !== expectedKind) {
          if (current) transcript.remove(current.renderable);
          current?.renderable.destroyRecursively();
          current = undefined;
        }
        if (!current) {
          const renderable = block.kind === "markdown"
            ? new MarkdownRenderable(renderer, {
              id: renderableId("runledger-block", key),
              width: "100%",
              flexShrink: 0,
              content: contentKey,
              // OpenTUI 0.4.5 首次以 streaming=false 创建时不会 materialize block cache，
              // 因此一律先按 streaming=true 创建；final 帧在内容落定后
              // 翻转 streaming 并 finalize 子 block（见下方 final 分支）。
              streaming: true,
              syntaxStyle,
              internalBlockMode: "top-level",
              renderNode: codeBlockRenderNode,
            })
            : block.kind === "exec"
            ? new ExecRenderable(renderer, {
              id: renderableId("runledger-block", key),
              width: "100%",
              flexShrink: 0,
              block,
              highlightService: syntaxHighlightService,
              themeController: syntaxThemeController,
            })
            : block.kind === "diff"
            ? new DiffRenderable(renderer, {
              id: renderableId("runledger-block", key),
              width: "100%",
              flexShrink: 0,
              block,
              highlightService: syntaxHighlightService,
              themeController: syntaxThemeController,
            })
            : block.kind === "plan-update"
            ? new PlanUpdateRenderable(renderer, {
              id: renderableId("runledger-block", key),
              width: "100%",
              flexShrink: 0,
              block,
            })
            : block.kind === "notice"
            ? new NoticeRenderable(renderer, {
              id: renderableId("runledger-block", key),
              width: "100%",
              flexShrink: 0,
              block,
              highlightService: syntaxHighlightService,
              themeController: syntaxThemeController,
            })
            : new TextRenderable(renderer, {
              id: renderableId("runledger-block", key),
              width: "100%",
              flexShrink: 0,
              content: ansiToStyledText(blockText(block)),
            });
          current = {
            kind: expectedKind,
            renderable,
            contentKey,
            ...(block.kind === "markdown" ? { streaming: block.streaming } : {}),
          };
          if (block.kind === "markdown" && !block.streaming && renderable instanceof MarkdownRenderable) {
            // OpenTUI 0.4.5：markdown 只在 streaming 态 materialize 内部 block；
            // final 帧在内容落定后翻转并强制子 block 以 unstyled 文本绘制，否则内容整体消失。
            renderable.streaming = false;
            finalizeMarkdownChildren(renderable);
          }
        } else if (block.kind === "markdown" && current.renderable instanceof MarkdownRenderable) {
          if (current.streaming !== block.streaming) {
            if (!block.streaming) {
              // OpenTUI 0.4.5：streaming -> final 边界先清空内部 block cache，
              // 防止旧 block 与内容重建结果并存（残留原始 fence 文本等）。
              current.renderable.content = "";
              current.contentKey = undefined;
            }
            current.renderable.streaming = block.streaming;
            current.streaming = block.streaming;
          }
          if (current.contentKey !== contentKey) {
            // split/rewind 后 tail 不再是旧正文的 append；先清空 OpenTUI 的
            // 内部 block cache，避免旧前缀状态污染新的 tail。
            if (current.contentKey !== undefined && !contentKey.startsWith(current.contentKey)) {
              current.renderable.content = "";
              current.contentKey = undefined;
            }
            current.renderable.content = contentKey;
            current.contentKey = contentKey;
          }
          // 同上：final 帧内容落定后再 finalize 子 block（顺序必须在 content set 之后）。
          if (!block.streaming) finalizeMarkdownChildren(current.renderable);
        } else if (block.kind === "exec" && current.renderable instanceof ExecRenderable) {
          const contentKey = blockText(block);
          if (current.contentKey !== contentKey) {
            current.renderable.updateBlock(block);
            current.contentKey = contentKey;
          }
        } else if (block.kind === "diff" && current.renderable instanceof DiffRenderable) {
          const contentKey = blockText(block);
          if (current.contentKey !== contentKey) {
            current.renderable.updateBlock(block);
            current.contentKey = contentKey;
          }
        } else if (block.kind === "plan-update" && current.renderable instanceof PlanUpdateRenderable) {
          const contentKey = blockText(block);
          if (current.contentKey !== contentKey) {
            current.renderable.updateBlock(block);
            current.contentKey = contentKey;
          }
        } else if (block.kind === "notice" && current.renderable instanceof NoticeRenderable) {
          const contentKey = blockText(block);
          if (current.contentKey !== contentKey) {
            current.renderable.updateBlock(block);
            current.contentKey = contentKey;
          }
        } else if (current.renderable instanceof TextRenderable) {
          const contentKey = blockText(block);
          if (current.contentKey !== contentKey) {
            current.renderable.content = ansiToStyledText(contentKey);
            current.contentKey = contentKey;
          }
        }
        nextBodyNodes.set(key, current);
        if (settledRenderable !== undefined) desiredBodyNodes.push(settledRenderable);
        desiredBodyNodes.push(current.renderable);
      }
      for (const [key, state] of settledMarkdownStates) {
        if (nextSettledMarkdownStates.has(key)) continue;
        transcript.remove(state.renderable);
        state.renderable.destroyRecursively();
      }
      for (const [key, node] of bodyNodes) {
        if (!nextBodyNodes.has(key)) {
          transcript.remove(node.renderable);
          node.renderable.destroyRecursively();
        }
      }
      for (const [index, node] of desiredBodyNodes.entries()) {
        if (transcript.getChildren()[index] !== node) {
          if (node.parent === transcript) transcript.remove(node);
          transcript.add(node, index);
        }
      }
      bodyNodes = nextBodyNodes;
      settledMarkdownStates = nextSettledMarkdownStates;
      if (editor.plainText !== frame.editorText) {
        editor.setText(frame.editorText);
      }
      const editorCursorOffset = Math.max(0, Math.min(frame.editorCursorOffset ?? frame.editorText.length, frame.editorText.length));
      if (editor.cursorOffset !== editorCursorOffset) editor.cursorOffset = editorCursorOffset;
      if (frame.editorHeight !== undefined) requestedEditorHeight = frame.editorHeight;
      const plainStatus = frame.statusIndicator === undefined ? "" : statusIndicatorPlainText(frame.statusIndicator, renderer.width);
      const projectedStatus = plainStatus.length > 0 && frame.statusIndicator !== undefined && frame.statusIndicatorShimmer !== undefined
        ? shimmerStatusLine(plainStatus, frame.statusIndicator, frame.statusIndicatorShimmer)
        : plainStatus;
      statusIndicator.visible = projectedStatus.length > 0;
      statusIndicator.content = projectedStatus.length > 0 ? ansiToStyledText(projectedStatus) : "";
      statusIndicator.height = plainStatus.length > 0 ? plainStatus.split("\n").length : 0;
      // OpenTUI 的 native word-wrap 是原生路径的测量 authority；用真实 textarea
      // 宽度(width - prompt 2 - right inset 1)校正纯组件估算，避免隐藏尾行。
      const editorInnerWidth = Math.max(1, renderer.width - 3);
      const measuredLines = editor.editorView.measureForDimensions(editorInnerWidth, 0x7fff)?.lineCount ?? 1;
      const desiredEditorHeight = Math.max(3, requestedEditorHeight, measuredLines + 2);
      // footer 与至少 1 行 transcript 必须留在 viewport 内；达到上限后 textarea
      // 由 OpenTUI 自己滚动，而不是把 footer 推出屏幕。
      const footerHeight = Math.max(1, frame.footer.length);
      const maxEditorHeight = Math.max(1, renderer.height - footerHeight - statusIndicator.height - 1);
      const boundedEditorHeight = Math.min(desiredEditorHeight, maxEditorHeight);
      if (boundedEditorHeight !== lastEditorHeight) {
        lastEditorHeight = boundedEditorHeight;
        editorRow.height = lastEditorHeight;
      }
      const appearance = frame.editorAppearance;
      if (appearance !== undefined && appearance !== lastEditorAppearance) {
        if (lastEditorAppearance === undefined || lastEditorAppearance.backgroundColor !== appearance.backgroundColor) {
          editorRow.backgroundColor = appearance.backgroundColor;
        }
        if (lastEditorAppearance === undefined || lastEditorAppearance.promptColor !== appearance.promptColor) {
          editorPrompt.content = appearance.promptColor.length > 0
            ? promptStyledText(appearance.promptColor)
            : ansiToStyledText("› ");
        }
        if (lastEditorAppearance === undefined || lastEditorAppearance.placeholderColor !== appearance.placeholderColor) {
          editor.placeholderColor = appearance.placeholderColor;
        }
        lastEditorAppearance = appearance;
      }
      footer.content = styledFooter(frame.footer, syntaxHighlightService, syntaxThemeController);
      footer.height = footerHeight;
      updateNewContentIndicator();

      if (frame.overlay) {
        const overlayBlocks = frame.overlay.map(toPresentationBlock);
        const isTranscriptOverlay = frame.overlayVariant === "transcript";
        const hasInteractiveControl = overlayBlocks.some((block) => block.kind === "select" || block.kind === "input");
        // nonCapturing 弹窗(slash 补全):贴编辑器上方、全宽、无模态边框;
        // 其余 overlay 保持居中宽框(兼容既有 modal 外观)。
        const bottomLeft = frame.overlayAnchor === "bottom-left";
        const compactPopup = frame.overlayNonCapturing === true && bottomLeft;
        const modalWidth = isTranscriptOverlay ? renderer.width : Math.max(1, Math.floor(renderer.width * 0.9));
        const modalContentHeight = overlayBlocks.reduce(
          (height, block) => height + overlayBlockHeight(block),
          0,
        ) + 4;
        const maxModalHeight = Math.max(1, Math.floor(renderer.height * 0.8));
        const modalHeight = hasInteractiveControl
          ? Math.min(
            maxModalHeight,
            Math.max(Math.max(1, Math.floor(renderer.height * 0.5)), modalContentHeight),
          )
          : Math.min(maxModalHeight, modalContentHeight);
        if (!overlay) {
          overlay = new BoxRenderable(renderer, {
            id: "runledger-overlay",
            position: "absolute",
            maxHeight: isTranscriptOverlay ? renderer.height : "80%",
            zIndex: 100,
          });
          screen.add(overlay);
        }
        // overlay 节点跨帧复用；每帧重置完整布局，防止 compact popup 的
        // 全宽/无边框样式泄漏到随后同步打开的捕获型 modal。
        overlay.left = isTranscriptOverlay
          ? 0
          : compactPopup
          ? 0
          : bottomLeft
            ? 1
            : Math.max(0, Math.floor((renderer.width - modalWidth) / 2));
        overlay.right = undefined;
        overlay.width = isTranscriptOverlay || compactPopup ? renderer.width : modalWidth;
        overlay.borderStyle = "rounded";
        overlay.border = !compactPopup && !isTranscriptOverlay;
        overlay.padding = compactPopup ? 0 : 1;
        if (isTranscriptOverlay) {
          overlay.backgroundColor = renderer.themeMode === "light" ? "#ffffff" : "#0b0e14";
          overlay.top = 0;
          overlay.bottom = 0;
          overlay.height = renderer.height;
          overlay.maxHeight = renderer.height;
        } else if (compactPopup) {
          overlay.backgroundColor = undefined;
          // 编辑器行上方 1 行留白;编辑器高度/行数变化时随帧更新
          overlay.top = undefined;
          overlay.bottom = footerHeight + boundedEditorHeight + 1;
        } else if (bottomLeft) {
          overlay.backgroundColor = undefined;
          overlay.top = undefined;
          overlay.bottom = 5;
        } else {
          overlay.backgroundColor = undefined;
          overlay.top = Math.max(0, Math.floor((renderer.height - modalHeight) / 2));
          overlay.bottom = undefined;
        }
        if (!isTranscriptOverlay) overlay.height = hasInteractiveControl ? modalHeight : "auto";
        const nextOverlayNodes = new Map<string, KeyedRenderable<OverlayRenderable>>();
        const desiredOverlayNodes: OverlayRenderable[] = [];
        let overlayFocus: InputRenderable | SelectRenderable | undefined;
        for (const [index, block] of overlayBlocks.entries()) {
          const baseKey = block.id ?? String(index);
          if (block.kind === "select") {
            const title = getOverlayTextNode(
              renderer,
              overlayNodes,
              nextOverlayNodes,
              `title-${baseKey}`,
              block.title,
            );
            desiredOverlayNodes.push(title);
            if (block.query !== undefined) {
              const query = getOverlayInputNode(
                renderer,
                overlayNodes,
                nextOverlayNodes,
                `query-${baseKey}`,
                block.query,
                "Filter…",
              );
              desiredOverlayNodes.push(query);
              overlayFocus = query;
            }
            const select = getOverlaySelectNode(
              renderer,
              overlayNodes,
              nextOverlayNodes,
              `select-${baseKey}`,
              block.options.map((option) => ({
                name: option.label,
                description: option.description ?? "",
                value: option.value,
              })),
              block.selectedIndex,
              options.onInput,
            );
            desiredOverlayNodes.push(select);
            overlayFocus ??= select;
          } else if (block.kind === "input") {
            desiredOverlayNodes.push(getOverlayTextNode(
              renderer,
              overlayNodes,
              nextOverlayNodes,
              `title-${baseKey}`,
              block.title,
            ));
            desiredOverlayNodes.push(getOverlayTextNode(
              renderer,
              overlayNodes,
              nextOverlayNodes,
              `message-${baseKey}`,
              block.message,
            ));
            const input = getOverlayInputNode(
              renderer,
              overlayNodes,
              nextOverlayNodes,
              `input-${baseKey}`,
              block.value,
              block.placeholder ?? "",
            );
            desiredOverlayNodes.push(input);
            overlayFocus = input;
		  } else if (block.kind === "command") {
			desiredOverlayNodes.push(getOverlayCommandNode(
			  renderer,
			  overlayNodes,
			  nextOverlayNodes,
			  `command-${baseKey}`,
			  block,
			  syntaxHighlightService,
			  syntaxThemeController,
			));
          } else {
            desiredOverlayNodes.push(getOverlayTextNode(
              renderer,
              overlayNodes,
              nextOverlayNodes,
              `content-${baseKey}`,
              blockText(block),
            ));
          }
        }
        for (const [key, node] of overlayNodes) {
          if (!nextOverlayNodes.has(key)) {
            overlay.remove(node.renderable);
            node.renderable.destroyRecursively();
          }
        }
        for (const [index, node] of desiredOverlayNodes.entries()) {
          if (overlay.getChildren()[index] !== node) {
            if (node.parent === overlay) overlay.remove(node);
            overlay.add(node, index);
          }
        }
        overlayNodes = nextOverlayNodes;
        overlayFocus?.focus();
      } else {
        if (overlay) {
          overlay.destroyRecursively();
          overlay = undefined;
          overlayNodes.clear();
        }
        editor.focus();
      }
      options.performanceObserver?.recordProjection({
        durationMs: Math.max(0, Date.now() - projectionStartedAt),
        processedChars: frameCharacterCount(frame),
        dirtyEntries: lastDirtyPartIds.length,
      });
      renderer.requestRender();
    },
    getLastDirtyPartIds: () => lastDirtyPartIds,
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
      for (const state of settledMarkdownStates.values()) state.renderable.destroyRecursively();
      settledMarkdownStates.clear();
      renderer.destroy();
      syntaxStyle.destroy();
    },
  };

  function updateNewContentIndicator(): void {
    if (pendingNewContent > 0 && isAtBottom(transcript)) pendingNewContent = 0;
    newContent.content = pendingNewContent > 0
      ? `↓ ${pendingNewContent} new content — PageDown to follow`
      : "";
    newContent.height = pendingNewContent > 0 ? 1 : 0;
  }
}

export function statusIndicatorPlainText(view: StatusIndicatorView, width?: number): string {
  const interrupt = view.interruptKey === undefined ? "" : ` • ${view.interruptKey} to interrupt`;
  const inline = view.inlineMessage === undefined ? "" : ` ${view.inlineMessage}`;
  const header = `${view.indicator} ${view.header} (${view.elapsed}${interrupt})${inline}`;
  if (width === undefined) {
    return [header, ...(view.details ?? []).map((detail) => `${STATUS_DETAILS_PREFIX}${detail.text}`)].join("\n");
  }
  const safeWidth = Math.max(1, Math.floor(width));
  const detailLines: string[] = [];
  let detailsTruncated = false;
  for (const [detailIndex, detail] of (view.details ?? []).entries()) {
    const firstPrefix = boundedStatusPrefix(STATUS_DETAILS_PREFIX, safeWidth);
    const continuationPrefix = boundedStatusPrefix("    ", safeWidth);
    const contentWidth = Math.max(1, safeWidth - displayWidth(firstPrefix));
    const wrapped = wrapDisplayWidth(detail.text, contentWidth, Math.max(1, graphemes(detail.text).length + 1));
    for (const [lineIndex, line] of wrapped.entries()) {
      if (detailLines.length >= 3) {
        detailsTruncated = true;
        break;
      }
      const prefix = lineIndex === 0 ? firstPrefix : continuationPrefix;
      detailLines.push(truncateDisplayWidth(`${prefix}${line}`, safeWidth));
    }
    if (detailsTruncated) break;
    if (detailIndex < (view.details?.length ?? 0) - 1 && detailLines.length >= 3) detailsTruncated = true;
  }
  if (detailsTruncated && detailLines.length > 0) {
    const lastIndex = detailLines.length - 1;
    detailLines[lastIndex] = truncateDisplayWidth(`${detailLines[lastIndex]}…`, safeWidth, true);
  }
  return [truncateDisplayWidth(header, safeWidth, true), ...detailLines].join("\n");
}

function chooseSettledMarkdownSpan(
	text: string,
	previous: SettledSpan | undefined,
	tableSplit: ReturnType<typeof splitClosedStreamingTable>,
): SettledSpan | undefined {
	const regular = freezeStreamPrefix(text, previous);
	if (tableSplit === undefined) return regular;
	if (previous !== undefined && !tableSplit.prefixText.startsWith(previous.prefixText)) return regular;
	if (previous !== undefined && tableSplit.prefixEnd <= previous.end) return regular;
	const tableSpan: SettledSpan = {
		start: 0,
		end: tableSplit.prefixEnd,
		prefixText: tableSplit.prefixText,
		lineCount: countNewlines(tableSplit.prefixText),
	};
	return regular === undefined || tableSpan.end > regular.end ? tableSpan : regular;
}

function countNewlines(text: string): number {
	let count = 0;
	for (const character of text) if (character === "\n") count += 1;
	return count;
}

function boundedStatusPrefix(prefix: string, width: number): string {
  return truncateDisplayWidth(prefix, Math.max(0, width - 1));
}

function styledFooter(
  lines: OpenTuiComponentFrame["footer"],
  service: SyntaxHighlightService,
  themeController: SyntaxThemeController,
): StyledText {
	const chunks = lines.flatMap((line, index) => {
		const styled = typeof line === "string"
			? ansiToStyledText(line)
			: statusLineToStyledText(line.segments, (scopes) =>
				service.foregroundForScopes(themeController.snapshot().activeName, scopes), line.separator);
		return index === 0
			? [...styled.chunks]
			: [...ansiToStyledText("\n").chunks, ...styled.chunks];
	});
	return new StyledText(chunks);
}

function updateMermaidTheme(renderable: Renderable, mode: MermaidThemeMode): void {
  if (renderable instanceof MermaidBlockRenderable) renderable.setThemeMode(mode);
  for (const child of renderable.getChildren()) updateMermaidTheme(child, mode);
}

function updateTranscriptHighlightAdmission(
	transcript: ScrollBoxRenderable,
	nodes: ReadonlyMap<string, KeyedRenderable<BodyRenderable>>,
	settledMarkdownStates: ReadonlyMap<string, SettledMarkdownState>,
): void {
	const viewportTop = transcript.viewport.screenY;
	const viewportHeight = Math.max(1, transcript.viewport.height);
	const viewportBottom = viewportTop + viewportHeight;
	const updateNode = (renderable: Renderable): void => {
		visitHighlightRenderables(renderable, (highlightable) => {
			const top = highlightable.screenY;
			const bottom = top + Math.max(1, highlightable.height);
			const admission: HighlightAdmission = bottom > viewportTop && top < viewportBottom
				? "visible"
				: bottom > viewportTop - viewportHeight && top < viewportBottom + viewportHeight
					? "overscan"
					: "offscreen";
			highlightable.setHighlightAdmission(admission);
		});
	};
	for (const node of nodes.values()) {
		updateNode(node.renderable);
	}
	for (const state of settledMarkdownStates.values()) updateNode(state.renderable);
}

function visitHighlightRenderables(
	renderable: Renderable,
  visit: (renderable: SyntectCodeBlockRenderable | ExecRenderable | DiffRenderable) => void,
): void {
  if (renderable instanceof SyntectCodeBlockRenderable || renderable instanceof ExecRenderable || renderable instanceof DiffRenderable) visit(renderable);
	for (const child of renderable.getChildren()) visitHighlightRenderables(child, visit);
}

function finalizeMarkdownChildren(renderable: Renderable): void {
  for (const child of renderable.getChildren()) {
    if (child instanceof CodeRenderable) {
      child.drawUnstyledText = true;
      child.streaming = false;
    }
    finalizeMarkdownChildren(child);
  }
}

function isAtBottom(transcript: ScrollBoxRenderable): boolean {
  // 与 OpenTUI 内部 maxScrollTop（scrollHeight - viewport.height）保持一致，
  // 避免 transcript.height（含 wrapper/scrollbar）与 viewport 高度不一致造成误判。
  const viewportHeight = transcript.viewport?.height ?? transcript.height;
  const maxScrollTop = Math.max(0, transcript.scrollHeight - viewportHeight);
  // 内容未超出视口时 scrollTop 可能为负（OpenTUI 预布局态），此时必然在底部。
  if (maxScrollTop <= 0) return true;
  return transcript.scrollTop >= maxScrollTop - 1;
}

function blockSignatureText(block: PresentationBlock): string {
  return block.kind === "markdown" ? block.content : blockText(block);
}

function presentationPart(block: PresentationBlock): PresentationPart | undefined {
  if (typeof block.entryId !== "string"
    || typeof block.partId !== "string"
    || typeof block.contentGeneration !== "number"
    || typeof block.finalized !== "boolean") return undefined;
  return {
    entryId: block.entryId,
    partId: block.partId,
    contentGeneration: block.contentGeneration,
    finalized: block.finalized,
  };
}

function isSettledPresentationBlock(block: PresentationBlock): boolean {
  const part = presentationPart(block);
  return part !== undefined && settled(part);
}

function getOverlayTextNode(
  renderer: CliRenderer,
  previous: Map<string, KeyedRenderable<OverlayRenderable>>,
  next: Map<string, KeyedRenderable<OverlayRenderable>>,
  key: string,
  content: string,
): TextRenderable {
  const old = previous.get(key);
  const node = old?.kind === "text" && old.renderable instanceof TextRenderable
    ? old.renderable
    : createOverlayTextNode(renderer, old, key);
  if (old?.contentKey !== content) {
    node.content = ansiToStyledText(content);
    // 多行内容按行数自适应高度(默认 1 会裁剪 slash popup 的后续行)
    node.height = Math.max(1, content.split("\n").length);
  }
  next.set(key, { kind: "text", renderable: node, contentKey: content });
  return node;
}

function getOverlayInputNode(
  renderer: CliRenderer,
  previous: Map<string, KeyedRenderable<OverlayRenderable>>,
  next: Map<string, KeyedRenderable<OverlayRenderable>>,
  key: string,
  value: string,
  placeholder: string,
): InputRenderable {
  const old = previous.get(key);
  const node = old?.kind === "input" && old.renderable instanceof InputRenderable
    ? old.renderable
    : createOverlayInputNode(renderer, old, key, value, placeholder);
  if (node.value !== value) node.value = value;
  if (node.placeholder !== placeholder) node.placeholder = placeholder;
  next.set(key, { kind: "input", renderable: node, contentKey: `${value}\u0000${placeholder}` });
  return node;
}

function getOverlayCommandNode(
  renderer: CliRenderer,
  previous: Map<string, KeyedRenderable<OverlayRenderable>>,
  next: Map<string, KeyedRenderable<OverlayRenderable>>,
  key: string,
  block: Extract<PresentationBlock, { readonly kind: "command" }>,
  service: SyntaxHighlightService,
  themeController: SyntaxThemeController,
): ExecRenderable {
  const old = previous.get(key);
  const node = old?.kind === "command" && old.renderable instanceof ExecRenderable
    ? old.renderable
    : createOverlayCommandNode(renderer, old, key, block, service, themeController);
  if (old?.contentKey !== block.command) node.updateBlock(block);
	node.setHighlightAdmission("visible");
  next.set(key, { kind: "command", renderable: node, contentKey: block.command });
  return node;
}

function getOverlaySelectNode(
  renderer: CliRenderer,
  previous: Map<string, KeyedRenderable<OverlayRenderable>>,
  next: Map<string, KeyedRenderable<OverlayRenderable>>,
  key: string,
  options: { name: string; description: string; value: string }[],
  selectedIndex: number,
  onInput: (data: string) => void,
): SelectRenderable {
  const old = previous.get(key);
  const node = old?.kind === "select" && old.renderable instanceof SelectRenderable
    ? old.renderable
    : createOverlaySelectNode(renderer, old, key, options, selectedIndex);
  const contentKey = `${JSON.stringify(options)}\u0000${selectedIndex}`;
  if (old?.contentKey !== contentKey) {
    node.options = options;
    node.selectedIndex = selectedIndex;
    node.height = overlaySelectHeight(options);
  }
  node.onMouseDown = (event) => handleOverlaySelectMouseDown(node, event, onInput);
  next.set(key, { kind: "select", renderable: node, contentKey });
  return node;
}

function handleOverlaySelectMouseDown(
  node: SelectRenderable,
  event: MouseEvent,
  onInput: (data: string) => void,
): void {
  if (event.button !== 0) return;
  const localY = event.y - node.screenY;
  if (localY < 0 || localY >= node.height) return;

  const visibleItems = Math.max(1, Math.floor(node.height / 2));
  const maxScrollOffset = Math.max(0, node.options.length - visibleItems);
  const scrollOffset = Math.max(
    0,
    Math.min(
      node.getSelectedIndex() - Math.floor(visibleItems / 2),
      maxScrollOffset,
    ),
  );
  const selectedIndex = scrollOffset + Math.floor(localY / 2);
  if (selectedIndex < 0 || selectedIndex >= node.options.length) return;

  event.preventDefault();
  event.stopPropagation();
  const currentIndex = node.getSelectedIndex();
  node.setSelectedIndex(selectedIndex);
  const direction = selectedIndex >= currentIndex ? "down" : "up";
  for (let index = currentIndex; index !== selectedIndex; index += direction === "down" ? 1 : -1) {
    onInput(direction);
  }
}

function disposeWrongOverlayNode(
  node: KeyedRenderable<OverlayRenderable> | undefined,
  expectedKind: string,
): void {
  if (!node || node.kind === expectedKind) return;
  node.renderable.parent?.remove(node.renderable);
  node.renderable.destroyRecursively();
}

function createOverlayTextNode(
  renderer: CliRenderer,
  old: KeyedRenderable<OverlayRenderable> | undefined,
  key: string,
): TextRenderable {
  disposeWrongOverlayNode(old, "text");
  return new TextRenderable(renderer, {
    id: renderableId("runledger-overlay", key),
    width: "100%",
    height: 1,
    content: "",
  });
}

function createOverlayInputNode(
  renderer: CliRenderer,
  old: KeyedRenderable<OverlayRenderable> | undefined,
  key: string,
  value: string,
  placeholder: string,
): InputRenderable {
  disposeWrongOverlayNode(old, "input");
  return new InputRenderable(renderer, {
    id: renderableId("runledger-overlay", key),
    width: "100%",
    value,
    placeholder,
  });
}

function createOverlayCommandNode(
  renderer: CliRenderer,
  old: KeyedRenderable<OverlayRenderable> | undefined,
  key: string,
  block: Extract<PresentationBlock, { readonly kind: "command" }>,
  service: SyntaxHighlightService,
  themeController: SyntaxThemeController,
): ExecRenderable {
  disposeWrongOverlayNode(old, "command");
  return new ExecRenderable(renderer, {
    id: renderableId("runledger-overlay", key),
    width: "100%",
    height: 1,
    block,
    highlightService: service,
    themeController,
  });
}

function createOverlaySelectNode(
  renderer: CliRenderer,
  old: KeyedRenderable<OverlayRenderable> | undefined,
  key: string,
  options: { name: string; description: string; value: string }[],
  selectedIndex: number,
): SelectRenderable {
  disposeWrongOverlayNode(old, "select");
  return new SelectRenderable(renderer, {
    id: renderableId("runledger-overlay", key),
    width: "100%",
    height: overlaySelectHeight(options),
    options,
    selectedIndex,
    showDescription: true,
    showSelectionIndicator: true,
  });
}

function overlaySelectHeight(options: readonly { readonly description?: string }[]): number {
  // SelectRenderable 在 showDescription=true 时始终为每项保留两行，哪怕
  // description 为空；按同一布局契约给高度，避免安全决策被裁成单项。
  return Math.max(2, Math.min(12, options.length * 2));
}

/** 生产路径只创建一个 OpenTUI renderer，并把销毁权交给 runtime owner。 */
export async function createOpenTuiComponentRuntime(
  options: OpenTuiComponentRuntimeOptions,
): Promise<OpenTuiComponentRuntime> {
  const renderer: CliRenderer = await createCliRenderer({
    screenMode: "alternate-screen",
    exitOnCtrlC: false,
    consoleMode: "disabled",
  });
  return createOpenTuiComponentRuntimeFromRenderer(renderer, options);
}
