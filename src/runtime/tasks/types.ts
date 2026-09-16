/**
 * 任务/目标投影共享的词汇。
 *
 * 这里只保留 TUI `task-goal` 查询投影(`src/tui/task-goal/types.ts`)读取的
 * priority / status 取值。历史上的 ledger 型 Task / TaskUpdate / TaskList 工具
 * (以及它们的 payload / snapshot / replay)已随 `todo` op 模型的接入移除:
 * 那三个工具从未进入任何生产组合,唯一消费者是被 `todo` 取代的 `TodoWrite`。
 * 任务表的持久化与重放现在由 `src/runtime/tools/todo.ts` 承担。
 */

/**
 * 任务优先级。对齐 docs:high / medium / low。
 */
export type TaskPriority = "high" | "medium" | "low";

/**
 * 任务状态机。
 * - pending: 已创建未开始
 * - in_progress: 进行中(限制单一进行中)
 * - completed: 完成
 * - deleted: 软删除(可读但默认不列入)
 */
export type TaskStatus = "pending" | "in_progress" | "completed" | "deleted";
