/**
 * LoadedResourcesComponent 单测:render 输出格式、setResource 0/negative 移除、sessionId 截断。
 *
 * 对照 src/tui/components/loaded-resources.ts 与 development-doc/tui/02-component-spec.md §2。
 */

import { describe, it, expect } from "vitest";
import { LoadedResourcesComponent } from "../../src/tui/components/loaded-resources.ts";

describe("LoadedResourcesComponent", () => {
  it("只有 sessionId 时渲染 ledger:<8 chars>", () => {
    const comp = new LoadedResourcesComponent({ activeLedgerSessionId: "abc123def456" });
    const lines = comp.render(80);
    expect(lines.length).toBe(1);
    expect(lines[0]).toBe("ledger:abc123de");
  });
  it("setResource('tools', 1) 后追加 tools:1", () => {
    const comp = new LoadedResourcesComponent({ activeLedgerSessionId: "xyz12345" });
    comp.setResource("tools", 1);
    const lines = comp.render(80);
    expect(lines[0]).toBe("ledger:xyz12345  tools:1");
  });
  it("setResource 0 / 负数视为移除", () => {
    const comp = new LoadedResourcesComponent({ activeLedgerSessionId: "12345678" });
    comp.setResource("tools", 2);
    comp.setResource("tools", 0);
    expect(comp.render(80)[0]).toBe("ledger:12345678");
    comp.setResource("mcp", 0);
    expect(comp.render(80)[0]).toBe("ledger:12345678");
  });
  it("无 session 时 render 输出空行", () => {
    const comp = new LoadedResourcesComponent({});
    expect(comp.render(40)[0]).toBe("");
  });
  it("setActiveLedgerSessionId 切换", () => {
    const comp = new LoadedResourcesComponent({});
    comp.setActiveLedgerSessionId("newsessionabc");
    // newsessionabc 长度 12 -> slice(0,8) => "newsessi"
    expect(comp.render(80)[0]).toBe("ledger:newsessi");
  });
});
