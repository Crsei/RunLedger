import type {
  InteractiveSessionControllerPort,
  ProviderStatus,
  RuntimeSelection,
} from "../../runtime/interactive-session-controller.ts";
import type { Api, Model } from "../../types.ts";

export interface ProviderWorkflowError {
  message: string;
  retryable: boolean;
}

export type ProviderWorkflowResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: ProviderWorkflowError };

export type ProviderStatusResult = ProviderWorkflowResult<{
  statuses: readonly ProviderStatus[];
  currentSelection: RuntimeSelection;
}>;

export type ProviderModelsResult = ProviderWorkflowResult<{
  models: readonly Model<Api>[];
}>;

export type ProviderSelectionResult = ProviderWorkflowResult<{
  selection: RuntimeSelection;
}>;

export type ProviderWorkflowPort = Pick<
  InteractiveSessionControllerPort,
  | "currentSelection"
  | "getProviderStatuses"
  | "getAvailableModels"
  | "login"
  | "selectModel"
>;

export interface ProviderSelectionSnapshot {
  generation: number;
  providerId: string;
  modelId: string;
  thinkingLevel: RuntimeSelection["thinkingLevel"];
}

export type ProviderWorkflowState =
  | { state: "idle"; generation: number }
  | {
      state: "loading-providers";
      generation: number;
      invocationId: string;
      statusRequestId: string;
    }
  | {
      state: "choosing-provider";
      generation: number;
      invocationId: string;
      statuses: readonly ProviderStatus[];
      query: string;
      selectedProviderId?: string;
      currentSelection: RuntimeSelection;
    }
  | {
      state: "loading-models";
      generation: number;
      invocationId: string;
      providerId: string;
      modelsRequestId: string;
    }
  | {
      state: "choosing-model";
      generation: number;
      invocationId: string;
      providerId: string;
      models: readonly Model<Api>[];
      query: string;
      selectedModelKey?: string;
    }
  | {
      state: "applying-selection";
      generation: number;
      invocationId: string;
      providerId: string;
      modelKey: string;
      selectionRequestId: string;
    }
  | {
      state: "failed";
      generation: number;
      invocationId: string;
      message: string;
      retryable: boolean;
    }
  | {
      state: "cancelled";
      generation: number;
      invocationId: string;
      reason: string;
    };

export interface ProviderLoginHandoff {
  id: string;
  providerId: string;
}

export function providerModelKey(model: Pick<Model<Api>, "provider" | "id">): string {
  return `${model.provider}/${model.id}`;
}
