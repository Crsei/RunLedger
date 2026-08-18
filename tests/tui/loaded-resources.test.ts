/**
 * LoadedResourcesComponent 单测:render 输出格式、setResource 0/negative 移除。
 *
 * 对照 src/tui/components/loaded-resources.ts 与 development-doc/tui/02-component-spec.md §2。
 * 面板不展示 ledger session id 与 tools 计数,只保留 mcp/skills/hooks/slash 资源类计数。
 */

import { describe, it, expect } from "vitest";
import { LoadedResourcesComponent } from "../../src/tui/components/loaded-resources.ts";

describe("LoadedResourcesComponent", () => {
  it("无资源时 render 输出空行", () => {
    const comp = new LoadedResourcesComponent({});
    expect(comp.render(40)[0]).toBe("");
  });
  it("setResource('mcp', 2) 后追加 mcp:2", () => {
    const comp = new LoadedResourcesComponent({});
    comp.setResource("mcp", 2);
    const lines = comp.render(80);
    expect(lines.length).toBe(1);
    expect(lines[0]).toBe("mcp:2");
  });
  it("多个资源按 mcp/skills/hooks/slash 顺序渲染", () => {
    const comp = new LoadedResourcesComponent({});
    comp.setResource("slash", 1);
    comp.setResource("mcp", 3);
    comp.setResource("hooks", 0);
    comp.setResource("skills", 2);
    expect(comp.render(80)[0]).toBe("mcp:3  skills:2  slash:1");
  });
  it("setResource 0 / 负数视为移除", () => {
    const comp = new LoadedResourcesComponent({});
    comp.setResource("mcp", 2);
    comp.setResource("mcp", 0);
    expect(comp.render(80)[0]).toBe("");
    comp.setResource("skills", 1);
    comp.setResource("skills", -1);
    expect(comp.render(80)[0]).toBe("");
  });
  it("长内容按宽度截断", () => {
    const comp = new LoadedResourcesComponent({});
    comp.setResource("mcp", 123456);
    expect(comp.render(8)[0].length).toBeLessThanOrEqual(8);
  });
});
