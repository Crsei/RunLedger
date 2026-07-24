import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { ActiveState } from "../../src/tui/components/active-state.ts";
import { ContextHeader } from "../../src/tui/components/context-header.ts";

describe("visible TUI structure slices", () => {
  it.each([60, 80, 143])("shows exact context and active state within %d columns", (width) => {
    const header = new ContextHeader({
      workspace: "/workspace/项目",
      sessionId: "session-1234567890",
      format: "v3",
      lifecycle: "active",
    });
    const active = new ActiveState({
      query: "running",
      activeTurn: 3,
      steeringCount: 1,
      followUpCount: 2,
      frozen: true,
      recoveryRequired: true,
    });
    const lines = [...header.render(width), ...active.render(width)];
    expect(lines.join("\n")).toContain("v3/active");
    expect(lines.join("\n")).toContain("query:running");
    expect(lines.join("\n")).toContain("recovery-required");
    expect(lines.every((line) => line.length <= width * 2)).toBe(true);
  });

  it("keeps the TUI dependency checker executable as a contract", () => {
    const result = spawnSync(
      process.execPath,
      ["--experimental-strip-types", "scripts/check-tui-boundaries.ts"],
      { cwd: process.cwd(), encoding: "utf8" },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("TUI boundary check passed");
  });
});
