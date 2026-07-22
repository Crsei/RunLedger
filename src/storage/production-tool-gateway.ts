/** 本地 production Tool Gateway composition；raw Node I/O 只存在于 storage adapter 边界。 */

import { constants } from "node:fs";
import {
	access,
	lstat,
	mkdir,
	readFile,
	readdir,
	realpath,
	rename,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { spawn } from "node:child_process";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import type {
	ApprovalCoordinatorPort,
	CapabilityGatewayPort,
	CapabilityName,
	CapabilityRateLimitPort,
} from "../runtime/protocol/v3/capability.ts";
import type { PrincipalId } from "../runtime/protocol/v3/ids.ts";
import type { ApprovalLifecycleEventPort } from "../runtime/protocol/v3/security-events.ts";
import type { CredentialBrokerPort } from "../runtime/identity/enterprise-ports.ts";
import type { WorkspaceServicePort } from "../runtime/protocol/v3/workspace.ts";
import type { ToolExecutionGatewayPort } from "../runtime/types.ts";
import {
	CredentialBroker,
	type CredentialExecutorInjectionPort,
	type CredentialMaterialPort,
} from "../security/enterprise/credential-broker.ts";
import { PermissionEngine } from "../security/permission/engine.ts";
import {
	ApprovalCoordinator,
	type ApprovalStateStorePort,
} from "../security/permission/approval-coordinator.ts";
import type { FileSystemBrokerPort } from "../security/policy-filesystem.ts";
import type { PermissionPrompter, SecurityResult } from "../security/types.ts";
import { isSandboxDenial } from "../security/sandbox/denial.ts";
import { LinuxBwrapBackend } from "../security/sandbox/linux-bwrap.ts";
import { MacOsSeatbeltBackend } from "../security/sandbox/macos-seatbelt.ts";
import type {
	SandboxBackend,
	SandboxBackendCapability,
	SandboxCommandProbePort,
	SandboxLaunchPlan,
	SandboxPrepareRequest,
	SandboxProcessPort,
	SandboxProcessResult,
} from "../security/sandbox/types.ts";
import { WindowsExternalSandboxBackend } from "../security/sandbox/windows-external.ts";
import {
	CapabilityAuthenticationAdapter,
	type CapabilityPeerBinding,
} from "../security/integration/capability-authentication.ts";
import {
	RuntimeCredentialBrokerAdapter,
	type CredentialAudienceBindingResolverPort,
} from "../security/integration/credential-broker-adapter.ts";
import { PendingApprovalRegistry } from "../security/integration/pending-approval-registry.ts";
import {
	ProductionCapabilityRequestFactory,
	ProductionRestrictedToolExecutionEnvironment,
	ProductionToolManifestRegistry,
	type ProductionToolManifest,
	type ToolInvocationInputClassificationPort,
} from "../security/integration/production-tool-components.ts";
import { RuntimeApprovalCoordinatorAdapter } from "../security/integration/runtime-approval-adapter.ts";
import {
	RuntimeCapabilityGatewayAdapter,
	type GatewayRateLimitPolicy,
	type SecuritySnapshotResolverPort,
} from "../security/integration/runtime-gateway-adapter.ts";
import {
	PortBackedToolExecutionGateway,
	type ToolExecutionWorkspaceResolverPort,
} from "../security/integration/tool-execution-gateway.ts";
import {
	FileApprovalStateStore,
	FileToolExecutionAttemptStore,
} from "./security-runtime-state.ts";

const MAX_SANDBOX_OUTPUT_BYTES = 8 * 1024 * 1024;

function brokerStats(value: Awaited<ReturnType<typeof stat>>) {
	return {
		size: Number(value.size),
		mtimeMs: Number(value.mtimeMs),
		isFile: value.isFile(),
		isDirectory: value.isDirectory(),
		isSymbolicLink: value.isSymbolicLink(),
	};
}

/** Runtime tools 只拿 PolicyFileSystem wrapper，不会拿到此 raw broker。 */
export class NodeToolFileSystemBroker implements FileSystemBrokerPort {
	public readFile(path: string): Promise<Buffer> {
		return readFile(path);
	}

	public async writeFile(path: string, data: string | Buffer): Promise<void> {
		await writeFile(path, data);
	}

	public async stat(path: string) {
		return brokerStats(await stat(path));
	}

	public async lstat(path: string) {
		return brokerStats(await lstat(path));
	}

	public realpath(path: string): Promise<string> {
		return realpath(path);
	}

	public readdir(path: string): Promise<string[]> {
		return readdir(path);
	}

	public async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
		await mkdir(path, options);
	}

	public async rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void> {
		await rm(path, options);
	}

	public async rename(from: string, to: string): Promise<void> {
		await rename(from, to);
	}
}

export class NodeSandboxCommandProbe implements SandboxCommandProbePort {
	readonly #searchPath: string;

	public constructor(searchPath: string) {
		this.#searchPath = searchPath;
	}

	public async which(program: string): Promise<string | undefined> {
		if (!program || program.includes("/") || program.includes("\\") || program.includes("\0")) return undefined;
		for (const entry of this.#searchPath.split(delimiter)) {
			if (!entry || !isAbsolute(entry)) continue;
			const candidate = join(entry, program);
			try {
				await access(candidate, constants.X_OK);
				const canonical = resolve(await realpath(candidate));
				const value = await stat(canonical);
				if (value.isFile()) return canonical;
			} catch {
				// 继续检查下一个受控 PATH entry。
			}
		}
		return undefined;
	}
}

function appendBounded(current: Buffer[], chunk: Buffer, state: { bytes: number }): void {
	if (state.bytes >= MAX_SANDBOX_OUTPUT_BYTES) return;
	const remaining = MAX_SANDBOX_OUTPUT_BYTES - state.bytes;
	const bounded = chunk.byteLength <= remaining ? chunk : chunk.subarray(0, remaining);
	current.push(Buffer.from(bounded));
	state.bytes += bounded.byteLength;
}

export class NodeSandboxProcessPort implements SandboxProcessPort {
	public async spawn(plan: SandboxLaunchPlan, signal?: AbortSignal): Promise<SecurityResult<SandboxProcessResult>> {
		if (!isAbsolute(plan.program) || signal?.aborted) {
			return { ok: false, error: { code: "sandbox_unavailable", message: "sandbox program is invalid or cancelled", retryable: false } };
		}
		return new Promise((resolveResult) => {
			let child;
			try {
				child = spawn(plan.program, [...plan.arguments], {
					cwd: plan.cwd,
					env: { ...plan.environment },
					windowsHide: true,
					stdio: ["pipe", "pipe", "pipe"],
				});
			} catch {
				resolveResult({ ok: false, error: { code: "sandbox_unavailable", message: "sandbox process could not be created", retryable: true } });
				return;
			}
			const stdout: Buffer[] = [];
			const stderr: Buffer[] = [];
			const stdoutState = { bytes: 0 };
			const stderrState = { bytes: 0 };
			let terminal = false;
			const finish = (result: SecurityResult<SandboxProcessResult>) => {
				if (terminal) return;
				terminal = true;
				clearTimeout(timer);
				signal?.removeEventListener("abort", abort);
				resolveResult(result);
			};
			child.stdout.on("data", (chunk: Buffer) => appendBounded(stdout, chunk, stdoutState));
			child.stderr.on("data", (chunk: Buffer) => appendBounded(stderr, chunk, stderrState));
			child.stdin.on("error", () => undefined);
			const abort = () => {
				try { child.kill("SIGKILL"); } catch { /* 已退出。 */ }
			};
			const timer = setTimeout(abort, plan.timeoutMs);
			signal?.addEventListener("abort", abort, { once: true });
			child.on("error", () => {
				finish({ ok: false, error: { code: "sandbox_unavailable", message: "sandbox process failed before a terminal receipt", retryable: true } });
			});
			child.on("close", (code, signalName) => {
				const stdoutText = Buffer.concat(stdout).toString("utf8");
				const stderrText = Buffer.concat(stderr).toString("utf8");
				const exitCode = code ?? 127;
				finish({
					ok: true,
					value: {
						stdout: stdoutText,
						stderr: stderrText,
						exitCode,
						signaled: signalName !== null,
						denied: isSandboxDenial(stderrText, exitCode),
					},
				});
			});
			child.stdin.end(plan.stdin);
		});
	}
}

class UnavailablePlatformSandboxBackend implements SandboxBackend {
	public async probe(): Promise<SandboxBackendCapability> {
		return {
			backendId: "platform-unavailable",
			platform: "unknown",
			status: "unavailable",
			supportsFilesystemIsolation: false,
			supportsNetworkDeny: false,
			supportsChildIsolation: false,
			reason: "this platform has no local sandbox backend",
		};
	}

	public async prepare(_request: SandboxPrepareRequest): Promise<SecurityResult<SandboxLaunchPlan>> {
		return { ok: false, error: { code: "sandbox_unavailable", message: "this platform has no local sandbox backend", retryable: false } };
	}

	public async spawn(_plan: SandboxLaunchPlan): Promise<SecurityResult<SandboxProcessResult>> {
		return { ok: false, error: { code: "sandbox_unavailable", message: "this platform has no local sandbox backend", retryable: false } };
	}
}

export function createNodePlatformSandboxBackend(options: {
	searchPath: string;
	processes?: SandboxProcessPort;
}): SandboxBackend {
	const processes = options.processes ?? new NodeSandboxProcessPort();
	const probe = new NodeSandboxCommandProbe(options.searchPath);
	if (process.platform === "linux") return new LinuxBwrapBackend(probe, processes);
	if (process.platform === "darwin") return new MacOsSeatbeltBackend(probe, processes);
	if (process.platform === "win32") return new WindowsExternalSandboxBackend(processes, false);
	return new UnavailablePlatformSandboxBackend();
}

export interface ProductionCredentialCompositionOptions {
	materials: CredentialMaterialPort;
	injection: CredentialExecutorInjectionPort;
	audienceResolver: CredentialAudienceBindingResolverPort;
	maxBrokerTtlMs: number;
	maxRuntimeGrantTtlMs: number;
	maxRequestAgeMs?: number;
	allowedClockSkewMs?: number;
}

export interface ProductionToolGatewayStatePaths {
	stateRoot: string;
	attemptsRoot: string;
	approvalsRoot: string;
}

export interface ProductionToolGatewayCompositionOptions {
	stateRoot: string;
	workspace: WorkspaceServicePort;
	workspaceResolver: ToolExecutionWorkspaceResolverPort;
	snapshots: SecuritySnapshotResolverPort;
	manifests: readonly ProductionToolManifest[];
	classification: ToolInvocationInputClassificationPort;
	peerBinding: CapabilityPeerBinding;
	rateLimiter: CapabilityRateLimitPort;
	rateLimitPolicy(capability: CapabilityName): GatewayRateLimitPolicy;
	prompter: PermissionPrompter;
	approvalEvents: ApprovalLifecycleEventPort;
	fallbackPrincipalId: PrincipalId;
	credentials: ProductionCredentialCompositionOptions;
	sandboxBackend?: SandboxBackend;
	baseEnvironment?: Readonly<Record<string, string>>;
	allowedEnvironmentKeys?: readonly string[];
	approvalStore?: ApprovalStateStorePort;
	clock?: () => Date;
	approvalTimeoutMs?: number;
	authenticationTtlMs?: number;
}

export interface ProductionToolGatewayComposition {
	paths: ProductionToolGatewayStatePaths;
	toolExecutionGateway: ToolExecutionGatewayPort;
	capabilityGateway: CapabilityGatewayPort;
	approvalCoordinator: ApprovalCoordinatorPort;
	credentialBroker: CredentialBrokerPort;
	attemptStore: FileToolExecutionAttemptStore;
	manifestRegistry: ProductionToolManifestRegistry;
}

function exactAbsolutePath(path: string): string {
	if (!isAbsolute(path) || resolve(path) !== path || path.includes("\0")) {
		throw new TypeError("production tool Gateway stateRoot must be an exact absolute path");
	}
	return path;
}

function defaultBaseEnvironment(): Readonly<Record<string, string>> {
	const output: Record<string, string> = {};
	for (const key of ["PATH", "LANG", "LC_ALL", "TERM", "NO_COLOR"] as const) {
		const value = process.env[key];
		if (value !== undefined) output[key] = value;
	}
	return output;
}

export async function createProductionToolGatewayComposition(
	options: ProductionToolGatewayCompositionOptions,
): Promise<ProductionToolGatewayComposition> {
	const stateRoot = exactAbsolutePath(options.stateRoot);
	const paths: ProductionToolGatewayStatePaths = {
		stateRoot,
		attemptsRoot: join(stateRoot, "tool-attempts"),
		approvalsRoot: join(stateRoot, "approvals"),
	};
	const attemptStore = new FileToolExecutionAttemptStore(paths.attemptsRoot);
	const approvalStore = options.approvalStore ?? new FileApprovalStateStore(paths.approvalsRoot);
	await attemptStore.verify();
	if (approvalStore instanceof FileApprovalStateStore) await approvalStore.verify();

	const clock = options.clock ?? (() => new Date());
	const manifestRegistry = new ProductionToolManifestRegistry(options.manifests);
	const pendingApprovals = new PendingApprovalRegistry();
	const approvalDomain = new ApprovalCoordinator({
		prompter: options.prompter,
		store: approvalStore,
		clock,
		fallbackPrincipalId: options.fallbackPrincipalId,
		...(options.approvalTimeoutMs === undefined ? {} : { timeoutMs: options.approvalTimeoutMs }),
	});
	const approvalCoordinator = new RuntimeApprovalCoordinatorAdapter({
		coordinator: approvalDomain,
		registry: pendingApprovals,
		events: options.approvalEvents,
	});
	const authentication = new CapabilityAuthenticationAdapter({
		peerBindings: [options.peerBinding],
		clock,
	});
	const capabilityGateway = new RuntimeCapabilityGatewayAdapter({
		authentication,
		rateLimiter: options.rateLimiter,
		rateLimitPolicy: options.rateLimitPolicy,
		manifestResolver: manifestRegistry,
		snapshotResolver: options.snapshots,
		permissionEngine: new PermissionEngine(),
		approvals: pendingApprovals,
		approvalEvents: options.approvalEvents,
		approvalCanceller: approvalCoordinator,
		clock,
		...(options.approvalTimeoutMs === undefined ? {} : { approvalTimeoutMs: options.approvalTimeoutMs }),
	});
	const capabilityRequestFactory = new ProductionCapabilityRequestFactory({
		manifests: manifestRegistry,
		snapshots: options.snapshots,
		classification: options.classification,
		peerBinding: options.peerBinding,
		clock,
		...(options.authenticationTtlMs === undefined ? {} : { authenticationTtlMs: options.authenticationTtlMs }),
	});
	const baseEnvironment = options.baseEnvironment ?? defaultBaseEnvironment();
	const sandboxBackend = options.sandboxBackend ?? createNodePlatformSandboxBackend({ searchPath: baseEnvironment.PATH ?? "" });
	const environment = new ProductionRestrictedToolExecutionEnvironment({
		snapshots: options.snapshots,
		filesystemBroker: new NodeToolFileSystemBroker(),
		sandboxBackend,
		baseEnvironment,
		...(options.allowedEnvironmentKeys === undefined ? {} : { allowedEnvironmentKeys: options.allowedEnvironmentKeys }),
		clock,
	});
	const toolExecutionGateway = new PortBackedToolExecutionGateway({
		workspace: options.workspace,
		workspaceResolver: options.workspaceResolver,
		capability: capabilityGateway,
		capabilityRequestFactory,
		approval: approvalCoordinator,
		approvalState: approvalStore,
		environment,
		attempts: attemptStore,
		clock,
	});
	const credentialDomain = new CredentialBroker(
		options.credentials.materials,
		options.credentials.injection,
		options.credentials.maxBrokerTtlMs,
		clock,
	);
	const credentialBroker = new RuntimeCredentialBrokerAdapter({
		broker: credentialDomain,
		audienceResolver: options.credentials.audienceResolver,
		maxGrantTtlMs: options.credentials.maxRuntimeGrantTtlMs,
		...(options.credentials.maxRequestAgeMs === undefined ? {} : { maxRequestAgeMs: options.credentials.maxRequestAgeMs }),
		...(options.credentials.allowedClockSkewMs === undefined ? {} : { allowedClockSkewMs: options.credentials.allowedClockSkewMs }),
		clock,
	});
	return {
		paths,
		toolExecutionGateway,
		capabilityGateway,
		approvalCoordinator,
		credentialBroker,
		attemptStore,
		manifestRegistry,
	};
}
