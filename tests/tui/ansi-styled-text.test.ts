import { describe, expect, it } from "vitest";
import { TextAttributes } from "@opentui/core";
import { ansiToStyledText } from "../../src/tui/opentui/ansi-styled-text.ts";

describe("ANSI 到 OpenTUI StyledText 边界", () => {
  it("保留 256 色和粗体，并丢弃 OSC/未知控制序列", () => {
    const styled = ansiToStyledText(
      "\x1b[38;5;196m红\x1b[1m粗\x1b[22m\x1b[0m plain\x1b]133;C\x07\x1b[999m",
    );

    expect(styled.chunks.map((chunk) => chunk.text).join("")).toBe("红粗 plain");
    expect(styled.chunks.some((chunk) => chunk.text.includes("\x1b"))).toBe(false);
    expect(styled.chunks[0]?.fg?.intent).toBe("indexed");
    expect(styled.chunks[1]?.attributes).toBe(TextAttributes.BOLD);
  });
});
