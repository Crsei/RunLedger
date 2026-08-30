/**
 * S4 拆分:runAgentLoop 稳定入口 facade。
 *
 * loop-runner 通过窄导入调用工具 pipeline,不反向导入任何 facade。
 */

export { runAgentLoop } from "./loop-runner.ts";
export { defaultConvertToLlm, serializeAssistant } from "./context-conversion.ts";

// ===== 兼容旧调用点(已无反射 trick,ledger 走 AgentLoopConfig.ledger 第一公民) =====

// 占位:runAgentLoopContinue 暂未实现(本期 demo 不使用)
// `// TODO(pi): resume without new prompt`
import type { AgentContext, AgentEventSink, AgentLoopConfig, AgentMessage, StreamFn } from "../types.ts";
export async function runAgentLoopContinue(
  _context: AgentContext,
  _config: AgentLoopConfig,
  _emit: AgentEventSink,
  _signal?: AbortSignal,
  _streamFn?: StreamFn,
): Promise<AgentMessage[]> {
  throw new Error("runAgentLoopContinue not implemented yet"); // TODO(pi)
}
