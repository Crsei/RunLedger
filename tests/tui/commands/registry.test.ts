import { describe, expect, it } from "vitest";
import {
  builtinCommandDescriptors,
  commandsForContext,
  findCommand,
  isCommandVisibleForContext,
  popupCommandsForFilter,
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

  it("commandsForContext 把动态命令稳定插入 /model 之后", () => {
    const model = builtinCommandDescriptors().find((entry) => entry.canonicalName === "model")!;
    const serviceTier = { ...model, canonicalName: "service-tier", description: "Switch service tier", aliases: [] };
    const context = { dynamicCommands: [serviceTier] } as Parameters<typeof commandsForContext>[0] & {
      readonly dynamicCommands: readonly [typeof serviceTier];
    };
    const names = commandsForContext(context).map((entry) => entry.canonicalName);
    expect(names.slice(names.indexOf("model"), names.indexOf("model") + 3)).toEqual(["model", "service-tier", "thinking"]);
  });

  it("内联参数/任务门控位符合既有行为(对照 codex available_during_task)", () => {
    const byName = new Map(builtinCommandDescriptors().map((entry) => [entry.canonicalName, entry]));
    // 配置类命令任务运行中被拒
    for (const name of ["provider", "login", "logout", "model", "thinking", "plan", "compact", "memory", "remember"]) {
      expect(byName.get(name)?.availableDuringTask).toBe(false);
    }
    // 支持内联参数的命令
    for (const name of ["resume", "login", "logout", "recovery", "terminal", "remember"]) {
      expect(byName.get(name)?.supportsInlineArgs).toBe(true);
    }
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
