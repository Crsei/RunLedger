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
}

export interface OpenTuiComponentRuntime {
  update(frame: OpenTuiComponentFrame): void;
  destroy(): void;
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
  const body = new BoxRenderable(renderer, {
    id: "runledger-transcript-content",
    width: "100%",
    flexDirection: "column",
    flexShrink: 0,
  });
  transcript.add(body);
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
  screen.add(editor);
  screen.add(footer);
  renderer.root.add(screen);
  editor.focus();

  let overlay: BoxRenderable | undefined;
  let bodyNodes: Array<TextRenderable | MarkdownRenderable> = [];
  const syntaxStyle = createRunLedgerSyntaxStyle();
  renderer.keyInput.on("keypress", (key) => {
    key.preventDefault();
    key.stopPropagation();
    options.onInput(normalizedInputFor(key));
  });
  renderer.keyInput.on("paste", (event) => {
    event.preventDefault();
    event.stopPropagation();
    options.onInput(new TextDecoder().decode(event.bytes));
  });
  renderer.on("resize", options.onResize);
  if (options.onThemeMode) renderer.on("theme_mode", options.onThemeMode);

  return {
    update: (frame) => {
      for (const node of bodyNodes) node.destroyRecursively();
      bodyNodes = [];
      for (const [index, rawBlock] of frame.body.entries()) {
        const block: PresentationBlock = typeof rawBlock === "string"
          ? { kind: "text", content: rawBlock }
          : rawBlock;
        const node = block.kind === "markdown"
          ? new MarkdownRenderable(renderer, {
            id: `runledger-markdown-${index}`,
            width: "100%",
            flexShrink: 0,
            content: block.content,
            streaming: block.streaming,
            syntaxStyle,
          })
          : new TextRenderable(renderer, {
            id: `runledger-text-${index}`,
            width: "100%",
            flexShrink: 0,
            content: ansiToStyledText(block.kind === "select"
              ? [block.title, ...block.options.map((option) => option.label)].join("\n")
              : block.kind === "input"
              ? `${block.title}\n${block.message}\n${block.value}`
              : block.content),
          });
        body.add(node);
        bodyNodes.push(node);
      }
      if (bodyNodes.length === 0) {
        const empty = new TextRenderable(renderer, {
          id: "runledger-text-empty",
          width: "100%",
          height: 1,
          content: "",
        });
        body.add(empty);
        bodyNodes.push(empty);
      }
      if (editor.plainText !== frame.editorText) editor.setText(frame.editorText);
      footer.content = ansiToStyledText(frame.footer.join("\n"));
      footer.height = Math.max(1, frame.footer.length);

      overlay?.destroyRecursively();
      overlay = undefined;
      if (frame.overlay) {
        const overlayBlocks: PresentationBlock[] = frame.overlay.map((rawBlock) => typeof rawBlock === "string"
          ? { kind: "text", content: rawBlock }
          : rawBlock);
        const hasInteractiveControl = overlayBlocks.some((block) => block.kind === "select" || block.kind === "input");
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
        let overlayFocus: InputRenderable | SelectRenderable | undefined;
        for (const [index, block] of overlayBlocks.entries()) {
          if (block.kind === "select") {
            overlay.add(new TextRenderable(renderer, {
              id: `runledger-overlay-title-${index}`,
              width: "100%",
              height: 1,
              content: block.title,
            }));
            if (block.query !== undefined) {
              const query = new InputRenderable(renderer, {
                id: `runledger-overlay-query-${index}`,
                width: "100%",
                value: block.query,
                placeholder: "Filter…",
              });
              overlay.add(query);
              overlayFocus = query;
            }
            const select = new SelectRenderable(renderer, {
              id: `runledger-overlay-select-${index}`,
              width: "100%",
              flexGrow: 1,
              options: block.options.map((option) => ({
                name: option.label,
                description: option.description ?? "",
                value: option.value,
              })),
              selectedIndex: block.selectedIndex,
              showDescription: true,
              showSelectionIndicator: true,
            });
            overlay.add(select);
            overlayFocus ??= select;
          } else if (block.kind === "input") {
            overlay.add(new TextRenderable(renderer, {
              id: `runledger-overlay-title-${index}`,
              width: "100%",
              height: 1,
              content: block.title,
            }));
            overlay.add(new TextRenderable(renderer, {
              id: `runledger-overlay-message-${index}`,
              width: "100%",
              height: 1,
              content: block.message,
            }));
            const input = new InputRenderable(renderer, {
              id: `runledger-overlay-input-${index}`,
              width: "100%",
              value: block.value,
              placeholder: block.placeholder ?? "",
            });
            overlay.add(input);
            overlayFocus = input;
          } else {
            const content = block.content;
            overlay.add(new TextRenderable(renderer, {
              id: `runledger-overlay-content-${index}`,
              width: "100%",
              content: ansiToStyledText(content),
            }));
          }
        }
        screen.add(overlay);
        overlayFocus?.focus();
      } else {
        editor.focus();
      }
      renderer.requestRender();
    },
    destroy: () => {
      renderer.destroy();
      syntaxStyle.destroy();
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
  });
  return createOpenTuiComponentRuntimeFromRenderer(renderer, options);
}
