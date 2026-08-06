/**
 * InteractiveSessionController -> typed workflow 结果 adapter。
 *
 * controller 方法调用 + typed envelope 包装；错误编码为 failed（不抛）；
 * 标签经有界 + 终端安全处理。controller 缺失时端口为 undefined
 * （capability unavailable，不发 effect）。
 *
 * auth interaction（secret/URL 提示）是短生命周期 owner：调用方在 dispatch
 * auth.login 前通过 setAuthInteraction 注入；AbortController 由 runner 提供，
 * 不进入 cloneable state。
 */

import type { TuiPortRequest, TuiResultEnvelope } from "../application/common.ts";
import type { TuiDomainPorts } from "../application/ports.ts";
import type { ProviderWorkflowPort, ProviderCatalogSnapshot, ProviderSelectionSnapshot } from "../providers/types.ts";
import type { ModelWorkflowPort, ModelCatalogSnapshot, ModelSelectionSnapshot } from "../models/types.ts";
import type { ThinkingWorkflowPort, ThinkingSnapshot } from "../thinking/types.ts";
import type { AuthWorkflowPort, AuthSnapshot, AuthProviderSnapshot, AuthInteractionState } from "../auth/types.ts";
import type { ShutdownWorkflowPort, ShutdownReceipt } from "../shutdown/types.ts";
import { boundedToolText } from "../presentation/tools/projector.ts";
import { getSupportedThinkingLevels } from "../../models.ts";
import type { InteractiveSessionControllerPort } from "../../runtime/interactive-session-controller.ts";
import type { AuthInteraction, AuthType } from "../../auth/types.ts";
import type { ModelThinkingLevel } from "../../types.ts";

const LABEL_BOUND = 120;

function envelope<T>(request: TuiPortRequest, produce: () => Promise<T | TuiResultEnvelope<T>>): Promise<TuiResultEnvelope<T>> {
	return produce().then(
		(value) => {
			if (isEnvelope(value)) return value;
			return { ok: true as const, ref: request, value };
		},
		(error: unknown) => ({
			ok: false as const,
			ref: request,
			error: { code: "controller_error", message: String(error), retryable: true },
		}),
	);
}

function isEnvelope(value: unknown): value is TuiResultEnvelope<unknown> {
	return typeof value === "object" && value !== null && "ok" in value && "ref" in value;
}

function fail<T>(request: TuiPortRequest, code: string, message: string, retryable = false): Promise<TuiResultEnvelope<T>> {
	return Promise.resolve({ ok: false, ref: request, error: { code, message, retryable } });
}

export interface InteractiveSessionAdapter {
	readonly ports: TuiDomainPorts;
	/** auth interaction 槽：login 前注入，login 完成后由调用方清空（短生命周期 owner）。 */
	setAuthInteraction(interaction: AuthInteraction | undefined): void;
}

export function createInteractiveSessionAdapter(controller: InteractiveSessionControllerPort | undefined): InteractiveSessionAdapter {
	if (controller === undefined) return { ports: {}, setAuthInteraction: () => undefined };
	let authInteraction: AuthInteraction | undefined;

	const providerPort: ProviderWorkflowPort = {
		list: (request) => envelope(request, async () => {
			const statuses = await controller.getProviderStatuses();
			const providers = statuses.map((status) => ({
				providerId: status.id,
				label: boundedToolText(status.name, LABEL_BOUND),
				status: status.configured ? "ready" as const : "not-configured" as const,
				authKinds: status.interactiveAuthTypes.map((type) => type === "api_key" ? "api-key" as const : "oauth" as const),
				generation: 1,
			}));
			const snapshot: ProviderCatalogSnapshot = {
				providers,
				models: [],
				generation: 1,
			};
			return snapshot;
		}),
		select: async (request) => fail<ProviderSelectionSnapshot>(request, "not_supported", "provider selection is a model/thinking concern"),
	};
	const modelPort: ModelWorkflowPort = {
		list: (request) => envelope(request, async () => {
			const models = await controller.getAvailableModels(request.providerId.length === 0 ? undefined : request.providerId);
			const snapshot: ModelCatalogSnapshot = {
				providerId: request.providerId,
				models: models.map((model) => ({
					providerId: model.provider,
					modelId: model.id,
					label: boundedToolText(model.name ?? model.id, LABEL_BOUND),
					contextWindow: typeof model.contextWindow === "number"
						? { state: "known", value: model.contextWindow }
						: { state: "unknown", reason: "not-reported" },
					availability: "available",
					generation: 1,
				})),
				generation: 1,
			};
			return snapshot;
		}),
		select: (request) => envelope(request, async () => {
			const models = await controller.getAvailableModels(request.providerId);
			const model = models.find((candidate) => candidate.id === request.modelId);
			if (model === undefined) {
				return { ok: false, ref: request, error: { code: "model_not_found", message: `model ${request.modelId} not found for ${request.providerId}`, retryable: false } };
			}
			await controller.selectModel(model);
			// controller 返回 authoritative selection 后再更新 view
			const selection = controller.currentSelection;
			const snapshot: ModelSelectionSnapshot = {
				providerId: selection.provider ?? request.providerId,
				modelId: typeof selection.model === "string" ? selection.model : (selection.model as { id?: string } | undefined)?.id ?? request.modelId,
				generation: 1,
			};
			return { ok: true, ref: request, value: snapshot };
		}),
	};
	const thinkingPort: ThinkingWorkflowPort = {
		inspect: (request) => envelope(request, async () => {
			const model = controller.currentSelection.model;
			const availableLevels: (ModelThinkingLevel | "unknown")[] = model === undefined
				? []
				: [...getSupportedThinkingLevels(model)];
			const snapshot: ThinkingSnapshot = {
				level: controller.currentSelection.thinkingLevel,
				availableLevels: availableLevels.length > 0 ? availableLevels : ["off"],
				generation: 1,
			};
			return snapshot;
		}),
		select: (request) => envelope(request, async () => {
			const level = await controller.setThinkingLevel(request.level);
			const snapshot: ThinkingSnapshot = {
				level,
				availableLevels: [],
				generation: 1,
			};
			return { ok: true, ref: request, value: snapshot };
		}),
	};
	const authPort: AuthWorkflowPort = {
		inspect: (request) => envelope(request, async () => {
			const statuses = await controller.getProviderStatuses();
			const providers: AuthProviderSnapshot[] = statuses.map((status) => ({
				providerId: status.id,
				providerLabel: boundedToolText(status.name, LABEL_BOUND),
				configured: status.configured ? "yes" : "no",
				authKind: status.interactiveAuthTypes.includes("oauth") ? "oauth" : status.interactiveAuthTypes.includes("api_key") ? "api-key" : "unknown",
				sourceLabel: status.source === undefined ? undefined : boundedToolText(status.source, LABEL_BOUND),
			}));
			const snapshot: AuthSnapshot = {
				providers,
				generation: 1,
				interaction: { state: "idle" },
			};
			return snapshot;
		}),
		beginLogin: (request) => envelope(request, async () => {
			const interaction = authInteraction;
			if (interaction === undefined) {
				return { ok: false, ref: request, error: { code: "auth_interaction_required", message: "no auth interaction owner is attached", retryable: false } };
			}
			// runner 的 AbortController 即登录生命周期信号
			const type: AuthType = request.authKind === "oauth" ? "oauth" : "api_key";
			await controller.login(request.providerId, type, interaction);
			const snapshot: AuthSnapshot = {
				providers: [],
				generation: 1,
				interaction: { state: "completed", requestId: request.correlationId },
			};
			return { ok: true, ref: request, value: snapshot };
		}),
		logout: (request) => envelope(request, async () => {
			await controller.logout(request.providerId);
			const snapshot: AuthSnapshot = {
				providers: [],
				generation: 1,
				interaction: { state: "idle" },
			};
			return { ok: true, ref: request, value: snapshot };
		}),
	};
	// B6:本地 shutdown 只提交 intent；renderer/lifecycle cleanup 由调用方执行
	const shutdownPort: ShutdownWorkflowPort = {
		request: (request) => envelope(request, async () => {
			const receipt: ShutdownReceipt = {
				trigger: request.trigger,
				outcome: "accepted",
				recoveryRequired: false,
			};
			return receipt;
		}),
	};
	return {
		ports: { provider: providerPort, model: modelPort, thinking: thinkingPort, auth: authPort, shutdown: shutdownPort },
		setAuthInteraction: (interaction) => {
			authInteraction = interaction;
		},
	};
}

export type { AuthInteractionState };
