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

/** 命令上下文门控;Session 能力来自当前连接的协商结果。 */
export interface SlashCommandContext {
  /** 是否展示 debug 命令(/commands 弹窗默认隐藏;直接输入仍可解析)。 */
  readonly showDebugCommands?: boolean;
  /** 动态命令按注册顺序插入 `/model` 之后。 */
  readonly dynamicCommands?: readonly RegisteredSlashCommand[];
  /** 省略时仅返回静态目录；真实 TUI 必须注入当前 Session 的精确判断。 */
  readonly supportsOperation?: (operation: string) => boolean;
}

export type SlashCommandActionType =
  | "ui.help"
  | "ui.clear"
  | "ui.dump"
  | "ui.scrollbar.toggle"
  | "ui.trajectory"
  | "ui.quit"
  | "session.mode"
  | "session.mode.minimal"
  | "session.create"
  | "session.resume"
  | "session.fork"
  | "session.rename"
  | "config.provider"
  | "config.model"
  | "config.thinking"
  | "config.hide-thinking"
  | "config.theme"
  | "config.permissions"
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
  /** 命令入口实际查询或变更的 operation，不根据菜单名称猜测。 */
  readonly requiredOperation?: string;
  /** 当前 Session 不提供能力时可执行的替代操作。 */
  readonly unavailableHint?: string;
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
    command("new", "Create or inherit a Session harness profile", 4, {
		actionType: "session.create",
		category: "session",
		policy: IDLE_ONLY_POLICY,
		supportsInlineArgs: true,
		usage: "[standard|minimal]",
		argumentSchema: [schema("harnessProfile", "Builtin harness profile", false)],
	}),
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
    command("rename", "Set the current Session display title", 6.5, {
      actionType: "session.rename",
      category: "session",
      policy: IDLE_ONLY_POLICY,
      supportsInlineArgs: true,
      usage: "<title>",
      argumentSchema: [schema("title", "Display title", true)],
    }),
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
    command("mode", "Select agent mode (creates a new Session)", 10.1, {
      actionType: "session.mode", category: "session", policy: IDLE_ONLY_POLICY,
      supportsInlineArgs: true, availableDuringTask: false,
      usage: "[default|minimal|plan]",
      argumentSchema: [schema("mode", "Agent mode", false)],
    }),
    command("minimal", "Create a shell-only Session", 10.2, {
      actionType: "session.mode.minimal", category: "session", policy: IDLE_ONLY_POLICY,
      supportsInlineArgs: true, availableDuringTask: false, hiddenInFullList: true,
    }),
    command("thinking", "Switch thinking level", 11, {
      actionType: "config.thinking",
      category: "config",
      policy: READONLY_POLICY,
      availableDuringTask: false,
      unavailableDuringTaskMessage: "Configuration commands are available when the current turn is idle.",
    }),
    command("hide-thinking", "Toggle hiding thinking blocks and save the setting", 12, {
		actionType: "config.hide-thinking",
		category: "config",
		policy: READONLY_POLICY,
		availableDuringTask: false,
		unavailableDuringTaskMessage: "Configuration commands are available when the current turn is idle.",
	}),
    command("theme", "Switch syntax theme", 13, {
      actionType: "config.theme",
      category: "config",
      policy: READONLY_POLICY,
    }),
    command("permissions", "Configure permissions for new Sessions", 13.5, {
		actionType: "config.permissions",
		category: "config",
		policy: IDLE_ONLY_POLICY,
		availableDuringTask: false,
		unavailableDuringTaskMessage: "/permissions is available when the current turn is idle.",
	}),
    command("recovery", "Inspect or resolve crash recovery", 14, {
      actionType: "recovery.open",
      category: "recovery",
      policy: READONLY_POLICY,
      supportsInlineArgs: true,
      usage: "[status|assess|verify <attemptId>|resume <reason>]",
      argumentSchema: [schema("action", "status|assess|verify <attemptId>|resume <reason>", false)],
    }),
    command("processes", "List managed processes", 14, { actionType: "process.list", category: "process", policy: READONLY_POLICY }),
    command("terminal", "Open managed terminal", 15, {
      actionType: "process.terminal",
      category: "process",
      policy: READONLY_POLICY,
      supportsInlineArgs: true,
      usage: "<executionId>",
      argumentSchema: [schema("executionId", "Managed process execution id", true)],
    }),
	    command("quit", "Exit safely", 16, { actionType: "ui.quit", category: "ui", aliases: ["exit"] }),
	    command("mcp", "List connected MCP servers", 17, { actionType: "extension.mcp", category: "extensions", policy: READONLY_POLICY, requiredOperation: "mcp.list", unavailableHint: "Use /new standard to work with extensions." }),
	    command("plugins", "List discovered plugins", 18, { actionType: "extension.plugins", category: "extensions", policy: READONLY_POLICY, requiredOperation: "extension.inspect", unavailableHint: "Use /new standard to work with extensions." }),
	    command("skills", "List discovered skills", 19, { aliases: ["skill"], actionType: "extension.skills", category: "extensions", policy: READONLY_POLICY, requiredOperation: "extension.inspect", unavailableHint: "Use /new standard to work with extensions." }),
	    command("hooks", "List configured hooks", 21, { actionType: "extension.hooks", category: "extensions", policy: READONLY_POLICY, requiredOperation: "extension.inspect", unavailableHint: "Use /new standard to work with extensions." }),
	    command("plan", "Inspect or review the current plan", 22, {
      actionType: "plan.inspect",
      category: "plan",
      policy: READONLY_POLICY,
      requiredOperation: "plan.inspect",
      availableDuringTask: false,
      unavailableDuringTaskMessage: "/plan is available when the current turn is idle.",
    }),
	    command("compact", "List compaction checkpoints", 23, {
      actionType: "compaction.list",
      category: "domain",
      policy: READONLY_POLICY,
      requiredOperation: "compaction.list",
      unavailableHint: "Start a new session with /new, then include a short summary.",
      availableDuringTask: false,
      unavailableDuringTaskMessage: "/compact is available when the current turn is idle.",
    }),
	    command("memory", "Inspect memory store", 24, {
      actionType: "memory.inspect",
      category: "domain",
      policy: READONLY_POLICY,
      requiredOperation: "memory.inspect",
      unavailableHint: "Use a normal message for context, or /resume to open a saved conversation.",
      availableDuringTask: false,
      unavailableDuringTaskMessage: "/memory is available when the current turn is idle.",
    }),
	    command("remember", "Propose a memory record", 25, {
      actionType: "memory.propose",
      category: "domain",
      policy: IDLE_ONLY_POLICY,
      requiredOperation: "memory.propose",
      unavailableHint: "Use a normal message for context, or /resume to open a saved conversation.",
      availableDuringTask: false,
      unavailableDuringTaskMessage: "/remember is available when the current turn is idle.",
      supportsInlineArgs: true,
      usage: "<text>",
      argumentSchema: [schema("text", "Memory content to propose", true)],
    }),
	    command("prompt", "Pick prompt template", 26, { actionType: "prompt.select", category: "prompts", policy: READONLY_POLICY }),
    command("trajectory", "Inspect running session trajectory", 27, {
      actionType: "ui.trajectory", category: "ui", policy: READONLY_POLICY,
      supportsInlineArgs: true, usage: "[close|status]", requiredOperation: "trajectory.page",
    }),
	    command("scrollbar", "Toggle the conversation scrollbar", 27, {
      actionType: "ui.scrollbar.toggle",
      category: "ui",
      policy: READONLY_POLICY,
    }),
    command("dump", "Export request or system content: /dump [request|system|assembled|base]", 28, {
      supportsInlineArgs: true,
      actionType: "ui.dump",
      category: "ui",
      policy: READONLY_POLICY,
      // 只读投影：turn 进行中读到的就是本次请求实际使用的提示词,不设 idle 门控。
      requiredOperation: "session.request.inspect",
      unavailableHint: "This runtime does not expose request snapshots.",
    }),
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
  const projectAvailability = (entry: RegisteredSlashCommand): RegisteredSlashCommand => context.supportsOperation === undefined || isCommandAvailable(entry, context.supportsOperation)
    ? entry
    : { ...entry, description: `${entry.description} · Unavailable in this session` };
  const builtins = builtinCommandDescriptors().filter((entry) => isCommandVisibleForContext(entry, context)).map(projectAvailability);
  const dynamic = (context.dynamicCommands ?? []).filter((entry) => isCommandVisibleForContext(entry, context)).map(projectAvailability);
  if (dynamic.length === 0) return builtins;
  const modelIndex = builtins.findIndex((entry) => entry.canonicalName === "model");
  const insertionIndex = modelIndex === -1 ? builtins.length : modelIndex + 1;
  return [...builtins.slice(0, insertionIndex), ...dynamic, ...builtins.slice(insertionIndex)];
}

/** 静态描述不能授予能力；菜单与派发均使用同一精确 operation 判断。 */
export function isCommandAvailable(command: RegisteredSlashCommand, supportsOperation: (operation: string) => boolean): boolean {
  return command.requiredOperation === undefined || supportsOperation(command.requiredOperation);
}

/** typed 错误保留可检索标识，正文说明当前 Session 的限制与替代操作。 */
export function unavailableCommandMessage(commandName: string): string {
  const command = findCommand(commandName.replace(/^\//u, ""));
  return `${commandName} is unavailable in this session (operation_unavailable).${command?.unavailableHint ? ` ${command.unavailableHint}` : ""}`;
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
