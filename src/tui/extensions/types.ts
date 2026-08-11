import type { TuiPortRequest, TuiResultEnvelope } from "../application/common.ts";
import type { SafeBoundedText } from "../presentation/tools/types.ts";

export type ExtensionKind = "plugin" | "skill" | "hook" | "mcp-server" | "mcp-tool";
export type ExtensionTrust = "trusted" | "untrusted" | "stale" | "revoked" | "unknown";
export type ExtensionActivation = "ready" | "disabled" | "blocked" | "failed" | "unknown";

export interface ExtensionResourceView {
	readonly resourceId: string;
	readonly kind: ExtensionKind;
	readonly label: SafeBoundedText;
	readonly description?: SafeBoundedText;
	readonly pluginId?: SafeBoundedText;
	readonly runtimeName?: SafeBoundedText;
	readonly digestPrefix: SafeBoundedText;
	readonly enabled: boolean;
	readonly trusted: boolean;
	readonly ready: boolean;
	readonly trust: ExtensionTrust;
	readonly activation: ExtensionActivation;
	readonly diagnostic?: SafeBoundedText;
}

export interface ExtensionResourceSnapshot {
	readonly generation: number;
	readonly resources: readonly ExtensionResourceView[];
}

export interface ExtensionMutationReceipt {
	readonly resourceId: string;
	readonly operation: "activate" | "deactivate" | "reload" | "enable" | "disable" | "trust" | "untrust";
	readonly generation: number;
	readonly receiptPrefix: SafeBoundedText;
	readonly outcome: "accepted" | "completed" | "failed" | "uncertain";
	readonly recoveryRequired: boolean;
}

export type ExtensionMutationReceiptOperation = ExtensionMutationReceipt["operation"];

export type ExtensionWorkflowResult = TuiResultEnvelope<ExtensionResourceSnapshot>;
export type ExtensionReloadReceipt = TuiResultEnvelope<ExtensionMutationReceipt>;

export type ExtensionWorkflowState =
	| { readonly state: "unavailable"; readonly reason: string }
	| { readonly state: "idle"; readonly generation: number }
	| { readonly state: "loading"; readonly generation: number; readonly requestId: string; readonly effectId: string }
	| { readonly state: "ready"; readonly generation: number; readonly value: ExtensionResourceSnapshot }
	| { readonly state: "empty"; readonly generation: number }
	| { readonly state: "error"; readonly generation: number; readonly code: string; readonly message: string; readonly retryable: boolean };

export type ExtensionReloadWorkflowState =
	| { readonly state: "idle"; readonly generation: number }
	| { readonly state: "running"; readonly generation: number; readonly requestId: string }
	| { readonly state: "completed"; readonly generation: number; readonly value: ExtensionMutationReceipt }
	| { readonly state: "uncertain"; readonly generation: number; readonly message: string; readonly recoveryRequired: true }
	| { readonly state: "failed"; readonly generation: number; readonly message: string; readonly retryable: boolean };

export interface ExtensionResourcePort {
	readonly inspect: (input: TuiPortRequest) => Promise<ExtensionWorkflowResult>;
	readonly reload: (input: TuiPortRequest & { readonly resourceId: string }) => Promise<ExtensionReloadReceipt>;
	/** plugin.enable / plugin.disable —— plugin 及其 skill/hook 组件共享同一开关。 */
	readonly setPluginEnabled: (input: TuiPortRequest & { readonly pluginId: string; readonly enabled: boolean }) => Promise<ExtensionReloadReceipt>;
	/** plugin.trust / plugin.untrust —— 信任与吊销 plugin 及其组件。 */
	readonly setPluginTrusted: (input: TuiPortRequest & { readonly pluginId: string; readonly trusted: boolean }) => Promise<ExtensionReloadReceipt>;
}
