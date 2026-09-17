import { createHash } from "node:crypto";
import { assistantText, messageText } from "../presentation/message-text.ts";
import { WEB_BOUNDS, type WebTimelineRow } from "@runledger/collab-web/contracts";
import type { SessionEventRecord } from "../storage/session-store/session-store.ts";
import { object, safeText } from "../runtime/trajectory/projection.ts";

export function publicId(value: string): string { return createHash("sha256").update(value).digest("hex"); }
/** 只投影 canonical ledger；agent.event 的 message_end 是重复观察，不再显示第二份消息。 */
export function projectWebTimeline(event: SessionEventRecord): readonly WebTimelineRow[] {
  if (event.eventType !== "ledger.message") return [];
  const envelope = object(JSON.parse(event.payloadJson));
  const payload = object(envelope.payload);
  const message = object(payload.message ?? payload);
  const content = Array.isArray(message.content) ? message.content.map(object) : [];
  const rows: WebTimelineRow[] = [];
  const add = (kind: WebTimelineRow["kind"], text: string, tool?: WebTimelineRow["tool"], previewTruncated = false): void => {
    const safe = safeText(text, WEB_BOUNDS.textCharacters + 1);
    rows.push({ id: `${event.eventId}:${rows.length}`, sequence: event.sequence, createdAtMs: event.createdAtMs,
      kind, text: safe.slice(0, WEB_BOUNDS.textCharacters), truncated: safe.length > WEB_BOUNDS.textCharacters || previewTruncated,
      ...(safe.length > WEB_BOUNDS.textCharacters ? { detailRecordId: `ledger:${event.sequence}:${rows.length}` } : {}),
      ...(tool === undefined ? {} : { tool }) });
  };
  if (message.role === "user") add("user", messageText(message));
  if (message.role === "assistant") {
    const thinking = messageText(message, "thinking");
    if (thinking) add("thinking", thinking);
    const text = assistantText(message);
    if (text || content.length === 0) add("assistant", text);
    for (const part of content) {
      if (part.type !== "toolCall" || typeof part.id !== "string") continue;
      const input = safeText(part.arguments, 2049);
      add("tool", "", { callId: publicId(part.id), name: safeText(part.name, 128), state: "unknown",
        inputPreview: input.slice(0, 2048), outputPreview: "", detailRecordId: `ledger:${event.sequence}:${rows.length}`, inputDetailRecordId: `ledger:${event.sequence}:${rows.length}` }, input.length > 2048);
    }
  }
  if (message.role === "tool" || message.role === "toolResult") {
    const parts = typeof message.toolCallId === "string" ? [message] : content;
    for (const part of parts) {
      if (typeof part.toolCallId !== "string") continue;
      const output = safeText(part.result ?? part.content ?? part, 4097);
      add("tool", "", { callId: publicId(part.toolCallId), name: safeText(part.toolName ?? "tool", 128),
        state: part.isError === true ? "failed" : "succeeded", inputPreview: "", outputPreview: output.slice(0, 4096),
        detailRecordId: `ledger:${event.sequence}:${rows.length}` }, output.length > 4096);
    }
  }
  return rows;
}
