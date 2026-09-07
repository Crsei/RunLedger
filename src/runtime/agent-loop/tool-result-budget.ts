/** 工具最终文本的首尾投影；标记计入字符上限，overflow 只通过注入端口存储。 */
import type { ImageContent, TextContent } from "../../types.ts";
import { runtimeDigest } from "../protocol/foundation.ts";
import type { ToolResultOverflowStore } from "../types.ts";

// 最终 inline 文本与 shell 捕获量分开；为 UTF-8/JSON 和会话事件 envelope 留出空间。
export const DEFAULT_TOOL_RESULT_MAX_CHARS = 32_000;

/** UTF-16 切点不能落在 surrogate pair 中间。 */
function safeCut(text: string, index: number, direction: -1 | 1): number {
  if (index > 0 && index < text.length
    && /[\uD800-\uDBFF]/u.test(text[index - 1]!)
    && /[\uDC00-\uDFFF]/u.test(text[index]!)) return index + direction;
  return index;
}

export async function applyToolResultBudget(
  content: (TextContent | ImageContent)[],
  maxChars: number,
  toolCallId: string,
  overflowStore?: ToolResultOverflowStore,
): Promise<(TextContent | ImageContent)[]> {
  const limit = Number.isSafeInteger(maxChars) && maxChars >= 0 ? maxChars : 0;
  const text = content.filter((block) => block.type === "text").map((block) => block.text).join("");
  if (text.length <= limit) return content;
  let artifactHint = "";
  if (overflowStore !== undefined) {
    try {
      // 保存完整文本，包含后续块；无需依赖裁剪算法或分块才能恢复原文。
      const stored = await overflowStore.put({
        toolCallId, bytes: new TextEncoder().encode(text),
        mediaType: "text/plain; charset=utf-8", sourceDigest: runtimeDigest(text),
      });
      if (/^[a-f0-9]{64}$/u.test(stored.ref.digest.digest)) {
        artifactHint = ` Stored artifact ${stored.ref.digest.digest}.`;
      }
    } catch {
      // 存储失败不改变工具成败，也不声称存在可读取的 artifact。
    }
  }
  const generic = `\n[${text.length} of ${text.length} chars omitted.]\n`;
  const full = `${generic.slice(0, -2)}${artifactHint}]\n`;
  const template = full.length + 2 <= limit ? full
    : generic.length + 2 <= limit ? generic
      : limit >= 11 ? "[truncated]" : limit > 0 ? "…" : "";
  const available = limit - template.length;
  const headEnd = safeCut(text, Math.ceil(available / 2), -1);
  const tailStart = safeCut(text, text.length - Math.floor(available / 2), 1);
  const omitted = tailStart - headEnd;
  const marker = template.startsWith("\n[")
    ? template.replace(`${text.length} of`, `${omitted} of`)
    : template;
  let offset = 0;
  let marked = false;
  const output: (TextContent | ImageContent)[] = [];
  for (const block of content) {
    if (block.type === "image") {
      output.push(block);
      continue;
    }
    const end = offset + block.text.length;
    const prefix = block.text.slice(0, Math.max(0, Math.min(block.text.length, headEnd - offset)));
    const suffix = block.text.slice(Math.max(0, Math.min(block.text.length, tailStart - offset)));
    if (prefix.length > 0) output.push({ type: "text", text: prefix });
    if (!marked && end > headEnd) {
      if (marker.length > 0) output.push({ type: "text", text: marker });
      marked = true;
    }
    if (suffix.length > 0) output.push({ type: "text", text: suffix });
    offset = end;
  }
  // 合并相邻文本，避免 provider 为裁剪产生的额外块插入分隔符。
  const merged: (TextContent | ImageContent)[] = [];
  for (const block of output) {
    const last = merged.at(-1);
    if (block.type === "text" && last?.type === "text") last.text += block.text;
    else merged.push(block);
  }
  return merged;
}
