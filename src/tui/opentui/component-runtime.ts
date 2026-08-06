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
} from "@opentui/core";
import { ansiToStyledText } from "./ansi-styled-text.ts";
import type { TuiPerformanceObserver } from "./performance-observer.ts";
import { createRunLedgerSyntaxStyle } from "./syntax-style.ts";
import type { PresentationBlock } from "../presentation.ts";

export interface OpenTuiComponentFrame {
  body: readonly (string | PresentationBlock)[];
  editorText: string;
  footer: readonly string[];
  overlay?: readonly (string | PresentationBlock)[];
}

export interface OpenTuiComponentRuntimeOptions {
  onInput(data: string): void;
  onResize(): void;
  onThemeMode?(mode: "dark" | "light"): void;
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

function blockKey(block: PresentationBlock, index: number): string {
  return block.id ?? `${block.kind}-${index}`;
}

function blockText(block: PresentationBlock): string {
  if (block.kind === "select") return [block.title, ...block.options.map((option) => option.label)].join("\n");
  if (block.kind === "input") return `${block.title}\n${block.message}\n${block.value}`;
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
    contentOptions: { flexDirection: "column", minHeight: 0 },
  });
  const newContent = new TextRenderable(renderer, {
    id: "runledger-new-content",
    width: "100%",
    height: 0,
    flexShrink: 0,
    content: "",
  });
  const editor = new TextareaRenderable(renderer, {
    id: "runledger-editor",
    width: "100%",
    height: 3,
    flexShrink: 0,
    placeholder: "Message RunLedger…",
    wrapMode: "word",
  });
  const footer = new TextRenderable(renderer, {
    id: "runledger-footer",
    width: "100%",
    flexShrink: 0,
    content: "",
  });
  screen.add(transcript);
  screen.add(newContent);
  screen.add(editor);
  screen.add(footer);
  renderer.root.add(screen);
  editor.focus();

  let overlay: BoxRenderable | undefined;
  let bodyNodes = new Map<string, KeyedRenderable<BodyRenderable>>();
  let overlayNodes = new Map<string, KeyedRenderable<OverlayRenderable>>();
  let previousBodySignature: readonly string[] = [];
  let pendingNewContent = 0;
  let syntaxStyle = createRunLedgerSyntaxStyle();
  let previousNativeCellsUpdated = 0;
  renderer.keyInput.on("keypress", (key) => {
    key.preventDefault();
    key.stopPropagation();
    const input = normalizedInputFor(key);
    if (input === "ctrl+c") {
      const selectedText = renderer.getSelection()?.getSelectedText();
      if (selectedText !== undefined && selectedText.length > 0) {
        renderer.copyToClipboardOSC52(selectedText);
        return;
      }
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
    options.onInput(new TextDecoder().decode(event.bytes));
  });
  renderer.on("resize", options.onResize);
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
              streaming: block.streaming,
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
            ...(block.kind === "markdown" ? { streaming: block.streaming } : {}),
          };
        } else if (block.kind === "markdown" && current.renderable instanceof MarkdownRenderable) {
          if (current.renderable.streaming && !block.streaming) {
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
        // setText 会重置原生 buffer(含光标到起始),补位到文本末尾,
        // 与 RunLedger Editor 输入模型(光标恒在末尾)保持一致。
        editor.gotoBufferEnd();
      }
      footer.content = ansiToStyledText(frame.footer.join("\n"));
      footer.height = Math.max(1, frame.footer.length);
      updateNewContentIndicator();

      if (frame.overlay) {
        const overlayBlocks = frame.overlay.map(toPresentationBlock);
        const hasInteractiveControl = overlayBlocks.some((block) => block.kind === "select" || block.kind === "input");
        if (!overlay) {
          overlay = new BoxRenderable(renderer, {
            id: "runledger-overlay",
            position: "absolute",
            left: 1,
            bottom: 5,
            width: "90%",
            maxHeight: "80%",
            ...(hasInteractiveControl ? { height: "50%" } : {}),
            zIndex: 100,
            borderStyle: "rounded",
            padding: 1,
          });
          screen.add(overlay);
        }
        overlay.height = hasInteractiveControl ? "50%" : "auto";
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
  const maxScrollTop = Math.max(0, transcript.scrollHeight - transcript.height);
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
  if (old?.contentKey !== content) node.content = ansiToStyledText(content);
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
    flexGrow: 1,
    options,
    selectedIndex,
    showDescription: true,
    showSelectionIndicator: true,
  });
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
