import type { ExtensionSpillRef, ExtensionResourceDescriptor, ExtensionSource } from "../types.ts";

export const HOOK_EVENTS = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "SessionEnd"] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];
export type HookFailureMode = "open" | "closed";

export interface CommandHookHandler {
	type: "command";
	command: string;
	args: readonly string[];
	timeoutMs: number;
	env: Readonly<Record<string, string>>;
	commandDigest: string;
}

export interface HookDescriptor {
	descriptor: ExtensionResourceDescriptor;
	event: HookEvent;
	matcher?: string;
	matcherRegex?: RegExp;
	failureMode: HookFailureMode;
	handlers: readonly CommandHookHandler[];
	configPath: string;
	configDirectory: string;
	priority: number;
	declarationIndex: number;
	pluginDataPath?: string;
}

export interface HookEnvelope {
	schemaVersion: 1;
	event: HookEvent;
	eventId: string;
	timestamp: string;
	sessionId: string;
	cwd: string;
	snapshotId: string;
	source: ExtensionSource;
	payload: Readonly<Record<string, unknown>>;
}

export interface HookCommandRequest {
	command: string;
	args: readonly string[];
	cwd: string;
	environment: Readonly<Record<string, string>>;
	stdin: string;
	timeoutMs: number;
	maxStdoutBytes: number;
	maxStderrBytes: number;
	hookId: string;
	commandDigest: string;
}

export interface HookCommandExecution {
	status: "completed" | "timed_out" | "aborted" | "failed";
	exitCode: number | null;
	stdout: string;
	stderr: string;
	durationMs: number;
}

export interface HookCommandExecutorPort {
	execute(request: HookCommandRequest, signal?: AbortSignal): Promise<HookCommandExecution>;
}

export interface HookOutput {
	decision: "allow" | "deny";
	reason?: string;
	updatedInput?: unknown;
	additionalContext?: string;
}

export interface HookRunOutcome {
	hookId: string;
	event: HookEvent;
	status: "allowed" | "denied" | "failed" | "timed_out" | "aborted";
	decision: "allow" | "deny";
	failureMode: HookFailureMode;
	reason: string;
	updatedInput?: unknown;
	additionalContext?: string;
	durationMs: number;
	exitCode: number | null;
	stdoutDigest: string;
	stderrDigest: string;
	stdoutPreview: string;
	stderrPreview: string;
	inputDigest: string;
	inputSpill?: ExtensionSpillRef;
	outputSpill?: ExtensionSpillRef;
}

export interface HookDispatchResult {
	decision: "allow" | "deny";
	reason?: string;
	input: unknown;
	inputUpdated: boolean;
	additionalContext?: string;
	outcomes: readonly HookRunOutcome[];
}
