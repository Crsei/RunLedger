import { loadTheme, type Theme } from "../theme/theme.ts";
import { SyntaxStyle } from "@opentui/core";

/** Markdown、Code 与未来真实 unified Diff 共用的稳定 OpenTUI 样式表。 */
export function createRunLedgerSyntaxStyle(mode: "dark" | "light" | Readonly<Theme> = "dark", variant?: "thinking"): SyntaxStyle {
  const theme = typeof mode === "string" ? loadTheme(mode) : mode;
  return SyntaxStyle.fromStyles({
    default: { fg: variant === "thinking" ? theme.thinkingText : theme.assistantMessage },
    "markup.heading": { fg: theme.info, bold: true },
    "markup.bold": { bold: true },
    "markup.italic": { italic: true },
    "markup.link": { fg: theme.link, underline: true },
    "markup.link.label": { fg: theme.link, underline: true },
    "markup.link.url": { fg: theme.link, underline: true },
    "markup.raw": { fg: theme.accent },
    comment: { fg: "#565f89", italic: true },
    string: { fg: "#9ece6a" },
    keyword: { fg: "#bb9af7", bold: true },
  });
}
