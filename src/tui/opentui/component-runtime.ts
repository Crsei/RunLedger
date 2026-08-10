import {
  BoxRenderable,
  InputRenderable,
  MarkdownRenderable,
  ScrollBoxRenderable,
  SelectRenderable,
  TextRenderable,
  TextareaRenderable,
  createCliRenderer,
  type CliRenderer,
  type KeyEvent,
  type StyledText,
} from "@opentui/core";
import { ansiToStyledText } from "./ansi-styled-text.ts";
import type { TuiPerformanceObserver } from "./performance-observer.ts";
import { createRunLedgerSyntaxStyle } from "./syntax-style.ts";
import type { PresentationBlock } from "../presentation.ts";
import { appInputForKeypress, normalizeAppInput } from "../input/normalize-action.ts";
import type { TuiAction } from "../application/action.ts";
import type { OverlayAnchor } from "../primitives.ts";

/** 输入区外观(由主题/终端背景计算,帧驱动下发到原生组件)。 */
export interface EditorAppearance {
  readonly backgroundColor: string;
  readonly promptColor: string;
  readonly placeholderColor: string;
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
  footer: readonly string[];
  overlay?: readonly (string | PresentationBlock)[];
  /** overlay 定位锚点;当前仅区分 bottom-left(贴合编辑器)与其余(居中)。 */
  overlayAnchor?: OverlayAnchor;
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
}

export interface OpenTuiComponentRuntime {
  update(frame: OpenTuiComponentFrame): void;
  destroy(): void;
}

type BodyRenderable = TextRenderable | MarkdownRenderable;
type OverlayRenderable = TextRenderable | InputRenderable | SelectRenderable;
interface KeyedRenderable<T extends BodyRenderable | OverlayRenderable> {
  readonly kind: string;
  readonly renderable: T;
  contentKey?: string;
  streaming?: boolean;
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
  if (block.kind === "separator") return block.content ?? block.label;
  return block.content;
}

function toPresentationBlock(rawBlock: string | PresentationBlock): PresentationBlock {
  return typeof rawBlock === "string" ? { kind: "text", content: rawBlock } : rawBlock;
}

function renderableId(prefix: string, key: string): string {
  return `${prefix}-${safeRenderableId(key)}`;
}

function blockCharacterCount(block: string | PresentationBlock): number {
  if (typeof block === "string") return block.length;
  return block.kind === "select"
    ? block.title.length + block.options.reduce((total, option) => total + option.label.length, 0)
    : block.kind === "input"
    ? block.title.length + block.message.length + block.value.length
    : block.kind === "separator"
    ? (block.content ?? block.label).length
    : block.content.length;
}

function frameCharacterCount(frame: OpenTuiComponentFrame): number {
  return frame.body.reduce((total, block) => total + blockCharacterCount(block), 0)
    + frame.editorText.length
    + frame.footer.reduce((total, line) => total + line.length, 0)
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
    // scrollbar 覆盖在 transcript 最右列，不占用正文布局宽度；全宽 separator
    // 因而按真实终端列数重排，同时保留长历史的滚动位置提示。
    verticalScrollbarOptions: { position: "absolute", right: 0 },
    contentOptions: { flexDirection: "column", minHeight: 0 },
  });
  const newContent = new TextRenderable(renderer, {
    id: "runledger-new-content",
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
  const editor = new TextareaRenderable(renderer, {
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
  screen.add(editorRow);
  screen.add(footer);
  renderer.root.add(screen);
  editor.focus();

  let overlay: BoxRenderable | undefined;
  let bodyNodes = new Map<string, KeyedRenderable<BodyRenderable>>();
  const pendingMarkdownFinalization = new Map<string, string>();
  let overlayNodes = new Map<string, KeyedRenderable<OverlayRenderable>>();
  let previousBodySignature: readonly string[] = [];
  let pendingNewContent = 0;
  let syntaxStyle = createRunLedgerSyntaxStyle();
  let previousNativeCellsUpdated = 0;
  let requestedEditorHeight = 3;
  let lastEditorHeight = 3;
  let lastEditorAppearance: EditorAppearance | undefined;
  const copySelection = (selectedText: string | undefined): boolean => {
    if (selectedText === undefined || selectedText.length === 0) return false;
    renderer.copyToClipboardOSC52(selectedText);
    return true;
  };
  const onSelection = (): void => {
    copySelection(renderer.getSelection()?.getSelectedText());
  };
  renderer.on("selection", onSelection);
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
  if (options.onThemeMode) {
    renderer.on("theme_mode", (mode) => {
      const previousStyle = syntaxStyle;
      syntaxStyle = createRunLedgerSyntaxStyle();
      for (const node of bodyNodes.values()) {
        if (node.renderable instanceof MarkdownRenderable) node.renderable.syntaxStyle = syntaxStyle;
      }
      previousStyle.destroy();
      options.onThemeMode?.(mode);
    });
  }
  const onFrame = (): void => {
    const stats = renderer.getNativeStats();
    const cellsUpdated = Math.max(0, stats.cellsUpdated - previousNativeCellsUpdated);
    previousNativeCellsUpdated = stats.cellsUpdated;
    options.performanceObserver?.recordNativeFrame({
      durationMs: Math.max(0, stats.nativeLastFrameTime),
      cellsUpdated,
    });
	if (pendingMarkdownFinalization.size > 0) {
		for (const [key, content] of pendingMarkdownFinalization) {
			const node = bodyNodes.get(key);
			if (node?.renderable instanceof MarkdownRenderable) {
				node.renderable.content = "";
				node.renderable.streaming = false;
				node.renderable.content = content;
				node.streaming = false;
			}
		}
		pendingMarkdownFinalization.clear();
		renderer.requestRender();
	}
  };
  renderer.on("frame", onFrame);

  return {
    update: (frame) => {
      const projectionStartedAt = Date.now();
      const nextBodyNodes = new Map<string, KeyedRenderable<BodyRenderable>>();
      const desiredBodyNodes: BodyRenderable[] = [];
      const usedBodyKeys = new Set<string>();
      const bodyBlocks = frame.body.length > 0
        ? frame.body.map(toPresentationBlock)
        : [{ id: "empty", kind: "text" as const, content: "" }];
      const bodySignature = bodyBlocks.map((block, index) => {
        const key = blockKey(block, index);
        const streaming = block.kind === "markdown" ? String(block.streaming) : "";
        return `${key}\u0000${block.kind}\u0000${streaming}\u0000${blockText(block)}`;
      });
      const bodyChanged = !sameStringArray(previousBodySignature, bodySignature);
      const wasFollowing = isAtBottom(transcript);
      if (previousBodySignature.length > 0 && bodyChanged) {
        if (bodySignature.length < previousBodySignature.length) pendingNewContent = 0;
        else if (wasFollowing) pendingNewContent = 0;
        else pendingNewContent += Math.max(1, bodySignature.length - previousBodySignature.length);
      }
      previousBodySignature = bodySignature;
      for (const [index, block] of bodyBlocks.entries()) {
        const baseKey = blockKey(block, index);
        const key = usedBodyKeys.has(baseKey) ? `${baseKey}-${index}` : baseKey;
        usedBodyKeys.add(key);
        const previous = bodyNodes.get(key);
        const expectedKind = block.kind;
        let current = previous;
        if (current?.kind !== expectedKind) {
          if (current) transcript.remove(current.renderable);
          current?.renderable.destroyRecursively();
          current = undefined;
        }
        if (!current) {
          const contentKey = blockText(block);
          const renderable = block.kind === "markdown"
            ? new MarkdownRenderable(renderer, {
              id: renderableId("runledger-block", key),
              width: "100%",
              flexShrink: 0,
              content: block.content,
              // OpenTUI 0.4.5 首次以 streaming=false 创建时不会 materialize block cache。
              // 先按 streaming 创建，再在下方走同一 finalization 边界。
              streaming: true,
              syntaxStyle,
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
            ...(block.kind === "markdown" ? { streaming: renderable instanceof MarkdownRenderable ? renderable.streaming : block.streaming } : {}),
          };
		  if (block.kind === "markdown" && !block.streaming) pendingMarkdownFinalization.set(key, block.content);
        } else if (block.kind === "markdown" && current.renderable instanceof MarkdownRenderable) {
		  if (block.streaming) pendingMarkdownFinalization.delete(key);
          if (!pendingMarkdownFinalization.has(key) && current.renderable.streaming && !block.streaming) {
            // OpenTUI 0.4.5 需要在 streaming -> final 边界清空内部 block cache，
            // 但外层 renderable identity 仍保持稳定。
            current.renderable.content = "";
            current.contentKey = undefined;
          }
          if (current.streaming !== block.streaming) {
            current.renderable.streaming = block.streaming;
            current.streaming = block.streaming;
          }
          if (current.contentKey !== block.content) {
            current.renderable.content = block.content;
            current.contentKey = block.content;
          }
        } else if (current.renderable instanceof TextRenderable) {
          const contentKey = blockText(block);
          if (current.contentKey !== contentKey) {
            current.renderable.content = ansiToStyledText(contentKey);
            current.contentKey = contentKey;
          }
        }
        nextBodyNodes.set(key, current);
        desiredBodyNodes.push(current.renderable);
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
      if (editor.plainText !== frame.editorText) {
        editor.setText(frame.editorText);
      }
      const editorCursorOffset = Math.max(0, Math.min(frame.editorCursorOffset ?? frame.editorText.length, frame.editorText.length));
      if (editor.cursorOffset !== editorCursorOffset) editor.cursorOffset = editorCursorOffset;
      if (frame.editorHeight !== undefined) requestedEditorHeight = frame.editorHeight;
      // OpenTUI 的 native word-wrap 是原生路径的测量 authority；用真实 textarea
      // 宽度(width - prompt 2 - right inset 1)校正纯组件估算，避免隐藏尾行。
      const editorInnerWidth = Math.max(1, renderer.width - 3);
      const measuredLines = editor.editorView.measureForDimensions(editorInnerWidth, 0x7fff)?.lineCount ?? 1;
      const desiredEditorHeight = Math.max(3, requestedEditorHeight, measuredLines + 2);
      // footer 与至少 1 行 transcript 必须留在 viewport 内；达到上限后 textarea
      // 由 OpenTUI 自己滚动，而不是把 footer 推出屏幕。
      const footerHeight = Math.max(1, frame.footer.length);
      const maxEditorHeight = Math.max(1, renderer.height - footerHeight - 1);
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
      footer.content = ansiToStyledText(frame.footer.join("\n"));
      footer.height = footerHeight;
      updateNewContentIndicator();

      if (frame.overlay) {
        const overlayBlocks = frame.overlay.map(toPresentationBlock);
        const hasInteractiveControl = overlayBlocks.some((block) => block.kind === "select" || block.kind === "input");
        // nonCapturing 弹窗(slash 补全):贴编辑器上方、全宽、无模态边框;
        // 其余 overlay 保持居中宽框(兼容既有 modal 外观)。
        const bottomLeft = frame.overlayAnchor === "bottom-left";
        const compactPopup = frame.overlayNonCapturing === true && bottomLeft;
        const modalWidth = Math.max(1, Math.floor(renderer.width * 0.9));
        const modalContentHeight = overlayBlocks.reduce(
          (height, block) => height + blockText(block).split("\n").length,
          0,
        ) + 4;
        const modalHeight = hasInteractiveControl
          ? Math.max(1, Math.floor(renderer.height * 0.5))
          : Math.min(Math.max(1, Math.floor(renderer.height * 0.8)), modalContentHeight);
        if (!overlay) {
          overlay = new BoxRenderable(renderer, {
            id: "runledger-overlay",
            position: "absolute",
            maxHeight: "80%",
            zIndex: 100,
          });
          screen.add(overlay);
        }
        // overlay 节点跨帧复用；每帧重置完整布局，防止 compact popup 的
        // 全宽/无边框样式泄漏到随后同步打开的捕获型 modal。
        overlay.left = compactPopup
          ? 0
          : bottomLeft
            ? 1
            : Math.max(0, Math.floor((renderer.width - modalWidth) / 2));
        overlay.right = undefined;
        overlay.width = compactPopup ? renderer.width : modalWidth;
        overlay.borderStyle = "rounded";
        overlay.border = !compactPopup;
        overlay.padding = compactPopup ? 0 : 1;
        if (compactPopup) {
          // 编辑器行上方 1 行留白;编辑器高度/行数变化时随帧更新
          overlay.top = undefined;
          overlay.bottom = footerHeight + boundedEditorHeight + 1;
        } else if (bottomLeft) {
          overlay.top = undefined;
          overlay.bottom = 5;
        } else {
          overlay.top = Math.max(0, Math.floor((renderer.height - modalHeight) / 2));
          overlay.bottom = undefined;
        }
        overlay.height = hasInteractiveControl ? modalHeight : "auto";
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
        dirtyEntries: frame.body.length,
      });
      renderer.requestRender();
    },
    destroy: () => {
      renderer.off("frame", onFrame);
      renderer.off("selection", onSelection);
	  renderer.off("resize", onResize);
	  renderer.off("focus", onFocus);
	  renderer.off("blur", onBlur);
      unsubscribeOsc();
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

function isAtBottom(transcript: ScrollBoxRenderable): boolean {
  // 与 OpenTUI 内部 maxScrollTop（scrollHeight - viewport.height）保持一致，
  // 避免 transcript.height（含 wrapper/scrollbar）与 viewport 高度不一致造成误判。
  const viewportHeight = transcript.viewport?.height ?? transcript.height;
  const maxScrollTop = Math.max(0, transcript.scrollHeight - viewportHeight);
  // 内容未超出视口时 scrollTop 可能为负（OpenTUI 预布局态），此时必然在底部。
  if (maxScrollTop <= 0) return true;
  return transcript.scrollTop >= maxScrollTop - 1;
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
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

function getOverlaySelectNode(
  renderer: CliRenderer,
  previous: Map<string, KeyedRenderable<OverlayRenderable>>,
  next: Map<string, KeyedRenderable<OverlayRenderable>>,
  key: string,
  options: { name: string; description: string; value: string }[],
  selectedIndex: number,
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
  next.set(key, { kind: "select", renderable: node, contentKey });
  return node;
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

function overlaySelectHeight(options: readonly { readonly description: string }[]): number {
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
