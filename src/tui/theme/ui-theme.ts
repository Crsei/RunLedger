import { UI_COLOR_KEYS, isUiColor, type UiThemeSettings } from "../../contracts/ui-theme.ts";
import { loadTheme, type Theme, type ThemeName } from "./theme.ts";
import { computeEditorBackground, parseHexColor, rgbToHex } from "./editor-background.ts";

export interface UiThemeSnapshot {
  readonly colors: Readonly<Theme>;
  readonly mode: ThemeName;
  readonly revision: string;
  readonly backgroundExplicit: boolean;
  readonly editorBackgroundExplicit: boolean;
  readonly diagnostics: readonly string[];
}
const NEUTRAL: Record<ThemeName, Partial<Theme>> = {
  dark: { primary: "#e5e5e5", assistantMessage: "#e5e5e5", userMessage: "#e5e5e5", thinkingText: "#909090", secondary: "#aaaaaa", muted: "#808080", hint: "#808080", accent: "#b0c4de", background: "#141414", surface: "#1c1c1c", surfaceAlt: "#262626", border: "#404040" },
  light: { primary: "#202020", assistantMessage: "#202020", userMessage: "#202020", thinkingText: "#666666", secondary: "#505050", muted: "#707070", hint: "#707070", accent: "#365f87", background: "#fafafa", surface: "#f0f0f0", surfaceAlt: "#e5e5e5", border: "#bbbbbb" },
};
const CONTRAST: Record<ThemeName, Partial<Theme>> = {
  dark: { primary: "#ffffff", assistantMessage: "#ffffff", userMessage: "#ffffff", thinkingText: "#b0b0b0", secondary: "#cccccc", muted: "#aaaaaa", hint: "#aaaaaa", accent: "#80dfff", background: "#000000", surface: "#101010", surfaceAlt: "#202020", border: "#808080" },
  light: { primary: "#000000", assistantMessage: "#000000", userMessage: "#000000", thinkingText: "#505050", secondary: "#303030", muted: "#505050", hint: "#505050", accent: "#004c99", background: "#ffffff", surface: "#f0f0f0", surfaceAlt: "#e0e0e0", border: "#606060" },
};
/** 同一有效主题注入所有原生视图；revision 只属于展示。 */
export function resolveUiTheme(settings: UiThemeSettings = {}, terminalMode: ThemeName = "dark", env: Readonly<Record<string, string | undefined>> = process.env): UiThemeSnapshot {
  const mode = settings.mode === "dark" || settings.mode === "light" ? settings.mode : terminalMode;
  const preset = settings.preset === "neutral" ? NEUTRAL[mode] : settings.preset === "high-contrast" ? CONTRAST[mode] : {};
  const overrides = { ...settings.colors?.common, ...settings.colors?.[mode] };
  const diagnostics: string[] = [];
  for (const key of UI_COLOR_KEYS) {
    const value = env[`RUNLEDGER_THEME_${key.toUpperCase()}`];
    if (value === undefined) continue;
    if (isUiColor(value)) overrides[key] = value.toLowerCase();
    else diagnostics.push(`RUNLEDGER_THEME_${key.toUpperCase()}`);
  }
  const colors = { ...loadTheme(mode), ...preset, ...overrides };
  if (overrides.editorBackground === undefined) colors.editorBackground = rgbToHex(computeEditorBackground(parseHexColor(colors.background)!));
  const backgroundExplicit = overrides.background !== undefined;
  const editorBackgroundExplicit = overrides.editorBackground !== undefined;
  return Object.freeze({ colors: Object.freeze(colors), mode, backgroundExplicit, editorBackgroundExplicit,
    revision: JSON.stringify([mode, colors, backgroundExplicit, editorBackgroundExplicit]), diagnostics: Object.freeze(diagnostics) });
}
