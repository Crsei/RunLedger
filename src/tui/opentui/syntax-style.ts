import { SyntaxStyle } from "@opentui/core";

/** Markdown、Code 与未来真实 unified Diff 共用的稳定 OpenTUI 样式表。 */
export function createRunLedgerSyntaxStyle(): SyntaxStyle {
  return SyntaxStyle.fromStyles({
    default: { fg: "#d4d4d4" },
    "markup.heading": { fg: "#7aa2f7", bold: true },
    "markup.bold": { bold: true },
    "markup.italic": { italic: true },
    "markup.link": { fg: "#7dcfff", underline: true },
    "markup.raw": { fg: "#e0af68" },
    comment: { fg: "#565f89", italic: true },
    string: { fg: "#9ece6a" },
    keyword: { fg: "#bb9af7", bold: true },
  });
}
