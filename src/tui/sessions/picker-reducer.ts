import type { SessionDetail, SessionListValue, SessionPreview } from "./types.ts";

export type SessionListState =
  | { state: "idle" }
  | { state: "loading"; requestId: string }
  | { state: "ready"; value: SessionListValue }
  | { state: "empty"; diagnostics: SessionListValue["diagnostics"] }
  | { state: "error"; message: string; retryable: boolean };

export type SessionDetailState =
  | { state: "idle" }
  | { state: "loading"; requestId: string; sessionId: string }
  | { state: "ready"; value: SessionDetail }
  | { state: "error"; sessionId: string; message: string; retryable: boolean };

export type SessionPreviewState =
  | { state: "idle" }
  | { state: "loading"; requestId: string; sessionId: string }
  | { state: "ready"; value: SessionPreview }
  | { state: "error"; sessionId: string; message: string; retryable: boolean };

export interface SessionPickerState {
  generation: number;
  query: string;
  selectedSessionId?: string;
  listRequestId?: string;
  enrichRequestId?: string;
  previewRequestId?: string;
  list: SessionListState;
  detail: SessionDetailState;
  preview: SessionPreviewState;
}

export function createSessionPickerState(): SessionPickerState {
  return {
    generation: 0,
    query: "",
    list: { state: "idle" },
    detail: { state: "idle" },
    preview: { state: "idle" },
  };
}
