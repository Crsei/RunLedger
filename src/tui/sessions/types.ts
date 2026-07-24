import type { AgentMessage } from "../../runtime/types.ts";
import type { ModelThinkingLevel } from "../../types.ts";
import type { TimelineState } from "../timeline/types.ts";

export type SessionCatalogFormat = "v1" | "v2" | "v3";
export type SessionCompatibility = "read-write" | "read-only" | "migration-required";
export type SessionCatalogLifecycle =
  | "active"
  | "stopped"
  | "closed"
  | "recovery-required"
  | "unknown";

export interface SessionSummary {
  id: string;
  title: string;
  cwd?: string;
  createdAt: number;
  modifiedAt: number;
  format: SessionCatalogFormat;
  compatibility: SessionCompatibility;
  lifecycle: SessionCatalogLifecycle;
  isCurrent: boolean;
}

export type SessionDiagnosticCode =
  | "corrupt"
  | "oversize"
  | "staging"
  | "unpublished"
  | "symlink"
  | "changed";

export interface SessionDiagnostic {
  code: SessionDiagnosticCode;
  fileName: string;
  message: string;
}

export interface SessionListValue {
  sessions: readonly SessionSummary[];
  diagnostics: readonly SessionDiagnostic[];
}

export interface SessionDetail {
  summary: SessionSummary;
  filePath: string;
  messageCount?: number;
  turnCount?: number;
  toolCount?: number;
  provider?: string;
  model?: string;
  thinkingLevel?: ModelThinkingLevel;
  headSequence?: number;
  headEventHash?: string;
  parentSessionId?: string;
}

export interface SessionPreview {
  sessionId: string;
  messages: readonly AgentMessage[];
  timeline: TimelineState;
  truncated: boolean;
  sourceBytes: number;
}

export type SessionCatalogErrorCode =
  | "not_found"
  | "directory_unavailable"
  | "corrupt"
  | "oversize"
  | "changed"
  | "aborted";

export interface SessionCatalogError {
  code: SessionCatalogErrorCode;
  message: string;
  retryable: boolean;
}

export type SessionCatalogResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: SessionCatalogError };

export type SessionListResult = SessionCatalogResult<SessionListValue>;
export type SessionDetailResult = SessionCatalogResult<SessionDetail>;
export type SessionPreviewResult = SessionCatalogResult<SessionPreview>;

export interface SessionCatalogCurrentRef {
  id: string;
  filePath: string;
}
