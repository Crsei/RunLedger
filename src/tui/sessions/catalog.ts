import type {
  SessionDetailResult,
  SessionListResult,
  SessionPreviewResult,
} from "./types.ts";

export interface SessionCatalogPort {
  listLite(input: {
    query: string;
    listRequestId: string;
    signal: AbortSignal;
  }): Promise<SessionListResult>;

  enrich(input: {
    sessionId: string;
    enrichRequestId: string;
    signal: AbortSignal;
  }): Promise<SessionDetailResult>;

  loadFullPreview(input: {
    sessionId: string;
    previewRequestId: string;
    signal: AbortSignal;
  }): Promise<SessionPreviewResult>;
}
