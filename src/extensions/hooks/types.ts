/** Hooks M3 的纯 descriptor、runner port 与 pipeline 结果合同。 */

import type { RuntimeDigest } from "../../runtime/protocol/foundation.ts";
import type { EventId, ResourceId, SessionId, SnapshotId } from "../../runtime/protocol/ids.ts";
import type { ExtensionDiagnostic } from "../diagnostics.ts";

export const HOOK_EVENT_NAMES = [
	"SessionStart",
	"UserPromptSubmit",
	"PreToolUse",
	"PostToolUse",
	"SessionEnd",
] as const;

export type HookEventName = (typeof HOOK_EVENT_NAMES)[number];
export type HookFailureMode = "open" | "closed";
export type HookSourceLayer = "builtin" | "user" | "project" | "plugin" | "session";

export interface HookHandlerDescriptor {
	readonly type: "command";
	readonly command: string;
	readonly args: readonly string[];
	readonly timeoutMs: number;
	readonly env: Readonly<Record<string, string>>;
}

export interface HookDefinition {
	readonly id: string;
	readonly event: HookEventName;
	readonly matcher?: string;
	readonly failureMode?: HookFailureMode;
	readonly handlers: readonly HookHandlerDescriptor[];
	readonly sourceLayer: HookSourceLayer;
	readonly sourcePath: string;
	readonly declarationIndex: number;
	readonly resourceId: ResourceId;
}

export interface HookParserOptions {
	readonly sourceLayer?: HookSourceLayer;
	readonly sourcePath?: string;
}

export type HookParseResult =
	| {
			readonly ok: true;
			readonly hooks: readonly HookDefinition[];
			readonly diagnostics: readonly ExtensionDiagnostic[];
			readonly digest: RuntimeDigest;
		}
	| {
			readonly ok: false;
			readonly hooks: readonly HookDefinition[];
			readonly diagnostics: readonly ExtensionDiagnostic[];
			readonly digest?: RuntimeDigest;
		};

export interface HookEvent {
	readonly event: HookEventName;
	readonly eventId: EventId;
	readonly timestamp: string;
	readonly sessionId: SessionId;
	readonly snapshotId: SnapshotId;
	readonly source: string;
	readonly matcherValue?: string;
	readonly input: unknown;
}

export interface HookCommandRunnerRequest {
	readonly command: string;
	readonly args: readonly string[];
	readonly env: Readonly<Record<string, string>>;
	readonly stdin: string;
	readonly signal: AbortSignal;
	readonly timeoutMs: number;
	/** Canonical directory of the hook document; relative commands resolve here. */
	readonly cwd?: string;
}

export interface HookCommandRunnerResult {
	readonly exitCode: number | null;
	readonly stdout: string;
	readonly stderr: string;
}

/** 只允许注入该 port；Hooks 领域不持有 child process、shell 或 ExecutionEnv。 */
export interface HookCommandRunner {
	run(request: HookCommandRunnerRequest): Promise<HookCommandRunnerResult>;
}

export interface HookPipelineLimits {
	readonly maxInputBytes: number;
	readonly maxStdoutBytes: number;
	readonly maxStderrBytes: number;
	readonly maxReasonChars: number;
	readonly maxAdditionalContextChars: number;
}

export interface HookPipelineOptions {
	readonly event: HookEvent;
	readonly hooks: readonly HookDefinition[];
	readonly runner: HookCommandRunner;
	readonly signal?: AbortSignal;
	readonly baseEnv?: Readonly<Record<string, string>>;
	readonly userFailureMode?: HookFailureMode;
	readonly limits?: Partial<HookPipelineLimits>;
}

export type HookFailureKind = "nonzero" | "timeout" | "aborted" | "spawn_error" | "invalid_output" | "oversized_input" | "oversized_output";

export interface HookHandlerRunResult {
	readonly hookId: ResourceId;
	readonly eventId: EventId;
	readonly outcome: "allow" | "deny" | "failure";
	readonly effectiveFailureMode: HookFailureMode;
	readonly failureKind?: HookFailureKind;
	readonly reason?: string;
	readonly exitCode: number | null;
	readonly timedOut: boolean;
	readonly aborted: boolean;
	readonly durationMs: number;
	readonly inputDigest: RuntimeDigest;
	readonly outputDigest: RuntimeDigest;
	readonly diagnosticDigest: RuntimeDigest;
	readonly diagnostics: readonly ExtensionDiagnostic[];
	readonly updatedInput: boolean;
}

export interface HookPipelineResult {
	readonly decision: "allow" | "deny" | "aborted";
	readonly blocked: boolean;
	readonly finalInput: unknown;
	readonly updatedInput?: unknown;
	readonly requiresRevalidation: boolean;
	readonly requiresAuthorization: boolean;
	readonly additionalContext: readonly string[];
	readonly handlers: readonly HookHandlerRunResult[];
	readonly diagnostics: readonly ExtensionDiagnostic[];
	readonly auditDigest: RuntimeDigest;
}

export interface HookHandlerReference {
	readonly hook: HookDefinition;
	readonly handler: HookHandlerDescriptor;
	readonly handlerIndex: number;
}

export interface HookStdoutValue {
	readonly decision: "allow" | "deny";
	readonly reason?: string;
	readonly updatedInput?: unknown | null;
	readonly additionalContext?: string | null;
}

export type HookStdoutParseResult =
	| { readonly ok: true; readonly value: HookStdoutValue }
	| { readonly ok: false; readonly diagnostics: readonly ExtensionDiagnostic[] };
