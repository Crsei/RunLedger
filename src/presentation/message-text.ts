/** TUI 与浏览器共同使用的纯消息文本投影；不持有框架、IO 或 runtime authority。 */
export function messageText(message: { readonly content?: unknown } | undefined, kind: "text" | "thinking" = "text"): string {
  if (!Array.isArray(message?.content)) return typeof message?.content === "string" && kind === "text" ? message.content : "";
  return message.content.filter((part): part is Record<string, unknown> => typeof part === "object" && part !== null && part.type === kind)
    .map((part) => typeof part[kind] === "string" ? part[kind] : "").join("");
}
export function assistantText(message: { readonly role?: string; readonly content?: unknown; readonly stopReason?: string; readonly errorMessage?: string } | undefined): string {
  if (message?.role !== "assistant" || !Array.isArray(message.content)) return "";
  const text = messageText(message);
  return text || (message.stopReason === "error" && message.errorMessage ? `Error: ${message.errorMessage}` : "");
}
export function assistantThinking(message: { readonly role?: string; readonly content?: unknown } | undefined): string {
  return message?.role === "assistant" ? messageText(message, "thinking") : "";
}
