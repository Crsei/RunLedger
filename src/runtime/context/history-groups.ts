/** 请求投影的私有依赖组，不改变原始会话或公共 ContextFragment 合同。 */
import type { Message } from "../../types.ts";
import { isCompleteToolBatch } from "./compaction/cut-planner.ts";

export interface HistoryGroup {
  readonly start: number;
  readonly end: number;
  readonly required: boolean;
  readonly messages: Message[];
}

function callIds(message: Message): string[] {
  return message.role === "assistant"
    ? message.content.flatMap((part) => part.type === "toolCall" ? [part.id] : [])
    : [];
}

/** 最近一次用户输入之前的完成边界之后，用户目标和 steering 都保持 required。 */
function activePromptStart(messages: readonly Message[]): number {
  let latestUser = messages.length - 1;
  while (latestUser >= 0 && messages[latestUser]?.role !== "user") latestUser--;
  for (let index = latestUser - 1; index >= 0; index--) {
    const message = messages[index]!;
    if (message.role === "assistant" && message.stopReason === "stop" && callIds(message).length === 0) return index + 1;
  }
  return 0;
}

export function groupRequestHistory(messages: Message[]): HistoryGroup[] {
  const results = new Map<string, number[]>();
  messages.forEach((message, index) => {
    if (message.role === "toolResult") {
      const indices = results.get(message.toolCallId) ?? [];
      indices.push(index);
      results.set(message.toolCallId, indices);
    }
  });
  const activeStart = activePromptStart(messages);
  const groups: HistoryGroup[] = [];
  for (let start = 0; start < messages.length;) {
    let end = start;
    // 延迟结果可能跨过 steering 或其他调用；扩展到传递依赖闭合。
    for (let index = start; index <= end; index++) {
      for (const id of callIds(messages[index]!)) {
        const match = results.get(id)?.find((position) => position > index);
        if (match !== undefined) end = Math.max(end, match);
      }
    }
    const members = messages.slice(start, end + 1);
    const complete = isCompleteToolBatch({
      toolCallIds: members.flatMap(callIds),
      toolResultIds: members.flatMap((message) => message.role === "toolResult" ? [message.toolCallId] : []),
    });
    const required = end === messages.length - 1
      || members.some((message, offset) => message.role === "user" && start + offset >= activeStart);
    // 未配对历史保留原样交给既有 provider 转换；不能在裁剪中制造更多孤儿。
    groups.push({ start, end, required: required || (!complete && end >= activeStart), messages: members });
    start = end + 1;
  }
  return groups;
}
