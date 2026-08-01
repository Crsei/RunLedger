/**
 * TodoWrite 工具 —— Task 系列的"行内 todo"别名。
 *
 * 与 Task 系列的关系:
 *   - 任务清单是"持久化 + 单一 in_progress + 排序"的语义模型。
 *   - 但 LLM 调用习惯:Agent 系上下文经常播报"用 TodoWrite 工具更新计划"。
 *   - 我们把 TodoWrite 实现为对 Task 系列的薄包装,语义:
 *       todos: array of { content, status, priority }  →
 *         1) 列出当前所有任务(TaskList)
 *         2) 把缺失的任务 create(Task),相同内容的 status 不一致则 update
 *         3) 不在 todos 中且非 completed 的旧任务 → task_update status=deleted
 *
 * 与 claude-code-bun docs/tools/todo-write-tool.mdx 区别:它把自己描述为
 * "system-reminder-derived" 工具的 free-form todos list;我们这里直接做更结构化的
 * Task 系列收口,即便用户调 TodoWrite 也是真落 ledger。
 */

import { Type } from "typebox";
import type { Static } from "typebox";
import type { AgentTool } from "../types.ts";
import { createTaskTool, createTaskUpdateTool, createTaskListTool, type TaskToolOptions } from "../tasks/task-tools.ts";
import type { TaskSnapshot } from "../tasks/types.ts";
import type { TaskPriority, TaskStatus } from "../tasks/types.ts";

export const todoWriteSchema = Type.Object({
  todos: Type.Array(
    Type.Object({
      content: Type.String({ description: "任务文本(单行;勿过长)" }),
      status: Type.String({ description: "pending | in_progress | completed" }),
      priority: Type.Optional(
        Type.String({ description: "high | medium | low;缺省 medium" }),
      ),
    }),
    { description: "整盘任务表;一次性覆盖当前清单(增删改)" },
  ),
});

export type TodoWriteInput = Static<typeof todoWriteSchema>;

export interface TodoWriteToolOptions extends TaskToolOptions {}

/**
 * TodoWrite 工厂。注入的 ledger / sessionId 沿用 Task 系列。
 */
export function createTodoWriteTool(options: TodoWriteToolOptions = {}): AgentTool<typeof todoWriteSchema> {
  const taskTool = createTaskTool(options);
  const upTool = createTaskUpdateTool(options);
  const listTool = createTaskListTool(options);
  return {
    name: "TodoWrite",
    label: "TodoWrite",
    description:
      "整盘覆写当前任务表(plan tracking)。语义复用 Task 系列;会调用 Task create/update 同步 ledger。",
    parameters: todoWriteSchema,
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    async execute(toolCallId, params): Promise<{
      content: Array<{ type: "text"; text: string }>;
      details: { written: number; updated: number; deleted: number };
      terminate: false;
    }> {
      const desiredTodos = params.todos ?? [];
      const desiredContents = desiredTodos.map((d) => d.content);
      // 1) 拉当前快照
      const listResult = await listTool.execute(toolCallId, {});
      const listText = (listResult.content[0] as { text: string }).text;
      const existing = parseSnapshots(listText);
      // 2) 把 existing 的内容用 content 做 key,逐条 update / create
      let written = 0;
      let updated = 0;
      const existingByContent = new Map<string, TaskSnapshot>();
      for (const s of existing) existingByContent.set(s.content, s);
      const desiredContentsSet = new Set(desiredContents);
      for (const d of desiredTodos) {
        const prior = existingByContent.get(d.content);
        if (!prior) {
          await taskTool.execute(toolCallId, { content: d.content, priority: d.priority });
          written++;
          continue;
        }
        if (prior.status !== d.status || (d.priority && prior.priority !== d.priority)) {
          await upTool.execute(toolCallId, {
            taskId: prior.taskId,
            status: d.status as TaskStatus,
            priority: d.priority as TaskPriority | undefined,
          });
          updated++;
        }
      }
      // 3) 旧任务不在 desired → 标 deleted
      let deleted = 0;
      for (const s of existing) {
        if (!desiredContentsSet.has(s.content) && s.status !== "deleted") {
          await upTool.execute(toolCallId, { taskId: s.taskId, status: "deleted" });
          deleted++;
        }
      }
      return {
        content: [
          { type: "text", text: `TodoWrite: ${written} created, ${updated} updated, ${deleted} deleted` },
        ],
        details: { written, updated, deleted },
        terminate: false,
      };
    },
  };
}

/**
 * 朴素解析 TaskList 输出 `- [taskId] (priority, status) content` 行。
 * 仅 TaskList 输出格式;若格式变,这里同步跟随。
 */
function parseSnapshots(text: string): TaskSnapshot[] {
  const lines = text.split("\n").filter((l) => l.trim().startsWith("- ["));
  const re = /^- \[([^\]]+)\] \(([^,]+),\s*([a-z_]+)\)\s*(.*)$/;
  return lines
    .map((l) => {
      const m = re.exec(l);
      if (!m) return null;
      const [, taskId, priority, status, content] = m;
      if (!taskId || !priority || !status || !content) return null;
      return {
        taskId,
        priority: priority as TaskPriority,
        status: status as TaskStatus,
        content,
        createdAt: 0,
        updatedAt: 0,
        lastEntryId: "",
      } satisfies TaskSnapshot;
    })
    .filter((s): s is TaskSnapshot => s !== null);
}
