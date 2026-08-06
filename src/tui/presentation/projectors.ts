/**
 * 只读 presentation projector：bootstrap/status/footer/welcome/composer 的
 * 纯投影。不接 renderer、Theme、controller instance 或 callback；标签一律
 * 经有界 + 终端安全处理（strip ANSI、按字节截断）。
 */

import type { PortAvailability, TuiField } from "../application/common.ts";
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
    sessionLabel: sanitizeLabel(bootstrap.session.id) || "unknown",
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

/** availability 辅助：capability -> 可见原因文本（不显示 0/空/伪 connected）。 */
export function availabilityReason(availability: PortAvailability): string {
  return availability.state === "available" ? "available" : availability.reason;
}

export type { TuiSessionLifecycle };
