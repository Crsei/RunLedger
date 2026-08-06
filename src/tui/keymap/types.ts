import type { TuiPortRequest, TuiResultEnvelope } from "../application/common.ts";
import type { SafeBoundedText } from "../presentation/tools/types.ts";

export interface KeyBindingSnapshot {
	readonly key: SafeBoundedText;
	readonly action: SafeBoundedText;
	readonly source: "default" | "user" | "unknown";
}

export interface KeymapSnapshot {
	readonly generation: number;
	readonly digestPrefix: SafeBoundedText;
	readonly bindings: readonly KeyBindingSnapshot[];
}

export type KeymapWorkflowState =
	| { readonly state: "unavailable"; readonly reason: string }
	| { readonly state: "idle"; readonly generation: number }
	| { readonly state: "loading"; readonly generation: number; readonly requestId: string; readonly effectId: string }
	| { readonly state: "ready"; readonly generation: number; readonly value: KeymapSnapshot }
	| { readonly state: "empty"; readonly generation: number }
	| { readonly state: "error"; readonly generation: number; readonly code: string; readonly message: string; readonly retryable: boolean };

export type KeymapUpdateResult = TuiResultEnvelope<KeymapSnapshot>;

export interface KeymapWorkflowPort {
	readonly inspect: (input: TuiPortRequest) => Promise<KeymapUpdateResult>;
	readonly update: (input: TuiPortRequest & { readonly bindings: readonly KeyBindingSnapshot[]; readonly expectedDigestPrefix: SafeBoundedText }) => Promise<KeymapUpdateResult>;
}
