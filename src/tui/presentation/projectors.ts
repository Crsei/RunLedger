/**
 * 只读 presentation projector：bootstrap/status/footer/welcome/composer 的
 * 纯投影。不接 renderer、Theme、controller instance 或 callback；标签一律
 * 经有界 + 终端安全处理（strip ANSI、按字节截断）。
 */

import type { PortAvailability, TuiField } from "../application/common.ts";
import type { TuiState } from "../application/state.ts";
import type { PresentationBlock, StatusIndicatorView } from "../presentation.ts";
import { STATUS_DETAILS_MAX_LINES, STATUS_INDICATOR_FRAMES, formatElapsedCompact } from "../opentui/block-layout.ts";
import type { ActiveRunState } from "../timeline/types.ts";
import type { SafeBoundedText } from "./tools/types.ts";
import { timelineToBlocks } from "../timeline/selectors.ts";
import type {
  ActiveStateView,
  ActivityPriority,
  CommandComposerView,
  CommandDraftProvenance,
  FooterView,
  SessionStripView,
  TuiBootstrapSnapshot,
  TuiSessionLifecycle,
  WelcomeView,
} from "./types.ts";

/** 终端安全 + 有界标签：strip ANSI 控制序列、去首尾空白、按 UTF-8 字节截断。 */
export function sanitizeLabel(value: unknown, maxBytes = 80): string {
  const raw = typeof value === "string" ? value : "";
  const stripped = raw.replace(/\x1b\[[0-9;?]*[a-zA-Z]/gu, "").replace(/\x1b\][^\x07]*\x07/gu, "").trim();
  if (stripped.length === 0) return "";
  const bytes = new TextEncoder().encode(stripped);
  if (bytes.byteLength <= maxBytes) return stripped;
  const cut = bytes.subarray(0, maxBytes);
  const text = new TextDecoder("utf-8", { fatal: false }).decode(cut);
  return `${text.replace(/\uFFFD$/u, "")}…`;
}

/** TuiField<string> 形态的有界标签；unknown/unavailable 保形。 */
export function boundedField(value: unknown, maxBytes = 80): TuiField<string> {
  const text = sanitizeLabel(value, maxBytes);
  if (text.length === 0) return { state: "unknown", reason: "empty-label" };
  return { state: "known", value: text };
}

export interface StatusIndicatorFacts {
	readonly nowMs?: number;
	readonly animationFrame?: number;
	readonly interruptKey?: string;
	readonly inlineMessage?: string;
	readonly details?: readonly SafeBoundedText[];
}

/** ActiveRunState -> editor 上方的 Codex 风格状态指示帧段。 */
export function projectStatusIndicator(
	activeRun: ActiveRunState | undefined,
	facts: StatusIndicatorFacts = {},
): StatusIndicatorView | undefined {
	if (activeRun === undefined || activeRun.state === "recovery_required") return undefined;
	const nowMs = facts.nowMs ?? Date.now();
	const resumedAtMs = activeRun.lastResumedAtMs ?? activeRun.startedAtMs;
	const runningDeltaMs = activeRun.state === "working"
		? Math.max(0, nowMs - resumedAtMs)
		: 0;
	const elapsed = formatElapsedCompact((activeRun.activeDurationMs + runningDeltaMs) / 1_000);
	const frame = Math.max(0, Math.floor(facts.animationFrame ?? 0)) % STATUS_INDICATOR_FRAMES.length;
	const details = facts.details?.slice(0, STATUS_DETAILS_MAX_LINES);
	const inlineMessage = facts.inlineMessage === undefined ? undefined : sanitizeLabel(facts.inlineMessage, 120);
	return {
		indicator: activeRun.state === "waiting" ? "⏸" : STATUS_INDICATOR_FRAMES[frame] ?? STATUS_INDICATOR_FRAMES[0],
		header: activeRun.state === "waiting" ? "Waiting" : "Working",
		elapsed,
		...(activeRun.state === "working" && facts.interruptKey !== undefined ? { interruptKey: facts.interruptKey } : {}),
		...(inlineMessage === undefined || inlineMessage.length === 0 ? {} : { inlineMessage }),
		...(details === undefined || details.length === 0 ? {} : { details }),
	};
}

export interface SessionStripFacts {
  readonly securityMode?: "guarded" | "unrestricted" | "unknown";
  readonly host?: TuiField<string>;
  readonly clientRole?: "driver" | "observer" | "unknown";
  readonly connection?: "connected" | "disconnected" | "unknown";
  readonly resync?: "synchronized" | "required" | "unknown";
}

/** bootstrap + 显式 facts -> SessionStripView；缺 Host authority 时显式 unavailable。 */
export function projectSessionStrip(bootstrap: TuiBootstrapSnapshot, facts: SessionStripFacts = {}): SessionStripView {
  return {
    workspaceLabel: sanitizeLabel(bootstrap.workspaceLabel) || "unknown",
    sessionLabel: sanitizeLabel(bootstrap.session.title ?? bootstrap.session.id) || "unknown",
    sessionFormat: "current-canonical",
    lifecycle: bootstrap.session.lifecycle,
    authorityGeneration: bootstrap.authorityGeneration,
    securityMode: facts.securityMode ?? "unknown",
    host: facts.host ?? { state: "unavailable", reason: "host-authority-not-connected" },
    clientRole: facts.clientRole ?? "unknown",
    connection: facts.connection ?? "unknown",
    resync: facts.resync ?? "unknown",
  };
}

export interface ActiveStateFacts {
  readonly priority?: ActivityPriority;
  readonly query?: "idle" | "dispatching" | "running";
  readonly sessionCapability?: "enabled" | "disabled" | "unknown";
  readonly transition?: string;
  readonly activeTurn?: TuiField<number>;
  readonly activeToolCount?: TuiField<number>;
  readonly steeringCount?: TuiField<number>;
  readonly followUpCount?: TuiField<number>;
  readonly claimedQueueCount?: TuiField<number>;
  readonly pendingApprovalCount?: TuiField<number>;
  readonly frozen?: boolean;
  readonly recoveryRequired?: boolean;
  readonly goalSummary?: string;
  readonly taskSummary?: string;
}

export function projectActiveState(bootstrap: TuiBootstrapSnapshot, facts: ActiveStateFacts = {}): ActiveStateView {
  return {
    priority: facts.priority ?? "idle",
    query: facts.query ?? "idle",
    authorityGeneration: bootstrap.authorityGeneration,
    sessionCapability: facts.sessionCapability ?? "unknown",
    transition: facts.transition,
    activeTurn: facts.activeTurn,
    activeToolCount: facts.activeToolCount,
    steeringCount: facts.steeringCount,
    followUpCount: facts.followUpCount,
    claimedQueueCount: facts.claimedQueueCount,
    pendingApprovalCount: facts.pendingApprovalCount,
    frozen: facts.frozen ?? false,
    recoveryRequired: facts.recoveryRequired ?? false,
    goalSummary: facts.goalSummary,
    taskSummary: facts.taskSummary,
  };
}

export interface FooterFacts {
  readonly context?: TuiField<string>;
  readonly selection?: TuiField<string>;
  readonly host?: TuiField<string>;
}

export function projectFooter(
  bootstrap: TuiBootstrapSnapshot,
  input: {
    readonly status: string;
    readonly securityMode?: "guarded" | "unrestricted" | "unknown";
    readonly facts?: FooterFacts;
  },
): FooterView {
  return {
    status: input.status,
    securityMode: input.securityMode ?? "unknown",
    context: input.facts?.context ?? { state: "unknown", reason: "no-context" },
    selection: input.facts?.selection ?? { state: "unknown", reason: "no-selection" },
    host: input.facts?.host ?? { state: "unavailable", reason: "host-authority-not-connected" },
  };
}

export interface WelcomeFacts {
  readonly versionLabel?: string;
  readonly modelLabel?: string;
  readonly thinkingLabel?: string;
  readonly directoryLabel?: string;
  readonly branchLabel?: string;
}

export function projectWelcome(bootstrap: TuiBootstrapSnapshot, facts: WelcomeFacts = {}): WelcomeView {
  return {
    versionLabel: sanitizeLabel(facts.versionLabel) || "unknown",
    modelLabel: sanitizeLabel(facts.modelLabel) || "unknown",
    thinkingLabel: sanitizeLabel(facts.thinkingLabel) || "unknown",
    directoryLabel: sanitizeLabel(facts.directoryLabel) || bootstrap.workspaceLabel || "unknown",
    branchLabel: sanitizeLabel(facts.branchLabel) || "unknown",
  };
}

export interface ComposerFacts {
  readonly mode: "prompt" | "follow-up" | "frozen";
  readonly draft?: string;
  readonly queuedCount: TuiField<number>;
  readonly frozen: boolean;
  readonly provenance?: CommandDraftProvenance;
}

export function projectComposer(facts: ComposerFacts): CommandComposerView {
  return {
    mode: facts.mode,
    draft: sanitizeLabel(facts.draft),
    queuedCount: facts.queuedCount,
    frozen: facts.frozen,
    provenance: facts.provenance,
  };
}

export interface InteractivePresentationFacts {
  readonly sessionStrip?: SessionStripFacts;
  readonly activeState?: ActiveStateFacts;
  readonly footer?: FooterFacts;
  readonly welcome?: WelcomeFacts;
  readonly composerMode?: ComposerFacts["mode"];
  readonly footerStatus?: string;
  readonly securityMode?: "guarded" | "unrestricted" | "unknown";
  /** 仅影响 thinking block 的展示投影，不改变 canonical Timeline。 */
  readonly hideThinking?: boolean;
}

/**
 * TuiState + 显式只读 facts -> 一次完整 presentation 快照。
 *
 * renderer 与组件只消费这个结果，不再各自解释 Timeline、bootstrap 或交互状态。
 */
export interface InteractivePresentation {
  readonly timeline: readonly PresentationBlock[];
  readonly sessionStrip: SessionStripView;
  readonly activeState: ActiveStateView;
  readonly footer: FooterView;
  readonly welcome: WelcomeView;
  readonly composer: CommandComposerView;
}

export function projectInteractivePresentation(
  state: TuiState,
  facts: InteractivePresentationFacts = {},
): InteractivePresentation {
  const activeRun = state.timeline.activeRun;
  const activeState = projectActiveState(state.bootstrap, {
    priority: state.recoveryRequired
      ? "recovery"
      : state.transitionFrozen
        ? "frozen"
        : activeRun?.state === "working"
          ? "running"
          : "idle",
    query: state.queryGuard.state,
    activeTurn: state.activeTurn,
    steeringCount: state.steeringCount,
    followUpCount: state.followUpCount,
    claimedQueueCount: state.claimedQueueCount,
    pendingApprovalCount: state.pendingApprovalCount,
    frozen: state.transitionFrozen,
    recoveryRequired: state.recoveryRequired,
    ...facts.activeState,
  });
  const footerStatus = facts.footerStatus
    ?? (state.recoveryRequired
      ? "recovery-required"
      : activeRun?.state === "working"
        ? "working"
        : activeRun?.state === "waiting"
          ? "waiting"
          : "idle");
  return {
    timeline: timelineToBlocks(state.timeline, { hideThinking: facts.hideThinking }),
    sessionStrip: projectSessionStrip(state.bootstrap, {
      securityMode: facts.securityMode,
      ...facts.sessionStrip,
    }),
    activeState,
    footer: projectFooter(state.bootstrap, {
      status: footerStatus,
      securityMode: facts.securityMode,
      facts: facts.footer,
    }),
    welcome: projectWelcome(state.bootstrap, facts.welcome),
    composer: projectComposer({
      mode: facts.composerMode ?? (state.transitionFrozen ? "frozen" : "prompt"),
      draft: state.interaction.composerDraft.text,
      queuedCount: { state: "known", value: state.transientInputQueue.length },
      frozen: state.transitionFrozen,
    }),
  };
}

/** availability 辅助：capability -> 可见原因文本（不显示 0/空/伪 connected）。 */
export function availabilityReason(availability: PortAvailability): string {
  return availability.state === "available" ? "available" : availability.reason;
}

export type { TuiSessionLifecycle };
