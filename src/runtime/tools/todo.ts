/**
 * todo 工具 —— 相位化任务表,按单个 op 增量更新(对齐 oh-my-pi `tools/todo.ts`)。
 *
 * 与旧的 `TodoWrite` 区别:不再"整盘覆写",而是显式 op 集合:
 *   init / append / start / done / drop / block / unblock / rm / view
 * 调用方无需先读回当前表再整表重发,因而不会因一次遗漏而清掉未提及的任务。
 *
 * 语义模型(与参考实现一致):
 *   - 表由相位组成(`TodoPhase { name, tasks[] }`),相位顺序即执行顺序。
 *   - 任务状态:pending | in_progress | completed | abandoned | blocked。
 *   - 不变量:最多一个 in_progress;若没有 in_progress,最早的 pending 自动提升。
 *     blocked 任务不参与自动提升;已完成/已放弃的任务不回退。
 *   - 目标解析:`task`(按内容唯一定位)> `phase`(该相位全部任务)> 全部任务。
 *     `block`/`unblock` 必须给出 `task` 或 `phase`;`rm` 两者都不给表示清空。
 *
 * 参考实现里还有 Markdown 往返(/todo 斜杠命令的编辑面)与 HUD 摘要;RunLedger
 * 没有对应的编辑入口,故不移植,只保留模型面 op 语义与有界文本摘要。
 *
 * 持久化:每次 mutation 追加一条 `custom` ledger entry(payload.kind =
 * "todo_phases")记录完整新状态;`view` 与后续 mutation 都按最后一条快照重放。
 */

import { Type } from "typebox";
import type { Static } from "typebox";
import type { AgentTool, AgentToolResult } from "../types.ts";
import type { LedgerSink, LedgerEntry } from "../ledger/types.ts";
import { newId } from "../ledger/types.ts";

export const TODO_OPERATIONS = [
  "init",
  "append",
  "start",
  "done",
  "drop",
  "block",
  "unblock",
  "rm",
  "view",
] as const;

export type TodoOperation = (typeof TODO_OPERATIONS)[number];

export const TODO_STATUSES = ["pending", "in_progress", "completed", "abandoned", "blocked"] as const;

export type TodoStatus = (typeof TODO_STATUSES)[number];

export interface TodoTask {
  readonly content: string;
  readonly status: TodoStatus;
  /** blocked 状态的原因;其他状态不携带。 */
  readonly blocker?: string;
}

export interface TodoPhase {
  readonly name: string;
  readonly tasks: readonly TodoTask[];
}

/** ledger payload:一条完整状态快照。 */
export interface TodoPhasesPayload {
  readonly kind: "todo_phases";
  readonly phases: readonly TodoPhase[];
  readonly updatedAt: number;
}

export const TODO_PHASES_KIND = "todo_phases";

/** 冻结的默认相位名:`init` 扁平写法(只有 items)时使用。 */
export const DEFAULT_TODO_PHASE = "Tasks";

const todoListEntry = Type.Object({
  phase: Type.String({ description: "相位名(短名词短语,如 Foundation)" }),
  items: Type.Array(Type.String({ description: "任务内容" })),
});

export const todoSchema = Type.Object({
  op: Type.Optional(Type.Unsafe<TodoOperation>({ type: "string", enum: [...TODO_OPERATIONS] })),
  list: Type.Optional(Type.Array(todoListEntry, { description: "相位任务表(init)" })),
  task: Type.Optional(Type.String({ description: "任务内容(按内容唯一定位;不要传 task-N 这类 id)" })),
  phase: Type.Optional(Type.String({ description: "相位名" })),
  items: Type.Optional(Type.Array(Type.String({ description: "任务内容" }), { description: "任务内容(append;或 init 的扁平写法)" })),
  reason: Type.Optional(Type.String({ description: "blocker 说明(block)" })),
});

export type TodoToolInput = Static<typeof todoSchema>;

export interface TodoToolDetails {
  readonly operation: TodoOperation;
  readonly phases: readonly TodoPhase[];
  /** 本次实际发生的状态迁移;view 与建表时为空。 */
  readonly transitions: readonly { readonly phase: string; readonly content: string; readonly to: TodoStatus }[];
  /** op 由参数形状推断时记录(模型常漏 op),便于审计调用形态。 */
  readonly inferredOp?: boolean;
}

export interface TodoToolOptions {
  /** 持久化 sink;未注入时工具只用内存状态(开发/测试)。 */
  readonly ledger?: LedgerSink;
  /** ledger entry id 生成器;缺省 `newId`。 */
  readonly newEntryId?: () => string;
}

/** 唯一 in_progress;多余的全部降级为 pending;没有则提升最早的 pending(blocked 不参与)。 */
export function normalizeInProgress(phases: readonly TodoPhase[]): readonly TodoPhase[] {
  const flat = phases.flatMap((phase) => phase.tasks);
  if (flat.length === 0) return phases;

  let seenInProgress = false;
  let changed = false;
  const demoted = phases.map((phase) => ({
    name: phase.name,
    tasks: phase.tasks.map((task) => {
      if (task.status !== "in_progress") return task;
      if (seenInProgress) {
        changed = true;
        return { content: task.content, status: "pending" as const };
      }
      seenInProgress = true;
      return task;
    }),
  }));
  if (seenInProgress) return changed ? demoted : phases;

  for (let phaseIndex = 0; phaseIndex < demoted.length; phaseIndex += 1) {
    const tasks = demoted[phaseIndex]!.tasks;
    const pendingIndex = tasks.findIndex((task) => task.status === "pending");
    if (pendingIndex < 0) continue;
    const promoted = [...tasks];
    promoted[pendingIndex] = { content: tasks[pendingIndex]!.content, status: "in_progress" };
    return demoted.map((phase, index) => (index === phaseIndex ? { name: phase.name, tasks: promoted } : phase));
  }
  return demoted;
}

/**
 * 按内容定位任务。相位未给时要求跨相位唯一命中;给定时限定在该相位内。
 * 找不到或有歧义都返回 undefined,由调用方转成明确的错误信息。
 */
function resolveTask(
  phases: readonly TodoPhase[],
  content: string,
  phaseName: string | undefined,
): { readonly phaseIndex: number; readonly taskIndex: number } | undefined {
  const candidates: Array<{ phaseIndex: number; taskIndex: number }> = [];
  phases.forEach((phase, phaseIndex) => {
    if (phaseName !== undefined && phase.name !== phaseName) return;
    phase.tasks.forEach((task, taskIndex) => {
      if (task.content === content) candidates.push({ phaseIndex, taskIndex });
    });
  });
  return candidates.length === 1 ? candidates[0] : undefined;
}

/** `task` > `phase` > 全部;`task` 未命中时抛错而不是放宽到全部。 */
function resolveTargets(
  phases: readonly TodoPhase[],
  params: TodoToolInput,
  op: TodoOperation,
): readonly { readonly phaseIndex: number; readonly taskIndex: number }[] {
  if (params.task !== undefined && params.task.length > 0) {
    const hit = resolveTask(phases, params.task, params.phase);
    if (hit === undefined) {
      throw new Error(
        `todo: ${op} 找不到任务 "${params.task}"(任务按内容引用,不按 id;请用之前结果里的完整文本。若该内容出现多次,请同时给 phase)`,
      );
    }
    return [hit];
  }
  if (params.phase !== undefined && params.phase.length > 0) {
    const phaseIndex = phases.findIndex((phase) => phase.name === params.phase);
    if (phaseIndex < 0) throw new Error(`todo: ${op} 找不到相位 "${params.phase}"`);
    return phases[phaseIndex]!.tasks.map((_task, taskIndex) => ({ phaseIndex, taskIndex }));
  }
  return phases.flatMap((phase, phaseIndex) => phase.tasks.map((_task, taskIndex) => ({ phaseIndex, taskIndex })));
}

/** 单条任务的替换:block 附带 blocker,其余状态清除 blocker。 */
function withStatus(task: TodoTask, status: TodoStatus, blocker: string | undefined): TodoTask {
  return status === "blocked"
    ? { content: task.content, status, blocker: blocker ?? "(no reason given)" }
    : { content: task.content, status };
}

/** 原地模型 → 不可变写回:按 (phaseIndex, taskIndex) 逐条替换。 */
function replaceTasks(
  phases: readonly TodoPhase[],
  edits: readonly { readonly phaseIndex: number; readonly taskIndex: number; readonly task: TodoTask }[],
): TodoPhase[] {
  const next = phases.map((phase) => ({ name: phase.name, tasks: [...phase.tasks] }));
  for (const edit of edits) {
    next[edit.phaseIndex]!.tasks[edit.taskIndex] = edit.task;
  }
  return next;
}

/**
 * 模型常漏 `op` 而只给可判定的载荷;只在无歧义时推断:
 *   - `list` → init
 *   - `items` + `phase` → append(相位不存在时惰性创建,结果等同单相位 init)
 *   - 仅有 `items` 且当前无表 → init
 */
function inferOperation(raw: Record<string, unknown>, hasExistingPhases: boolean): TodoOperation | undefined {
  if (Array.isArray(raw["list"]) && raw["list"].length > 0) return "init";
  if (Array.isArray(raw["items"]) && raw["items"].length > 0) {
    if (typeof raw["phase"] === "string" && raw["phase"].length > 0) return "append";
    if (!hasExistingPhases) return "init";
  }
  return undefined;
}

function replayPhases(entries: readonly LedgerEntry[]): readonly TodoPhase[] {
  let latest: readonly TodoPhase[] = [];
  for (const entry of entries) {
    const payload = entry.payload;
    if (payload === null || typeof payload !== "object") continue;
    if ((payload as { kind?: unknown }).kind !== TODO_PHASES_KIND) continue;
    const phases = (payload as { phases?: unknown }).phases;
    if (Array.isArray(phases)) latest = phases as readonly TodoPhase[];
  }
  return latest;
}

function renderPhases(phases: readonly TodoPhase[]): string {
  if (phases.length === 0) return "(empty todo list)";
  const tasks = phases.flatMap((phase) => phase.tasks);
  const remaining = tasks.filter((task) => task.status === "pending" || task.status === "in_progress");
  const closed = tasks.filter((task) => task.status === "completed" || task.status === "abandoned");
  const blocked = tasks.filter((task) => task.status === "blocked");
  const lines: string[] = [];
  if (remaining.length === 0) {
    lines.push("Remaining items: none.");
  } else {
    lines.push(`Remaining items (${remaining.length}):`);
    for (const phase of phases) {
      for (const task of phase.tasks) {
        if (task.status !== "pending" && task.status !== "in_progress") continue;
        lines.push(`  - ${task.content} [${task.status}] (${phase.name})`);
      }
    }
  }
  lines.push(`Overall: ${closed.length}/${tasks.length} done, ${remaining.length} open${blocked.length > 0 ? `, ${blocked.length} blocked` : ""}.`);
  for (const phase of phases) {
    lines.push(`  ${phase.name}:`);
    for (const task of phase.tasks) {
      const suffix = task.status === "blocked"
        ? task.blocker === undefined ? " (blocked)" : ` (blocked: ${task.blocker})`
        : task.status === "abandoned" ? " (dropped)"
          : task.status === "in_progress" ? " (in progress)"
            : "";
      lines.push(`    - ${task.status === "completed" ? "[X]" : "[ ]"} ${task.content}${suffix}`);
    }
  }
  return lines.join("\n");
}

/**
 * 计算一次 op 的新状态。抛错即调用非法(由 agent-loop 转 isError),且不写入任何
 * ledger entry —— 失败不产生半更新状态。
 */
function applyOperation(
  current: readonly TodoPhase[],
  params: TodoToolInput,
  operation: TodoOperation,
): { phases: readonly TodoPhase[]; transitions: TodoToolDetails["transitions"] } {
  const transitions: Array<TodoToolDetails["transitions"][number]> = [];
  switch (operation) {
    case "view":
      return { phases: current, transitions };
    case "init": {
      // 兼容扁平写法 `{items:[...], phase?}`:合成单相位表,而不是当成非法参数。
      const list = params.list ?? (params.items !== undefined && params.items.length > 0
        ? [{ phase: params.phase ?? DEFAULT_TODO_PHASE, items: [...params.items] }]
        : undefined);
      if (list === undefined || list.length === 0) {
        throw new Error("todo: init 需要非空 list(或扁平 items)");
      }
      const phases = list.map((entry) => ({
        name: entry.phase,
        tasks: entry.items.map((content): TodoTask => ({ content, status: "pending" })),
      }));
      return { phases: normalizeInProgress(phases), transitions };
    }
    case "append": {
      if (params.phase === undefined || params.phase.length === 0) throw new Error("todo: append 需要 phase");
      if (params.items === undefined || params.items.length === 0) throw new Error("todo: append 需要非空 items");
      const added = params.items.map((content): TodoTask => ({ content, status: "pending" }));
      const existing = current.find((candidate) => candidate.name === params.phase);
      const phases = existing === undefined
        ? [...current, { name: params.phase, tasks: added }]
        : current.map((phase) => (phase.name === params.phase ? { name: phase.name, tasks: [...phase.tasks, ...added] } : phase));
      return { phases: normalizeInProgress(phases), transitions };
    }
    case "start": {
      if (params.task === undefined || params.task.length === 0) throw new Error("todo: start 需要 task");
      const hit = resolveTask(current, params.task, params.phase);
      if (hit === undefined) {
        throw new Error(`todo: start 找不到任务 "${params.task}"(任务按内容引用,不按 id)`);
      }
      const target = current[hit.phaseIndex]!.tasks[hit.taskIndex]!;
      if (target.status === "completed" || target.status === "abandoned") {
        throw new Error(`todo: "${target.content}" 已是 ${target.status},不能重新 start;需要时先 rm 再 append`);
      }
      // in_progress 是排他的:先把其它 in_progress 落回 pending,再置目标。
      const edits: Array<{ phaseIndex: number; taskIndex: number; task: TodoTask }> = [];
      current.forEach((phase, phaseIndex) => {
        phase.tasks.forEach((task, taskIndex) => {
          if (task.status === "in_progress" && !(phaseIndex === hit.phaseIndex && taskIndex === hit.taskIndex)) {
            edits.push({ phaseIndex, taskIndex, task: withStatus(task, "pending", undefined) });
          }
        });
      });
      edits.push({ phaseIndex: hit.phaseIndex, taskIndex: hit.taskIndex, task: withStatus(target, "in_progress", undefined) });
      transitions.push({ phase: current[hit.phaseIndex]!.name, content: target.content, to: "in_progress" });
      return { phases: normalizeInProgress(replaceTasks(current, edits)), transitions };
    }
    case "done":
    case "drop": {
      const to: TodoStatus = operation === "done" ? "completed" : "abandoned";
      const targets = resolveTargets(current, params, operation);
      const edits = targets.map((target) => ({
        ...target,
        task: withStatus(current[target.phaseIndex]!.tasks[target.taskIndex]!, to, undefined),
      }));
      for (const edit of edits) {
        transitions.push({ phase: current[edit.phaseIndex]!.name, content: edit.task.content, to });
      }
      return { phases: normalizeInProgress(replaceTasks(current, edits)), transitions };
    }
    case "block":
    case "unblock": {
      if ((params.task === undefined || params.task.length === 0) && (params.phase === undefined || params.phase.length === 0)) {
        throw new Error(`todo: ${operation} 需要 task 或 phase 目标`);
      }
      // blocker 说明会进入单行摘要,折叠空白避免多行外部错误破坏展示。
      const reason = operation === "block" ? params.reason?.replace(/\s+/gu, " ").trim() || undefined : undefined;
      const targets = resolveTargets(current, params, operation);
      const edits: Array<{ phaseIndex: number; taskIndex: number; task: TodoTask }> = [];
      for (const target of targets) {
        const task = current[target.phaseIndex]!.tasks[target.taskIndex]!;
        if (operation === "block") {
          // 只有仍开放的工作能转 blocked;阻止已完成的进度被回退。
          if (task.status !== "pending" && task.status !== "in_progress" && task.status !== "blocked") continue;
          edits.push({ ...target, task: withStatus(task, "blocked", reason) });
          transitions.push({ phase: current[target.phaseIndex]!.name, content: task.content, to: "blocked" });
          continue;
        }
        if (task.status !== "blocked") continue;
        edits.push({ ...target, task: withStatus(task, "pending", undefined) });
        transitions.push({ phase: current[target.phaseIndex]!.name, content: task.content, to: "pending" });
      }
      return { phases: normalizeInProgress(replaceTasks(current, edits)), transitions };
    }
    case "rm": {
      const hasTarget = (params.task !== undefined && params.task.length > 0) || (params.phase !== undefined && params.phase.length > 0);
      if (!hasTarget) {
        for (const phase of current) {
          for (const task of phase.tasks) transitions.push({ phase: phase.name, content: task.content, to: "abandoned" });
        }
        return { phases: [], transitions };
      }
      const targets = resolveTargets(current, params, operation);
      const removed = new Set(targets.map((target) => `${target.phaseIndex}::${target.taskIndex}`));
      for (const target of targets) {
        const task = current[target.phaseIndex]!.tasks[target.taskIndex]!;
        transitions.push({ phase: current[target.phaseIndex]!.name, content: task.content, to: "abandoned" });
      }
      const phases = current
        .map((phase, phaseIndex) => ({
          name: phase.name,
          tasks: phase.tasks.filter((_task, taskIndex) => !removed.has(`${phaseIndex}::${taskIndex}`)),
        }))
        .filter((phase) => phase.tasks.length > 0);
      return { phases: normalizeInProgress(phases), transitions };
    }
    default:
      throw new Error(`todo: 未知 op ${String(operation)}`);
  }
}

export function createTodoTool(options: TodoToolOptions = {}): AgentTool<typeof todoSchema, TodoToolDetails> {
  const newEntryId = options.newEntryId ?? newId;
  return {
    name: "todo",
    label: "todo",
    description:
      "维护相位化任务表。op: init/append 建表;start/done/drop/block/unblock/rm 改任务;view 只读。" +
      "任务用完整内容文本引用(不要用 id)。目标解析:task(按内容)> phase(该相位全部)> 全部任务;" +
      "block/unblock 必须给 task 或 phase,rm 两者都不给表示清空。" +
      "无 in_progress 时最早的 pending 自动提升,同时只允许一个 in_progress;blocked 不自动提升。",
    parameters: todoSchema,
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    async execute(_toolCallId, params): Promise<AgentToolResult<TodoToolDetails>> {
      const ledger = options.ledger;
      const current = ledger === undefined ? [] : replayPhases(await ledger.findByType("custom"));
      const raw = params as Record<string, unknown>;
      const inferred = params.op === undefined ? inferOperation(raw, current.length > 0) : undefined;
      const operation = params.op ?? inferred;
      if (operation === undefined) {
        throw new Error("todo: 需要 op(init/append/start/done/drop/block/unblock/rm/view)");
      }
      const { phases, transitions } = applyOperation(current, params, operation);
      if (operation !== "view" && ledger !== undefined) {
        const payload: TodoPhasesPayload = { kind: TODO_PHASES_KIND, phases, updatedAt: Date.now() };
        const entry: LedgerEntry = {
          id: newEntryId(),
          sessionId: ledger.sessionId,
          parentId: "",
          timestamp: Date.now(),
          type: "custom",
          payload: payload as unknown as Record<string, unknown>,
        };
        await ledger.append(entry);
      }
      return {
        content: [{ type: "text", text: `todo ${operation}\n${renderPhases(phases)}` }],
        details: {
          operation,
          phases,
          transitions,
          ...(inferred === undefined ? {} : { inferredOp: true }),
        },
      };
    },
  };
}
