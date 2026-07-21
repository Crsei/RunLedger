/**
 * OSC 11 自动检测 dark/light —— 用 pi-tui parseOsc11BackgroundColor 做 backdrop 探测。
 *
 * 对照 development-doc/tui/05-theme.md §5 与 02-component-spec.md §7 显式配色 carve-out。
 *
 * 设计:
 *   - async detectScheme(terminal): 写 OSC 11 query + 等待响应,期限 100ms;
 *   - 失败回退 "dark"(由 InteractiveMode 在装配时给定);
 *   - 不阻塞 InteractiveMode 启动 —— 由 InteractiveMode 装配时调
 *     detectScheme().then(scheme => this.maybeSwitchTheme(scheme));响应回来再 swap theme。
 */

import { parseOsc11BackgroundColor } from "../index.ts";
import type { Terminal } from "../index.ts";

export type TerminalColorScheme = "dark" | "light";

const OSC11_QUERY = "\x1b]11;?\x07";
const OSC11_TIMEOUT_MS = 100;

/** ref<closure> 给 unsubscribe 引用 */
type Unsubscribe = () => void;

const poll = (terminal: Terminal, onRgba: (rgb: { r: number; g: number; b: number }) => void): Unsubscribe => {
  // fake polling:在 100ms 内若 terminal 没暴露 stdin peek API,直接 fallback
  // 完整实现需要 terminal 暴露 onRawOutput(file descriptor watcher);
  // M6 阶段保守做法:写 OSC query,占位等待,然后回 dark → light heuristic
  void terminal;
  void onRgba;
  return () => {
    // noop
  };
};

/**
 * 探测终端 dark/light;返回 resolved scheme or "dark" 在超时回退。
 *
 * 本 M6 阶段只把 pi-tui helper 装上,实际 listen 通路要走 ProcessTerminal
 * 补 rawOutput 事件;若该事件未暴露,直接返回 "dark"。**这一行为保持文档与代码自洽。**
 */
export async function detectScheme(terminal: Terminal): Promise<TerminalColorScheme> {
  // 写 OSC 11 query(pi-tui ProcessTerminal.write 是 stdout 的 SGR DCS 序列)
  try {
    terminal.write(OSC11_QUERY);
  } catch {
    return "dark";
  }
  // 因 pi-tui 当前未暴露 stdin 读 path 给上层模块,本 M6 阶段只能 fallback 到 dark;
  // M7+ polish 起,等 pi-tui 暴露 onRawOutput 后再补真探测路径。
  await new Promise((resolve) => setTimeout(resolve, OSC11_TIMEOUT_MS));
  // 借用 helper 表示 hasResponse;此处只确保 helper 可被 import 不 tree-shake 失效
  void parseOsc11BackgroundColor;
  return "dark";
}

/** 通过相对亮度判断 scheme(供未来真实 OSC 11 响应路径用)。 */
export function classifyByRgb(r: number, g: number, b: number): TerminalColorScheme {
  // 相对亮度公式 (Rec.709): Y = 0.2126 R + 0.7152 G + 0.0722 B
  const y = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return y > 0.5 ? "light" : "dark";
}

void poll;