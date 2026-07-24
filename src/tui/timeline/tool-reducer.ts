import { Buffer } from "node:buffer";
import type { TimelineEvent, TimelineRow, TimelineState } from "./types.ts";

export const TIMELINE_MAX_PARTIAL_BYTES = 300_000;
export const TIMELINE_MAX_PARTIAL_LINES = 200;
export const TIMELINE_ORPHAN_TIMEOUT_MS = 30_000;

export function createTimelineState(): TimelineState {
  return { committedRows: [], activeRowsByCorrelationId: {}, activeOrder: [] };
}

/** 只清 viewport 已提交行；运行中的 message/tool correlation 继续接收终态。 */
export function clearTimelineViewport(state: TimelineState): TimelineState {
  return {
    committedRows: [],
    activeRowsByCorrelationId: state.activeRowsByCorrelationId,
    activeOrder: state.activeOrder,
  };
}

export function reduceTimeline(state: TimelineState, event: TimelineEvent): TimelineState {
  switch (event.type) {
    case "message.start":
      return putActive(state, {
        id: event.id,
        timestamp: event.timestamp,
        kind: event.role,
        text: event.text,
        status: "running",
      });
    case "message.update": {
      const row = state.activeRowsByCorrelationId[event.id];
      if (!row || (row.kind !== "assistant" && row.kind !== "user")) return state;
      return putActive(state, { ...row, text: event.text });
    }
    case "message.end": {
      const current = state.activeRowsByCorrelationId[event.id];
      const row: TimelineRow = current && (current.kind === "assistant" || current.kind === "user")
        ? { ...current, text: event.text ?? current.text, status: event.status }
        : {
            id: event.id,
            timestamp: event.timestamp,
            kind: event.role,
            text: event.text ?? "",
            status: event.status,
          };
      return commit(state, row);
    }
    case "tool.start": {
      const current = findRow(state, event.id);
      if (current?.kind === "tool" && terminal(current.status)) {
        return replaceCommitted(state, {
          ...current,
          toolName: event.toolName,
          args: event.args,
          orphanDeadline: undefined,
        });
      }
      const next: TimelineRow = current?.kind === "tool"
        ? {
            ...current,
            toolName: event.toolName,
            args: event.args,
            status: "running",
            orphanDeadline: undefined,
          }
        : {
            id: event.id,
            timestamp: event.timestamp,
            kind: "tool",
            toolCallId: event.id,
            toolName: event.toolName,
            args: event.args,
            output: "",
            truncated: false,
            status: "running",
          };
      return putActive(state, next);
    }
    case "tool.update": {
      const current = findRow(state, event.id);
      if (current?.kind === "tool" && terminal(current.status)) return state;
      const bounded = boundOutput(event.output);
      const next: TimelineRow = current?.kind === "tool"
        ? {
            ...current,
            output: bounded.text,
            truncated: current.truncated || bounded.truncated,
          }
        : {
            id: event.id,
            timestamp: event.timestamp,
            kind: "tool",
            toolCallId: event.id,
            toolName: "<unknown>",
            output: bounded.text,
            truncated: bounded.truncated,
            status: "pending",
            orphanDeadline: event.timestamp + TIMELINE_ORPHAN_TIMEOUT_MS,
          };
      return putActive(state, next);
    }
    case "tool.end": {
      const current = findRow(state, event.id);
      if (current?.kind === "tool" && terminal(current.status)) return state;
      const bounded = boundOutput(event.output);
      const row: TimelineRow = {
        id: event.id,
        timestamp: current?.timestamp ?? event.timestamp,
        kind: "tool",
        toolCallId: event.id,
        toolName: event.toolName || (current?.kind === "tool" ? current.toolName : "<unknown>"),
        ...(current?.kind === "tool" && current.args !== undefined ? { args: current.args } : {}),
        output: bounded.text,
        truncated: bounded.truncated,
        status: event.status,
      };
      return commit(state, row);
    }
    case "notice":
      return commit(state, {
        id: event.id,
        timestamp: event.timestamp,
        kind: "notice",
        level: event.level,
        text: event.text,
        status: event.level === "error" ? "failed" : "succeeded",
      });
    case "cleanup": {
      let next = state;
      for (const id of state.activeOrder) {
        const row = state.activeRowsByCorrelationId[id];
        if (
          row?.kind === "tool" &&
          row.orphanDeadline !== undefined &&
          row.orphanDeadline <= event.timestamp
        ) {
          next = commit(next, {
            ...row,
            status: "aborted",
            output: row.output || "orphan tool update expired before start",
            orphanDeadline: undefined,
          });
        }
      }
      return next;
    }
  }
}

function terminal(status: TimelineRow["status"]): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled" || status === "aborted";
}

function findRow(state: TimelineState, id: string): TimelineRow | undefined {
  return state.activeRowsByCorrelationId[id] ??
    state.committedRows.find((row) => row.id === id);
}

function putActive(state: TimelineState, row: TimelineRow): TimelineState {
  const exists = state.activeRowsByCorrelationId[row.id] !== undefined;
  return {
    ...state,
    activeRowsByCorrelationId: { ...state.activeRowsByCorrelationId, [row.id]: row },
    activeOrder: exists ? state.activeOrder : [...state.activeOrder, row.id],
  };
}

function commit(state: TimelineState, row: TimelineRow): TimelineState {
  const active = { ...state.activeRowsByCorrelationId };
  delete active[row.id];
  const existing = state.committedRows.findIndex((candidate) => candidate.id === row.id);
  const committed = [...state.committedRows];
  if (existing >= 0) committed[existing] = row;
  else committed.push(row);
  return {
    committedRows: committed,
    activeRowsByCorrelationId: active,
    activeOrder: state.activeOrder.filter((id) => id !== row.id),
  };
}

function replaceCommitted(state: TimelineState, row: TimelineRow): TimelineState {
  return {
    ...state,
    committedRows: state.committedRows.map((candidate) => candidate.id === row.id ? row : candidate),
  };
}

function boundOutput(value: string): { text: string; truncated: boolean } {
  const lines = value.split(/\r?\n/u);
  const lineBounded = lines.length > TIMELINE_MAX_PARTIAL_LINES
    ? lines.slice(-TIMELINE_MAX_PARTIAL_LINES).join("\n")
    : value;
  if (Buffer.byteLength(lineBounded, "utf8") <= TIMELINE_MAX_PARTIAL_BYTES) {
    return { text: lineBounded, truncated: lines.length > TIMELINE_MAX_PARTIAL_LINES };
  }
  let bytes = 0;
  const out: string[] = [];
  for (const character of Array.from(lineBounded)) {
    const size = Buffer.byteLength(character, "utf8");
    if (bytes + size > TIMELINE_MAX_PARTIAL_BYTES) break;
    out.push(character);
    bytes += size;
  }
  return { text: out.join(""), truncated: true };
}
