import { describe, expect, it } from "vitest";
import stripAnsi from "strip-ansi";
import { SlashCommandPopup, slashPopupFilterToken } from "../../src/tui/components/slash-command-popup.ts";
import { builtinCommandDescriptors } from "../../src/tui/commands/registry.ts";
import { makeSelectListTheme } from "../../src/tui/theme/factories.ts";
import { loadTheme } from "../../src/tui/theme/theme.ts";

const commands = builtinCommandDescriptors();
const theme = makeSelectListTheme(loadTheme("dark"));
const names = (popup: SlashCommandPopup): string[] => popup.getVisibleRows().map((row) => row.command.canonicalName);
const visible = (popup: SlashCommandPopup, width = 80): string[] => popup.render(width);

describe("slashPopupFilterToken", () => {
  it("提取 `/` 后首个 token;空/仅斜杠 → 空过滤", () => {
    expect(slashPopupFilterToken("/model")).toBe("model");
    expect(slashPopupFilterToken("/")).toBe("");
    expect(slashPopupFilterToken("")).toBe("");
    expect(slashPopupFilterToken("/re view the diff")).toBe("re");
  });
});

describe("SlashCommandPopup 过滤", () => {
  it("空过滤 → 全量列表且不隐藏别名命令", () => {
    const popup = new SlashCommandPopup({ commands, theme });
    expect(names(popup)).toEqual(commands.map((entry) => entry.canonicalName));
    expect(visible(popup)[0]).toContain("/help");
  });

  it("空过滤隐藏 hiddenInFullList 别名命令(对照 codex ALIAS_COMMANDS)", () => {
    const flagged = commands.map((entry) => entry.canonicalName === "quit" ? { ...entry, hiddenInFullList: true as const } : entry);
    const popup = new SlashCommandPopup({ commands: flagged, theme });
    expect(names(popup)).not.toContain("quit");
    popup.setFilter("/q");
    expect(names(popup)).toEqual(["quit"]);
  });

  it("非空过滤:exact 匹配在前,prefix 匹配在后,保持注册表顺序", () => {
    const popup = new SlashCommandPopup({ commands, theme });
    popup.setFilter("/mo");
    expect(names(popup)).toEqual(["model"]);
    popup.setFilter("/m");
    expect(names(popup)).toEqual(["model", "mcp", "memory"]);
    popup.setFilter("/s");
		expect(popup.getVisibleRows().map((row) => row.name)).toEqual(["sessions", "shape", "setup", "skills", "skillsproviders", "scrollbar"]);
		expect(names(popup)).toEqual(["resume", "shape", "setup", "skills", "skillsproviders", "scrollbar"]);
    popup.setFilter("/c");
    expect(popup.getVisibleRows().map((row) => row.name)).toEqual(["commands", "clear", "compact"]);
  });

  it("非空过滤会展示并补全真实别名,空列表仍只展示 canonical 命令", () => {
    const popup = new SlashCommandPopup({ commands, theme });
    expect(popup.getVisibleRows().some((row) => row.name === "commands")).toBe(false);
    expect(popup.getVisibleRows().some((row) => row.name === "exit")).toBe(false);

    popup.setFilter("/co");
    expect(popup.getVisibleRows().map((row) => row.name)).toEqual(["commands", "compact"]);
    expect(popup.selectedItem()?.canonicalName).toBe("help");
    expect(popup.selectedName()).toBe("commands");

    popup.setFilter("/exit");
    expect(popup.getVisibleRows().map((row) => row.name)).toEqual(["exit"]);
    expect(popup.selectedItem()?.canonicalName).toBe("quit");
  });

  it("exact 匹配选中精确项(对照 codex filter_includes_init_when_typing_prefix)", () => {
    const popup = new SlashCommandPopup({ commands, theme });
    popup.setFilter("/model");
    expect(names(popup)).toEqual(["model"]);
    expect(popup.selectedItem()?.canonicalName).toBe("model");
  });

  it("过滤串变化重置选中,过滤后选择 clamp 到列表内", () => {
    const popup = new SlashCommandPopup({ commands, theme });
    popup.moveDown();
    popup.moveDown();
    expect(popup.getSelectedIndex()).toBe(2);
    popup.setFilter("/c");
    expect(popup.getSelectedIndex()).toBe(0);
    popup.moveDown();
    expect(popup.getSelectedIndex()).toBe(1);
    popup.setFilter("/zebra");
    expect(names(popup)).toEqual([]);
    expect(popup.getSelectedIndex()).toBe(0);
  });

  it("无匹配渲染 no matches(对照 codex 文案)", () => {
    const popup = new SlashCommandPopup({ commands, theme });
    popup.setFilter("/zzz");
    expect(stripAnsi(visible(popup).join("\n"))).toContain("no matches");
  });
});

describe("SlashCommandPopup 高亮与选中", () => {
  it("matchIndices 相对命令名,渲染 +1 偏移跳过 `/`", () => {
    const popup = new SlashCommandPopup({ commands, theme });
    popup.setFilter("/mo");
    const row = popup.getVisibleRows()[0]!;
    expect(row.matchIndices).toEqual([0, 1]);
    const line = visible(popup)[0]!;
    // 高亮段含 ANSI 包装(theme.matchHighlight),命中 "mo" 部分有换码
    expect(line).toMatch(/\u001b\[/u);
    expect(stripAnsi(line)).toContain("/model");
  });

  it("moveUp/moveDown wrap 循环", () => {
    const popup = new SlashCommandPopup({ commands, theme });
    expect(popup.selectedItem()?.canonicalName).toBe("help");
    popup.moveUp();
    expect(popup.selectedItem()?.canonicalName).toBe(commands.at(-1)!.canonicalName);
    popup.moveDown();
    expect(popup.selectedItem()?.canonicalName).toBe("help");
  });

  it("渲染行含滚动信息与选中前缀,高度受 maxVisible 限制", () => {
    const popup = new SlashCommandPopup({ commands, theme, maxVisible: 5 });
    popup.moveDown();
    popup.moveDown();
    popup.moveDown();
    const lines = visible(popup);
    expect(stripAnsi(lines[lines.length - 1]!)).toContain(`(4/${commands.length})`);
    expect(lines.length).toBeLessThanOrEqual(6);
  });

  it("窄终端下描述折行计入行数,总行数仍受 maxVisible 限制", () => {
    const narrow = new SlashCommandPopup({ commands, theme, maxVisible: 3 });
    const lines = visible(narrow, 12);
    expect(lines.length).toBeLessThanOrEqual(4);
    for (const line of lines) {
      expect(stripAnsi(line).length).toBeLessThanOrEqual(12);
    }
  });

  it("描述在有空间时只渲染一次,不会占用双倍可见行", () => {
    const popup = new SlashCommandPopup({ commands, theme, maxVisible: 4 });
    const text = stripAnsi(visible(popup, 80).join("\n"));
    expect(text.match(/Show help/gu)).toHaveLength(1);
    expect(text.match(/Clear chat/gu)).toHaveLength(1);
    expect(text).toContain("/resume");
    expect(text).not.toContain("/sessions");
    expect(text).toContain("/new");
  });
});
