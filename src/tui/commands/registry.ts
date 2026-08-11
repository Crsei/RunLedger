/**
 * Slash 命令注册表 —— `/` 命令的唯一事实源。
 *
 * 对照 development-doc/tui/20-codex-slash-command-adaptation-plan.md P0 与
 * codex-rs `tui/src/slash_command.rs` + `bottom_pane/slash_commands.rs`。
 *
 * 设计:
 *   - 复用 commands/types.ts 的 CommandDescriptor 作为基础字段;
 *   - builtinCommandDescriptors() 的顺序即弹窗展示顺序(高频在前,禁止字母排序);
 *   - findCommand(name) 解析 canonicalName 与别名(对照 codex from_str);
 *   - commandsForContext(context) 做可见性门控(debug 命令默认隐藏);
 *   - availableDuringTask 对照 codex `available_during_task`:任务运行中被拒的
 *     命令在派发层二次检查(TUI 弹窗仍展示,派发时报错)。
 */

import type { CommandDescriptor, CommandPolicy } from "./types.ts";

/** 命令上下文门控;当前只有可见性,派发期门控由 availableDuringTask 表达。 */
export interface SlashCommandContext {
  /** 是否展示 debug 命令(/commands 弹窗默认隐藏;直接输入仍可解析)。 */
  readonly showDebugCommands?: boolean;
  /** 动态命令按注册顺序插入 `/model` 之后。 */
  readonly dynamicCommands?: readonly RegisteredSlashCommand[];
}

export type SlashCommandActionType =
  | "ui.help"
  | "ui.clear"
  | "ui.quit"
  | "session.create"
  | "session.resume"
  | "session.fork"
  | "config.provider"
  | "config.model"
  | "config.thinking"
  | "auth.login"
  | "auth.logout"
  | "recovery.open"
  | "process.list"
  | "process.terminal"
  | "extension.mcp"
  | "extension.plugins"
  | "extension.skills"
  | "extension.hooks"
  | "plan.inspect"
  | "compaction.list"
  | "memory.inspect"
  | "memory.propose"
  | "prompt.select";

/** 注册表内建命令:CommandDescriptor + TUI 弹窗/派发所需的扩展位。 */
export interface RegisteredSlashCommand extends CommandDescriptor {
  /** 派发语义;InteractiveMode 只按此字段路由,不再以 canonicalName 隐式配对。 */
  readonly actionType: SlashCommandActionType;
  /** 支持内联参数(对照 codex supports_inline_args,如 /resume <id>)。 */
  readonly supportsInlineArgs: boolean;
  /** false = 任务运行中被拒(对照 codex available_during_task)。 */
  readonly availableDuringTask: boolean;
  /** debug 命令:默认不在 /commands 弹窗展示(对照 codex CommandPopup::new debug 过滤)。 */
  readonly debug?: boolean;
  /** 始终不在 TUI 命令列表展示;直接输入仍可解析。 */
  readonly hidden?: boolean;
  /** 别名命令:仅在前缀过滤命中时展示,空过滤全量列表隐藏(对照 codex ALIAS_COMMANDS)。 */
  readonly hiddenInFullList?: boolean;
  /** 弹窗中的用法提示(如 "[sessionId]"),渲染在命令名右侧。 */
  readonly usage?: string;
  /** 任务运行中被拒时的稳定用户文案。 */
  readonly unavailableDuringTaskMessage?: string;
}

const DEFAULT_POLICY: CommandPolicy = {
  draft: "allowed",
  history: "allowed",
  query: "allowed",
  frozen: "disabled",
};

const READONLY_POLICY: CommandPolicy = {
  draft: "allowed",
  history: "allowed",
  query: "allowed",
  frozen: "allowed",
};

const IDLE_ONLY_POLICY: CommandPolicy = {
  ...DEFAULT_POLICY,
  draft: "disabled",
};

function command(
  canonicalName: string,
  description: string,
  order: number,
  extra: Partial<Omit<RegisteredSlashCommand, "canonicalName" | "description" | "order" | "actionType">>
    & Pick<RegisteredSlashCommand, "actionType">,
): RegisteredSlashCommand {
  return {
    canonicalName,
    aliases: [],
    description,
    category: "ui",
    order,
    argumentSchema: [],
    policy: DEFAULT_POLICY,
    supportsInlineArgs: false,
    availableDuringTask: true,
    ...extra,
  };
}

function schema(
  name: string,
  description: string,
  required: boolean,
): { readonly name: string; readonly description: string; readonly required: boolean; readonly valueKind: "text" } {
  return { name, description, required, valueKind: "text" };
}

/**
 * 全量内建命令注册表。顺序即展示顺序(对照 codex enum 顺序语义:高频在前)。
 * 与 openSlashCommands / handleSubmit 双写收敛:两处都只读本注册表。
 */
export function builtinCommandDescriptors(): readonly RegisteredSlashCommand[] {
  return [
    command("help", "Show help", 1, {
      actionType: "ui.help",
      aliases: ["commands"],
      category: "ui",
      policy: READONLY_POLICY,
      hidden: true,
    }),
    command("clear", "Clear chat", 2, { actionType: "ui.clear", category: "ui" }),
    command("new", "Create a Session in this workspace", 4, { actionType: "session.create", category: "session", policy: IDLE_ONLY_POLICY }),
    command("resume", "Browse or resume a canonical Session", 5, {
      actionType: "session.resume",
      aliases: ["sessions"],
      category: "session",
      policy: IDLE_ONLY_POLICY,
      supportsInlineArgs: true,
      usage: "[sessionId]",
      argumentSchema: [schema("sessionId", "Session id to resume", false)],
    }),
    command("fork", "Fork the current durable head", 6, { actionType: "session.fork", category: "session", policy: IDLE_ONLY_POLICY }),
    command("provider", "Configure provider", 7, {
      actionType: "config.provider",
      category: "config",
      policy: IDLE_ONLY_POLICY,
      availableDuringTask: false,
      unavailableDuringTaskMessage: "Configuration commands are available when the current turn is idle.",
    }),
    command("login", "Authenticate provider", 8, {
      actionType: "auth.login",
      category: "config",
      policy: IDLE_ONLY_POLICY,
      availableDuringTask: false,
      unavailableDuringTaskMessage: "Configuration commands are available when the current turn is idle.",
      supportsInlineArgs: true,
      usage: "[providerId]",
      argumentSchema: [schema("providerId", "Provider to authenticate", false)],
    }),
    command("logout", "Remove credential", 9, {
      actionType: "auth.logout",
      category: "config",
      policy: IDLE_ONLY_POLICY,
      availableDuringTask: false,
      unavailableDuringTaskMessage: "Configuration commands are available when the current turn is idle.",
      supportsInlineArgs: true,
      usage: "[providerId]",
      argumentSchema: [schema("providerId", "Provider to log out of", false)],
    }),
    command("model", "Switch model", 10, {
      actionType: "config.model",
      category: "config",
      policy: READONLY_POLICY,
      availableDuringTask: false,
      unavailableDuringTaskMessage: "Configuration commands are available when the current turn is idle.",
    }),
    command("thinking", "Switch thinking level", 11, {
      actionType: "config.thinking",
      category: "config",
      policy: READONLY_POLICY,
      availableDuringTask: false,
      unavailableDuringTaskMessage: "Configuration commands are available when the current turn is idle.",
    }),
    command("recovery", "Inspect or resolve crash recovery", 12, {
      actionType: "recovery.open",
      category: "recovery",
      policy: READONLY_POLICY,
      supportsInlineArgs: true,
      usage: "[status|assess|verify <attemptId>|resume <reason>]",
      argumentSchema: [schema("action", "status|assess|verify <attemptId>|resume <reason>", false)],
    }),
    command("processes", "List managed processes", 13, { actionType: "process.list", category: "process", policy: READONLY_POLICY }),
    command("terminal", "Open managed terminal", 14, {
      actionType: "process.terminal",
      category: "process",
      policy: READONLY_POLICY,
      supportsInlineArgs: true,
      usage: "<executionId>",
      argumentSchema: [schema("executionId", "Managed process execution id", true)],
    }),
    command("quit", "Exit safely", 15, { actionType: "ui.quit", category: "ui", aliases: ["exit"] }),
    command("mcp", "List connected MCP servers", 16, { actionType: "extension.mcp", category: "extensions", policy: READONLY_POLICY }),
    command("plugins", "List discovered plugins", 17, { actionType: "extension.plugins", category: "extensions", policy: READONLY_POLICY }),
    command("skills", "List discovered skills", 18, { actionType: "extension.skills", category: "extensions", policy: READONLY_POLICY }),
    command("hooks", "List configured hooks", 19, { actionType: "extension.hooks", category: "extensions", policy: READONLY_POLICY }),
    command("plan", "Inspect Plan Mode state", 20, {
      actionType: "plan.inspect",
      category: "plan",
      policy: READONLY_POLICY,
      availableDuringTask: false,
      unavailableDuringTaskMessage: "/plan is available when the current turn is idle.",
    }),
    command("compact", "List compaction checkpoints", 21, {
      actionType: "compaction.list",
      category: "domain",
      policy: READONLY_POLICY,
      availableDuringTask: false,
      unavailableDuringTaskMessage: "/compact is available when the current turn is idle.",
    }),
    command("memory", "Inspect memory store", 22, {
      actionType: "memory.inspect",
      category: "domain",
      policy: READONLY_POLICY,
      availableDuringTask: false,
      unavailableDuringTaskMessage: "/memory is available when the current turn is idle.",
    }),
    command("remember", "Propose a memory record", 23, {
      actionType: "memory.propose",
      category: "domain",
      policy: IDLE_ONLY_POLICY,
      availableDuringTask: false,
      unavailableDuringTaskMessage: "/remember is available when the current turn is idle.",
      supportsInlineArgs: true,
      usage: "<text>",
      argumentSchema: [schema("text", "Memory content to propose", true)],
    }),
    command("prompt", "Pick prompt template", 24, { actionType: "prompt.select", category: "prompts", policy: READONLY_POLICY }),
  ];
}

/** 单条命令的上下文可见性门控(debug 命令默认隐藏,对照 codex CommandPopup debug 前缀过滤)。 */
export function isCommandVisibleForContext(entry: RegisteredSlashCommand, context: SlashCommandContext): boolean {
  if (entry.hidden === true) return false;
  const isDebug = entry.debug === true || entry.canonicalName.startsWith("debug");
  return !(isDebug && context.showDebugCommands !== true);
}

/** 展示可见命令;debug 命令默认隐藏(直接输入仍可解析,对照 codex is_visible)。 */
export function commandsForContext(context: SlashCommandContext = {}): readonly RegisteredSlashCommand[] {
  const builtins = builtinCommandDescriptors().filter((entry) => isCommandVisibleForContext(entry, context));
  const dynamic = (context.dynamicCommands ?? []).filter((entry) => isCommandVisibleForContext(entry, context));
  if (dynamic.length === 0) return builtins;
  const modelIndex = builtins.findIndex((entry) => entry.canonicalName === "model");
  const insertionIndex = modelIndex === -1 ? builtins.length : modelIndex + 1;
  return [...builtins.slice(0, insertionIndex), ...dynamic, ...builtins.slice(insertionIndex)];
}

/** canonicalName 或别名精确查找;小写归一,无命中返回 undefined。 */
export function findCommand(name: string): RegisteredSlashCommand | undefined {
  const normalized = name.trim().toLowerCase();
  if (normalized.length === 0) return undefined;
  const entries = builtinCommandDescriptors();
  const exact = entries.find((entry) => entry.canonicalName === normalized);
  if (exact !== undefined) return exact;
  return entries.find((entry) => entry.aliases.includes(normalized));
}

/** 非空过滤时展示所有命令(含 hiddenInFullList 别名);空过滤只展示 full-list 命令。 */
export function popupCommandsForFilter(entries: readonly RegisteredSlashCommand[], hasFilter: boolean): readonly RegisteredSlashCommand[] {
  return hasFilter
    ? entries
    : entries.filter((entry) => entry.hiddenInFullList !== true);
}
