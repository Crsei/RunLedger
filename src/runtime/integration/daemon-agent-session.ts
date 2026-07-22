/** Daemon 持有的 production Agent session 组合；CLI 不参与 controller 生命周期。 */

import type { Models } from "../../models.ts";
import type { ProjectSettings } from "../../storage/settings-manager.ts";
import type { SessionReplay } from "../../storage/session-codec.ts";
import type { ProductionInteractiveRuntime } from "../../storage/production-interactive-runtime.ts";
import type { V3SessionManager } from "../../storage/v3-session-manager.ts";
import {
	InteractiveSessionController,
	type GovernedPromptRuntimeAcceptance,
	type RuntimeSelectionOverrides,
} from "../interactive-session-controller.ts";
import type { DurableQueueReceipt } from "../session/agent-loop-events.ts";
import type { SessionId } from "../protocol/v3/ids.ts";

export interface DaemonAgentSessionBindingPort {
	readonly sessionId: SessionId;
	readonly manager: V3SessionManager;
	preflightPrompt(commandId: string, text: string, expectsActiveTurn: boolean): Promise<void>;
	acceptPrompt(
		commandId: string,
		text: string,
		behavior: "start" | "steer" | "followUp",
		receipt: DurableQueueReceipt,
	): GovernedPromptRuntimeAcceptance;
	interrupt(): void;
	waitForIdle(): Promise<void>;
	close(): Promise<void>;
}

export interface DaemonAgentSessionBindingFactoryPort {
	create(manager: V3SessionManager): Promise<DaemonAgentSessionBindingPort>;
}

export interface ProductionInteractiveRuntimeFactoryPort {
	/** createProductionInteractiveRuntime 的部署层封装；成功后接管 manager。 */
	create(manager: V3SessionManager): Promise<ProductionInteractiveRuntime>;
}

type SessionValueProvider<T> = T | ((manager: V3SessionManager) => T | Promise<T>);

export interface ProductionDaemonAgentSessionFactoryOptions {
	models: Models;
	runtime: ProductionInteractiveRuntimeFactoryPort;
	systemPrompt: SessionValueProvider<string>;
	settings: SessionValueProvider<ProjectSettings>;
	overrides?: RuntimeSelectionOverrides;
}

async function resolveSessionValue<T>(
	provider: SessionValueProvider<T>,
	manager: V3SessionManager,
): Promise<T> {
	return typeof provider === "function"
		? (provider as (manager: V3SessionManager) => T | Promise<T>)(manager)
		: provider;
}

function assertProductionRuntimeBinding(
	manager: V3SessionManager,
	runtime: ProductionInteractiveRuntime,
): void {
	const identity = manager.identity();
	if (
		manager.isClosed() ||
		runtime.sessionId !== manager.sessionId() ||
		runtime.sessionEvents !== manager.sessionEvents() ||
		runtime.toolResultArtifactSink !== manager.toolResultArtifactSink() ||
		runtime.sessionRuntime.operationBudget !== runtime.operationBudget ||
		runtime.workspace.sessionId !== manager.sessionId() ||
		runtime.workspace.ownerRuntimeId !== manager.runtimeId() ||
		runtime.workspace.authorityId !== identity.authorityId ||
		runtime.workspace.tenantId !== identity.tenantId ||
		runtime.workspace.principalId !== identity.principalId ||
		!runtime.featureEvidence.features.includes("turn") ||
		!runtime.featureEvidence.features.includes("queue")
	) {
		throw new Error("daemon Agent session is not correlated to one production v3 runtime");
	}
}

class ProductionDaemonAgentSession implements DaemonAgentSessionBindingPort {
	public readonly sessionId: SessionId;
	public readonly manager: V3SessionManager;
	readonly #runtime: ProductionInteractiveRuntime;
	readonly #controller: InteractiveSessionController;
	#closePromise: Promise<void> | undefined;

	public constructor(options: {
		manager: V3SessionManager;
		runtime: ProductionInteractiveRuntime;
		controller: InteractiveSessionController;
	}) {
		this.sessionId = options.manager.sessionId();
		this.manager = options.manager;
		this.#runtime = options.runtime;
		this.#controller = options.controller;
	}

	public preflightPrompt(
		commandId: string,
		text: string,
		expectsActiveTurn: boolean,
	): Promise<void> {
		return this.#controller.preflightGovernedPrompt(expectsActiveTurn, { commandId, text });
	}

	public acceptPrompt(
		commandId: string,
		text: string,
		behavior: "start" | "steer" | "followUp",
		receipt: DurableQueueReceipt,
	): GovernedPromptRuntimeAcceptance {
		return this.#controller.acceptDurablyEnqueuedPrompt(
			text,
			behavior,
			commandId,
			receipt,
		);
	}

	public interrupt(): void {
		this.#controller.interrupt();
	}

	public waitForIdle(): Promise<void> {
		return this.#controller.waitForIdle();
	}

	public close(): Promise<void> {
		this.#closePromise ??= (async () => {
			this.#controller.dispose();
			await this.#runtime.close();
		})();
		return this.#closePromise;
	}
}

/**
 * 所有 model/tool/budget 字段都从已探测的 ProductionInteractiveRuntime 原样接入。
 * 本 factory 不接受 caller-supplied loop hooks，从而避免 daemon 旁路 Gateway。
 */
export class ProductionDaemonAgentSessionFactory implements DaemonAgentSessionBindingFactoryPort {
	readonly #models: Models;
	readonly #runtime: ProductionInteractiveRuntimeFactoryPort;
	readonly #systemPrompt: SessionValueProvider<string>;
	readonly #settings: SessionValueProvider<ProjectSettings>;
	readonly #overrides: RuntimeSelectionOverrides | undefined;

	public constructor(options: ProductionDaemonAgentSessionFactoryOptions) {
		this.#models = options.models;
		this.#runtime = options.runtime;
		this.#systemPrompt = options.systemPrompt;
		this.#settings = options.settings;
		this.#overrides = options.overrides ? { ...options.overrides } : undefined;
	}

	public async create(manager: V3SessionManager): Promise<DaemonAgentSessionBindingPort> {
		if (manager.isClosed()) throw new Error("daemon Agent factory requires an open v3 manager");
		const [systemPrompt, settings, messages, config] = await Promise.all([
			resolveSessionValue(this.#systemPrompt, manager),
			resolveSessionValue(this.#settings, manager),
			manager.replayMessages(),
			manager.replayRuntimeConfig(),
		]);
		const replay: SessionReplay = {
			messages: [...messages],
			config: { ...config },
			auditEntries: [],
			warnings: [],
		};
		const runtime = await this.#runtime.create(manager);
		try {
			assertProductionRuntimeBinding(manager, runtime);
			const controller = await InteractiveSessionController.create({
				cwd: runtime.cwd,
				sessionId: runtime.sessionId,
				tools: [...runtime.tools],
				...(runtime.beforeToolCall ? { beforeToolCall: runtime.beforeToolCall } : {}),
				...(runtime.afterToolCall ? { afterToolCall: runtime.afterToolCall } : {}),
				prepareModelRequest: runtime.prepareModelRequest,
				toolExecutionGateway: runtime.toolExecutionGateway,
				sessionEvents: runtime.sessionEvents,
				toolResultArtifactSink: runtime.toolResultArtifactSink,
				operationBudget: runtime.operationBudget,
				...(runtime.extensionRuntime ? {
					extensionLifecycle: runtime.extensionRuntime,
					toolProvider: () => runtime.toolRegistry.toContext(),
				} : {}),
				systemPrompt,
				models: this.#models,
				settings: { ...settings },
				replay,
				...(this.#overrides ? { overrides: { ...this.#overrides } } : {}),
			});
			return new ProductionDaemonAgentSession({ manager, runtime, controller });
		} catch (error) {
			try {
				await runtime.close();
			} catch (closeError) {
				throw new AggregateError(
					[error, closeError],
					"daemon Agent session creation failed and production runtime cleanup was incomplete",
				);
			}
			throw error;
		}
	}
}
