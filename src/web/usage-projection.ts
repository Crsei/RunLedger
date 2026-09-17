import { createHash } from "node:crypto";
import type { WebUsage } from "@runledger/collab-web/contracts";
import type { TraceEvent } from "../runtime/trace/types.ts";
import { object } from "../runtime/trajectory/projection.ts";

type Metrics = "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens" | "costUsd";
type Source = WebUsage["sources"][number];
interface Observation {
  readonly id: string; readonly start: number; readonly final: boolean; readonly priority: number;
  readonly source: Source; readonly estimatedCost: boolean;
  readonly values: Record<Metrics, number | null>;
}
function identity(...parts: string[]): string { return createHash("sha256").update(JSON.stringify(parts)).digest("hex"); }
function number(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER ? value : null;
}
function reported(value: unknown, presence: unknown): number | null {
  const result = number(value); return presence === false || (result === 0 && presence !== true) ? null : result;
}
const fields: readonly Metrics[] = ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "costUsd"];
/** 实际调用身份去重；Run/Step 汇总、fork 复制 ledger 不参与消耗累加。 */
export class UsageProjection {
  private readonly calls = new Map<string, Observation>();
  private readonly unidentified = new Set<string>();
  private readonly conflicts = new Set<string>();
  private readonly starts = new Map<string, number>();
  private quota = false;
  private put(observation: Observation): void {
    const old = this.calls.get(observation.id);
    if (!old && this.calls.size >= 50000) { this.quota = true; return; }
    if (old && old.priority !== observation.priority && old.final && observation.final) {
      if (fields.some((field) => old.values[field] !== null && observation.values[field] !== null
        && Math.abs(old.values[field]! - observation.values[field]!) > (field === "costUsd" ? 0.000001 : 0))) this.conflicts.add(observation.id);
    }
    if (!old || observation.priority > old.priority || (observation.priority === old.priority && (observation.final || !old.final))) this.calls.set(observation.id, observation);
  }
  event(sessionId: string, eventId: string, event: Record<string, unknown>): void {
    if (event.type === "message_end" && event.role === "assistant" && typeof event.modelCallId !== "string") {
      if (this.unidentified.size < 50000) this.unidentified.add(identity(sessionId, eventId)); else this.quota = true;
      return;
    }
    if (event.type !== "model_call") return;
    if (typeof event.callId !== "string" || typeof event.originSessionId !== "string" || number(event.startedAtMs) === null) {
      if (this.unidentified.size < 50000) this.unidentified.add(identity(sessionId, eventId)); else this.quota = true;
      return;
    }
    if (event.dispatched === false) { this.calls.delete(identity(event.originSessionId, event.callId)); return; }
    const usage = object(event.usage), presence = object(usage.reported);
    this.put({ id: identity(event.originSessionId, event.callId), start: Number(event.startedAtMs), final: event.phase === "finished", priority: 2,
      source: "provider", estimatedCost: presence.cost !== true,
      values: { inputTokens: reported(usage.input, presence.input), outputTokens: reported(usage.output, presence.output),
        cacheReadTokens: reported(usage.cacheRead, presence.cacheRead), cacheWriteTokens: reported(usage.cacheWrite, presence.cacheWrite), costUsd: reported(object(usage.cost).total, presence.cost) } });
  }
  trace(sessionId: string, event: TraceEvent): void {
    if (event.kind !== "model") return;
    const id = identity(sessionId, event.nodeId);
    if (event.metadata?.modelDispatched === false) { this.calls.delete(id); this.starts.delete(id); return; }
    if (event.phase === "started") {
      if (this.starts.size < 50000) this.starts.set(id, Date.parse(event.timestamp)); else this.quota = true;
    }
    const start = this.starts.get(id);
    if (start === undefined || !Number.isFinite(start)) {
      if (this.unidentified.size < 50000) this.unidentified.add(`${id}:${event.sequence}`); else this.quota = true;
      return;
    }
    const usage = event.usage, cost = event.cost;
    const source: Source = usage?.source === "metered" ? "metered" : usage?.source === "estimated" ? "estimated" : "provider";
    const token = (value: unknown) => reported(value, event.metadata?.usagePresenceRecorded === true ? true : undefined);
    const validUsage = usage && !["unavailable", "not_applicable"].includes(usage.source);
    this.put({ id, start, final: event.phase !== "started", priority: 1, source,
      estimatedCost: cost?.source !== "provider" && cost?.source !== "metered",
      values: { inputTokens: validUsage ? token(usage.inputTokens) : null, outputTokens: validUsage ? token(usage.outputTokens) : null,
        cacheReadTokens: validUsage ? token(usage.cacheReadTokens) : null, cacheWriteTokens: validUsage ? token(usage.cacheWriteTokens) : null,
        costUsd: cost && !["unavailable", "not_applicable"].includes(cost.source) && token(cost.usdMicros) !== null ? cost.usdMicros! / 1e6 : null } });
  }
  snapshot(projectId: string, timeFrom: number, timeTo: number, scanned: boolean): WebUsage {
    const selected = [...this.calls.values()].filter((call) => call.start >= timeFrom && call.start < timeTo);
    const sources = new Set<Source>();
    let missing = false;
    const quantity = (field: Metrics): WebUsage[Metrics] => {
      let exact: number | null = selected.length === 0 && scanned && !this.quota && this.unidentified.size === 0 ? 0 : null, estimated: number | null = null, missingCalls = 0;
      for (const call of selected) {
        const value = call.values[field];
        if (value === null || !call.final) { missingCalls++; missing = true; continue; }
        const estimate = field === "costUsd" ? call.estimatedCost : call.source === "estimated";
        sources.add(estimate ? "estimated" : call.source);
        const sum: number = ((estimate ? estimated : exact) ?? 0) + value;
        if (!Number.isFinite(sum) || sum > Number.MAX_SAFE_INTEGER) { missingCalls++; missing = true; continue; }
        if (estimate) estimated = sum; else exact = sum;
      }
      return { exact, estimated, missingCalls };
    };
    const totals = { inputTokens: quantity("inputTokens"), outputTokens: quantity("outputTokens"), cacheReadTokens: quantity("cacheReadTokens"), cacheWriteTokens: quantity("cacheWriteTokens"), costUsd: quantity("costUsd") };
    return { version: 1, projectId, asOfMs: Date.now(), timeFrom, timeTo, uniqueCalls: selected.length,
      excludedUnidentifiedObservations: this.unidentified.size, sources: [...sources], ...totals,
      coverage: !scanned || this.quota || this.unidentified.size || selected.some((call) => this.conflicts.has(call.id)) || missing ? "partial" : "complete" };
  }
}
