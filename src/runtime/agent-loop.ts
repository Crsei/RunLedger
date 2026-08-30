/**
 * Agent 循环核心实现 —— 公共入口 facade。
 *
 * S4 拆分后实现位于 `agent-loop/`:
 * - `agent-loop/loop-runner.ts`         outer turn / inner stream 状态机;
 * - `agent-loop/context-conversion.ts`  AgentMessage → LLM Message;
 * - `agent-loop/run-budget.ts`          budget 校验/耗尽/终止摘要;
 * - `agent-loop/tool-call-preparation.ts` schema、参数、execution mode 与管线编排;
 * - `agent-loop/tool-call-execution.ts` execute + abort + error 归一化;
 * - `agent-loop/tool-call-finalization.ts` ledger/event/result/budget 结算;
 * - `agent-loop/assistant-recovery.ts`  truncated/assumed assistant 收口。
 *
 * 本文件只重导出,不复制实现;公共 import 路径不变。
 */

export {
  runAgentLoop,
  runAgentLoopContinue,
  defaultConvertToLlm,
  serializeAssistant,
} from "./agent-loop/index.ts";
