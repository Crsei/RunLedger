import type { CorrelatedRequestRef } from "../application/common.ts";

export interface CommandArgumentDescriptor {
	readonly name: string;
	readonly description: string;
	readonly required: boolean;
	readonly valueKind: "text" | "number" | "boolean" | "choice";
}

export interface CommandPolicy {
	readonly draft: "allowed" | "disabled";
	readonly history: "allowed" | "disabled";
	readonly query: "allowed" | "disabled";
	readonly frozen: "allowed" | "disabled";
}

export interface CommandDescriptor {
	readonly canonicalName: string;
	readonly aliases: readonly string[];
	readonly description: string;
	readonly category: string;
	readonly order: number;
	readonly argumentSchema: readonly CommandArgumentDescriptor[];
	readonly policy: CommandPolicy;
}

export interface CommandIntent {
	readonly invocationId: string;
	readonly displayOrder: number;
	readonly canonicalName: string;
	readonly normalizedArgs: readonly string[];
	readonly catalogGeneration: number;
	readonly createdAt: string;
}

export type CommandDecision =
	| { readonly state: "handled"; readonly invocationId: string; readonly message?: string }
	| { readonly state: "action"; readonly invocationId: string; readonly actionType: string }
	| { readonly state: "effect"; readonly invocationId: string; readonly effectId: string; readonly effectType: string }
	| { readonly state: "queued"; readonly invocationId: string; readonly queueItemId: string }
	| { readonly state: "failed"; readonly invocationId: string; readonly code: string; readonly message: string; readonly retryable: boolean }
	| { readonly state: "cancelled"; readonly invocationId: string; readonly reason?: string }
	| { readonly state: "aborted"; readonly invocationId: string; readonly reason: string };

export interface CommandCompletion {
	readonly ref: CorrelatedRequestRef;
	readonly decision: CommandDecision;
}
