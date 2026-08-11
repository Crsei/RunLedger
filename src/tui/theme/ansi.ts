/**
 * ANSI 颜色辅助:把 #rrggbb 与 ANSI 风格 wrap 成 SGR 函数,带 16 色回退。
 *
 * 对照 development-doc/tui/05-theme.md §4。
 *
 * 设计:
 *   - hexToAnsi256 把 #rrggbb 映射到 xterm 256 调色板(标准算法);
 *   - hexToAnsi16 在 256 色基础上进一步降到 16 色,适应不支持 256 色的终端;
 *   - wrapFg / wrapBg 接受 hex 字符串返回 (text) => `\x1b[38;5;n m${text}\x1b[39m`;
 *   - 终端能力检测放在更高层调用方决定 wrapFg vs wrapFg16;本 helper 不持终端状态;
 *   - 失败回退:hex 不合法时返回 identity 函数,不抛错(对照 02 §1 不可变契约)。
 */

const ANSI_16 = [
  [0, 0, 0], // 0 black
  [205, 0, 0], // 1 red
  [0, 205, 0], // 2 green
  [205, 205, 0], // 3 yellow
  [0, 0, 238], // 4 blue (维基 Color_value#Color_Palette)
  [205, 0, 205], // 5 magenta
  [0, 205, 205], // 6 cyan
  [229, 229, 229], // 7 white
  [127, 127, 127], // 8 bright black (gray)
  [255, 0, 0], // 9 bright red
  [0, 255, 0], // 10 bright green
  [255, 255, 0], // 11 bright yellow
  [92, 92, 255], // 12 bright blue
  [255, 0, 255], // 13 bright magenta
  [0, 255, 255], // 14 bright cyan
  [255, 255, 255], // 15 bright white
];

/** hex 转换工具:接受 #rrggbb 或 #rgb,失败按全 0 处理。 */
function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-fA-F]{6}|[0-9a-fA-F]{3})$/.exec(hex.trim());
  if (!m) return [0, 0, 0];
  const v = m[1];
  if (v.length === 3) {
    return [
      parseInt(v[0] + v[0], 16),
      parseInt(v[1] + v[1], 16),
      parseInt(v[2] + v[2], 16),
    ];
  }
  return [
    parseInt(v.slice(0, 2), 16),
    parseInt(v.slice(2, 4), 16),
    parseInt(v.slice(4, 6), 16),
  ];
}

/** 把 [r,g,b] 映射到 xterm 256 调色板索引(标准算法)。 */
export function rgbToAnsi256(r: number, g: number, b: number): number {
  // 灰阶(232~255):r=g=b 时优先按灰阶匹配
  if (r === g && g === b) {
    if (r < 8) return 16;
    if (r > 248) return 231;
    return Math.round(((r - 8) / 247) * 24) + 232;
  }
  return 16 + 36 * Math.floor(r / 51) + 6 * Math.floor(g / 51) + Math.floor(b / 51);
}

/** 把 256 色索引进一步降到 16 色表(标准 16 色 ANSI)。 */
export function ansi256ToAnsi16(n: number): number {
  if (n < 8) return n;
  if (n < 16) return n;
  if (n >= 232) {
    // 灰阶 -> 黑/白
    const gray = (n - 232) * 10 + 8;
    return gray < 80 ? 0 : gray > 180 ? 15 : 7;
  }
  // 16~231 色立方回退到 ANSI 16,按欧氏距离最近邻;立方解码需先减去 16 偏移。
  let bestIdx = 0;
  let bestDist = Infinity;
  const cube = n - 16;
  for (let i = 0; i < 16; i++) {
    const [r, g, b] = ANSI_16[i];
    const rr = (Math.floor(cube / 36) % 6) * 51;
    const gg = (Math.floor(cube / 6) % 6) * 51;
    const bb = (cube % 6) * 51;
    const dist = (r - rr) ** 2 + (g - gg) ** 2 + (b - bb) ** 2;
    if (dist < bestDist) {
      bestDist = dist;
      bestIdx = i;
    }
  }
  return bestIdx;
}

export type StyleFn = (text: string) => string;

/** 把 hex 字符串转成 SGR ANSI 函数(foreground,256 色 fallback 到 16 色)。 */
export function wrapFg(hex: string, fallback16 = true): StyleFn {
  const [r, g, b] = hexToRgb(hex);
  const wrap256 = (text: string): string => `\x1b[38;5;${rgbToAnsi256(r, g, b)}m${text}\x1b[39m`;
  if (!fallback16) return wrap256;
  const idx16 = ansi256ToAnsi16(rgbToAnsi256(r, g, b));
  // 亮色(8-15)fg SGR 为 90+(idx-8);30+idx 只覆盖暗色,避免输出 98/99 等非法码。
  const wrap16 = (text: string): string => `\x1b[${30 + (idx16 >= 8 ? idx16 + 52 : idx16)}m${text}\x1b[39m`;
  return wrap16 === null ? wrap256 : wrap16;
}

/** 把 hex 字符串转成 SGR ANSI 函数(background)。 */
export function wrapBg(hex: string, fallback16 = true): StyleFn {
  const [r, g, b] = hexToRgb(hex);
  if (!fallback16) {
    return (text: string): string => `\x1b[48;5;${rgbToAnsi256(r, g, b)}m${text}\x1b[49m`;
  }
  const idx16 = ansi256ToAnsi16(rgbToAnsi256(r, g, b));
  // 亮色(8-15)bg SGR 为 100+(idx-8);40+idx 只覆盖暗色。
  return (text: string): string => `\x1b[${40 + (idx16 >= 8 ? idx16 + 52 : idx16)}m${text}\x1b[49m`;
}

/** Bold wrap: \x1b[1m...\x1b[22m。 */
export function wrapBold(text: string): string {
  return `\x1b[1m${text}\x1b[22m`;
}

/** Dim wrap: \x1b[2m...\x1b[22m(对照 codex Line::dim 的副标题/描述/提示)。 */
export function wrapDim(text: string): string {
  return `\x1b[2m${text}\x1b[22m`;
}

/** Italic wrap: \x1b[3m...\x1b[23m。 */
export function wrapItalic(text: string): string {
  return `\x1b[3m${text}\x1b[23m`;
}

/** Underline wrap: \x1b[4m...\x1b[24m。 */
export function wrapUnderline(text: string): string {
  return `\x1b[4m${text}\x1b[24m`;
}

/** Strikethrough wrap: \x1b[9m...\x1b[29m。 */
export function wrapStrikethrough(text: string): string {
  return `\x1b[9m${text}\x1b[29m`;
}
