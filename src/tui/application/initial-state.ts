/**
 * 从显式 bootstrap/capability input 构造完整 TuiState 的 initial fixture。
 *
 * 纯函数：不接 renderer、Theme、controller instance 或 callback；所有 workflow
 * 都有显式初态。capability 未提供时 workflow 进入 unavailable（不显示 0、
 * 空列表或伪 connected），提供时进入 idle（generation 0）。
 */

import type { PortAvailability, TuiField } from "./common.ts";
import type { TuiCapabilitySnapshot, TuiState } from "./state.ts";
import type { TuiBootstrapSnapshot } from "../presentation/types.ts";

export interface InitialTuiStateInput {
  readonly bootstrap: TuiBootstrapSnapshot;
  readonly capabilities?: Partial<TuiCapabilitySnapshot>;
  readonly preferences?: {
    readonly transcriptScrollbarVisible?: boolean;
  };
}

/** 未接线端口统一落到 explicit unavailable；调用方可按真实端口覆盖。 */
export function defaultCapabilities(): TuiCapabilitySnapshot {
  const unavailable: PortAvailability = { state: "unavailable", reason: "port-not-wired" };
  return {
    sessionCatalog: unavailable,
    sessionMutation: unavailable,
    provider: unavailable,
    auth: unavailable,
    model: unavailable,
    thinking: unavailable,
    prompt: unavailable,
    keymap: unavailable,
    queue: unavailable,
    approval: unavailable,
    taskGoal: unavailable,
    plan: unavailable,
    agents: unavailable,
    extensions: unavailable,
    mcp: unavailable,
    runtimeSnapshot: unavailable,
    securityMode: unavailable,
    shutdown: unavailable,
    workspaceGit: unavailable,
    process: unavailable,
    update: unavailable,
  };
}

const notQueried: TuiField<number> = { state: "unknown", reason: "not-yet-queried" };

export function createInitialTuiState(input: InitialTuiStateInput): TuiState {
  const capabilities: TuiCapabilitySnapshot = { ...defaultCapabilities(), ...input.capabilities };
  return {
    bootstrap: input.bootstrap,
    authorityGeneration: input.bootstrap.authorityGeneration,
    capabilities,
    queryGuard: { state: "idle" },
    commandsById: {},
    commandOrder: [],
    transientInputQueue: [],
    timeline: {
      generation: 0,
      committedRows: [],
      activeRowsByCorrelationId: {},
      activeOrder: [],
      cursor: { messageIndex: 0 },
    },
    sessionWorkflow: { state: "idle", generation: 0 },
    providerWorkflow: initialWorkflow(capabilities.provider),
    authWorkflow: initialWorkflow(capabilities.auth),
    modelWorkflow: initialWorkflow(capabilities.model),
    thinkingWorkflow: initialWorkflow(capabilities.thinking),
    promptWorkflow: initialWorkflow(capabilities.prompt),
    keymapWorkflow: initialWorkflow(capabilities.keymap),
    queueWorkflow: initialWorkflow(capabilities.queue),
    approvalWorkflow: initialWorkflow(capabilities.approval),
    taskGoalWorkflow: initialWorkflow(capabilities.taskGoal),
    planWorkflow: initialWorkflow(capabilities.plan),
    agentWorkflow: initialWorkflow(capabilities.agents),
    extensionWorkflow: initialWorkflow(capabilities.extensions),
    runtimeSnapshotWorkflow: initialWorkflow(capabilities.runtimeSnapshot),
    securityModeWorkflow: initialWorkflow(capabilities.securityMode),
    shutdownWorkflow: initialWorkflow(capabilities.shutdown),
    workspaceGitWorkflow: initialWorkflow(capabilities.workspaceGit),
    processWorkflow: initialWorkflow(capabilities.process),
    updateWorkflow: initialWorkflow(capabilities.update),
    interaction: {
      overlay: { state: "closed" },
      search: { state: "unknown", reason: "no-active-search" },
      selectedId: { state: "unknown", reason: "no-selection" },
      generation: 0,
      viewportClearRevision: 0,
	  transcriptScrollbarVisible: input.preferences?.transcriptScrollbarVisible ?? false,
	  terminalFocused: true,
	  viewport: { columns: 0, rows: 0 },
      toolDetailsExpanded: false,
      composerEmpty: true,
      composerDraft: { text: "", truncated: false, byteLength: 0 },
      transitionFrozen: false,
    },
    activeTurn: notQueried,
    steeringCount: notQueried,
    followUpCount: notQueried,
    claimedQueueCount: notQueried,
    pendingApprovalCount: notQueried,
    transitionFrozen: false,
    recoveryRequired: false,
  };
}

/** workflow 初态：capability 缺失 → unavailable；否则 idle(generation 0)。 */
function initialWorkflow(
  capability: PortAvailability,
):
  | { readonly state: "unavailable"; readonly reason: string }
  | { readonly state: "idle"; readonly generation: number } {
  return capability.state === "available"
    ? { state: "idle", generation: 0 }
    : { state: "unavailable", reason: capability.reason };
}
