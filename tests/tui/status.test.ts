/**
 * StatusComponent 单测:turn / stopReason / tokenUsage 渲染组合。
 *
 * 对照 src/tui/components/status.ts 与 development-doc/tui/02-component-spec.md §2。
 */

import { describe, it, expect } from "vitest";
import { StatusComponent } from "../../src/tui/components/status.ts";

describe("StatusComponent", () => {
  it("空状态 render 输出空白行(填充到 width)", () => {
    const comp = new StatusComponent({});
    const lines = comp.render(20);
    expect(lines.length).toBe(1);
    expect(lines[0]?.length).toBe(20);
  });
  it("setTurn 后渲染 turn:n", () => {
    const comp = new StatusComponent({});
    comp.setTurn(2);
    expect(comp.render(40)[0]).toContain("turn:2");
  });
  it("setStopReason 后渲染 stop:<reason>", () => {
    const comp = new StatusComponent({});
    comp.setStopReason("toolUse");
    expect(comp.render(40)[0]).toContain("stop:toolUse");
  });
  it("setTokens 后渲染 tok:<in>/<out>", () => {
    const comp = new StatusComponent({});
    comp.setTokens(100, 200);
    expect(comp.render(40)[0]).toContain("tok:100/200");
  });
  it("三者组合用双空格分隔", () => {
    const comp = new StatusComponent({});
    comp.setTurn(1);
    comp.setStopReason("stop");
    comp.setTokens(50, 60);
    const line = comp.render(80)[0];
    expect(line).toContain("turn:1  stop:stop  tok:50/60");
  });
  it("长串截断到 width", () => {
    const comp = new StatusComponent({});
    comp.setTurn(1);
    comp.setStopReason("stop");
    comp.setTokens(50, 60);
    const line = comp.render(8)[0] ?? "";
    expect(line.endsWith("…")).toBe(true);
  });
});
