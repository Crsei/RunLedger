/**
 * 输入区背景计算:对照 codex codex-rs/tui/src/{color,style}.rs 的最小可运行复刻。
 *
 * 映射关系:
 *   - isLight          -> color.rs::is_light(亮度阈值 128);
 *   - blend            -> color.rs::blend(Rust `as u8` 截断语义,非四舍五入);
 *   - computeEditorBackground -> style.rs::user_message_bg_rgb(暗 12% 白 / 亮 4% 黑);
 *   - resolveTerminalBackground -> style.rs::user_message_style_for(default_bg())
 *     的解析入口:OSC 11 探测值优先,缺失回退 theme.background 的 16 进制解析。
 *
 * 本模块只含纯函数,不持终端状态;终端能力降级(Ansi256/Ansi16)由调用方的
 * wrapBg / wrapFg 决定,与 codex best_color 的降级语义对齐。
 */

import type { RgbColor } from "../primitives.ts";
import type { Theme } from "./theme.ts";

/** 按 alpha 线性混合两个 RGB;alpha=0 返回 bg,alpha=1 返回 fg。 */
export function blend(fg: RgbColor, bg: RgbColor, alpha: number): RgbColor {
  const mix = (a: number, b: number): number => Math.trunc(a * alpha + b * (1 - alpha));
  return { r: mix(fg.r, bg.r), g: mix(fg.g, bg.g), b: mix(fg.b, bg.b) };
}

/** codex color.rs::is_light:Rec.601 亮度 > 128 视为亮背景。 */
export function isLight(rgb: RgbColor): boolean {
  return 0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b > 128;
}

/** codex style.rs::user_message_bg_rgb:亮背景 4% 黑、暗背景 12% 白。 */
export function computeEditorBackground(bg: RgbColor): RgbColor {
  if (isLight(bg)) return blend({ r: 0, g: 0, b: 0 }, bg, 0.04);
  const blended = blend({ r: 255, g: 255, b: 255 }, bg, 0.12);
  // 暗背景保底:codex 在纯黑终端(bg=#000000,如 tmux 默认/黑色主题)下产出
  // #1e1e1e,肉眼与黑无法区分;RunLedger 保底到主题静态回退值
  // #282a30(= computeEditorBackground(#0b0e14)),保证输入区始终可辨。
  return {
    r: Math.max(blended.r, DARK_FLOOR.r),
    g: Math.max(blended.g, DARK_FLOOR.g),
    b: Math.max(blended.b, DARK_FLOOR.b),
  };
}

/** 暗模式输入区背景最低亮度(#282a30,与 dark 主题 editorBackground 槽一致)。 */
const DARK_FLOOR: RgbColor = { r: 40, g: 42, b: 48 };

/** RgbColor -> #rrggbb(小写,与主题槽一致)。 */
export function rgbToHex(rgb: RgbColor): string {
  const hex = (value: number): string => value.toString(16).padStart(2, "0");
  return `#${hex(rgb.r)}${hex(rgb.g)}${hex(rgb.b)}`;
}

/** #rrggbb / #rgb 解析;不合法返回 undefined(调用方决定回退)。 */
export function parseHexColor(value: string): RgbColor | undefined {
  const match = /^#?([0-9a-fA-F]{6}|[0-9a-fA-F]{3})$/.exec(value.trim());
  if (!match) return undefined;
  const hex = match[1];
  if (hex.length === 3) {
    return {
      r: Number.parseInt(hex[0]! + hex[0], 16),
      g: Number.parseInt(hex[1]! + hex[1], 16),
      b: Number.parseInt(hex[2]! + hex[2], 16),
    };
  }
  return {
    r: Number.parseInt(hex.slice(0, 2), 16),
    g: Number.parseInt(hex.slice(2, 4), 16),
    b: Number.parseInt(hex.slice(4, 6), 16),
  };
}

/** 终端背景解析:OSC 11 优先,缺失回退 theme.background 的 16 进制解析。 */
export function resolveTerminalBackground(theme: Theme, osc11: RgbColor | undefined): RgbColor {
  if (osc11 !== undefined) return osc11;
  return parseHexColor(theme.background) ?? { r: 0, g: 0, b: 0 };
}

/** 输入区背景完整计算链:终端背景 -> blend -> hex(InteractiveMode 帧下发用)。 */
export function editorBackgroundFromTerminal(theme: Theme, osc11: RgbColor | undefined): string {
  return rgbToHex(computeEditorBackground(resolveTerminalBackground(theme, osc11)));
}
