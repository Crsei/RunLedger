/** 平台 sandbox 内部 backend 合同。 */

import type { SandboxEffectiveEnforcement, SandboxProfileName } from "../../runtime/protocol/v3/capability.ts";
import type { WorkspaceExecutionEnvelope } from "../../runtime/protocol/v3/workspace.ts";
import type { SecurityResult } from "../types.ts";

export type SandboxPlatform = "linux" | "macos" | "windows" | "external" | "unknown";

export interface SandboxBackendCapability {
	backendId: string;
	platform: SandboxPlatform;
	status: "available" | "external" | "unavailable";
	supportsFilesystemIsolation: boolean;
	supportsNetworkDeny: boolean;
	supportsChildIsolation: boolean;
	reason?: string;
}

export interface SandboxPrepareRequest {
	requested: SandboxProfileName;
	policyDigest: string;
	envelope: WorkspaceExecutionEnvelope;
	readRoots: readonly string[];
	writeRoots: readonly string[];
	denyRead: readonly string[];
	denyWrite: readonly string[];
	protectedPaths: readonly string[];
	network: "deny" | "allow";
	command: string;
	cwd: string;
	environment: Readonly<Record<string, string>>;
	timeoutMs: number;
	stdin?: string;
}

export interface SandboxLaunchPlan {
	backendId: string;
	requested: SandboxProfileName;
	resolved: SandboxProfileName;
	effectiveEnforcement: SandboxEffectiveEnforcement;
	policyDigest: string;
	program: string;
	arguments: readonly string[];
	cwd: string;
	environment: Readonly<Record<string, string>>;
	timeoutMs: number;
	stdin?: string;
	reason?: string;
}

export interface SandboxProcessResult {
	stdout: string;
	stderr: string;
	exitCode: number;
	signaled: boolean;
	denied: boolean;
}

export interface SandboxProcessPort {
	spawn(plan: SandboxLaunchPlan, signal?: AbortSignal): Promise<SecurityResult<SandboxProcessResult>>;
}

export interface SandboxBackend {
	probe(): Promise<SandboxBackendCapability>;
	prepare(request: SandboxPrepareRequest): Promise<SecurityResult<SandboxLaunchPlan>>;
	spawn(plan: SandboxLaunchPlan, signal?: AbortSignal): Promise<SecurityResult<SandboxProcessResult>>;
}

export interface SandboxCommandProbePort {
	which(program: string): Promise<string | undefined>;
}
