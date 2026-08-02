export type PresentationBlock =
  | { kind: "text"; content: string }
  | { kind: "markdown"; content: string; streaming: boolean }
  | {
    kind: "select";
    title: string;
    query?: string;
    options: readonly { value: string; label: string; description?: string }[];
    selectedIndex: number;
  }
  | {
    kind: "input";
    title: string;
    message: string;
    value: string;
    placeholder?: string;
  };
