/** 界面基础色槽；配置解析、预设与覆盖规则见 ui-theme.ts。 */
export interface Theme {
  thinkingText: string;
  /** 8 个基础前景槽。 */
  primary: string;
  secondary: string;
  accent: string;
  muted: string;
  success: string;
  warning: string;
  error: string;
  info: string;
  /** 5 个背景槽 */
  background: string;
  surface: string;
  surfaceAlt: string;
  border: string;
  /** 输入区整块背景(codex user_message_bg_rgb:暗 12% 白 / 亮 4% 黑)。 */
  editorBackground: string;
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

/** 有效的终端配色模式；auto 在配置解析层解析。 */
export type ThemeName = "dark" | "light";

/** dark 主题默认色值。 */
const DARK_THEME: Theme = {
  thinkingText: "#777d88",
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
  // 静态回退值 = computeEditorBackground(解析 background);OSC 11 可用时由
  // theme/editor-background.ts 重算,两者对默认主题保持一致。
  editorBackground: "#282a30",
  userMessage: "#e6e6e6",
  assistantMessage: "#e6e6e6",
  toolCall: "#e5c07b",
  toolResult: "#7fd1a4",
  toolError: "#f7768e",
  status: "#7aa2f7",
  hint: "#666666",
  link: "#7dcfff",
};

/** light 主题默认色值。 */
const LIGHT_THEME: Theme = {
  thinkingText: "#6c6c6c",
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
  // 亮主题回退值 = computeEditorBackground(#ffffff) = 4% 黑混入。
  editorBackground: "#f4f4f4",
  userMessage: "#1a1a1a",
  assistantMessage: "#1a1a1a",
  toolCall: "#a07000",
  toolResult: "#2a8a4a",
  toolError: "#c01030",
  status: "#3050c0",
  hint: "#888888",
  link: "#0066cc",
};

/** 返回基础 dark/light 预设；调用方不得修改共享对象。 */
export function loadTheme(name: ThemeName): Theme {
  switch (name) {
    case "dark":
      return DARK_THEME;
    case "light":
      return LIGHT_THEME;
  }
}

/**
 * 兼容入口：应用合法的 hex 环境覆盖；生产使用 resolveUiTheme。
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
    if (typeof v === "string" && /^#[0-9a-fA-F]{6}$/u.test(v)) {
      (next[k] as string) = v;
    }
  }
  return next;
}
