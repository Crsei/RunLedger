import { describe, expect, it } from "vitest";
import {
  builtinCommandDescriptors,
  commandsForContext,
  findCommand,
  isCommandVisibleForContext,
  popupCommandsForFilter,
  suggestCommand,
} from "../../../src/tui/commands/registry.ts";

describe("slash command registry", () => {
  it("canonicalName 无重复,顺序即展示顺序(高频在前)", () => {
    const entries = builtinCommandDescriptors();
    const names = entries.map((entry) => entry.canonicalName);
    expect(new Set(names).size).toBe(names.length);
    // 对照 codex:高频命令在前;help/clear 领先于 domain 命令
    expect(names[0]).toBe("help");
    expect(names[1]).toBe("clear");
    expect(names.indexOf("model")).toBeLessThan(names.indexOf("recovery"));
    expect(names.indexOf("recovery")).toBeLessThan(names.indexOf("mcp"));
    expect(names.indexOf("quit")).toBeGreaterThan(names.indexOf("resume"));
  });

  it("findCommand 解析 canonicalName 与别名(help/commands, quit/exit)", () => {
    expect(findCommand("help")?.canonicalName).toBe("help");
    expect(findCommand("commands")?.canonicalName).toBe("help");
    expect(findCommand("HELP")?.canonicalName).toBe("help");
    expect(findCommand("  resume ")?.canonicalName).toBe("resume");
    expect(findCommand("exit")?.canonicalName).toBe("quit");
    expect(findCommand("nosuchcommand")).toBeUndefined();
    expect(findCommand("")).toBeUndefined();
  });

  it("/resume 是唯一 Session 恢复入口,/sessions 仅作为兼容别名", () => {
    const entries = builtinCommandDescriptors();
    expect(entries.filter((entry) => entry.actionType === "session.resume")).toHaveLength(1);
    expect(entries.some((entry) => entry.canonicalName === "sessions")).toBe(false);
    expect(findCommand("sessions")?.canonicalName).toBe("resume");
  });

  it("registers /scrollbar as a local readonly command available during a task", () => {
    const entry = findCommand("scrollbar");
    expect(entry).toMatchObject({
      canonicalName: "scrollbar",
      actionType: "ui.scrollbar.toggle",
      category: "ui",
      availableDuringTask: true,
      supportsInlineArgs: false,
    });
    expect(entry?.policy).toEqual({
      draft: "allowed",
      history: "allowed",
      query: "allowed",
      frozen: "allowed",
    });
    expect(commandsForContext().some((candidate) => candidate.canonicalName === "scrollbar")).toBe(true);
  });

	it("registers /theme as the syntax-theme preview and persistence entrypoint", () => {
		expect(findCommand("theme")).toMatchObject({
			canonicalName: "theme",
			actionType: "config.theme",
			category: "config",
			availableDuringTask: true,
			supportsInlineArgs: false,
		});
	});

	it("registers /hide-thinking as the persistent display-only visibility command", () => {
		expect(findCommand("hide-thinking")).toMatchObject({
			canonicalName: "hide-thinking",
			actionType: "config.hide-thinking",
			category: "config",
			availableDuringTask: false,
			supportsInlineArgs: false,
		});
	});

	it("does not reserve /settings for Permissions on this rollback baseline", () => {
		expect(findCommand("settings")).toBeUndefined();
	});

	it("registers /permissions as the only Permissions entrypoint, with /permission as its alias", () => {
		expect(findCommand("permissions")).toMatchObject({
			canonicalName: "permissions",
			aliases: ["permission"],
			actionType: "config.permissions",
			category: "config",
			availableDuringTask: false,
		});
		expect(findCommand("permission")?.canonicalName).toBe("permissions");
		expect(findCommand("settings")?.actionType).not.toBe("config.permissions");
	});

	it("suggestCommand 只对唯一最近命中给出建议", () => {
		expect(suggestCommand("permissons")).toBe("permissions");
		expect(suggestCommand("recovry")).toBe("recovery");
		// canonical 与 alias 同为最近命中时保持沉默,不猜。
		expect(suggestCommand("permissionz")).toBeUndefined();
		expect(suggestCommand("nonsense-command-name")).toBeUndefined();
		expect(suggestCommand("")).toBeUndefined();
	});

  it("commandsForContext 隐藏 /help,但直接输入与 /commands 别名仍可解析", () => {
    const visible = commandsForContext({});
    expect(visible.some((entry) => entry.canonicalName === "help")).toBe(false);
    expect(commandsForContext({ showDebugCommands: true }).some((entry) => entry.canonicalName === "help")).toBe(false);
    expect(findCommand("help")?.actionType).toBe("ui.help");
    expect(findCommand("commands")?.actionType).toBe("ui.help");
    expect(visible.every((entry) => entry.debug !== true)).toBe(true);
  });

  it("commandsForContext 预留 debug 门控", () => {
    const clear = builtinCommandDescriptors().find((entry) => entry.canonicalName === "clear")!;
    const flagged = { ...clear, debug: true as const };
    expect(isCommandVisibleForContext(flagged, {})).toBe(false);
    expect(isCommandVisibleForContext(flagged, { showDebugCommands: true })).toBe(true);
    // debug* 前缀约定(对照 codex command_popup 过滤)
    const prefixed = { ...clear, canonicalName: "debug-memory" as const };
    expect(isCommandVisibleForContext(prefixed, {})).toBe(false);
    expect(isCommandVisibleForContext(prefixed, { showDebugCommands: true })).toBe(true);
  });

  it("exposes /skill as the skills manager alias and removes provider UI commands", () => {
    expect(findCommand("skill")?.actionType).toBe("extension.skills");
    expect(findCommand("skillsproviders")).toBeUndefined();
    expect(findCommand("skillproviders")).toBeUndefined();
  });

  it("labels unavailable Session commands using the exact negotiated operation", () => {
    const supported = new Set(["extension.inspect", "mcp.list", "plan.inspect"]);
    const context = { showDebugCommands: false, supportsOperation: (operation: string) => supported.has(operation) };
    const entries = commandsForContext(context);
    for (const name of ["compact", "memory", "remember"]) {
      expect(entries.find((entry) => entry.canonicalName === name)?.description).toContain("Unavailable in this session");
    }
    for (const name of ["plugins", "skills", "hooks", "mcp", "plan", "new", "quit"]) {
      expect(entries.find((entry) => entry.canonicalName === name)?.description).toBe(findCommand(name)?.description);
    }
  });

  it("restores the ordinary command description when a later Session supports the operation", () => {
    const unavailableContext = { showDebugCommands: false, supportsOperation: () => false };
    expect(commandsForContext(unavailableContext).find((entry) => entry.canonicalName === "memory")?.description).toContain("Unavailable in this session");
    const availableContext = { showDebugCommands: false, supportsOperation: (operation: string) => operation === "memory.inspect" };
    expect(commandsForContext(availableContext).find((entry) => entry.canonicalName === "memory")?.description).toBe(findCommand("memory")?.description);
  });

  it("commandsForContext 把动态命令稳定插入 /model 之后", () => {
    const model = builtinCommandDescriptors().find((entry) => entry.canonicalName === "model")!;
    const serviceTier = { ...model, canonicalName: "service-tier", description: "Switch service tier", aliases: [] };
    const context = { dynamicCommands: [serviceTier] } as Parameters<typeof commandsForContext>[0] & {
      readonly dynamicCommands: readonly [typeof serviceTier];
    };
    const names = commandsForContext(context).map((entry) => entry.canonicalName);
    expect(names.slice(names.indexOf("model"), names.indexOf("model") + 3)).toEqual(["model", "service-tier", "mode"]);
  });

  it("内联参数/任务门控位符合既有行为(对照 codex available_during_task)", () => {
    const byName = new Map(builtinCommandDescriptors().map((entry) => [entry.canonicalName, entry]));
    // 配置类命令任务运行中被拒
    for (const name of ["provider", "login", "logout", "model", "thinking", "plan", "compact", "memory", "remember"]) {
      expect(byName.get(name)?.availableDuringTask).toBe(false);
    }
    // 支持内联参数的命令
		for (const name of ["new", "resume", "login", "logout", "recovery", "terminal", "remember"]) {
			expect(byName.get(name)?.supportsInlineArgs).toBe(true);
		}
		expect(byName.get("new")?.usage).toBe("[standard|minimal]");
    expect(byName.get("terminal")?.argumentSchema[0]?.required).toBe(true);
  });

  it("popupCommandsForFilter:空过滤隐藏 hiddenInFullList 别名,有过滤全部展示", () => {
    const flagged = builtinCommandDescriptors().map((entry) =>
      entry.canonicalName === "quit" ? { ...entry, hiddenInFullList: true as const } : entry,
    );
    const full = popupCommandsForFilter(flagged, false);
    expect(full.find((entry) => entry.canonicalName === "quit")).toBeUndefined();
    const filtered = popupCommandsForFilter(flagged, true);
    expect(filtered.find((entry) => entry.canonicalName === "quit")).toBeDefined();
  });

  it("CommandDescriptor 基础字段完整(argumentSchema/policy/order 非占位)", () => {
    for (const entry of builtinCommandDescriptors()) {
      expect(entry.order).toBeGreaterThan(0);
      expect(Array.isArray(entry.argumentSchema)).toBe(true);
      expect(entry.policy.draft).toMatch(/allowed|disabled/u);
    }
  });

  it("每条注册命令都携带显式派发 actionType,不再靠 canonicalName 隐式配对", () => {
    for (const entry of builtinCommandDescriptors()) {
      const actionType = (entry as unknown as { readonly actionType?: string }).actionType;
      expect(actionType, entry.canonicalName).toMatch(/^[a-z]+(?:[.-][a-z]+)+$/u);
    }
  });
});
