/** TUI facade：配置读取留在本地，所有 session/turn mutation 交给 Control Plane client。 */

import type { AuthInteraction, AuthType, Credential } from "../../auth/types.ts";
import type { Provider } from "../../models.ts";
import type { Api, Model, ModelThinkingLevel } from "../../types.ts";
import type {
	InteractiveSessionControllerPort,
	ProviderStatus,
	RuntimeSelection,
} from "../interactive-session-controller.ts";
import type { AgentEventSink, AgentMessage, UserAgentMessage } from "../types.ts";
import type { LedgerEntry } from "../ledger/types.ts";

export interface GovernedInteractiveMutationPort {
	prompt(text: string, behavior?: "steer" | "followUp"): Promise<void>;
	interrupt(): void;
	cancelAllQueues(reason?: string): Promise<{ steering: UserAgentMessage[]; followUp: UserAgentMessage[] }>;
	waitForIdle(): Promise<void>;
	dispose(): void;
}

export interface GovernedInteractiveSessionFacadeOptions {
	/** Provider/model/auth 与 transient Agent event 的 Runtime-owned view。 */
	view: InteractiveSessionControllerPort;
	/** 必须由 versioned Control Plane client 实现，不得直接调用 Agent mutation。 */
	mutations: GovernedInteractiveMutationPort;
}

/**
 * InteractiveMode 只看到此对象。持久状态 mutation 无法落回 view；view 仅提供
 * provider/auth 配置、历史快照和 Runtime 发出的 transient render events。
 */
export class GovernedInteractiveSessionFacade implements InteractiveSessionControllerPort {
	readonly #view: InteractiveSessionControllerPort;
	readonly #mutations: GovernedInteractiveMutationPort;

	public constructor(options: GovernedInteractiveSessionFacadeOptions) {
		this.#view = options.view;
		this.#mutations = options.mutations;
	}

	public get sessionId(): string { return this.#view.sessionId; }
	public get inFlight(): boolean { return this.#view.inFlight; }
	public get currentSelection(): RuntimeSelection { return this.#view.currentSelection; }
	public get messages(): readonly AgentMessage[] { return this.#view.messages; }
	public get warnings(): readonly string[] { return this.#view.warnings; }
	public get auditEntries(): readonly LedgerEntry[] { return this.#view.auditEntries; }
	public get toolCount(): number { return this.#view.toolCount; }
	public getExtensionSnapshot() { return this.#view.getExtensionSnapshot?.(); }
	public reloadExtensions() {
		return this.#view.reloadExtensions?.() ?? Promise.resolve({
			status: "failed" as const,
			reason: "production Extension runtime is not configured",
		});
	}
	public mutateExtension(
		input: Parameters<NonNullable<InteractiveSessionControllerPort["mutateExtension"]>>[0],
	) {
		return this.#view.mutateExtension?.(input) ?? Promise.resolve({
			ok: false,
			status: "failed" as const,
			message: "governed Extension mutation ports are not configured",
		});
	}

	public subscribe(listener: AgentEventSink): () => void { return this.#view.subscribe(listener); }
	public getProviderStatuses(): Promise<ProviderStatus[]> { return this.#view.getProviderStatuses(); }
	public getProvider(id: string): Provider | undefined { return this.#view.getProvider(id); }
	public getAvailableModels(provider?: string): Promise<readonly Model<Api>[]> {
		return this.#view.getAvailableModels(provider);
	}
	public login(providerId: string, type: AuthType, interaction: AuthInteraction): Promise<Credential> {
		return this.#view.login(providerId, type, interaction);
	}
	public logout(providerId: string): Promise<void> { return this.#view.logout(providerId); }
	public selectModel(model: Model<Api>): Promise<void> { return this.#view.selectModel(model); }
	public setThinkingLevel(level: ModelThinkingLevel): Promise<ModelThinkingLevel> {
		return this.#view.setThinkingLevel(level);
	}
	public prompt(text: string, behavior?: "steer" | "followUp"): Promise<void> {
		return this.#mutations.prompt(text, behavior);
	}
	public interrupt(): void { this.#mutations.interrupt(); }
	public cancelAllQueues(
		reason?: string,
	): Promise<{ steering: UserAgentMessage[]; followUp: UserAgentMessage[] }> {
		return this.#mutations.cancelAllQueues(reason);
	}
	public waitForIdle(): Promise<void> { return this.#mutations.waitForIdle(); }
	public dispose(): void { this.#mutations.dispose(); }
}
