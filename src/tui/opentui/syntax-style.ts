import { loadTheme } from "../theme/theme.ts";
import { SyntaxStyle } from "@opentui/core";

/** Markdown、Code 与未来真实 unified Diff 共用的稳定 OpenTUI 样式表。 */
export function createRunLedgerSyntaxStyle(mode: "dark" | "light" = "dark"): SyntaxStyle {
  const theme = loadTheme(mode);
  return SyntaxStyle.fromStyles({
    default: { fg: theme.primary },
    "markup.heading": { fg: "#7aa2f7", bold: true },
    "markup.bold": { bold: true },
    "markup.italic": { italic: true },
    "markup.link": { fg: theme.accent, underline: true },
    "markup.link.label": { fg: theme.accent, underline: true },
    "markup.link.url": { fg: theme.accent, underline: true },
    "markup.raw": { fg: theme.accent },
    comment: { fg: "#565f89", italic: true },
    string: { fg: "#9ece6a" },
    keyword: { fg: "#bb9af7", bold: true },
  });
}
