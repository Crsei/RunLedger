/**
 * TUI feature adapters 接入点(本期 stub,远期启用)。
 *
 * 对照文档:
 *   - development-doc/tui/02-component-spec.md §0.1
 *   - development-doc/tui/08-cross-project-lessons.md §3 规则 3
 *   - development-doc/tui/07-roadmap.md 独立任务对接清单 "featureAdapters 接入点"
 *
 * 设计目的:把可选特性(voice / proactive / IDE 集成等)收敛到本文件,主组件树 import
 * 统一从此处取,组件内不散落 `if (process.env.X)` 判支。本期所有 adapter 为 no-op,
 * 文件被 import 时零运行副作用,tree-shaking 后零成本。
 *
 * 本文件本期不主动被任何主代码 import(M0–M7 尚未开始);M8 任务到来时,启用以下顺序:
 *   1. 由 InteractiveMode 顶层 import 取 adapter;
 *   2. 切换形态由 env flag 或未来的编译期 feature gate 决定;
 *   3. 主组件树引用 adapter,不直接 import 真实特性模块。
 *
 * 本期形式:占位 type + no-op 实现,等待落地。
 */

/** Voice 输入 adapter 接口契约(对照 claude-code-bun src/screens/repl/featureAdapters.ts)。 */
export interface VoiceAdapter {
  /** 处理一次键盘事件;真实实现消费 voice 模态键并触发语音捕获。 */
  handleKeyEvent(_data: string): void;
  /** 移除光标尾部 voice 状态字符,返回移除的列数。 */
  stripTrailing(): number;
  /** 重置 voice 输入锚点(切换 mode / 失焦时调)。 */
  resetAnchor(): void;
}

/** Voice adapter 本期 no-op,后续可由 env / 编译期切换到真实实现。 */
export const voiceAdapter: VoiceAdapter = {
  handleKeyEvent: () => {},
  stripTrailing: () => 0,
  resetAnchor: () => {},
};

/** Proactive 通知订阅器;真实实现订阅 panic / suggestion 流,本文件返回 noop unsubscribe。 */
export const PROACTIVE_NO_OP_SUBSCRIBE =
  (_cb: () => void): (() => void) =>
  (): void => {};

/** Proactive 可用性判断,本期恒 false。 */
export const PROACTIVE_FALSE = (): boolean => false;

/** Proactive 计数器取值,本期恒 null。 */
export const PROACTIVE_NULL = (): number | null => null;

/**
 * 维护约定:
 *   - 新增 adapter 必须在此文件 export,主组件树 import 不直接走真实模块;
 *   - 任何切换逻辑(env / feature())集中在 init 阶段顶层 const,不写 `await import()`;
 *   - 启用任何 adapter 后,同步在 07-roadmap.md 独立任务对接清单追加进度条目。
 */
