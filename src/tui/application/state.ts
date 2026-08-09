import type { TuiField } from "./common.ts";
import type { QueryGuard, TuiExecutionState, PortAvailability } from "./common.ts";
import type { TuiBootstrapSnapshot } from "../presentation/types.ts";
import type { SafeBoundedText } from "../presentation/tools/types.ts";
import type { TimelineState } from "../timeline/types.ts";
import type { CommandIntent } from "../commands/types.ts";
import type { SessionTransitionState, SessionWorkflowState } from "../sessions/types.ts";
import type { ProviderWorkflowState } from "../providers/types.ts";
import type { AuthWorkflowState } from "../auth/types.ts";
import type { ModelWorkflowState } from "../models/types.ts";
import type { ThinkingWorkflowState } from "../thinking/types.ts";
import type { PromptWorkflowState } from "../prompts/types.ts";
import type { KeymapWorkflowState } from "../keymap/types.ts";
import type { DurableQueueWorkflowState } from "../queue/types.ts";
import type { ApprovalWorkflowState } from "../approval/types.ts";
import type { TaskGoalWorkflowState } from "../task-goal/types.ts";
import type { PlanRenderWorkflowState } from "../goal-plan/types.ts";
import type { AgentActivityWorkflowState } from "../agents/types.ts";
import type { ExtensionWorkflowState } from "../extensions/types.ts";
import type { RuntimeSnapshotWorkflowState } from "../runtime-snapshot/types.ts";
import type { SecurityModeWorkflowState } from "../security-mode/types.ts";
import type { ShutdownWorkflowState } from "../shutdown/types.ts";
import type { WorkspaceGitWorkflowState } from "../workspace/types.ts";
import type { ProcessPassiveWorkflowState } from "../process/types.ts";
import type { UpdateWorkflowState } from "../update/types.ts";

export type TuiOverlayState =
	| { readonly state: "closed" }
	| { readonly state: "command"; readonly requestId: string }
	| { readonly state: "session"; readonly requestId: string }
	| { readonly state: "provider"; readonly requestId: string }
	| { readonly state: "auth"; readonly requestId: string }
	| { readonly state: "model"; readonly requestId: string }
	| { readonly state: "thinking"; readonly requestId: string }
	| { readonly state: "prompt"; readonly requestId: string }
	| { readonly state: "extension"; readonly requestId: string }
	| { readonly state: "keymap"; readonly requestId: string }
	| { readonly state: "approval"; readonly requestId: string }
	| { readonly state: "process"; readonly requestId: string }
	| { readonly state: "transition"; readonly requestId: string };

export interface TuiInteractionState {
	readonly overlay: TuiOverlayState;
	readonly search: TuiField<string>;
	readonly selectedId: TuiField<string>;
	readonly generation: number;
	readonly viewportClearRevision: number;
	readonly terminalFocused: boolean;
	readonly viewport: { readonly columns: number; readonly rows: number };
	readonly toolDetailsExpanded: boolean;
	readonly composerEmpty: boolean;
	readonly composerDraft: SafeBoundedText;
	readonly transitionFrozen: boolean;
}

export interface TuiCapabilitySnapshot {
	readonly sessionCatalog: PortAvailability;
	readonly sessionMutation: PortAvailability;
	readonly provider: PortAvailability;
	readonly auth: PortAvailability;
	readonly model: PortAvailability;
	readonly thinking: PortAvailability;
	readonly prompt: PortAvailability;
	readonly keymap: PortAvailability;
	readonly queue: PortAvailability;
	readonly approval: PortAvailability;
	readonly taskGoal: PortAvailability;
	readonly plan: PortAvailability;
	readonly agents: PortAvailability;
	readonly extensions: PortAvailability;
	readonly runtimeSnapshot: PortAvailability;
	readonly securityMode: PortAvailability;
	readonly shutdown: PortAvailability;
	readonly workspaceGit: PortAvailability;
	readonly process: PortAvailability;
	readonly update: PortAvailability;
}

export interface TuiCommandRecord {
	readonly invocationId: string;
	readonly createdAt: string;
	readonly displayOrder: number;
	readonly canonicalName: string;
	readonly normalizedArgs: readonly string[];
	readonly execution: TuiExecutionState;
}

export interface TuiTransientInput {
	readonly id: string;
	readonly kind: "prompt" | "follow-up" | "slash";
	readonly text: SafeBoundedText;
	readonly invocationId?: string;
}

export interface TuiState {
	readonly bootstrap: TuiBootstrapSnapshot;
	readonly authorityGeneration: number;
	readonly capabilities: TuiCapabilitySnapshot;
	readonly queryGuard: QueryGuard;
	readonly commandsById: Readonly<Record<string, TuiCommandRecord>>;
	readonly commandOrder: readonly string[];
	readonly transientInputQueue: readonly TuiTransientInput[];
	readonly timeline: TimelineState;
	readonly sessionWorkflow: SessionWorkflowState;
	readonly providerWorkflow: ProviderWorkflowState;
	readonly authWorkflow: AuthWorkflowState;
	readonly modelWorkflow: ModelWorkflowState;
	readonly thinkingWorkflow: ThinkingWorkflowState;
	readonly promptWorkflow: PromptWorkflowState;
	readonly keymapWorkflow: KeymapWorkflowState;
	readonly queueWorkflow: DurableQueueWorkflowState;
	readonly approvalWorkflow: ApprovalWorkflowState;
	readonly taskGoalWorkflow: TaskGoalWorkflowState;
	readonly planWorkflow: PlanRenderWorkflowState;
	readonly agentWorkflow: AgentActivityWorkflowState;
	readonly extensionWorkflow: ExtensionWorkflowState;
	readonly runtimeSnapshotWorkflow: RuntimeSnapshotWorkflowState;
	readonly securityModeWorkflow: SecurityModeWorkflowState;
	readonly shutdownWorkflow: ShutdownWorkflowState;
	readonly workspaceGitWorkflow: WorkspaceGitWorkflowState;
	readonly processWorkflow: ProcessPassiveWorkflowState;
	readonly updateWorkflow: UpdateWorkflowState;
	readonly interaction: TuiInteractionState;
	readonly activeTurn: TuiField<number>;
	readonly steeringCount: TuiField<number>;
	readonly followUpCount: TuiField<number>;
	readonly claimedQueueCount: TuiField<number>;
	readonly pendingApprovalCount: TuiField<number>;
	readonly transitionFrozen: boolean;
	readonly recoveryRequired: boolean;
}
