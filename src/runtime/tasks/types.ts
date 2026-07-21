/**
 * V2 Task 系列 —— Task / TaskUpdate / TaskList 共享类型。
 *
 * 对齐 claude-code-bun docs/tools/task-tool.mdx / task-update-tool.mdx /
 * task-list-tool.mdx 的 V2 体系(text-content 任务清单,不再依赖 system reminder)。
 *
 * 与 pi 的区别:不做持久化跨 session 的 SQLite 表,而是把 task / task_update
 * 作为 `custom` 类型 LedgerEntry 写进 JsonlLedger,通过 `findByType("custom")`
 * + `payload.kind` 重放出当前任务状态。
 *
 * 任务语义:
 *   - 状态机:pending ⇄ in_progress → completed;deleted 软删除。
 *   - 同一 taskId 的多次 task_update 形成一个 timeline;TaskList 输出当前快照
 *     (即最后一次 update 的状态;若仅 task 创建无 update,则原 task 状态有效)。
 *   - status "in_progress" 在 V2 中是 soft exclusive —— 若一个任务置为 in_progress,
 *     其它置为 in_progress 的任务会被自动改为 pending(对齐 claude-code-bun
 *     "task tool: only one in_progress at a time")。
 */

/**
 * 任务优先级。对齐 docs:high / medium / low。
 */
export type TaskPriority = "high" | "medium" | "low";

/**
 * 任务状态机。
 * - pending: 已创建未开始
 * - in_progress: 进行中(V2 中限制单一进行中)
 * - completed: 完成
 * - deleted: 软删除(可读但默认不列入)
 */
export type TaskStatus = "pending" | "in_progress" | "completed" | "deleted";

/**
 * 创建任务 payload(由 Task 工具写入 ledger 的 custom entry)。
 */
export interface TaskCreatePayload {
  kind: "task";
  taskId: string;
  content: string;
  priority: TaskPriority;
  status: TaskStatus;
  createdAt: number;
}

/**
 * 更新任务 payload。
 * - 至少有一个字段(status/content/priority)非空。
 * - updatedAt 由 TaskUpdate 工具填。
 */
export interface TaskUpdatePayload {
  kind: "task_update";
  taskId: string;
  status?: TaskStatus;
  content?: string;
  priority?: TaskPriority;
  updatedAt: number;
}

/**
 * TaskList payload(只读,不写 ledger;仅作为 schema 标记)。
 */
export interface TaskListPayload {
  kind: "task_list";
  /** 过滤 status;不设 → 返回非 deleted 的全部 */
  status?: TaskStatus;
  /** 按 priority 过滤 */
  priority?: TaskPriority;
}

export type TaskPayload = TaskCreatePayload | TaskUpdatePayload | TaskListPayload;

/**
 * 重放出来的最新快照。
 */
export interface TaskSnapshot {
  taskId: string;
  content: string;
  priority: TaskPriority;
  status: TaskStatus;
  createdAt: number;
  updatedAt: number;
  /** 最后一条 update entry.id(便于审计) */
  lastEntryId: string;
}

/**
 * 校验 payload.kind 是否为 task / task_update,助手函数。
 */
export function isTaskCreatePayload(p: unknown): p is TaskCreatePayload {
  return (
    typeof p === "object" &&
    p !== null &&
    (p as { kind?: unknown }).kind === "task" &&
    typeof (p as TaskCreatePayload).taskId === "string"
  );
}

export function isTaskUpdatePayload(p: unknown): p is TaskUpdatePayload {
  return (
    typeof p === "object" &&
    p !== null &&
    (p as { kind?: unknown }).kind === "task_update" &&
    typeof (p as TaskUpdatePayload).taskId === "string"
  );
}
