import { describe, expect, it } from "vitest";
import stripAnsi from "strip-ansi";
import { SelectionView, type SelectionItem } from "../../src/tui/components/selection-view.ts";
import { makeSelectListTheme } from "../../src/tui/theme/factories.ts";
import { loadTheme } from "../../src/tui/theme/theme.ts";

const theme = makeSelectListTheme(loadTheme("dark"));

const archiveItems: SelectionItem[] = [
  { name: "Yes archive and exit", description: "Archive this session, then quit", dismissOnSelect: true, action: () => { hits.push("archive"); } },
  { name: "Cancel", description: "Keep this session open" },
];
const hits: string[] = [];

describe("SelectionView", () => {
  it("渲染标题/副标题/列表/footer 提示,Enter 触发 action,Esc 触发 onCancel", () => {
    let cancelled = 0;
    const view = new SelectionView({
      title: "/archive",
      subtitle: "Archive session s-123 and exit?",
      footerHint: "enter: confirm · esc: cancel",
      items: archiveItems,
      selectListTheme: theme,
      onCancel: () => { cancelled += 1; },
    });
    const lines = view.render(80);
    const text = stripAnsi(lines.join("\n"));
    expect(text).toContain("/archive");
    expect(text).toContain("Archive session s-123 and exit?");
    expect(text).toContain("Yes archive and exit");
    expect(text).toContain("enter: confirm · esc: cancel");

    view.handleInput("\r");
    expect(hits).toEqual(["archive"]);
    view.handleInput("\x1b");
    expect(cancelled).toBe(1);
  });

  it("无 action 的 item 走 onSelect 回调,dismissOnSelect 位透传", () => {
    const received: SelectionItem[] = [];
    const view = new SelectionView({
      title: "pick",
      items: [{ name: "alpha", dismissOnSelect: true }, { name: "beta" }],
      selectListTheme: theme,
      onSelect: (item) => received.push(item),
    });
    view.handleInput("down");
    view.handleInput("\r");
    expect(received).toEqual([{ name: "beta" }]);
  });

  it("dismissOnSelect 在 action 前关闭视图,未标记的选项保持打开", () => {
    const events: string[] = [];
    const props = {
      title: "confirm",
      items: [
        { name: "apply", dismissOnSelect: true, action: () => events.push("action") },
        { name: "stay", action: () => events.push("stay") },
      ],
      selectListTheme: theme,
      onDismiss: () => events.push("dismiss"),
    } as const;
    const view = new SelectionView(props as unknown as ConstructorParameters<typeof SelectionView>[0]);

    view.handleInput("\r");
    expect(events).toEqual(["dismiss", "action"]);

    events.length = 0;
    view.handleInput("down");
    view.handleInput("\r");
    expect(events).toEqual(["stay"]);
  });

  it("窄终端下逐行截断不溢出,高度不超 maxVisible", () => {
    const view = new SelectionView({
      title: "a fairly long title that will overflow a narrow terminal",
      subtitle: "a fairly long subtitle that will overflow a narrow terminal",
      footerHint: "a fairly long footer hint that will overflow a narrow terminal",
      items: archiveItems,
      selectListTheme: theme,
      maxVisible: 2,
    });
    const lines = view.render(20);
    expect(lines.length).toBeLessThanOrEqual(6);
    for (const line of lines) {
      expect(stripAnsi(line).length).toBeLessThanOrEqual(20);
    }
  });
});
