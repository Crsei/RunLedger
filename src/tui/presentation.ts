export type PresentationBlock =
  | { id?: string; kind: "text"; content: string }
  | { id?: string; kind: "markdown"; content: string; streaming: boolean }
  | { id?: string; kind: "command"; command: string }
  | {
    id?: string;
    kind: "exec";
    command: string;
    status: "pending" | "running" | "succeeded" | "failed" | "cancelled" | "aborted";
    output: readonly { readonly channel: "stdout" | "stderr"; readonly text: string }[];
    exitCode?: number;
    durationMs?: number;
    background?: boolean;
  }
  | {
    id?: string;
    kind: "diff";
    document: import("./presentation/tools/types.ts").SafeDiffDocument;
  }
  | {
    id?: string;
    kind: "status-line";
    segments: readonly import("./highlight/status-style.ts").StatusLineSegment[];
  }
  | { id?: string; kind: "separator"; label: string; content?: string }
  | {
    id?: string;
    kind: "select";
    title: string;
    query?: string;
    options: readonly { value: string; label: string; description?: string }[];
    selectedIndex: number;
  }
  | {
    id?: string;
    kind: "input";
    title: string;
    message: string;
    value: string;
    placeholder?: string;
  };
