import type { TuiEffect, TuiResult, TuiTerminalState } from "./types.ts";
import type { TuiEffectPorts } from "./effects.ts";
import type { ProviderWorkflowResult } from "../providers/types.ts";

export class EffectRunner {
  private readonly ports: TuiEffectPorts;

  constructor(ports: TuiEffectPorts) {
    this.ports = ports;
  }

  async execute(effect: TuiEffect, signal: AbortSignal): Promise<TuiResult> {
    try {
      if (effect.type === "provider.status") {
        const result = await providerResult(signal, async () => {
          const port = this.ports.providerWorkflow;
          if (!port) throw new Error("provider workflow is unavailable");
          const statuses = await port.getProviderStatuses();
          return {
            statuses,
            currentSelection: port.currentSelection,
          };
        });
        return {
          type: "provider.status.completed",
          effectId: effect.effectId,
          correlationId: effect.correlationId,
          generation: effect.generation,
          statusRequestId: effect.statusRequestId,
          result,
        };
      }
      if (effect.type === "provider.models") {
        const result = await providerResult(signal, async () => {
          const port = this.ports.providerWorkflow;
          if (!port) throw new Error("provider workflow is unavailable");
          return { models: await port.getAvailableModels(effect.providerId) };
        });
        return {
          type: "provider.models.completed",
          effectId: effect.effectId,
          correlationId: effect.correlationId,
          generation: effect.generation,
          modelsRequestId: effect.modelsRequestId,
          providerId: effect.providerId,
          result,
        };
      }
      if (effect.type === "provider.select-model") {
        const result = await providerResult(signal, async () => {
          const port = this.ports.providerWorkflow;
          if (!port) throw new Error("provider workflow is unavailable");
          await port.selectModel(effect.model);
          return { selection: port.currentSelection };
        });
        return {
          type: "provider.select-model.completed",
          effectId: effect.effectId,
          correlationId: effect.correlationId,
          generation: effect.generation,
          selectionRequestId: effect.selectionRequestId,
          providerId: effect.providerId,
          modelKey: effect.modelKey,
          result,
        };
      }
      if (effect.type === "session.list") {
        const result = this.ports.sessionCatalog
          ? await this.ports.sessionCatalog.listLite({
              query: effect.query,
              listRequestId: effect.listRequestId,
              signal,
            })
          : {
              ok: false as const,
              error: {
                code: "directory_unavailable" as const,
                message: "session catalog is unavailable",
                retryable: false,
              },
            };
        return {
          type: "session.list.completed",
          effectId: effect.effectId,
          correlationId: effect.correlationId,
          generation: effect.generation,
          listRequestId: effect.listRequestId,
          result,
        };
      }
      if (effect.type === "session.enrich" || effect.type === "session.current.enrich") {
        const result = this.ports.sessionCatalog
          ? await this.ports.sessionCatalog.enrich({
              sessionId: effect.sessionId,
              enrichRequestId: effect.enrichRequestId,
              signal,
            })
          : {
              ok: false as const,
              error: {
                code: "directory_unavailable" as const,
                message: "session catalog is unavailable",
                retryable: false,
              },
            };
        return {
          type: effect.type === "session.enrich"
            ? "session.enrich.completed"
            : "session.current.enrich.completed",
          effectId: effect.effectId,
          correlationId: effect.correlationId,
          generation: effect.generation,
          enrichRequestId: effect.enrichRequestId,
          sessionId: effect.sessionId,
          result,
        };
      }
      if (effect.type === "session.preview") {
        const result = this.ports.sessionCatalog
          ? await this.ports.sessionCatalog.loadFullPreview({
              sessionId: effect.sessionId,
              previewRequestId: effect.previewRequestId,
              signal,
            })
          : {
              ok: false as const,
              error: {
                code: "directory_unavailable" as const,
                message: "session catalog is unavailable",
                retryable: false,
              },
            };
        return {
          type: "session.preview.completed",
          effectId: effect.effectId,
          correlationId: effect.correlationId,
          generation: effect.generation,
          previewRequestId: effect.previewRequestId,
          sessionId: effect.sessionId,
          result,
        };
      }
      let terminal: TuiTerminalState;
      if (effect.type === "prompt") {
        await this.ports.prompt.run(effect.text, effect.behavior, signal);
        terminal = { state: "succeeded" };
      } else {
        terminal = await this.ports.compatibility.execute(
          effect.canonicalName,
          effect.normalizedArgs,
          signal,
        );
      }
      return {
        type: "effect.completed",
        effectId: effect.effectId,
        correlationId: effect.correlationId,
        terminal,
      };
    } catch (error) {
      const terminal: TuiTerminalState = signal.aborted
        ? { state: "aborted", reason: String(signal.reason ?? "aborted") }
        : { state: "failed", message: String(error), retryable: false };
      return {
        type: "effect.completed",
        effectId: effect.effectId,
        correlationId: effect.correlationId,
        terminal,
      };
    }
  }
}

async function providerResult<T>(
  signal: AbortSignal,
  run: () => Promise<T>,
): Promise<ProviderWorkflowResult<T>> {
  if (signal.aborted) {
    return {
      ok: false,
      error: { message: String(signal.reason ?? "provider workflow aborted"), retryable: false },
    };
  }
  try {
    const value = await run();
    if (signal.aborted) {
      return {
        ok: false,
        error: { message: String(signal.reason ?? "provider workflow aborted"), retryable: false },
      };
    }
    return { ok: true, value };
  } catch (error) {
    return {
      ok: false,
      error: {
        message: error instanceof Error ? error.message : String(error),
        retryable: false,
      },
    };
  }
}
