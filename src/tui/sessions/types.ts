import type { TuiField } from "../application/common.ts";
import type { SafeBoundedText } from "../presentation/tools/types.ts";
import type { TimelineState } from "../timeline/types.ts";

export type CanonicalSessionFormat = "current-canonical";

export type SessionLifecycle =
	| "active"
	| "read-only"
	| "stopped"
	| "recovery-required"
	| "unknown";

export type SessionLineage =
	| { readonly kind: "root"; readonly rootSessionId: string }
	| {
			readonly kind: "fork";
			readonly rootSessionId: string;
			readonly parentSessionId: string;
			readonly parentCursor: string;
			readonly goalMode: "continue-existing-goal" | "create-child-goal";
	  };

export interface SessionSummary {
	readonly id: string;
	readonly title: string;
	readonly locator: SafeBoundedText;
	readonly cwdLabel: string;
	readonly createdAt: string;
	readonly updatedAt: string;
	readonly lifecycle: SessionLifecycle;
	readonly access: "read-write" | "read-only" | "unavailable";
	readonly format: CanonicalSessionFormat;
	readonly lineage: SessionLineage;
	readonly current: boolean;
}

/** SQLite session catalog 的真实公开投影；不补造 title、cwd、locator 或 lineage。 */
export interface SessionCatalogItem {
	readonly sessionId: string;
	readonly workspaceId: string;
	readonly repositoryId: string;
	readonly status: string;
	readonly createdAtMs: number;
	readonly updatedAtMs: number;
	readonly headSequence: number;
	readonly driverRevision: number;
	readonly current: boolean;
}

export interface SessionSelection {
	readonly providerId: TuiField<string>;
	readonly modelId: TuiField<string>;
	readonly thinkingLevel: TuiField<string>;
}

export interface SessionDetail {
	readonly summary: SessionSummary;
	readonly messageCount: TuiField<number>;
	readonly turnCount: TuiField<number>;
	readonly toolCount: TuiField<number>;
	readonly selection: TuiField<SessionSelection>;
	readonly headCursor: TuiField<string>;
	readonly lineage: SessionLineage;
}

export interface SessionPreviewMessage {
	readonly role: "user" | "assistant" | "tool" | "notice";
	readonly text: string;
	readonly truncated: boolean;
}

export interface SessionPreview {
	readonly summary: SessionSummary;
	readonly messages: readonly SessionPreviewMessage[];
	readonly timeline: TimelineState;
	readonly truncated: boolean;
	readonly sourceBytes: TuiField<number>;
}

export type SessionDiagnostic =
	| { readonly kind: "corrupt"; readonly message: string }
	| { readonly kind: "oversize"; readonly message: string }
	| { readonly kind: "staging"; readonly message: string }
	| { readonly kind: "unpublished"; readonly message: string }
	| { readonly kind: "symlink"; readonly message: string }
	| { readonly kind: "changed"; readonly message: string };

export type SessionCatalogResult = { readonly kind: "catalog"; readonly revision: number; readonly items: readonly SessionCatalogItem[] };
export type SessionDetailResult = { readonly kind: "detail"; readonly value: SessionDetail };
export type SessionPreviewResult = { readonly kind: "preview"; readonly value: SessionPreview };
export type SessionTransitionResult = {
	readonly kind: "transition";
	readonly operation: "create" | "resume" | "fork";
	readonly targetSessionId: string;
	readonly catalogRevision: number;
	readonly attemptId?: string;
};
export type SessionWorkflowValue = SessionCatalogResult | SessionDetailResult | SessionPreviewResult | SessionTransitionResult;

export type SessionWorkflowState =
	| { readonly state: "idle"; readonly generation: number }
	| { readonly state: "loading"; readonly generation: number; readonly requestId: string }
	| { readonly state: "ready"; readonly generation: number; readonly value: SessionWorkflowValue }
	| { readonly state: "empty"; readonly generation: number }
	| { readonly state: "error"; readonly generation: number; readonly code: string; readonly message: string; readonly retryable: boolean };

export type SessionTransitionState =
	| { readonly state: "idle"; readonly generation: number }
	| { readonly state: "requesting"; readonly generation: number; readonly intentId: string; readonly expectedRevision: number }
	| {
			readonly state: "confirming";
			readonly generation: number;
			readonly intentId: string;
			readonly expectedRevision: number;
			readonly targetSessionId: string;
	  }
	| { readonly state: "succeeded"; readonly generation: number; readonly intentId: string; readonly targetSessionId: string }
	| { readonly state: "recovery-required"; readonly generation: number; readonly intentId: string; readonly message: string }
	| { readonly state: "failed"; readonly generation: number; readonly intentId: string; readonly message: string; readonly retryable: boolean };
