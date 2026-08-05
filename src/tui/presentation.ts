export type PresentationBlock =
  | { id?: string; kind: "text"; content: string }
  | { id?: string; kind: "markdown"; content: string; streaming: boolean }
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
