import type { PortAvailability, TuiField } from "../application/common.ts";

export type TuiSessionLifecycle =
	| "active"
	| "read-only"
	| "stopped"
	| "recovery-required"
	| "unknown";

export interface TuiBootstrapSnapshot {
	readonly workspaceLabel: string;
	readonly session: {
		readonly id: string;
		readonly format: "current-canonical";
		readonly lifecycle: TuiSessionLifecycle;
		readonly title?: string;
	};
	readonly authorityGeneration: number;
}

export interface SessionStripView {
	readonly workspaceLabel: string;
	readonly sessionLabel: string;
	readonly sessionFormat: "current-canonical";
	readonly lifecycle: TuiSessionLifecycle;
	readonly authorityGeneration: number;
	readonly securityMode: "guarded" | "unrestricted" | "unknown";
	readonly host?: TuiField<string>;
	readonly clientRole?: "driver" | "observer" | "unknown";
	readonly connection: "connected" | "disconnected" | "unknown";
	readonly resync?: "synchronized" | "required" | "unknown";
}

export type ActivityPriority =
	| "recovery"
	| "frozen"
	| "approval"
	| "running"
	| "queue"
	| "unknown"
	| "idle";

export interface ActiveStateView {
	readonly priority: ActivityPriority;
	readonly query: "idle" | "dispatching" | "running";
	readonly authorityGeneration: number;
	readonly sessionCapability?: "enabled" | "disabled" | "unknown";
	readonly transition?: string;
	readonly activeTurn?: TuiField<number>;
	readonly activeToolCount?: TuiField<number>;
	readonly steeringCount?: TuiField<number>;
	readonly followUpCount?: TuiField<number>;
	readonly claimedQueueCount?: TuiField<number>;
	readonly pendingApprovalCount?: TuiField<number>;
	readonly frozen: boolean;
	readonly recoveryRequired: boolean;
	readonly goalSummary?: string;
	readonly taskSummary?: string;
}

export interface FooterView {
	readonly status: string;
	readonly securityMode: "guarded" | "unrestricted" | "unknown";
	readonly context?: TuiField<string>;
	readonly selection?: TuiField<string>;
	readonly host?: TuiField<string>;
}

export type CommandSuggestionView = {
	readonly canonicalName: string;
	readonly alias?: string;
	readonly label: string;
	readonly description: string;
	readonly catalogGeneration: number;
	readonly availability: PortAvailability;
};

export interface CommandDraftProvenance {
	readonly source: "palette" | "autocomplete";
	readonly canonicalName: string;
	readonly catalogGeneration: number;
}

export interface CommandComposerView {
	readonly mode: "prompt" | "follow-up" | "frozen";
	readonly draft?: string;
	readonly queuedCount: TuiField<number>;
	readonly frozen: boolean;
	readonly provenance?: CommandDraftProvenance;
}

export interface WelcomeView {
	readonly versionLabel: string;
	readonly modelLabel: string;
	readonly thinkingLabel: string;
	readonly directoryLabel: string;
	readonly branchLabel: string;
}
