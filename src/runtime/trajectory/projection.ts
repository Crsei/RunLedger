import type { TrajectoryState } from "../contracts/trajectory.ts";
import { sanitizeTraceValue } from "../trace/recorder.ts";
import type { TraceEvent } from "../trace/types.ts";
import { TrajectoryIndex, type IndexedTrajectoryRecord } from "./index-store.ts";

export function object(value: unknown): Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
export function numeric(value: unknown): number | undefined { return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined; }
export function string(value: unknown): string | undefined { return typeof value === "string" ? value : undefined; }
export function safeText(value: unknown, limit = 4_096): string {
  const sanitized = sanitizeTraceValue(value);
  const text = typeof sanitized === "string" ? sanitized : JSON.stringify(sanitized) ?? "";
  return text.replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|$))/g, "")
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "")
    .replace(/(bearer\s+)[^\s"\\]+/gi, "$1[REDACTED]")
    .replace(/((?:api[_-]?key|password|secret|access[_-]?token|authorization)\s*[=:]\s*)[^\s,;"\\]+/gi, "$1[REDACTED]")
    .slice(0, limit);
}
function state(reason: unknown): TrajectoryState { return reason === "error" ? "failed" : reason === "aborted" ? "cancelled" : "succeeded"; }
function textContent(value: unknown): unknown {
  const message = object(value);
  return Array.isArray(message.content) ? message.content.filter((part) => object(part).type === "text").map((part) => object(part).text).join("\n") : message.content ?? value;
}
export function sessionDetail(event: Record<string, unknown>, field: "input" | "output"): string {
  return safeText(field === "input" ? event.args ?? textContent(event.message) : event.result ?? textContent(event.message), 2 * 1024 * 1024 + 1);
}
/** Agent Loop turn 是模型步骤；只有 agent_start/end 形成用户运行轮次。 */
export function projectSessionEvent(index: TrajectoryIndex, event: Record<string, unknown>, seq: number, generation: number): void {
  const type = string(event.type);
  if (type === undefined) return;
  const explicitRun = string(event.runId);
  const run = explicitRun ?? (index.get("activeRun") || undefined) ?? `legacy-${generation}-${seq}`;
  const runId = `run/${run}`;
  const time = numeric(event.timestamp);
  const currentStep = Number(index.get(`step:${run}`) ?? 0);
  const step = numeric(event.turn) ?? currentStep;
  const stepId = `step/${run}/${step}`;
  const put = (id: string, fields: Partial<IndexedTrajectoryRecord>): void => {
    const previous = index.find(id);
    index.put({ id, runId, kind: "message", name: "Message", summary: "", state: "running", source: "session",
      generation, input: "unavailable", output: "unavailable", ...previous, ...fields });
  };
  if (type === "agent_start") {
    index.set("activeRun", run);
    put(runId, { kind: "run", name: "Turn", startedAtMs: time });
  } else if (type === "agent_end") {
    put(runId, { kind: "run", name: "Turn", state: state(event.stopReason), endedAtMs: time,
      durationMs: numeric(event.elapsedMs), activeDurationMs: numeric(event.activeDurationMs), summary: safeText(event.stopReason) });
    index.set("activeRun", "");
  } else if (type === "turn_start" || type === "turn_end") {
    index.set(`step:${run}`, String(step));
    const old = index.find(stepId);
    put(stepId, { parentId: runId, stepId, kind: "step", name: `Step ${step}`,
      ...(type === "turn_start" ? { startedAtMs: time } : { endedAtMs: time, state: state(event.stopReason),
        durationMs: time !== undefined && old?.startedAtMs !== undefined ? Math.max(0, time - old.startedAtMs) : undefined }) });
  } else if (type === "agent_work_pause" || type === "agent_work_resume") {
    const id = `wait/${run}/${string(event.waitId)}`;
    const old = index.find(id);
    put(id, { parentId: runId, kind: "wait", name: safeText(event.reason),
      ...(type === "agent_work_pause" ? { startedAtMs: time, state: "waiting" } : { endedAtMs: time, state: "succeeded",
        durationMs: time !== undefined && old?.startedAtMs !== undefined ? Math.max(0, time - old.startedAtMs) : undefined }) });
  } else if (type === "tool_execution_start" || type === "tool_execution_end") {
    const callId = string(event.toolCallId);
    if (callId === undefined) return;
    const id = `tool/${run}/${callId}`;
    const old = index.find(id);
    put(id, { parentId: `model/${run}/${step}`, stepId, kind: "tool", name: safeText(event.toolName, 128),
      ...(type === "tool_execution_start" ? { startedAtMs: time, input: "session", sessionInputSeq: seq, summary: safeText(event.args) }
        : { endedAtMs: time, state: event.isError === true ? "failed" : "succeeded", output: "session", sessionOutputSeq: seq,
          durationMs: time !== undefined && old?.startedAtMs !== undefined ? Math.max(0, time - old.startedAtMs) : undefined }) });
  } else if (type === "message_update") {
    const update = object(event.assistantMessageEvent);
    // 只投影公开文本；thinking 与原始 provider partial 不进入检索或详情。
    if (update.type !== "text_delta") return;
    const id = `model/${run}/${step}`;
    const old = index.find(id);
    put(id, { parentId: stepId, stepId, kind: "model", name: old?.name ?? "Assistant",
      summary: safeText(`${old?.summary ?? ""}${string(update.delta) ?? ""}`),
      ttftMs: old?.ttftMs ?? (time !== undefined && old?.startedAtMs !== undefined ? Math.max(0, time - old.startedAtMs) : undefined),
    });
  } else if (type === "message_start" || type === "message_end") {
    const assistant = event.role === "assistant";
    const id = assistant ? `model/${run}/${step}` : `message/${run}/${seq}`;
    if (!assistant && type !== "message_end") return;
    const message = object(event.message);
    const usage = object(message.usage);
    const old = index.find(id);
    put(id, { parentId: assistant ? stepId : runId, stepId: assistant ? stepId : undefined,
      kind: assistant ? "model" : "message", name: assistant ? safeText(message.model ?? "Assistant", 128) : safeText(event.role ?? "Message", 128),
      ...(type === "message_start" ? { startedAtMs: time } : { endedAtMs: time, state: state(event.stopReason ?? message.stopReason),
        summary: safeText(textContent(message)), output: "session", sessionOutputSeq: seq,
        durationMs: numeric(message.durationMs) ?? (time !== undefined && old?.startedAtMs !== undefined ? Math.max(0, time - old.startedAtMs) : undefined),
        ttftMs: numeric(message.ttftMs) ?? old?.ttftMs, inputTokens: numeric(usage.input), outputTokens: numeric(usage.output),
        cacheReadTokens: numeric(usage.cacheRead), costUsd: numeric(object(usage.cost).total), usageSource: "provider", costSource: "pricing_table" }) });
  }
}

export function projectTraceEvent(index: TrajectoryIndex, event: TraceEvent, run: string, generation: number): void {
  if (event.kind === "agent") return;
  const runId = `run/${run}`;
  const step = numeric(event.metadata?.turn);
  const stepId = step === undefined ? undefined : `step/${run}/${step}`;
  const call = string(event.metadata?.toolCallId);
  const id = event.kind === "trace" ? runId : event.kind === "turn" && stepId ? stepId
    : event.kind === "model" && step !== undefined ? `model/${run}/${step}`
    : event.kind === "tool" && call ? `tool/${run}/${call}` : `trace/${event.traceId}/${event.nodeId}`;
  index.set(`node:${event.traceId}:${event.nodeId}`, id);
  const parentId = event.kind === "tool_attempt" && string(event.metadata?.attemptId) ? `attempt/${String(event.metadata?.attemptId)}` : event.kind === "trace" ? undefined
    : event.kind === "turn" ? runId
    : event.parentNodeId === null ? runId : index.get(`node:${event.traceId}:${event.parentNodeId}`) ?? runId;
  const old = index.find(id);
  const time = Date.parse(event.timestamp);
  index.put({ id, runId, kind: event.kind === "trace" ? "run" : event.kind === "turn" ? "step"
    : event.kind === "tool_attempt" && event.name === "process.output" ? "context" : event.kind === "tool_attempt" ? "attempt" : event.kind === "verification" ? "context" : event.kind,
    name: safeText(event.name, 128), summary: "", state: "running", source: "trace", generation,
    input: "unavailable", output: "unavailable", ...old,
    ...(parentId === undefined ? {} : { parentId }), ...(stepId === undefined ? {} : { stepId }),
    ...(event.phase === "started" ? { startedAtMs: Number.isFinite(time) ? time : undefined }
      : { endedAtMs: Number.isFinite(time) ? time : undefined, state: event.phase === "failed" ? "failed" : event.phase === "interrupted" ? "interrupted" : "succeeded" }),
    ...(event.durationMs === undefined ? {} : { durationMs: event.durationMs }),
    ...(event.inputContent === undefined ? {} : { traceInput: event.inputContent, input: old?.input === "session" ? "session" : event.inputContent.storage }),
    ...(event.outputContent === undefined ? {} : { traceOutput: event.outputContent, output: old?.output === "session" ? "session" : event.outputContent.storage }),
    ...(event.usage?.inputTokens === undefined ? {} : { inputTokens: event.usage.inputTokens }),
    ...(event.usage?.outputTokens === undefined ? {} : { outputTokens: event.usage.outputTokens }),
    ...(event.usage?.source === undefined ? {} : { usageSource: event.usage.source }),
    ...(event.cost?.usdMicros === undefined ? {} : { costUsd: event.cost.usdMicros / 1_000_000, costSource: event.cost.source }),
    ...(event.error === undefined ? {} : { summary: safeText(event.error.message) }),
  });
}
