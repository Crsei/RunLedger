/**
 * StatusComponent 单测:隐藏内部 turn / stopReason,只渲染用户可用状态。
 *
 * 对照 src/tui/components/status.ts 与 development-doc/tui/02-component-spec.md §2。
 */

import { describe, it, expect } from "vitest";
import { StatusComponent } from "../../src/tui/components/status.ts";

describe("StatusComponent", () => {
  it("空状态不占用 Footer 行", () => {
    const comp = new StatusComponent({});
    expect(comp.render(20)).toEqual([]);
  });
	it("不再暴露 turn、stop、token 或 queue 参数 setter", () => {
		const comp = new StatusComponent({});
		for (const method of ["setTurn", "setStopReason", "setTokens", "setQueueCounts"]) {
			expect(method in comp).toBe(false);
		}
	});
	it("renders and clears a transient idle recap without exposing turn fields", () => {
		const comp = new StatusComponent({});
		comp.setIdleRecap("ship the next action");
    expect(comp.render(80)[0]).toContain("※ recap: ship the next action");
    comp.setIdleRecap(undefined);
    expect(comp.render(80)).toEqual([]);
  });
});
