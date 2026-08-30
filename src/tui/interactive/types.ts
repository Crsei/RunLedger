/**
 * S7 拆分:InteractiveMode 协作者共享的窄 port 契约。
 *
 * facade(interactive-mode.ts)实现本接口并把自身能力注入各 workflow /
 * controller;协作者不反向访问 facade 私有状态。WorkflowKey 与
 * WorkflowResult 由 store workflow 形状投影。
 */

import type { Agent } from "../../runtime/agent.ts";
import type { InteractiveSessionControllerPort } from "../../runtime/interactive-session-controller.ts";
import type { Theme } from "../theme/theme.ts";
import type { SyntaxThemeController } from "../highlight/theme-controller.ts";
import type { SyntaxThemeSettingsPort } from "../interactive-mode.ts";
import type { HideThinkingSettingsPort } from "../interactive-mode.ts";
import type { HostConnectionUiState } from "../interactive-mode.ts";
import type { TUI, Component, OverlayOptions } from "../index.ts";
import type { CustomEditor } from "../components/custom-editor.ts";
import type { ChatContainer } from "../components/chat-container.ts";
import type { StatusComponent } from "../components/status.ts";
import type { WelcomeComponent } from "../components/welcome.ts";
import type { ProcessOverlayComponent } from "../process/overlay-component.ts";
import type { TuiStore } from "../application/store.ts";
import type { EffectRunner } from "../application/effect-runner.ts";
import type { TuiEffect } from "../application/effect.ts";
import type { TuiOverlayState } from "../application/state.ts";
import type { TimelineEvent } from "../timeline/types.ts";
import type { TuiPreferencesPort, TuiShimmerMode } from "../preferences/types.ts";
import type { InteractiveSessionAdapter } from "../adapters/interactive-session.ts";
import type { InteractiveExitIntent } from "../interactive-mode.ts";

export type WorkflowKey =
	| "sessionWorkflow"
	| "extensionWorkflow"
	| "providerWorkflow"
	| "modelWorkflow"
	| "thinkingWorkflow"
	| "authWorkflow"
	| "promptWorkflow"
	| "keymapWorkflow"
	| "runtimeSnapshotWorkflow"
	| "processWorkflow"
	| "taskGoalWorkflow"
	| "planWorkflow"
	| "agentWorkflow"
	| "securityModeWorkflow"
	| "workspaceGitWorkflow"
	| "updateWorkflow"
	| "queueWorkflow"
	| "approvalWorkflow"
	| "shutdownWorkflow";

export interface WorkflowResult {
	readonly state: string;
	readonly value?: unknown;
	readonly message?: string;
	readonly reason?: string;
}

export interface InteractiveModePorts {
	readonly ui: TUI;
	readonly store: TuiStore;
	readonly runner: EffectRunner;
	readonly controller: InteractiveSessionControllerPort | undefined;
	readonly agent: Agent | undefined;
	readonly authAdapter: InteractiveSessionAdapter;
	readonly theme: Theme;
	readonly refs: {
		readonly editor: CustomEditor;
		readonly chat: ChatContainer;
		readonly status: StatusComponent;
		readonly welcome: WelcomeComponent | undefined;
	};
	readonly quitting: boolean;
	readonly hideThinkingSettingsPort?: HideThinkingSettingsPort;
	readonly preferencesPort?: TuiPreferencesPort;
	readonly shimmerMode: TuiShimmerMode;
	readonly syntaxThemeController: SyntaxThemeController;
	readonly syntaxThemeSettingsPort?: SyntaxThemeSettingsPort;
	readonly processOverlayComponent: ProcessOverlayComponent | undefined;
	readonly hostConnectionState: HostConnectionUiState;
	/** session domain port(session.create/resume/fork 等 mutation 经它派发)。 */
	readonly sessionPort?: unknown;

	showNotice(text: string, kind?: "note" | "error"): void;
	showOverlayModal(component: Component, options?: OverlayOptions, kind?: Exclude<TuiOverlayState["state"], "closed">): void;
	closeOverlay(): void;
	createEffect(type: TuiEffect["type"], extra?: Record<string, unknown>): TuiEffect;
	waitForWorkflow(key: WorkflowKey, requestId: string): Promise<WorkflowResult>;
	dispatchTimeline(events: readonly TimelineEvent[]): void;
	requestExit(intent: InteractiveExitIntent): Promise<void>;
	inFlight(): boolean;
	getSessionId(): string;
	hideSlashPopup(): void;
	uiRequestRender(): void;
	syncThinkingWorkflow(): Promise<void>;
	openModelSelector(provider?: string): void;
	nextCorrelationId(): number;
	nextEffectId(): number;
	processOverlaySnapshot(): boolean | undefined;
	interruptCurrentTurn(): void;
	clearIdleRecapStatus(): void;
	keyBindings(): Record<string, string | readonly string[] | undefined>;
	refreshSessionCatalog(): Promise<void>;
	setStreaming(value: boolean): void;
	setStopReason(value: string | undefined): void;
	dispatchCommand(command: unknown, arg: string): void;
}

export type { InteractiveExitIntent };
