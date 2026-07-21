/**
 * 进程级 singleton handle:让非 TUI 代码(daemon / `runledger remote *` / 外部 IDE)反向
 * 操作当前活跃 InteractiveMode。本文件本期为 stub,只声明类型 + no-op 注册器,
 * M0–M7 期间无主代码 import 不会触发起任何运行行为。
 *
 * 对照文档:
 *   - development-doc/tui/01-architecture.md §9
 *   - development-doc/tui/09-remote-control-roadmap.md(完整远期设计)
 *   - development-doc/tui/08-cross-project-lessons.md §3 规则 8
 *
 * 设计边界(本期 stub 已就位):
 *   - handle 不持有 InteractiveMode 内部引用,只暴露 5 个事件式 API;
 *   - 调用方在 handle 路径上不触发 mutation,经合成事件 CentalMode 同步消费;
 *   - ReplHandle 接口与 RunLedger 内部类型解耦,以便单测 mock。
 *
 * M0–M7 期间就读取本文件无副作用:
 *   - module-level state 是单变量 handle,初值 null;
 *   - getReplHandle() 返回 null;
 *   - setReplHandle() 仅写入模块变量;
 *   - InteractiveMode 不引入 import,getReplHandle 永远返回 null。
 *
 * M8 任务到来时:
 *   1. InteractiveMode.run() 入口调 setReplHandle(buildReplHandle(this));
 *   2. 退出时 setReplHandle(null);
 *   3. buildReplHandle 由 interactive-mode.ts 内部实现,handle 暴露同步事件式方法。
 */

/** 操作结果类型;所有 handle 方法必须同步返回此联合,异步副作用 / 异常一律编码为 error。 */
export type ReplResult = { ok: true } | { ok: false; error: string };

/** 暴露给非 TUI 代码的接口;与 RunLedger 内部类型解耦以便 mock。 */
export interface ReplHandle {
  /** 把文本作为用户 prompt 注入 InteractiveMode;返回是否成功投递。 */
  sendText(_text: string): ReplResult;

  /** 中断当前 turn;若无活跃 turn,返回 ok 但 error 标 "no-active-turn"。 */
  interrupt(): ReplResult;

  /** 切换模型;若 modelId 未知返回 ok: false;error: "model-not-found"。 */
  setModel(_modelId: string): ReplResult;

  /** 切换 thinking 模式;mode 取值固化为 4 个字符串之一。 */
  setThinking(_mode: "off" | "low" | "medium" | "high"): ReplResult;

  /** dispose 后所有方法返回 ok: false;error: "disposed"。 */
  dispose(): void;
}

/** 进程内单例 handle,初值 null;InteractiveMode.run() 入口注册。 */
let activeHandle: ReplHandle | null = null;

/** 取当前活跃 InteractiveMode 的 handle;无活跃实例返回 null。 */
export function getReplHandle(): ReplHandle | null {
  return activeHandle;
}

/** InteractiveMode.run() 入口注册 handle;退出时传 null 清空。 */
export function setReplHandle(handle: ReplHandle | null): void {
  activeHandle = handle;
}
