import type { TuiPortRequest, TuiResultEnvelope } from "../application/common.ts";
import type { SafeBoundedText } from "../presentation/tools/types.ts";

export type WorkspaceGitHead =
	| { readonly kind: "branch"; readonly name: SafeBoundedText }
	| { readonly kind: "detached"; readonly commitPrefix: SafeBoundedText }
	| { readonly kind: "unavailable"; readonly reason: string };

export interface WorkspaceGitSnapshot {
	readonly workspaceId: string;
	readonly observedRevision: number;
	readonly head: WorkspaceGitHead;
}

export type WorkspaceGitResult = TuiResultEnvelope<WorkspaceGitSnapshot>;

export type WorkspaceGitWorkflowState =
	| { readonly state: "unavailable"; readonly reason: string }
	| { readonly state: "idle"; readonly generation: number }
	| { readonly state: "loading"; readonly generation: number; readonly requestId: string }
	| { readonly state: "ready"; readonly generation: number; readonly value: WorkspaceGitSnapshot }
	| { readonly state: "error"; readonly generation: number; readonly code: string; readonly message: string; readonly retryable: boolean };

export interface WorkspaceGitPort {
	readonly inspect: (input: TuiPortRequest & { readonly workspaceId: string }) => Promise<WorkspaceGitResult>;
}
