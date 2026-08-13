import { describe, expect, it } from "vitest";
import stripAnsi from "strip-ansi";
import { ListSelectionModal, type ListSelectionItem } from "../../src/tui/components/list-selection-modal.ts";
import { makeSelectListTheme } from "../../src/tui/theme/factories.ts";
import { loadTheme } from "../../src/tui/theme/theme.ts";

const theme = makeSelectListTheme(loadTheme("dark"));

function plain(modal: ListSelectionModal, width = 80): string {
  return stripAnsi(modal.render(width).join("\n"));
}

describe("ListSelectionModal(codex /model 展示格式)", () => {
  const items: ListSelectionItem[] = [
    { value: "deepseek", name: "deepseek", description: "2 available models", isCurrent: true },
    { value: "openai", name: "openai", description: "5 available models" },
    { value: "all", name: "All models", description: "Choose a specific model and provider (current: deepseek-v4-pro)" },
  ];

  it("头部 bold 标题 + dim 副标题,行首 › 编号 name 标记,描述按 desc 列对齐,footer hint 收尾", () => {
    const modal = new ListSelectionModal({
      title: "Select Model",
      subtitle: "Pick a quick provider or browse all models.",
      items,
      selectListTheme: theme,
      onSelect: () => undefined,
      onCancel: () => undefined,
    });
    const text = plain(modal);
    const lines = text.split("\n");
    expect(lines[0]).toBe("Select Model");
    expect(lines[1]).toBe("Pick a quick provider or browse all models.");
    // desc 列 = 可见行最大 name 宽(18)+ prefix(5) + 2 = 25,各描述对齐到该列。
    expect(lines[2]).toBe(`› 1. deepseek (current)  2 available models`);
    expect(lines[3]).toBe(`  2. openai${" ".repeat(14)}5 available models`);
    // 描述过长时整行截断到终端宽(对照 codex word_wrap 的截断路径)。
    expect(lines[4]!.startsWith(`  3. All models${" ".repeat(10)}Choose a specific model and provider (current: deepsee`)).toBe(true);
    expect(lines[4]!.endsWith("…")).toBe(true);
    expect(lines[5]).toBe("Press Enter to confirm or Esc to go back");
  });

  it("未选中行无 ›,(current)/(default) 标记只出现一次且 current 优先", () => {
    const modal = new ListSelectionModal({
      title: "Select Model and Provider",
      items: [
        { value: "a", name: "model-a", isDefault: true },
        { value: "b", name: "model-b", isCurrent: true },
      ],
      selectListTheme: theme,
      onSelect: () => undefined,
      onCancel: () => undefined,
    });
    modal.handleInput("down");
    const text = plain(modal);
    expect(text).toContain("  1. model-a (default)");
    expect(text).toContain("› 2. model-b (current)");
  });

  it("Enter 回调选中项,Esc 回调 onCancel,Up/Down 环绕导航", () => {
    const received: ListSelectionItem[] = [];
    let cancelled = 0;
    const modal = new ListSelectionModal({
      title: "Select Model",
      items,
      selectListTheme: theme,
      onSelect: (item) => received.push(item),
      onCancel: () => { cancelled += 1; },
    });
    modal.handleInput("\r");
    expect(received.map((item) => item.value)).toEqual(["deepseek"]);
    modal.handleInput("down");
    modal.handleInput("down");
    modal.handleInput("\r");
    expect(received.map((item) => item.value)).toEqual(["deepseek", "all"]);
    modal.handleInput("\x1b");
    expect(cancelled).toBe(1);
  });

  it("PageUp/PageDown 跨页移动,Ctrl+C 等价 Esc", () => {
    const many: ListSelectionItem[] = Array.from({ length: 25 }, (_, i) => ({ value: `m${i}`, name: `model-${i}` }));
    let cancelled = 0;
    const modal = new ListSelectionModal({
      title: "Select Model",
      items: many,
      selectListTheme: theme,
      onSelect: () => undefined,
      onCancel: () => { cancelled += 1; },
    });
    modal.handleInput("pageDown");
    const after = plain(modal);
    expect(after).toContain("› 9. model-8");
    modal.handleInput("pageUp");
    modal.handleInput("pageUp");
    modal.handleInput("\u0003");
    expect(cancelled).toBe(1);
    const top = plain(modal);
    expect(top).toContain("› 1. model-0");
  });

  it("超长 name 截断保留 desc 列间隙,描述列上限 70% 宽", () => {
    const longName = "accounts/fireworks/models/deepseek-v4-pro-with-a-very-long-name";
    const modal = new ListSelectionModal({
      title: "Select Model",
      items: [{ value: "f", name: longName, description: "Long description text here" }],
      selectListTheme: theme,
      onSelect: () => undefined,
      onCancel: () => undefined,
    });
    const lines = plain(modal, 40).split("\n");
    for (const line of lines) {
      expect(stripAnsi(line).length).toBeLessThanOrEqual(40);
    }
    const row = lines[1]!;
    expect(row).toContain("…");
  });

  it("空列表显示 noMatch 占位,窄终端不溢出", () => {
    const modal = new ListSelectionModal({
      title: "Select Model",
      items: [],
      selectListTheme: theme,
      onSelect: () => undefined,
      onCancel: () => undefined,
    });
    const text = plain(modal, 20);
    expect(text).toContain("No matching items");
    for (const line of text.split("\n")) {
      expect(line.length).toBeLessThanOrEqual(20);
    }
  });

	it("starts on the current value and reports cursor changes for live preview", () => {
		const previews: string[] = [];
		const modal = new ListSelectionModal({
			title: "Select Syntax Theme",
			items,
			initialSelectedValue: "openai",
			onSelectionChange: (item) => previews.push(item.value),
			selectListTheme: theme,
			onSelect: () => undefined,
			onCancel: () => undefined,
		});
		expect(plain(modal)).toContain("› 2. openai");
		modal.handleInput("down");
		expect(previews).toEqual(["all"]);
	});

	it("shows disabled load errors but skips them during preview and confirmation", () => {
		const previews: string[] = [];
		const selected: string[] = [];
		const modal = new ListSelectionModal({
			title: "Select Syntax Theme",
			items: [
				{ value: "ansi", name: "ansi", description: "built-in" },
				{ value: "broken", name: "broken", description: "load error", disabled: true },
				{ value: "custom", name: "custom", description: "custom" },
			],
			selectListTheme: theme,
			onSelectionChange: (item) => previews.push(item.value),
			onSelect: (item) => selected.push(item.value),
			onCancel: () => undefined,
		});
		expect(plain(modal)).toContain("broken");
		expect(plain(modal)).toContain("load error");
		modal.handleInput("down");
		expect(previews).toEqual(["custom"]);
		modal.handleInput("enter");
		expect(selected).toEqual(["custom"]);
	});
});
