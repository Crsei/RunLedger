import type { TuiField, TuiPortRequest, TuiResultEnvelope } from "../application/common.ts";
import type { SafeBoundedText } from "../presentation/tools/types.ts";

export interface AgentActivityView {
	readonly agentId: string;
	readonly parentAgentId: TuiField<string>;
	readonly sessionId: string;
	readonly label: SafeBoundedText;
	readonly phase: SafeBoundedText;
	readonly residency: "foreground" | "background" | "unknown";
	readonly progress: TuiField<number>;
	readonly repositoryRevision: TuiField<number>;
}

export interface AgentActivitySnapshot {
	readonly authorityGeneration: number;
	readonly agents: readonly AgentActivityView[];
}

export type AgentActivityQueryResult = TuiResultEnvelope<AgentActivitySnapshot>;

export type AgentActivityWorkflowState =
	| { readonly state: "unavailable"; readonly reason: string }
	| { readonly state: "idle"; readonly generation: number }
	| { readonly state: "loading"; readonly generation: number; readonly requestId: string }
	| { readonly state: "ready"; readonly generation: number; readonly value: AgentActivitySnapshot }
	| { readonly state: "empty"; readonly generation: number }
	| { readonly state: "error"; readonly generation: number; readonly code: string; readonly message: string; readonly retryable: boolean };

export interface AgentActivityQueryPort {
	readonly inspect: (input: TuiPortRequest) => Promise<AgentActivityQueryResult>;
}
