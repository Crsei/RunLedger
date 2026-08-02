/**
 * TUI 主题:20 色槽 schema 的核心类型与 dark/light 加载入口。
 *
 * 对照 development-doc/tui/05-theme.md §1 与 §3:
 *   - Theme 接口包含 20 个色槽 + accentBold/Italic 字符变体;
 *   - loadTheme(name) 在 M1 阶段只支持 "dark" 硬编码色值;
 *   - env 覆盖 RUNLEDGER_THEME_<KEY> 在 M6 接入,本期占位函数 noop;
 *   - 中文注释与色槽保持简洁技术化,不堆形容词。
 *
 * dark/light 由 OpenTUI theme_mode 事件切换，不再保留第二套终端探测 authority。
 */

/** ANSI 16 色基础槽 + accent 字符变体,共 20 项(对照 05-theme.md §3 表)。 */
export interface Theme {
  /** 8 个基础前景槽。 */
  primary: string;
  secondary: string;
  accent: string;
  muted: string;
  success: string;
  warning: string;
  error: string;
  info: string;
  /** 4 个背景槽 */
  background: string;
  surface: string;
  surfaceAlt: string;
  border: string;
  /** 8 个语义槽(细粒度业务着色) */
  userMessage: string;
  assistantMessage: string;
  toolCall: string;
  toolResult: string;
  toolError: string;
  status: string;
  hint: string;
  link: string;
}

/** 本期支持的预设名;light 与 auto 在 M6 接入。 */
export type ThemeName = "dark" | "light";

/** dark 主题默认色值。 */
const DARK_THEME: Theme = {
  primary: "#e6e6e6",
  secondary: "#a0a0a0",
  accent: "#7dcfff",
  muted: "#666666",
  success: "#7fd1a4",
  warning: "#e5c07b",
  error: "#f7768e",
  info: "#7aa2f7",
  background: "#0b0e14",
  surface: "#11151c",
  surfaceAlt: "#1a1f29",
  border: "#2b3340",
  userMessage: "#7dcfff",
  assistantMessage: "#e6e6e6",
  toolCall: "#e5c07b",
  toolResult: "#7fd1a4",
  toolError: "#f7768e",
  status: "#7aa2f7",
  hint: "#666666",
  link: "#7aa2f7",
};

/** light 主题占位;M6 阶段补真值。 */
const LIGHT_THEME: Theme = {
  primary: "#1a1a1a",
  secondary: "#444444",
  accent: "#0066cc",
  muted: "#888888",
  success: "#2a8a4a",
  warning: "#a07000",
  error: "#c01030",
  info: "#3050c0",
  background: "#ffffff",
  surface: "#f5f5f5",
  surfaceAlt: "#eaeaea",
  border: "#cccccc",
  userMessage: "#0066cc",
  assistantMessage: "#1a1a1a",
  toolCall: "#a07000",
  toolResult: "#2a8a4a",
  toolError: "#c01030",
  status: "#3050c0",
  hint: "#888888",
  link: "#3050c0",
};

/**
 * 按预设名加载 theme;不存在的名字回退到 dark,记 stderr 一行。
 *
 * env 覆盖 RUNLEDGER_THEME_<KEY> 在 M6 阶段加入,本期保持纯预设。
 */
export function loadTheme(name: ThemeName): Theme {
  switch (name) {
    case "dark":
      return DARK_THEME;
    case "light":
      return LIGHT_THEME;
  }
}

/**
 * 应用 env 覆盖到 theme(M6 真实装)。
 *
 * 通过 RUNLEDGER_THEME_<KEY> 覆盖 Theme 的某项颜色;KEY 取大写形式,
 * 例如 RUNLEDGER_THEME_PRIMARY="#ffffff"。
 * 不支持新增色槽;只覆盖已存在字段。返回新对象,不污染 caller 引用。
 */
export function applyEnvOverrides(theme: Theme, env: NodeJS.ProcessEnv = process.env): Theme {
  const next: Theme = { ...theme };
  const keys = Object.keys(next) as (keyof Theme)[];
  for (const k of keys) {
    const envKey = `RUNLEDGER_THEME_${k.toUpperCase()}`;
    const v = env[envKey];
    if (typeof v === "string" && v.length > 0) {
      (next[k] as string) = v;
    }
  }
  return next;
}
