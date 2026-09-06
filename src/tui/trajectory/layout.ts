import type { TrajectoryRecord } from "../../runtime/contracts/trajectory.ts";

export function trajectoryCost(value: number | undefined): string {
  return value === undefined ? "unavailable" : value > 0 && value < 0.000001 ? `$${value.toPrecision(3)}` : `$${value.toFixed(value > 0 && value < 0.01 ? 6 : 2)}`;
}
export function trajectoryDuration(value: number | undefined): string {
  if (value === undefined) return "—";
  return value < 1_000 ? `${Math.round(value)}ms` : `${(value / 1_000).toFixed(2)}s`;
}
export interface TrajectorySpan { readonly id: string; readonly start: number; readonly end: number; readonly kind: string; readonly recordedStart?: number; readonly recordedEnd?: number }
/** 排除容器节点，避免父跨度把子节点之间的空闲误判为工作。 */
export function trajectorySpans(records: readonly TrajectoryRecord[], duration: boolean): TrajectorySpan[] {
  const leaves = records.filter((record) => record.kind === "model" || record.kind === "tool" || record.kind === "attempt" || record.kind === "wait");
  if (!duration) return leaves.map((record, i) => ({ id: record.id, start: i, end: i + 1, kind: record.kind,
    recordedStart: record.startedAtMs, recordedEnd: record.endedAtMs }));
  const timed = leaves.filter((record) => record.startedAtMs !== undefined && (record.durationMs !== undefined || record.endedAtMs !== undefined))
    .sort((a, b) => a.startedAtMs! - b.startedAtMs!);
  let covered: number | undefined;
  let removed = 0;
  const origin = timed[0]?.startedAtMs ?? 0;
  return timed.map((record) => {
    const start = record.startedAtMs!;
    const end = Math.max(start, record.endedAtMs ?? start + record.durationMs!);
    if (covered !== undefined && start > covered) removed += start - covered;
    covered = Math.max(covered ?? end, end);
    return { id: record.id, start: start - origin - removed, end: end - origin - removed, kind: record.kind, recordedStart: start, recordedEnd: record.endedAtMs };
  });
}
export function renderTrajectoryTimeline(spans: readonly TrajectorySpan[], width: number, selected?: string): string {
  const cells = Array.from({ length: Math.max(1, width) }, () => "·");
  const end = Math.max(1, ...spans.map((span) => span.end));
  for (const span of spans) {
    const first = Math.min(cells.length - 1, Math.floor(span.start / end * cells.length));
    const last = Math.min(cells.length, Math.max(first + 1, Math.ceil(span.end / end * cells.length)));
    for (let i = first; i < last; i++) cells[i] = span.id === selected ? "█" : span.kind === "model" ? "M" : span.kind === "wait" ? "W" : "T";
  }
  return cells.join("");
}
