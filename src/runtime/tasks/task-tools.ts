/**
 * Task 系列工具 —— Task / TaskUpdate / TaskList。
 *
 * 与 stdlib tools 区别:Task 系列必须依赖 LedgerSink 注入(不像 read/write
 * 那样自带 cwd 闭包),因为它们的核心用处是"持久化 + timeline 重放"。
 *
 * 设计:
 *   - createTaskTool(options: { ledger: LedgerSink, sessionId, ... }): AgentTool
 *   - ledger 写入 type: "custom" + payload.kind: "task"|"task_update" 的 LedgerEntry
 *   - TaskList 走 findByType("custom") + 过滤 kind + 重放
 *
 * 遵循 pi `core/tools/task.ts` / `task-update.ts` / `task-list.ts` 的契约:
 *   - Task 工具 isDestructive=false(纯追加 ledger entry)
 *   - TaskUpdate 也是追加而非修改 ledger(`// TODO(pi): 树形 update merge`)
 *   - 只读 TaskList isReadOnly=true + isConcurrencySafe=true
 */

import { Type } from "typebox";
import type { Static } from "typebox";
import type { AgentTool, AgentToolResult } from "../types.ts";
import type { LedgerSink, LedgerEntry } from "../ledger/types.ts";
import { newId } from "../ledger/types.ts";
import {
  type TaskCreatePayload,
  type TaskUpdatePayload,
  type TaskPriority,
  type TaskStatus,
  type TaskSnapshot,
  isTaskCreatePayload,
  isTaskUpdatePayload,
} from "./types.ts";

// ===== Schemas =====

export const taskSchema = Type.Object({
  content: Type.String({
    description: "任务正文(单行文本,如 'implement X');勿多行,勿 markdown",
  }),
  priority: Type.Optional(
    Type.String({
      description: "high | medium | low;缺省 medium",
    }),
  ),
});

export const taskUpdateSchema = Type.Object({
  taskId: Type.String({ description: "目标任务 id(由 Task 工具返回的 taskId)" }),
  status: Type.Optional(
    Type.String({
      description: "pending | in_progress | completed | deleted",
    }),
  ),
  content: Type.Optional(
    Type.String({ description: "修订后的任务正文(留空则不改)" }),
  ),
  priority: Type.Optional(
    Type.String({ description: "high | medium | low;留空则不改" }),
  ),
});

export const taskListSchema = Type.Object({
  status: Type.Optional(
    Type.String({ description: "只列该 status 的任务;不设则不返回 deleted 的" }),
  ),
  priority: Type.Optional(
    Type.String({ description: "只列该 priority 的任务" }),
  ),
});

export type TaskToolInput = Static<typeof taskSchema>;
export type TaskUpdateToolInput = Static<typeof taskUpdateSchema>;
export type TaskListToolInput = Static<typeof taskListSchema>;

// ===== Task 持久性 helper =====

/**
 * 调用方注入:用于审计/同步 task 状态的 sink + 工具内 id 生成。
 */
export interface TaskToolOptions {
  /** 持久化 sink;未设则使用内存 Map(开发/demo 用) */
  ledger?: LedgerSink;
  /** session 内单调 id,用于 ledger entry id */
  newEntryId?: () => string;
}

// ===== 工具工厂 =====

const VALID_PRIORITY: ReadonlyArray<TaskPriority> = ["high", "medium", "low"];
const VALID_STATUS: ReadonlyArray<TaskStatus> = [
  "pending",
  "in_progress",
  "completed",
  "deleted",
];

function normalizePriority(p: unknown): TaskPriority {
  return VALID_PRIORITY.includes(p as TaskPriority) ? (p as TaskPriority) : "medium";
}

function normalizeStatus(s: unknown): TaskStatus | undefined {
  return VALID_STATUS.includes(s as TaskStatus) ? (s as TaskStatus) : undefined;
}

/** 工具 1: Task —— 内容 + 优先级 → 写 taskId 返回 OK */
export function createTaskTool(options: TaskToolOptions = {}): AgentTool<typeof taskSchema> {
  const newEntryId = options.newEntryId ?? newId;
  return {
    name: "Task",
    label: "Task",
    description:
      "Task: 把一句任务写入 ledger(task custom entry)。返回 taskId 供后续 TaskUpdate。",
    parameters: taskSchema,
    isDestructive: () => false,
    isConcurrencySafe: () => false, // 写 ledger
    async execute(_toolCallId, params): Promise<AgentToolResult> {
      const content = (params.content ?? "").trim();
      if (!content) {
        throw new Error("Task: content 必须非空字符串");
      }
      const priority = normalizePriority(params.priority);
      const taskId = `task-${newId()}`;
      const payload: TaskCreatePayload = {
        kind: "task",
        taskId,
        content,
        priority,
        status: "pending",
        createdAt: Date.now(),
      };
      const entry: LedgerEntry = {
        id: newEntryId(),
        sessionId: options.ledger?.sessionId ?? "",
        parentId: "",
        timestamp: Date.now(),
        type: "custom",
        payload: payload as unknown as Record<string, unknown>,
      };
      if (options.ledger) {
        await options.ledger.append(entry);
      }
      return {
        content: [
          {
            type: "text",
            text: `Task created\n  taskId: ${taskId}\n  content: ${content}\n  priority: ${priority}\n  status: pending`,
          },
        ],
        details: { taskId, priority },
        terminate: false,
      };
    },
  };
}

/** 工具 2: TaskUpdate —— 任务状态机更新(写入 task_update custom entry) */
export function createTaskUpdateTool(options: TaskToolOptions = {}): AgentTool<typeof taskUpdateSchema> {
  const newEntryId = options.newEntryId ?? newId;
  return {
    name: "TaskUpdate",
    label: "TaskUpdate",
    description:
      "TaskUpdate: 改 task 的 status / content / priority。in_progress 排他:其它 in_progress 自动落 pending。",
    parameters: taskUpdateSchema,
    isDestructive: () => false,
    isConcurrencySafe: () => false,
    async execute(_toolCallId, params): Promise<AgentToolResult> {
      const taskId = params.taskId;
      if (!taskId) throw new Error("TaskUpdate: taskId 必填");
      const newStatus = normalizeStatus(params.status);
      const newPriority = params.priority ? normalizePriority(params.priority) : undefined;
      const newContent = params.content ?? undefined;
      if (!newStatus && !newPriority && !newContent) {
        throw new Error("TaskUpdate: 至少要 status / content / priority 之一");
      }

      // in_progress 排他机制:若设置 in_progress,自动把其它 in_progress置 pending
      // 仍以追加 ledger entry 形式(不修改任何已有 entry),重放时按规则落实排他。
      // 实现:在 update entry 里仅记录此 update 的目标状态;排他在 TaskList 重放时落实。
      const payload: TaskUpdatePayload = {
        kind: "task_update",
        taskId,
        status: newStatus,
        content: newContent,
        priority: newPriority,
        updatedAt: Date.now(),
      };
      const entry: LedgerEntry = {
        id: newEntryId(),
        sessionId: options.ledger?.sessionId ?? "",
        parentId: "",
        timestamp: Date.now(),
        type: "custom",
        payload: payload as unknown as Record<string, unknown>,
      };
      if (options.ledger) {
        await options.ledger.append(entry);
      }
      const applied = [
        newStatus && `status=${newStatus}`,
        newPriority && `priority=${newPriority}`,
        newContent && `content updated`,
      ]
        .filter(Boolean)
        .join(", ");
      return {
        content: [
          {
            type: "text",
            text: `Task updated\n  taskId: ${taskId}\n  ${applied}`,
          },
        ],
        details: { taskId, status: newStatus, priority: newPriority, contentUpdated: !!newContent },
        terminate: false,
      };
    },
  };
}

/** 工具 3: TaskList —— 仅读 ledger;按 status / priority 过滤后输出当前快照 */
export function createTaskListTool(options: TaskToolOptions = {}): AgentTool<typeof taskListSchema> {
  return {
    name: "TaskList",
    label: "TaskList",
    description:
      "TaskList: 按 status / priority 过滤输出当前任务快照。in_progress 排他(同时只一)。",
    parameters: taskListSchema,
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    async execute(_toolCallId, params): Promise<AgentToolResult> {
      const ledger = options.ledger;
      if (!ledger) {
        return {
          content: [{ type: "text", text: "TaskList: 未注入 ledger,无任务可列。" }],
          details: { count: 0 },
          terminate: false,
        };
      }
      const entries = await ledger.findByType("custom");
      const snapshots = replayTaskSnapshots(entries);
      // 过滤
      const wantStatus =
        params.status != null && VALID_STATUS.includes(params.status as TaskStatus)
          ? (params.status as TaskStatus)
          : undefined;
      const wantPriority =
        params.priority != null && VALID_PRIORITY.includes(params.priority as TaskPriority)
          ? (params.priority as TaskPriority)
          : undefined;

      let filtered = snapshots.filter((s) => s.status !== "deleted");
      if (wantStatus) filtered = filtered.filter((s) => s.status === wantStatus);
      else if (params.status == null) {
        // 默认:不返回 deleted
      } else {
        // 显式 "deleted" 想要 deleted 的 → 上面 if wantStatus 不命中,这里返回 deleted
        filtered = snapshots.filter((s) => s.status === (params.status as TaskStatus));
      }
      if (wantPriority) filtered = filtered.filter((s) => s.priority === wantPriority);

      // 排序:in_progress 优先 → 然后 priority desc → 创建时间 asc
      const priorityOrder: Record<TaskPriority, number> = { high: 0, medium: 1, low: 2 };
      filtered.sort((a, b) => {
        const sa = a.status === "in_progress" ? 0 : 1;
        const sb = b.status === "in_progress" ? 0 : 1;
        if (sa !== sb) return sa - sb;
        const pa = priorityOrder[a.priority];
        const pb = priorityOrder[b.priority];
        if (pa !== pb) return pa - pb;
        return a.createdAt - b.createdAt;
      });

      const lines = filtered.map(
        (s) => `- [${s.taskId}] (${s.priority}, ${s.status}) ${s.content}`,
      );
      const text =
        lines.length === 0
          ? "(no tasks match)"
          : `Tasks (${lines.length}):\n${lines.join("\n")}`;
      return {
        content: [{ type: "text", text }],
        details: { count: lines.length },
        terminate: false,
      };
    },
  };
}

// ===== Replay =====

/**
 * 重放 ledger custom entries → 任务当前快照。
 * - 仅关心 payload.kind === "task" | "task_update"
 * - 同一 taskId 的多次 update 按时间顺序应用,取最后值;
 *   in_progress 排他:每次新 in_progress 设置后,之前 in_progress 的同类被覆盖为 pending。
 */
export function replayTaskSnapshots(entries: LedgerEntry[]): TaskSnapshot[] {
  // taskId → snapshot(累积)
  const map = new Map<string, TaskSnapshot>();
  // 当前正在 in_progress 的 taskId(用于排他)
  // 应用时间序列
  for (const e of entries) {
    const p = e.payload as unknown;
    if (isTaskCreatePayload(p)) {
      map.set(p.taskId, {
        taskId: p.taskId,
        content: p.content,
        priority: p.priority,
        status: p.status,
        createdAt: p.createdAt,
        updatedAt: p.createdAt,
        lastEntryId: e.id,
      });
    } else if (isTaskUpdatePayload(p)) {
      const existing = map.get(p.taskId);
      if (!existing) {
        // update 早于 create?(异常)跳过
        continue;
      }
      // in_progress 排他:先复位旧 in_progress
      if (p.status === "in_progress") {
        for (const other of map.values()) {
          if (other.taskId !== p.taskId && other.status === "in_progress") {
            other.status = "pending";
            other.updatedAt = p.updatedAt;
          }
        }
      }
      const next: TaskSnapshot = {
        taskId: existing.taskId,
        content: p.content ?? existing.content,
        priority: p.priority ?? existing.priority,
        status: p.status ?? existing.status,
        createdAt: existing.createdAt,
        updatedAt: p.updatedAt,
        lastEntryId: e.id,
      };
      map.set(p.taskId, next);
    }
  }
  return Array.from(map.values());
}
