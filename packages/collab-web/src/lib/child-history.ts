// Adapted from collab-web transcript-poll.ts; see THIRD_PARTY_NOTICES.md.
import type { WebTimelinePage } from "../contracts/index.ts";
import { ApiError, errorText } from "./api.ts";

export type ChildHistoryDecision = { action: "retry" } | { action: "stop"; message: string } | { action: "resync" }
  | { action: "advance"; page: WebTimelinePage };
/** 临时请求失败保留游标；终态错误停止，epoch 变化先重取快照。 */
export function decideChildHistory(reply: WebTimelinePage | null, error?: unknown): ChildHistoryDecision {
  if (reply) return { action: "advance", page: reply };
  if (error instanceof ApiError) {
    if (error.code === "resync_required") return { action: "resync" };
    if (["unauthenticated", "forbidden", "not_found", "schema_incompatible", "corrupt"].includes(error.code)) return { action: "stop", message: errorText(error) };
  }
  return { action: "retry" };
}
