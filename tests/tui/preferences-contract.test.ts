import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("TUI preference contract boundary", () => {
  it("is passive and keeps filesystem authority outside src/tui", () => {
    const path = join(process.cwd(), "src/tui/preferences/types.ts");
    expect(existsSync(path)).toBe(true);
    if (!existsSync(path)) return;
    const source = readFileSync(path, "utf8");
    expect(source).not.toMatch(/node:|@opentui|Renderable|RunledgerLayout|scrollTop/u);
    expect(source).toContain("TuiPreferencesPort");
  });
});
