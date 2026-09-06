/** 用户级界面配色合同；纯数据，不依赖 TUI 或文件系统。 */
export const UI_COLOR_KEYS = [
  "primary", "secondary", "accent", "muted", "success", "warning", "error", "info",
  "background", "surface", "surfaceAlt", "border", "editorBackground",
  "userMessage", "assistantMessage", "thinkingText", "toolCall", "toolResult", "toolError", "status", "hint", "link",
] as const;
export type UiColorKey = typeof UI_COLOR_KEYS[number];
export type UiColors = Partial<Record<UiColorKey, string>>;
export interface UiThemeSettings {
  readonly preset?: "default" | "neutral" | "high-contrast";
  readonly mode?: "auto" | "dark" | "light";
  readonly colors?: { readonly common?: UiColors; readonly dark?: UiColors; readonly light?: UiColors };
}
export function isUiColor(value: unknown): value is string {
  return typeof value === "string" && /^#[0-9a-fA-F]{6}$/u.test(value);
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function parseUiThemeSettings(raw: unknown): { value?: UiThemeSettings; diagnostics: string[] } {
  const diagnostics: string[] = [];
  if (raw === undefined) return { diagnostics };
  if (!record(raw)) return { diagnostics: ["uiTheme"] };
  const value: { preset?: UiThemeSettings["preset"]; mode?: UiThemeSettings["mode"]; colors?: { common?: UiColors; dark?: UiColors; light?: UiColors } } = {};
  if (raw.preset === "default" || raw.preset === "neutral" || raw.preset === "high-contrast") value.preset = raw.preset;
  else if (raw.preset !== undefined) diagnostics.push("uiTheme.preset");
  if (raw.mode === "auto" || raw.mode === "dark" || raw.mode === "light") value.mode = raw.mode;
  else if (raw.mode !== undefined) diagnostics.push("uiTheme.mode");
  if (raw.colors !== undefined) {
    if (!record(raw.colors)) diagnostics.push("uiTheme.colors");
    else {
      value.colors = {};
      for (const mode of ["common", "dark", "light"] as const) {
        const input = raw.colors[mode];
        if (input === undefined) continue;
        if (!record(input)) { diagnostics.push(`uiTheme.colors.${mode}`); continue; }
        const colors: UiColors = {};
        for (const key of UI_COLOR_KEYS) {
          if (input[key] === undefined) continue;
          if (isUiColor(input[key])) colors[key] = input[key].toLowerCase();
          else diagnostics.push(`uiTheme.colors.${mode}.${key}`);
        }
        // 未知键不回显，避免配置中的控制字符进入终端。
        if (Object.keys(input).some(key => !UI_COLOR_KEYS.some(known => known === key))) diagnostics.push(`uiTheme.colors.${mode}.unknown_key`);
        value.colors[mode] = colors;
      }
      if (Object.keys(raw.colors).some(key => !["common", "dark", "light"].includes(key))) diagnostics.push("uiTheme.colors.unknown_key");
    }
  }
  if (Object.keys(raw).some(key => !["preset", "mode", "colors"].includes(key))) diagnostics.push("uiTheme.unknown_key");
  return { value, diagnostics };
}
