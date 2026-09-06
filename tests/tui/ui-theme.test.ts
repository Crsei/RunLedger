import { rowToBlocks } from "../../src/tui/timeline/selectors.ts";
import { describe, expect, it } from "vitest";
import { parseUiThemeSettings } from "../../src/contracts/ui-theme.ts";
import { resolveUiTheme } from "../../src/tui/theme/ui-theme.ts";
import { TranscriptOverlayComponent } from "../../src/tui/transcript-view.ts";

describe("UI theme configuration", () => {
  it("resolves presets, mode overrides and environment without changing the input", () => {
    const settings = parseUiThemeSettings({ preset: "neutral", mode: "auto", colors: { common: { thinkingText: "#AABBCC" }, light: { thinkingText: "#123456" } } }).value;
    expect(resolveUiTheme(settings, "dark", {}).colors.thinkingText).toBe("#aabbcc");
    expect(resolveUiTheme(settings, "light", {}).colors.thinkingText).toBe("#123456");
    expect(resolveUiTheme(settings, "light", { RUNLEDGER_THEME_THINKINGTEXT: "#abcdef" }).colors.thinkingText).toBe("#abcdef");
    expect(settings?.colors?.common?.thinkingText).toBe("#aabbcc");
    expect(resolveUiTheme({ mode: "dark" }, "light", {}).mode).toBe("dark");
    for (const preset of ["default", "neutral", "high-contrast"] as const) {
      for (const mode of ["dark", "light"] as const) {
        const theme = resolveUiTheme({ preset }, mode, {});
        expect(Object.isFrozen(theme.colors)).toBe(true);
        expect(theme.colors.thinkingText).not.toBe(theme.colors.assistantMessage);
        expect(Object.values(theme.colors).every(color => /^#[0-9a-f]{6}$/u.test(color))).toBe(true);
      }
    }
  });
  it("rejects malformed colors and never echoes untrusted keys", () => {
    const parsed = parseUiThemeSettings({ preset: "bogus", colors: { dark: { thinkingText: "\x1b[31m", accent: "#ABCDEF", "\x1b[2J": "bad" } } });
    expect(parsed.value?.colors?.dark).toEqual({ accent: "#abcdef" });
    expect(parsed.diagnostics.join()).not.toContain("\x1b");
    expect(parsed.diagnostics).toContain("uiTheme.colors.dark.thinkingText");
    const resolved = resolveUiTheme(parsed.value, "dark", { RUNLEDGER_THEME_PRIMARY: "red" });
    expect(resolved.colors.primary).toBe("#e6e6e6");
    expect(resolved.diagnostics).toEqual(["RUNLEDGER_THEME_PRIMARY"]);
  });
  it("records explicit backgrounds independently of their values", () => {
    const theme = resolveUiTheme({ colors: { dark: { background: "#0b0e14", editorBackground: "#282a30" } } }, "dark", {});
    expect(theme.backgroundExplicit).toBe(true);
    expect(theme.editorBackgroundExplicit).toBe(true);
  });
  it("retains thinking semantics when hiding and rebuilding presentation", () => {
    const row = { id: "assistant", kind: "assistant" as const, timestamp: "2026-09-06T00:00:00Z", displayOrder: 0, status: "succeeded" as const, streaming: false, text: { text: "answer", truncated: false, byteLength: 6 }, thinking: { text: "thought", truncated: false, byteLength: 7 } };
    expect(rowToBlocks(row)[0]).toMatchObject({ variant: "thinking", content: "thought" });
    expect(rowToBlocks(row, { hideThinking: true })).toHaveLength(1);
    expect(rowToBlocks(row)[0]).toMatchObject({ variant: "thinking", content: "thought" });
    expect(row.thinking.text).toBe("thought");
  });
  it("preserves thinking color across wrapped transcript lines", () => {
    const theme = resolveUiTheme({}, "dark", {}).colors;
    const view = new TranscriptOverlayComponent({ rows: [{ kind: "markdown", content: "thinking words wrap here", variant: "thinking", streaming: false }], timelineGeneration: 1, committedRevision: "1", activeRevision: "1" }, { theme, getViewportHeight: () => 20 });
    expect(view.render(14).slice(1, -1).every(line => line.includes("38;2;119;125;136"))).toBe(true);
  });
});
