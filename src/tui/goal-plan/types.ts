import type { TuiPortRequest, TuiResultEnvelope } from "../application/common.ts";
import type { SafeBoundedText } from "../presentation/tools/types.ts";

export interface PlanRenderReference {
	readonly repositoryId: string;
	readonly planId: string;
	readonly revision: number;
	readonly digestPrefix: SafeBoundedText;
}

export interface PlanRenderView {
	readonly reference: PlanRenderReference;
	readonly title: SafeBoundedText;
	readonly status: "verified" | "in-progress" | "blocked" | "unknown";
	readonly summary: SafeBoundedText;
	readonly evidenceCount: { readonly state: "known" | "unknown" | "unavailable"; readonly value?: number; readonly reason?: string };
}

export type PlanRenderQueryResult = TuiResultEnvelope<PlanRenderView>;

export type PlanRenderWorkflowState =
	| { readonly state: "unavailable"; readonly reason: string }
	| { readonly state: "idle"; readonly generation: number }
	| { readonly state: "loading"; readonly generation: number; readonly requestId: string }
	| { readonly state: "ready"; readonly generation: number; readonly value: PlanRenderView }
	| { readonly state: "empty"; readonly generation: number }
	| { readonly state: "error"; readonly generation: number; readonly code: string; readonly message: string; readonly retryable: boolean };

export interface PlanRenderQueryPort {
	readonly inspect: (input: TuiPortRequest & { readonly reference: PlanRenderReference }) => Promise<PlanRenderQueryResult>;
}
