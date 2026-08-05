import {
  BoxRenderable,
  ScrollBoxRenderable,
  TextRenderable,
  TextareaRenderable,
  type CliRenderer,
} from "@opentui/core";

export interface OpenTuiTranscriptLine {
  readonly id: string;
  readonly content: string;
}

export interface OpenTuiScreenSnapshot {
  header: string;
  resources: string;
  transcript: readonly (string | OpenTuiTranscriptLine)[];
  status: string;
  footer: string;
  hints: string;
}

export interface OpenTuiRuntimeOptions {
  renderer: CliRenderer;
  onSubmit?: (text: string) => void;
}

export interface OpenTuiRuntime {
  mount(snapshot: OpenTuiScreenSnapshot): void;
  getEditorText(): string;
  setEditorText(text: string): void;
  destroy(): void;
}

interface MountedOpenTuiScreen {
  readonly screen: BoxRenderable;
  readonly header: TextRenderable;
  readonly resources: TextRenderable;
  readonly transcript: ScrollBoxRenderable;
  readonly status: TextRenderable;
  readonly editor: TextareaRenderable;
  readonly footer: TextRenderable;
  readonly hints: TextRenderable;
  readonly transcriptLines: Map<string, TextRenderable>;
}

function transcriptLine(line: string | OpenTuiTranscriptLine, index: number): { id: string; content: string } {
  return typeof line === "string" ? { id: `transcript-${index}`, content: line } : line;
}

/** 持有一个 OpenTUI renderer 的 RunLedger screen owner；普通 mount 只 mutation 子节点。 */
export function createOpenTuiRuntime(options: OpenTuiRuntimeOptions): OpenTuiRuntime {
  const renderer = options.renderer;
  let mounted: MountedOpenTuiScreen | undefined;
  let editorText = "";

  const mount = (snapshot: OpenTuiScreenSnapshot): void => {
    if (!mounted) {
      const screen = new BoxRenderable(renderer, {
        id: "runledger-screen",
        width: "100%",
        height: "100%",
        flexDirection: "column",
      });
      const header = new TextRenderable(renderer, {
        id: "runledger-header",
        width: "100%",
        height: 1,
        content: "",
      });
      const resources = new TextRenderable(renderer, {
        id: "runledger-resources",
        width: "100%",
        height: 1,
        content: "",
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
      const status = new TextRenderable(renderer, {
        id: "runledger-status",
        width: "100%",
        height: 1,
        content: "",
      });
      const editor = new TextareaRenderable(renderer, {
        id: "runledger-editor",
        width: "100%",
        height: 3,
        flexShrink: 0,
        initialValue: editorText,
        placeholder: "Message RunLedger…",
        wrapMode: "word",
        keyBindings: [
          { name: "return", action: "submit" },
          { name: "kpenter", action: "submit" },
        ],
        onSubmit: () => {
          const currentEditor = mounted?.editor;
          if (!currentEditor) return;
          const submitted = currentEditor.plainText;
          editorText = "";
          currentEditor.setText("");
          options.onSubmit?.(submitted);
        },
      });
      const footer = new TextRenderable(renderer, {
        id: "runledger-footer",
        width: "100%",
        height: 1,
        content: "",
      });
      const hints = new TextRenderable(renderer, {
        id: "runledger-hints",
        width: "100%",
        height: 1,
        content: "",
      });
      screen.add(header);
      screen.add(resources);
      screen.add(transcript);
      screen.add(status);
      screen.add(editor);
      screen.add(footer);
      screen.add(hints);
      renderer.root.add(screen);
      mounted = {
        screen,
        header,
        resources,
        transcript,
        status,
        editor,
        footer,
        hints,
        transcriptLines: new Map(),
      };
    }

    const current = mounted;
    current.header.content = snapshot.header;
    current.resources.content = snapshot.resources;
    current.status.content = snapshot.status;
    current.footer.content = snapshot.footer;
    current.hints.content = snapshot.hints;

    const lines = snapshot.transcript.length > 0
      ? snapshot.transcript.map(transcriptLine)
      : [{ id: "transcript-empty", content: "" }];
    const nextLines = new Map<string, TextRenderable>();
    const desiredNodes: TextRenderable[] = [];
    for (const line of lines) {
      const old = current.transcriptLines.get(line.id);
      const node = old ?? new TextRenderable(renderer, {
        id: `runledger-transcript-${line.id}`,
        width: "100%",
        flexShrink: 0,
        content: line.content,
      });
      node.content = line.content;
      nextLines.set(line.id, node);
      desiredNodes.push(node);
    }
    for (const [id, node] of current.transcriptLines) {
      if (!nextLines.has(id)) {
        current.transcript.remove(node);
        node.destroyRecursively();
      }
    }
    for (const [index, node] of desiredNodes.entries()) {
      if (current.transcript.getChildren()[index] !== node) {
        if (node.parent === current.transcript) current.transcript.remove(node);
        current.transcript.add(node, index);
      }
    }
    current.transcriptLines.clear();
    for (const [id, node] of nextLines) current.transcriptLines.set(id, node);
    current.editor.focus();
    renderer.requestRender();
  };

  return {
    mount,
    getEditorText: () => mounted?.editor.plainText ?? editorText,
    setEditorText: (text) => {
      editorText = text;
      mounted?.editor.setText(text);
    },
    destroy: () => {
      mounted = undefined;
      renderer.destroy();
    },
  };
}
