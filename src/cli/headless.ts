/** 单次非交互执行：复用生产 Session controller，不绕过权限与 Owner。 */
import type { AgentEvent, AgentEventSink } from "../runtime/types.ts";

export interface HeadlessController {
  readonly sessionId: string;
  subscribe(listener: AgentEventSink): () => void;
  prompt(text: string): Promise<void>;
  interrupt(): void;
}

export async function runHeadless(
  controller: HeadlessController,
  prompt: string,
  options: { write: (event: unknown) => void; signal?: AbortSignal; timeoutMs?: number },
): Promise<void> {
  if (!prompt.trim()) throw new Error("headless prompt must not be empty");
  let finish!: (event: Extract<AgentEvent, { type: "agent_end" }>) => void;
  let fail!: (error: Error) => void;
  const completion = new Promise<Extract<AgentEvent, { type: "agent_end" }>>((resolve, reject) => {
    finish = resolve;
    fail = reject;
  });
  // prompt admission may reject before the completion promise is awaited.
  void completion.catch(() => undefined);
  let started = false;
  let runId: string | undefined;
  const unsubscribe = controller.subscribe((event) => {
    if (event.type === "agent_start") { started = true; runId = event.runId; }
    if (!started || (runId !== undefined && event.runId !== undefined && event.runId !== runId)) return;
    try {
      // 完整消息和工具结果保留；流式累积快照不重复写入。
      if (event.type !== "message_update" && event.type !== "tool_execution_update") options.write(event);
      if (event.type === "agent_end") finish(event);
    } catch (error) {
      controller.interrupt();
      fail(error instanceof Error ? error : new Error(String(error)));
    }
  });
  const abort = () => { controller.interrupt(); fail(new Error("headless execution aborted")); };
  const timer = setTimeout(() => {
    controller.interrupt();
    fail(new Error("headless execution timed out"));
  }, options.timeoutMs ?? 1_800_000);
  options.signal?.addEventListener("abort", abort, { once: true });
  try {
    if (options.signal?.aborted) throw new Error("headless execution aborted");
    options.write({ type: "runledger_session", sessionId: controller.sessionId });
    await Promise.race([controller.prompt(prompt), completion.then(() => undefined)]);
    const end = await completion;
    if (end.stopReason === "error" || end.stopReason === "aborted" || end.terminationReason !== undefined) {
      throw new Error(`headless agent ended: ${end.terminationReason ?? end.stopReason}`);
    }
    options.write({ type: "runledger_complete", sessionId: controller.sessionId, stopReason: end.stopReason });
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
    unsubscribe();
  }
}
