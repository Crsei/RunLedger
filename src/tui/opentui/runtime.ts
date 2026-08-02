import {
  BoxRenderable,
  ScrollBoxRenderable,
  TextRenderable,
  TextareaRenderable,
  type CliRenderer,
} from "@opentui/core";

export interface OpenTuiScreenSnapshot {
  header: string;
  resources: string;
  transcript: readonly string[];
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

/** 持有一个 OpenTUI renderer 的最小 RunLedger screen owner。 */
export function createOpenTuiRuntime(options: OpenTuiRuntimeOptions): OpenTuiRuntime {
  const renderer = options.renderer;
  let screen: BoxRenderable | undefined;
  let editor: TextareaRenderable | undefined;
  let editorText = "";

  const mount = (snapshot: OpenTuiScreenSnapshot): void => {
    if (screen) screen.destroyRecursively();

    const nextScreen = new BoxRenderable(renderer, {
      id: "runledger-screen",
      width: "100%",
      height: "100%",
      flexDirection: "column",
    });
    nextScreen.add(new TextRenderable(renderer, {
      id: "runledger-header",
      width: "100%",
      height: 1,
      content: snapshot.header,
    }));
    nextScreen.add(new TextRenderable(renderer, {
      id: "runledger-resources",
      width: "100%",
      height: 1,
      content: snapshot.resources,
    }));

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
    transcript.add(new TextRenderable(renderer, {
      id: "runledger-transcript-content",
      width: "100%",
      height: Math.max(1, snapshot.transcript.length),
      flexShrink: 0,
      content: snapshot.transcript.join("\n"),
    }));
    nextScreen.add(transcript);

    nextScreen.add(new TextRenderable(renderer, {
      id: "runledger-status",
      width: "100%",
      height: 1,
      content: snapshot.status,
    }));
    editor = new TextareaRenderable(renderer, {
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
        if (!editor) return;
        const submitted = editor.plainText;
        editorText = "";
        editor.setText("");
        options.onSubmit?.(submitted);
      },
    });
    nextScreen.add(editor);
    nextScreen.add(new TextRenderable(renderer, {
      id: "runledger-footer",
      width: "100%",
      height: 1,
      content: snapshot.footer,
    }));
    nextScreen.add(new TextRenderable(renderer, {
      id: "runledger-hints",
      width: "100%",
      height: 1,
      content: snapshot.hints,
    }));

    screen = nextScreen;
    renderer.root.add(nextScreen);
    editor.focus();
  };

  return {
    mount,
    getEditorText: () => editor?.plainText ?? editorText,
    setEditorText: (text) => {
      editorText = text;
      editor?.setText(text);
    },
    destroy: () => {
      screen = undefined;
      editor = undefined;
      renderer.destroy();
    },
  };
}
