/** Session 级调用计量：包括交互、标题、摘要及 child；不复制 prompt 或凭据。 */
import { randomUUID } from "node:crypto";
import type { Models } from "../../models.ts";
import type { Usage } from "../../types.ts";
import type { AssistantMessageEventStream } from "../../utils/event-stream.ts";
import type { SessionStore } from "../../storage/session-store/session-store.ts";
import type { OwnerFence } from "../session-owner/types.ts";
import { createRuntimeId } from "../protocol/ids.ts";

export interface ModelCallReceipt { readonly callId: string; readonly startedAtMs: number }
export class SessionModelCalls {
  private readonly store: SessionStore;
  private readonly fence: OwnerFence;
  constructor(store: SessionStore, fence: OwnerFence) { this.store = store; this.fence = fence; }
  start(identity?: unknown): ModelCallReceipt {
    const receipt = { callId: typeof identity === "string" && identity.length > 0 && identity.length <= 512 ? identity : `model-${randomUUID()}`, startedAtMs: Date.now() };
    this.append(receipt, "started"); return receipt;
  }
  finish(receipt: ModelCallReceipt, usage?: Usage): void { this.append(receipt, "finished", usage); }
  private append(receipt: ModelCallReceipt, phase: "started" | "finished", usage?: Usage): void {
    this.store.appendEvent(this.fence, { eventId: createRuntimeId("event", `model-call-${randomUUID()}`), eventType: "model.call", ownerGeneration: this.fence.generation,
      payloadJson: JSON.stringify({ type: "model_call", originSessionId: this.fence.sessionId, ...receipt, phase, usage }), createdAtMs: Date.now(), expectedPreviousEventHash: this.store.latestEventHead(this.fence.sessionId).hash });
  }
  observe(create: () => AssistantMessageEventStream, metadata?: Record<string, unknown>): AssistantMessageEventStream {
    const receipt = this.start(metadata?.modelCallId ?? metadata?.requestId);
    try {
      const stream = create();
      // result() 是独立终态 promise，不消费下游使用的 async iterator。
      void stream.result().then((message) => this.finish(receipt, message.usage)).catch(() => {
        // started 记录保留未知用量；不把遥测写入错误冒充 provider 错误。
      });
      return stream;
    } catch (error) { this.finish(receipt); throw error; }
  }
}
/** 显式转发 catalog/auth 方法，流式与非流式调用共用同一个观察边界。 */
export function observeSessionModels(models: Models, calls: SessionModelCalls): Models {
  const observed: Models = {
    getProviders: models.getProviders.bind(models), getProvider: models.getProvider.bind(models),
    getModels: models.getModels.bind(models), getModel: models.getModel.bind(models), refresh: models.refresh.bind(models),
    checkAuth: models.checkAuth.bind(models), getAvailable: models.getAvailable.bind(models), getAuth: models.getAuth.bind(models),
    login: models.login.bind(models), logout: models.logout.bind(models),
    stream: (model, context, options) => calls.observe(() => models.stream(model, context, options), options?.metadata),
    streamSimple: (model, context, options) => calls.observe(() => models.streamSimple(model, context, options), options?.metadata),
    complete: (model, context, options) => observed.stream(model, context, options).result(),
    completeSimple: (model, context, options) => observed.streamSimple(model, context, options).result(),
  };
  return observed;
}
