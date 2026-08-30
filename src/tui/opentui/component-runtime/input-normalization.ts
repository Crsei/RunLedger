/**
 * S6 拆分:key event → normalized input 字符串。
 */

import type { KeyEvent } from "@opentui/core";

export function normalizedInputFor(key: KeyEvent): string {
  const aliases: Record<string, string> = {
    return: "enter",
    pageup: "pageUp",
    pagedown: "pageDown",
  };
  const name = aliases[key.name.toLowerCase()] ?? key.name.toLowerCase();
  const namedKeys = new Set([
    "enter", "escape", "tab", "backspace", "delete", "home", "end",
    "pageUp", "pageDown", "up", "down", "left", "right",
  ]);
  const modifiers: string[] = [];
  if (key.ctrl) modifiers.push("ctrl");
  if (key.meta || key.option) modifiers.push("alt");
  if (key.super) modifiers.push("super");
  if (key.shift && (modifiers.length > 0 || namedKeys.has(name))) modifiers.push("shift");
  if (modifiers.length > 0) return `${modifiers.join("+")}+${name}`;
  if (namedKeys.has(name)) return name;
  return key.sequence || key.raw;
}
