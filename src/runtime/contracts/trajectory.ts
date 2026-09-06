/** 本地轨迹：只读 DTO，不携带 native path、凭据或执行权限。 */
export const TRAJECTORY_BOUNDS = Object.freeze({
  pageSize: 50, maxPageSize: 200, pageBytes: 192 * 1024,
  detailBytes: 48 * 1024, windowSize: 400, searchCharacters: 128,
  pendingEvents: 256, eventBytes: 64 * 1024,
});

export type TrajectoryKind = "run" | "step" | "model" | "tool" | "attempt" | "context" | "wait" | "message";
export type TrajectoryState = "running" | "waiting" | "succeeded" | "failed" | "cancelled" | "interrupted" | "unknown";
export type TrajectorySource = "session" | "trace";
export interface TrajectoryRecord {
  readonly id: string;
  readonly parentId?: string;
  readonly runId: string;
  readonly stepId?: string;
  readonly kind: TrajectoryKind;
  readonly name: string;
  readonly summary: string;
  readonly state: TrajectoryState;
  readonly startedAtMs?: number;
  readonly endedAtMs?: number;
  readonly durationMs?: number;
  readonly activeDurationMs?: number;
  readonly ttftMs?: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheReadTokens?: number;
  readonly costUsd?: number;
  readonly usageSource?: string;
  readonly costSource?: string;
  readonly source: TrajectorySource;
  readonly generation: number;
  readonly revision: number;
  readonly ordinal: number;
  readonly input: "session" | "artifact" | "digest_only" | "unavailable";
  readonly output: "session" | "artifact" | "digest_only" | "unavailable";
}
export interface TrajectoryStatus {
  readonly mode: "off" | "events" | "events_and_artifacts";
  readonly failurePolicy: "best_effort" | "fail_closed";
  readonly health: "ready" | "rebuilding" | "degraded";
  readonly diagnostics: readonly string[];
  readonly recordedBytes: number;
  readonly records: number;
  readonly gaps?: readonly { readonly runId: string; readonly reason: "trace-unavailable" | "prior-generation-unfinished" }[];
  readonly historyCoverage: "session-and-trace" | "session-only" | "partial";
}
/** 不同日志的序号不得直接相互比较；opaque cursor 由 owner 签名并绑定 session。 */
export interface TrajectoryWatermark {
  readonly generation: number;
  readonly revision: number;
  readonly sessionSequence: number;
  readonly traceRevision: number;
  readonly attemptSequence?: number;
}
export interface TrajectoryPage {
  readonly version: 1;
  readonly sessionId: string;
  readonly records: readonly TrajectoryRecord[];
  readonly before?: string;
  readonly after?: string;
  readonly hasOlder: boolean;
  readonly hasNewer: boolean;
  readonly watermark: TrajectoryWatermark;
  readonly status: TrajectoryStatus;
}
export interface TrajectoryDetail {
  readonly record: TrajectoryRecord;
  readonly field: "input" | "output";
  readonly text: string;
  readonly availability: "complete" | "more" | "not-recorded" | "unavailable" | "corrupt";
  readonly next?: string;
}
export interface TrajectoryRequest {
  readonly cursor?: string;
  readonly direction?: "older" | "newer";
  readonly pageSize?: number;
  readonly search?: string;
  readonly recordId?: string;
  readonly timeFrom?: number;
  readonly timeTo?: number;
}
export type TrajectoryResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly code: string };
export interface TrajectoryClientPort {
  page(request?: TrajectoryRequest): Promise<TrajectoryResult<TrajectoryPage>>;
  detail(recordId: string, field: "input" | "output", cursor?: string): Promise<TrajectoryResult<TrajectoryDetail>>;
  subscribe(listener: () => void): () => void;
}
