/** Sandbox 平台适配器的内部合同；本切片只准备 launch plan，不执行进程。 */

import type { SandboxProfileName, WorkspaceExecutionEnvelope } from "../../runtime/contracts/public.ts";
import type { RuntimeDigest } from "../../runtime/protocol/foundation.ts";

export type SandboxPlatform = "linux" | "macos" | "windows" | "unknown";
export type SandboxDigestInput = RuntimeDigest | string;
export type SandboxBackendStatus = "available" | "unavailable";
export type SandboxEnforcement = "off" | "enforced" | "degraded" | "unavailable";
export type SandboxDecision = "allow" | "deny" | "unsupported" | "off";

/** 只做命令可用性查询；不得在 probe 中 spawn 或执行任意命令。 */
export interface SandboxProbe {
	which(program: string): Promise<string | undefined>;
}

/** 兼容调用方更明确的命名，但仍然只允许返回可执行文件路径。 */
export interface SandboxCommandAvailabilityProbe {
	commandAvailable(program: string): Promise<string | undefined>;
}

export type SandboxProbePort = SandboxProbe | SandboxCommandAvailabilityProbe;

export interface SandboxCapability {
	readonly backendId: string;
	readonly platform: SandboxPlatform;
	readonly status: SandboxBackendStatus;
	readonly supportsFilesystemIsolation: boolean;
	readonly supportsNetworkDeny: boolean;
	readonly supportsChildIsolation: boolean;
	readonly commandPath?: string;
	readonly deprecated?: boolean;
	readonly reason?: string;
	readonly capabilityDigest: RuntimeDigest;
}

export type SandboxBackendCapability = SandboxCapability;

export interface SandboxResolutionState {
	readonly backendId: string;
	readonly requested: SandboxProfileName;
	readonly resolved: SandboxProfileName;
	readonly effective: SandboxProfileName;
	readonly enforcement: SandboxEnforcement;
	readonly reason?: string;
}

export interface SandboxPrepareRequest {
	readonly requested: SandboxProfileName;
	/** Policy 已解析出的 profile；未提供时 backend 只使用 requested。 */
	readonly resolved?: SandboxProfileName;
	readonly policyDigest: SandboxDigestInput;
	readonly requestDigest?: SandboxDigestInput;
	readonly workspace: WorkspaceExecutionEnvelope;
	readonly readRoots: readonly string[];
	readonly writeRoots: readonly string[];
	readonly denyRead: readonly string[];
	readonly denyWrite: readonly string[];
	readonly protectedPaths: readonly string[];
	readonly network: "deny" | "allow";
	readonly command: string;
	readonly cwd: string;
	readonly environment: Readonly<Record<string, string>>;
	readonly timeoutMs: number;
	readonly stdin?: string;
}

export interface SandboxLaunchPlan extends SandboxResolutionState {
	readonly policyDigest: RuntimeDigest;
	readonly requestDigest: RuntimeDigest;
	readonly planDigest: RuntimeDigest;
	readonly program: string;
	readonly arguments: readonly string[];
	readonly command: string;
	readonly cwd: string;
	readonly environment: Readonly<Record<string, string>>;
	readonly timeoutMs: number;
	readonly workspaceRoot: string;
	readonly readRoots: readonly string[];
	readonly writeRoots: readonly string[];
	readonly denyRead: readonly string[];
	readonly protectedPaths: readonly string[];
	readonly network: "deny" | "allow";
	readonly stdin?: string;
}

export type SandboxErrorCode =
	| "invalid_request"
	| "path_escape"
	| "protected_path"
	| "sandbox_unavailable"
	| "unsupported_platform"
	| "request_digest_mismatch"
	| "plan_tampered"
	| "sandbox_denied";

export interface SandboxError {
	readonly code: SandboxErrorCode;
	readonly message: string;
	readonly retryable: boolean;
	readonly state?: SandboxResolutionState;
	readonly details?: Readonly<Record<string, string>>;
}

export type SandboxResult<T> =
	| { readonly ok: true; readonly value: T }
	| { readonly ok: false; readonly error: SandboxError };

export type SandboxFailure = { readonly ok: false; readonly error: SandboxError };

export type SandboxPrepareResult = SandboxResult<SandboxLaunchPlan>;

export interface SandboxDecisionReceipt extends SandboxResolutionState {
	readonly decision: SandboxDecision;
	readonly policyDigest: RuntimeDigest;
	readonly requestDigest: RuntimeDigest;
	readonly planDigest: RuntimeDigest;
	readonly finalLeafDigest: RuntimeDigest;
	readonly receiptDigest: RuntimeDigest;
	readonly error?: SandboxError;
}

export interface SandboxBackend {
	readonly backendId: string;
	probe(): Promise<SandboxCapability>;
	prepare(request: SandboxPrepareRequest): Promise<SandboxPrepareResult>;
	validateFinalLeaf(plan: SandboxLaunchPlan, requestDigest: SandboxDigestInput): Promise<SandboxDecisionReceipt>;
}
