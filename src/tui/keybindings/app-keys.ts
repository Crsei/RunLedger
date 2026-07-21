/**
 * RunLedger app.* 键位扩展:在 pi-tui 默认 KeybindingsManager 之外,
 * 通过 TUI.addInputListener 拦截若干全局键位,映射到 app 动作。
 *
 * 对照 development-doc/tui/06-keybindings.md §3。
 *
 * 设计:
 *   - createAppKeyListener(callbacks) 返回 InputListener;
 *   - 拦截键:Ctrl+C / Ctrl+D / Ctrl+L / Esc (但当 Editor 处于 autocomplete 时不抢);
 *   - matchesKey 检查;若命中则调对应 callback 并 consume=true;
 *   - 不命中返回 undefined,继续走默认链路。
 *
 * Tricky:
 *   - pi-tui Editor 的 handleInput 在 TUI.start() 后已成为 listener chain 的一员,
 *     外部 addInputListener 监听顺序决定于注册顺序;
 *   - 我们的 listener 必须在 InteractiveMode.run() 之前注册,以保证先于 Editor 拦截;
 *   - Esc 单按下在 Editor 中通常 abort autocomplete,我们不应抢;只在非 focus 编辑器状态下拦;
 *     M6 阶段简化:不抢 Esc,只抢 Ctrl+C / Ctrl+D / Ctrl+L。
 */

import { matchesKey } from "../index.ts";

/**
 * 本地 InputListener 描述(pi-tui 顶层未 re-export,我们在本地复述确保签名兼容)。
 * 与 pi-tui dist/tui.d.ts InputListenerResult 同形:
 *   (data: string) => {consume?: boolean; data?: string} | undefined
 */
export type InputListener = (data: string) =>
  | { consume?: boolean; data?: string }
  | undefined;

export interface AppKeyCallbacks {
  /** Ctrl+C:中断当前 turn(若 streaming)、否则尝试清空当前输入(默认 Editor 行为)。 */
  onInterrupt?: () => void;
  /** Ctrl+D:若 Editor 空且无 streaming,优雅退出 TUI(EOF 语义)。 */
  onExit?: () => void;
  /** Ctrl+L:重新同步终端状态(强制全屏重绘)。 */
  onRefresh?: () => void;
}

export function createAppKeyListener(callbacks: AppKeyCallbacks): InputListener {
  return (data: string): ReturnType<InputListener> => {
    if (matchesKey(data, "ctrl+c") && callbacks.onInterrupt) {
      callbacks.onInterrupt();
      return { consume: true };
    }
    if (matchesKey(data, "ctrl+d") && callbacks.onExit) {
      callbacks.onExit();
      return { consume: true };
    }
    if (matchesKey(data, "ctrl+l") && callbacks.onRefresh) {
      callbacks.onRefresh();
      return { consume: true };
    }
    return undefined;
  };
}
