/**
 * Resident Runtime Host 的唯一 Security/ExecutionGateway 组合。
 *
 * 本文件只拥有 security snapshot、policy broker、constraint receipt 与
 * final-leaf adapter；session/process/output 生命周期仍由 Host 原有 owner
 * 持有。生产工具拿到的 ExecutionEnv 没有 raw fs/fetch/shell fallback。
 */

import { existsSync } from "node:fs";
import type { Stats } from "node:fs";
import * as fs from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ExecutionEnv, FileSystem, Network, NetworkRequest, NetworkResponse, Shell } from "../runtime/execution-env.ts";
import type { RuntimeHostScope } from "../runtime/host/types.ts";
import { createRuntimeId } from "../runtime/protocol/ids.ts";
import { canonicalDigest } from "../runtime/protocol/canonical-json.ts";
import { runtimeDigest } from "../runtime/protocol/foundation.ts";
import {
	evaluateExecutionConstraints,
	createExecutionConstraintReceipt,
	createProductionExecutionDecisionProviders,
	type ExecutionConstraintInput,
	type ExecutionConstraintProviders,
	type ExecutionConstraintSnapshot,
} from "../runtime/process/execution-decision.ts";
import type { RuntimeDigest } from "../runtime/protocol/foundation.ts";
import type { RunledgerLayout } from "../runtime/contracts/storage-layout.ts";
import {
	validatePersistedWorkspaceBinding,
	type PersistedWorkspaceBinding,
} from "../worktree/persisted-binding.ts";
import type { SecurityConfigSourcePort } from "../security/config/loader.ts";
import { loadSecurityConfigLayers } from "../security/config/loader.ts";
import { resolveSecuritySnapshot } from "../security/config/resolver.ts";
import { ExecutionGateway, gatewayRequestDigest, type ExecutionGatewayContext } from "../security/execution-gateway.ts";
import {
	ApprovalCoordinator,
	HeadlessDenyPrompter,
	type ApprovalCoordinatorOptions,
} from "../security/permission/approval-coordinator.ts";
import { analyzeShellCommand } from "../security/permission/shell-analyzer.ts";
import { PermissionEngine } from "../security/permission/engine.ts";
import { pathWithin, type FileSystemBrokerPort } from "../security/policy-filesystem.ts";
import {
	PolicyNetworkClient,
	type NetworkBrokerPort,
	type NetworkBrokerResponse,
} from "../security/policy-network.ts";
import type {
	AccessRequest,
	AuthorizationRequest,
	PermissionPrompter,
	SecurityResult,
	SecuritySnapshot,
} from "../security/types.ts";
import { createSandboxBackend } from "../security/sandbox/factory.ts";
import { digestOf } from "../security/sandbox/common.ts";
import type {
	SandboxBackend,
	SandboxLaunchPlan,
	SandboxPrepareRequest,
} from "../security/sandbox/types.ts";
import {
	HostProcessFinalLeafAdapter,
	type HostProcessFinalLeafDecision,
	type HostProcessFinalLeafDecisionPort,
	type HostProcessFinalLeafRequest,
} from "../security/integration/runtime-gateway-adapter.ts";
import { HostSecurityAuditAdapter } from "../security/integration/runtime-security-events.ts";
import { JsonApprovalStateStore } from "../storage/host/approval-store.ts";
import { JsonlRuntimeEventStore } from "../storage/host/runtime-event-store.ts";

export interface HostSecurityConfigSource extends SecurityConfigSourcePort {
	readonly source: SecurityConfigSourcePort["source"];
}

export interface HostSecurityCompositionOptions {
	readonly layout: RunledgerLayout;
	readonly scope: RuntimeHostScope;
	readonly cwd: string;
	/** Cold-replayed canonical binding; absent only for an explicit source workspace. */
	readonly workspaceBinding?: PersistedWorkspaceBinding;
	readonly sessionId?: string;
	readonly principalId?: string;
	readonly sandboxBackend?: SandboxBackend;
	readonly permissionPrompter?: PermissionPrompter;
	readonly approval?: Omit<ApprovalCoordinatorOptions, "prompter">;
	readonly filesystemBroker?: FileSystemBrokerPort;
	readonly networkBroker?: NetworkBrokerPort;
	readonly securitySources?: readonly HostSecurityConfigSource[];
	readonly now?: () => Date;
}

export interface HostExecutionEnvOptions {
	readonly sessionId?: string;
	readonly principalId?: string;
	readonly toolCallId?: string;
	readonly cwd?: string;
	readonly shell?: Shell;
}

export interface HostProcessSecurityRequest {
	readonly sessionId: string;
	readonly principalId: string;
	readonly commandId: string;
	readonly command: string;
	readonly cwd: string;
	readonly timeoutMs: number;
	readonly backend: "pipe" | "pty";
	readonly executionMode: "foreground" | "background";
	readonly containment: "none" | "process_group" | "supervisor";
	readonly requestDigest: RuntimeDigest;
	readonly stdin?: string;
}

export interface PreparedHostProcessSecurity {
	readonly constraintInput: ExecutionConstraintInput;
	readonly constraintSnapshot: ExecutionConstraintSnapshot;
	readonly sandboxPlan?: SandboxLaunchPlan;
	readonly authorization: ExecutionGatewayContext["authorization"];
	readonly authorizationDigest: RuntimeDigest;
	readonly requestDigest: RuntimeDigest;
}

export interface HostProcessFinalLeafInput extends PreparedHostProcessSecurity {
	readonly constraintSnapshot: ExecutionConstraintSnapshot;
}

export interface ProductionHostSecurity {
	readonly snapshot: SecuritySnapshot;
	readonly gateway: ExecutionGateway;
	readonly finalLeaf: HostProcessFinalLeafDecisionPort;
	readonly constraintProviders: ExecutionConstraintProviders;
	readonly sandboxBackend: SandboxBackend;
	createExecutionEnv(options?: HostExecutionEnvOptions): ExecutionEnv;
	prepareProcess(input: HostProcessSecurityRequest): Promise<SecurityResult<PreparedHostProcessSecurity>>;
	validateProcessFinalLeaf(input: HostProcessFinalLeafInput): Promise<SecurityResult<HostProcessFinalLeafDecision>>;
	processSandboxPlan(requestDigest: RuntimeDigest): SandboxLaunchPlan | undefined;
}

interface ProcessBinding {
	readonly sandboxPlan?: SandboxLaunchPlan;
	readonly authorizationRequest: AuthorizationRequest;
}

const SECURITY_ADAPTER_COMPOSITION = {
	permission: "permission-engine",
	approval: "approval-coordinator",
	sandbox: "platform-final-leaf",
	gateway: "execution-gateway",
	filesystem: "policy-filesystem",
	network: "policy-network",
	containment: "host-process-manager",
} as const;

/** Host scope 使用的稳定 adapter composition 摘要，不代表具体 policy snapshot。 */
export function productionSecurityAdapterDigest(): RuntimeDigest {
	return digestOf(SECURITY_ADAPTER_COMPOSITION);
}

export async function createProductionHostSecurity(
	options: HostSecurityCompositionOptions,
): Promise<ProductionHostSecurity> {
	const baseSessionId = options.sessionId ?? createRuntimeId("session", `host-${options.scope.workspaceStorageKey.slice(3, 67)}`);
	const basePrincipalId = options.principalId ?? "principal_host-agent";
	if (options.workspaceBinding !== undefined) {
		const binding = validatePersistedWorkspaceBinding(options.workspaceBinding);
		if (!binding.ok) throw new Error(`${binding.error.code}: ${binding.error.message}`);
		if (binding.value.binding.workspaceId !== options.scope.workspaceId) throw new Error("workspace binding does not match Host workspace identity");
	}
	const snapshot = await loadSnapshot(options);
	const sandboxBackend = options.sandboxBackend ?? createSandboxBackend(process.platform === "darwin" ? "macos" : process.platform === "win32" ? "windows" : process.platform === "linux" ? "linux" : "unknown", {
		probe: { which: findExecutable },
	});
	const filesystemBroker = options.filesystemBroker ?? createLocalFileSystemBroker();
	const networkBroker = options.networkBroker ?? createLocalNetworkBroker();
	const permissionEngine = new PermissionEngine();
	const runtimeEventWriter = new JsonlRuntimeEventStore({ layout: options.layout, workspaceStorageKey: options.scope.workspaceStorageKey });
	const audit = new HostSecurityAuditAdapter({ authorityId: options.scope.authorityId, tenantId: options.scope.tenantId, writer: runtimeEventWriter });
	const approvalCoordinator = new ApprovalCoordinator({
		...(options.approval ?? {}),
		prompter: options.permissionPrompter ?? new HeadlessDenyPrompter(),
		store: new JsonApprovalStateStore({ layout: options.layout, workspaceStorageKey: options.scope.workspaceStorageKey }),
		audit,
	});
	const bindings = new Map<string, ProcessBinding>();
	const baseProviders = createHostConstraintProviders(bindings);
	const finalLeaf = new HostProcessFinalLeafAdapter({
		sandboxBackend,
		currentPolicyDigest: () => snapshot.policyDigest,
	});
	const workspaceRoot = resolve(options.workspaceBinding?.worktreePath ?? options.cwd);
	const baseWorkspace = (sessionId: string, principalId: string, toolCallId: string, cwd: string) => createWorkspaceEnvelope(options.scope, sessionId, principalId, toolCallId, cwd, workspaceRoot, options.workspaceBinding);
	const gateway = new ExecutionGateway({
		snapshot,
		workspace: baseWorkspace(baseSessionId, basePrincipalId, "toolCall_host-security", options.cwd),
		filesystemBroker,
		networkBroker,
		permissionEngine,
		approvalCoordinator,
		finalLeaf,
	});

	const composition: ProductionHostSecurity = {
		snapshot,
		gateway,
		finalLeaf,
		constraintProviders: baseProviders,
		sandboxBackend,
		createExecutionEnv: (input = {}) => createGovernedExecutionEnv({
			composition: {
				gateway,
				snapshot,
				providers: baseProviders,
				workspace: baseWorkspace,
				baseSessionId,
				basePrincipalId,
				cwd: options.cwd,
			},
			options: input,
		}),
		prepareProcess: async (input) => prepareProcessSecurity({
			input,
			options,
			snapshot,
			gateway,
			providers: baseProviders,
			bindings,
			sandboxBackend,
			baseWorkspace,
			audit,
		}),
		validateProcessFinalLeaf: async (input) => {
			const plan = input.sandboxPlan ?? bindings.get(input.requestDigest.digest)?.sandboxPlan;
			const request: HostProcessFinalLeafRequest = {
				constraintInput: input.constraintInput,
				constraintSnapshot: input.constraintSnapshot,
				requestDigest: input.requestDigest,
				policyDigest: snapshot.policyDigest,
				...(plan === undefined ? {} : { sandboxPlan: plan }),
			};
			const result = await finalLeaf.decide(request);
			if (plan !== undefined) {
				const authorizationRequest = bindings.get(input.requestDigest.digest)?.authorizationRequest;
				if (authorizationRequest === undefined) return securityFailure("invalid_request", "sandbox authorization binding is missing");
				try {
					await audit.sandboxExecutionRecorded({
						request: authorizationRequest,
						plan,
						...(result.ok && result.value.sandboxReceipt === undefined ? {} : { receipt: result.ok ? result.value.sandboxReceipt : undefined }),
						outcome: result.ok ? "allow" : "deny",
						...(result.ok ? {} : { reason: result.error.message }),
					});
				} catch {
					return securityFailure("invalid_request", "sandbox execution audit is unavailable");
				}
			}
			return result;
		},
		processSandboxPlan: (requestDigest) => bindings.get(requestDigest.digest)?.sandboxPlan,
	};
	return composition;
}

async function loadSnapshot(options: HostSecurityCompositionOptions): Promise<SecuritySnapshot> {
	const sources = options.securitySources ?? createDefaultSecuritySources(options.layout, options.scope.workspaceStorageKey);
	const loaded = await loadSecurityConfigLayers(sources);
	if (!loaded.ok) throw new Error(loaded.error.message);
	const resolved = resolveSecuritySnapshot({
		layers: loaded.value,
		workspaceRoot: resolve(options.workspaceBinding?.worktreePath ?? options.cwd),
		tempRoot: resolve(options.layout.tmp, options.scope.workspaceStorageKey),
		createdAt: (options.now ?? (() => new Date()))().toISOString(),
	});
	if (!resolved.ok) throw new Error(resolved.error.message);
	return resolved.value;
}

function createDefaultSecuritySources(layout: RunledgerLayout, workspaceStorageKey: string): readonly HostSecurityConfigSource[] {
	return [
		jsonFileSource("managed", "/etc/runledger/security.json", false),
		jsonFileSource("project", join(layout.projects, workspaceStorageKey, "settings.json"), true),
		jsonFileSource("user", layout.settings, true),
	];
}

function jsonFileSource(
	source: HostSecurityConfigSource["source"],
	path: string,
	section: boolean,
): HostSecurityConfigSource {
	return {
		source,
		read: async () => {
			let text: string;
			try {
				text = await fs.readFile(path, "utf8");
			} catch (error) {
				if (isMissing(error)) return { status: "missing" };
				throw error;
			}
			if (!section) return { status: "available", text };
			let parsed: unknown;
			try {
				parsed = JSON.parse(text) as unknown;
			} catch {
				return { status: "available", text: "{" };
			}
			if (!isRecord(parsed) || !Object.prototype.hasOwnProperty.call(parsed, "security")) return { status: "missing" };
			return { status: "available", text: JSON.stringify(parsed.security) };
		},
	};
}

function isMissing(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function createLocalFileSystemBroker(): FileSystemBrokerPort {
	return {
		readFile: (path) => fs.readFile(path),
		writeFile: async (path, data) => { await fs.writeFile(path, data); },
		stat: async (path) => fileStats(await fs.stat(path)),
		lstat: async (path) => fileStats(await fs.lstat(path)),
		realpath: (path) => fs.realpath(path),
		readdir: async (path) => fs.readdir(path),
		mkdir: async (path, options) => { await fs.mkdir(path, options); },
		rm: async (path, options) => { await fs.rm(path, options); },
		rename: async (from, to) => { await fs.rename(from, to); },
	};
}

function fileStats(value: Stats) {
	return {
		size: value.size,
		mtimeMs: value.mtimeMs,
		isFile: value.isFile(),
		isDirectory: value.isDirectory(),
		isSymbolicLink: value.isSymbolicLink(),
	};
}

function createLocalNetworkBroker(): NetworkBrokerPort {
	return {
		request: async (request, signal): Promise<NetworkBrokerResponse> => {
			const response = await fetch(request.url, {
				method: request.method,
				headers: request.headers,
				body: request.body === undefined ? undefined : typeof request.body === "string" ? request.body : Uint8Array.from(request.body),
				redirect: "manual",
				signal,
			});
			const headers: Record<string, string> = {};
			response.headers.forEach((value, key) => { headers[key] = value; });
			return {
				status: response.status,
				headers,
				body: Buffer.from(await response.arrayBuffer()),
				finalUrl: request.url,
			};
		},
	};
}

function createHostConstraintProviders(bindings: ReadonlyMap<string, ProcessBinding>): ExecutionConstraintProviders {
	const containment = createProductionExecutionDecisionProviders(process.platform === "win32" ? "win32" : "posix").containment;
	return {
		permission: {
			decide: async (input) => input.modes.permission === "policy"
				? createExecutionConstraintReceipt({ dimension: "permission", mode: input.modes.permission, decision: "allow", providerId: "runledger.security.permission", providerRevision: 1, policyDigest: input.policyDigest, invocationDigest: input.requestDigest })
				: createExecutionConstraintReceipt({ dimension: "permission", mode: input.modes.permission, decision: "allow", providerId: "builtin-none.permission", providerRevision: 1, policyDigest: input.policyDigest, invocationDigest: input.requestDigest }),
		},
		approval: {
			decide: async (input) => createExecutionConstraintReceipt({
				dimension: "approval",
				mode: input.modes.approval,
				decision: input.modes.approval === "none" ? "not_required" : "allow",
				providerId: input.modes.approval === "none" ? "builtin-none.approval" : "runledger.security.approval",
				providerRevision: 1,
				policyDigest: input.policyDigest,
				invocationDigest: input.requestDigest,
			}),
		},
		sandbox: {
			decide: async (input) => {
				if (input.modes.sandbox === "none") return createExecutionConstraintReceipt({ dimension: "sandbox", mode: input.modes.sandbox, decision: "not_required", enforcement: "off", providerId: "builtin-none.sandbox", providerRevision: 1, policyDigest: input.policyDigest, invocationDigest: input.requestDigest });
				const binding = bindings.get(input.requestDigest.digest);
				if (binding?.sandboxPlan?.enforcement !== "enforced") return undefined;
				return createExecutionConstraintReceipt({ dimension: "sandbox", mode: input.modes.sandbox, decision: "allow", enforcement: "enforced", providerId: `runledger.security.sandbox.${binding.sandboxPlan.backendId}`, providerRevision: 1, policyDigest: input.policyDigest, invocationDigest: input.requestDigest });
			},
		},
		gateway: {
			decide: async (input) => createExecutionConstraintReceipt({ dimension: "gateway", mode: input.modes.gateway, decision: "allow", route: input.modes.gateway === "none" ? "direct_local" : "mediated", providerId: input.modes.gateway === "none" ? "builtin-none.gateway" : "runledger.security.gateway", providerRevision: 1, policyDigest: input.policyDigest, invocationDigest: input.requestDigest }),
		},
		containment,
	};
}

async function prepareProcessSecurity(input: {
	readonly input: HostProcessSecurityRequest;
	readonly options: HostSecurityCompositionOptions;
	readonly snapshot: SecuritySnapshot;
	readonly gateway: ExecutionGateway;
	readonly providers: ExecutionConstraintProviders;
	readonly bindings: Map<string, ProcessBinding>;
	readonly sandboxBackend: SandboxBackend;
	readonly baseWorkspace: (sessionId: string, principalId: string, toolCallId: string, cwd: string) => ReturnType<typeof createWorkspaceEnvelope>;
	readonly audit: HostSecurityAuditAdapter;
}): Promise<SecurityResult<PreparedHostProcessSecurity>> {
	const request = input.input;
	if (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs <= 0 || !isAbsolutePath(request.cwd)) return securityFailure("invalid_request", "process security request is malformed");
	const commandId = runtimeId("command", request.commandId);
	const principalId = runtimeId("principal", request.principalId);
	const sessionId = runtimeId("session", request.sessionId);
	const toolCallId = runtimeId("toolCall", `process-${request.requestDigest.digest.slice(0, 48)}`);
	const workspace = input.baseWorkspace(sessionId, principalId, toolCallId, request.cwd);
	const authorizationRequest: AuthorizationRequest = {
		requestId: commandId,
		sessionId,
		turnId: runtimeId("turn", canonicalDigest({ commandId, sessionId, toolCallId, command: request.command, cwd: request.cwd }).slice(0, 64)),
		toolCallId,
		toolName: "bash",
		argumentsDigest: request.requestDigest,
		cwd: request.cwd,
		requests: [{ kind: "shell", command: request.command, cwd: request.cwd, analysis: analyzeShellCommand(request.command).analysis }],
		workspace,
		snapshot: input.snapshot,
	};
	const executionRequestDigest = gatewayRequestDigest(authorizationRequest);
	const executionIdentityDigest = canonicalDigest({ commandId, requestDigest: executionRequestDigest });
	const executionId = runtimeId("execution", executionIdentityDigest);
	const attemptId = runtimeId("attempt", `${executionIdentityDigest}_1`);
	let sandboxPlan: SandboxLaunchPlan | undefined;
	if (input.snapshot.profile.sandbox !== "off") {
		const plan = await prepareSandboxPlan(input.sandboxBackend, input.snapshot, workspace, request, executionRequestDigest);
		if (!plan.ok) return securityFailure(plan.error.code === "sandbox_unavailable" ? "policy_denied" : "invalid_request", plan.error.message);
		sandboxPlan = plan.value;
	}
	input.bindings.set(executionRequestDigest.digest, { authorizationRequest, ...(sandboxPlan === undefined ? {} : { sandboxPlan }) });
	const constraintInput: ExecutionConstraintInput = {
		authorityId: input.options.scope.authorityId,
		tenantId: input.options.scope.tenantId,
		workspaceId: input.options.scope.workspaceId,
		principalId,
		executionId,
		attemptId,
		commandId,
		requestDigest: executionRequestDigest,
		policyDigest: input.snapshot.policyDigest,
		modes: {
			permission: "policy",
			approval: input.snapshot.profile.approvalPolicy === "never" ? "none" : "required",
			sandbox: input.snapshot.profile.sandbox === "off" ? "none" : "profile",
			gateway: "mediated",
			containment: request.containment,
		},
	};
	const decision = await evaluateExecutionConstraints(constraintInput, input.providers);
	if (!decision.ok) {
		input.bindings.delete(executionRequestDigest.digest);
		return securityFailure(decision.code === "constraint_denied" ? "policy_denied" : decision.code === "constraint_provider_unavailable" ? "invalid_request" : "invalid_request", `process constraint ${decision.code} at ${decision.dimension}`);
	}
	const authorized = await input.gateway.authorize({ request: authorizationRequest, requestDigest: executionRequestDigest, constraintInput, constraintSnapshot: decision.snapshot });
	if (!authorized.ok) {
		input.bindings.delete(executionRequestDigest.digest);
		return authorized;
	}
	if (sandboxPlan !== undefined) {
		try {
			await input.audit.sandboxResolved({ request: authorizationRequest, plan: sandboxPlan });
		} catch {
			input.bindings.delete(executionRequestDigest.digest);
			return securityFailure("invalid_request", "sandbox resolution audit is unavailable");
		}
	}
	return {
		ok: true,
		value: {
			constraintInput,
			constraintSnapshot: decision.snapshot,
			...(sandboxPlan === undefined ? {} : { sandboxPlan }),
			authorization: authorized.value.authorization,
			authorizationDigest: authorized.value.authorizationDigest,
			requestDigest: executionRequestDigest,
		},
	};
}

async function prepareSandboxPlan(
	backend: SandboxBackend,
	snapshot: SecuritySnapshot,
	workspace: ReturnType<typeof createWorkspaceEnvelope>,
	request: HostProcessSecurityRequest,
	requestDigest: RuntimeDigest,
): Promise<Awaited<ReturnType<SandboxBackend["prepare"]>>> {
	const writeRoots = snapshot.filesystem.writeRoots.filter((path) => pathWithin(workspace.worktreePath, path) && existsSync(path));
	const readRoots = snapshot.filesystem.readRoots.filter((path) => existsSync(path));
	const denyRead = snapshot.filesystem.denyRead.filter((path) => existsSync(path));
	const protectedPaths = snapshot.filesystem.protectedPaths.filter((path) => existsSync(path));
	const input: SandboxPrepareRequest = {
		requested: snapshot.profile.sandbox,
		resolved: snapshot.profile.sandbox,
		policyDigest: snapshot.policyDigest,
		requestDigest,
		workspace,
		readRoots,
		writeRoots,
		denyRead,
		denyWrite: snapshot.filesystem.denyWrite.filter((path) => existsSync(path)),
		protectedPaths,
		network: snapshot.profile.network.mode === "deny" ? "deny" : "allow",
		command: request.command,
		cwd: request.cwd,
		environment: {},
		timeoutMs: request.timeoutMs,
		...(request.stdin === undefined ? {} : { stdin: request.stdin }),
	};
	return backend.prepare(input);
}

function createGovernedExecutionEnv(input: {
	readonly composition: {
		readonly gateway: ExecutionGateway;
		readonly snapshot: SecuritySnapshot;
		readonly providers: ExecutionConstraintProviders;
		readonly workspace: (sessionId: string, principalId: string, toolCallId: string, cwd: string) => ReturnType<typeof createWorkspaceEnvelope>;
		readonly baseSessionId: string;
		readonly basePrincipalId: string;
		readonly cwd: string;
	};
	readonly options: HostExecutionEnvOptions;
}): ExecutionEnv {
	const sessionId = input.options.sessionId ?? input.composition.baseSessionId;
	const principalId = input.options.principalId ?? input.composition.basePrincipalId;
	const toolCallId = input.options.toolCallId ?? `tool-${runtimeDigest({ sessionId, principalId, cwd: input.composition.cwd }).digest.slice(0, 48)}`;
	const envCwd = resolve(input.options.cwd ?? input.composition.cwd);
	const authorize = async (toolName: string, requests: readonly AccessRequest[], args: unknown, cwd = envCwd, signal?: AbortSignal): Promise<ExecutionGatewayContext> => {
		const normalizedSessionId = runtimeId("session", sessionId);
		const normalizedPrincipalId = runtimeId("principal", principalId);
		const normalizedToolCallId = runtimeId("toolCall", toolCallId);
		const workspace = input.composition.workspace(normalizedSessionId, normalizedPrincipalId, normalizedToolCallId, cwd);
		const requestId = runtimeId("command", canonicalDigest({ sessionId, toolCallId, toolName, args, cwd, requests }));
		const authorizationRequest: AuthorizationRequest = {
			requestId,
			sessionId: normalizedSessionId,
			turnId: runtimeId("turn", canonicalDigest({ requestId, sessionId, toolCallId, toolName, cwd }).slice(0, 64)),
			toolCallId: normalizedToolCallId,
			toolName,
			argumentsDigest: digestOf(args),
			cwd,
			requests,
			workspace,
			snapshot: input.composition.snapshot,
		};
		const requestDigest = gatewayRequestDigest(authorizationRequest);
		const constraintInput: ExecutionConstraintInput = {
			authorityId: workspace.authorityId,
			tenantId: workspace.tenantId,
			workspaceId: workspace.workspaceId,
			principalId: workspace.principalId,
			executionId: runtimeId("execution", requestDigest.digest.slice(0, 64)),
			attemptId: runtimeId("attempt", `${requestDigest.digest.slice(0, 48)}_1`),
			commandId: requestId,
			requestDigest,
			policyDigest: input.composition.snapshot.policyDigest,
			modes: {
				permission: "policy",
				approval: input.composition.snapshot.profile.approvalPolicy === "never" ? "none" : "required",
				// Filesystem/network operations are already mediated by the Host
				// Gateway; OS sandbox enforcement is reserved for the process final
				// leaf, where a concrete launch plan is available.
				sandbox: "none",
				gateway: "mediated",
				containment: "none",
			},
		};
		const constraints = await evaluateExecutionConstraints(constraintInput, input.composition.providers);
		if (!constraints.ok) throw new Error(`execution constraint ${constraints.code} at ${constraints.dimension}`);
		const opened = await input.composition.gateway.authorize({ request: authorizationRequest, requestDigest, constraintInput, constraintSnapshot: constraints.snapshot }, signal);
		if (!opened.ok) throw new Error(opened.error.message);
		return opened.value;
	};
	const fsPort = createGovernedFileSystem({ authorize });
	const networkPort = createGovernedNetwork({ authorize });
	return {
		fs: fsPort,
		shell: input.options.shell ?? unavailableShell(),
		cwd: envCwd,
		network: networkPort,
	};
}

function createGovernedFileSystem(input: {
	readonly authorize: (toolName: string, requests: readonly AccessRequest[], args: unknown, cwd?: string) => Promise<ExecutionGatewayContext>;
}): FileSystem {
	const read = async (path: string) => {
		const context = await input.authorize("read", [{ kind: "filesystem", operation: "read", path }], { path });
		const result = await context.fs.readFile(path);
		return unwrapSecurityResult(result);
	};
	return {
		readFile: read,
		writeFile: async (path, data) => unwrapSecurityResult(await (await input.authorize("write", [{ kind: "filesystem", operation: "write", path }], { path, data: digestOf(data) })).fs.writeFile(path, data)),
		stat: async (path) => {
			const context = await input.authorize("stat", [{ kind: "filesystem", operation: "read", path }], { path });
			return toFileStats(unwrapSecurityResult(await context.fs.stat(path)));
		},
		readdir: async (path) => {
			const context = await input.authorize("readdir", [{ kind: "filesystem", operation: "read", path }], { path });
			return [...unwrapSecurityResult(await context.fs.readdir(path))];
		},
		mkdir: async (path, options) => unwrapSecurityResult(await (await input.authorize("mkdir", [{ kind: "filesystem", operation: "write", path }], { path, options })).fs.mkdir(path, options)),
		rm: async (path, options) => unwrapSecurityResult(await (await input.authorize("rm", [{ kind: "filesystem", operation: "delete", path }], { path, options })).fs.rm(path, options)),
	};
}

function createGovernedNetwork(input: {
	readonly authorize: (toolName: string, requests: readonly AccessRequest[], args: unknown, cwd?: string, signal?: AbortSignal) => Promise<ExecutionGatewayContext>;
}): Network {
	return {
		request: async (request: NetworkRequest, signal?: AbortSignal): Promise<NetworkResponse> => {
			const url = new URL(request.url);
			const context = await input.authorize("WebFetch", [{ kind: "network", operation: "fetch", host: url.hostname, ...(url.port ? { port: Number(url.port) } : {}) }], request, undefined, signal);
			return unwrapSecurityResult(await context.network.request({
				url: request.url,
				method: request.method,
				headers: request.headers,
				...(request.body === undefined ? {} : { body: request.body }),
				maxBytes: request.maxBytes,
			}, signal));
		},
	};
}

function unavailableShell(): Shell {
	return {
		exec: async () => {
			throw new Error("Host ExecutionEnv shell requires the Host managed process facade");
		},
	};
}

function unwrapSecurityResult<T>(result: SecurityResult<T>): T {
	if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
	return result.value;
}

function toFileStats(value: { readonly size: number; readonly mtimeMs: number; readonly isFile: boolean; readonly isDirectory: boolean }): Awaited<ReturnType<FileSystem["stat"]>> {
	return { size: value.size, mtimeMs: value.mtimeMs, isFile: value.isFile, isDirectory: value.isDirectory };
}

function runtimeId<K extends "command" | "execution" | "attempt" | "principal" | "session" | "toolCall" | "turn">(kind: K, value: string): ReturnType<typeof createRuntimeId<K>> {
	const seed = value.startsWith(`${kind}_`) ? value.slice(kind.length + 1) : value;
	return createRuntimeId(kind, seed.length > 128 ? canonicalDigest(seed) : seed);
}

function createWorkspaceEnvelope(
	scope: RuntimeHostScope,
	sessionId: string,
	principalId: string,
	toolCallId: string,
	cwd: string,
	workspaceRoot = cwd,
	binding?: PersistedWorkspaceBinding,
) {
	const normalizedSession = runtimeId("session", sessionId);
	const normalizedPrincipal = runtimeId("principal", principalId);
	const normalizedToolCall = runtimeId("toolCall", toolCallId);
	return {
		authorityId: scope.authorityId,
		tenantId: scope.tenantId,
		principalId: normalizedPrincipal,
		sessionId: normalizedSession,
		workspaceId: binding?.binding.workspaceId ?? scope.workspaceId,
		repositoryId: binding?.binding.repositoryId ?? scope.repositoryId,
		worktreePath: resolve(binding?.worktreePath ?? workspaceRoot),
		branch: binding === undefined ? "runledger/host" : `runledger/worktree/${binding.worktreeId.slice(0, 96)}`,
		baseCommit: binding?.baseCommit ?? "0".repeat(40),
		agentId: createRuntimeId("agent", "runledger-host-agent"),
		toolCallId: normalizedToolCall,
		traceId: createRuntimeId("trace", canonicalDigest({ sessionId, principalId, toolCallId, cwd })),
		cwd: resolve(cwd),
		ownerRuntimeId: binding?.lease.ownerRuntimeId ?? createRuntimeId("runtime", scope.workspaceStorageKey.slice(3, 67)),
		leaseRevision: binding?.lease.leaseRevision ?? 1,
		fencingTokenDigest: binding?.lease.fencingTokenDigest ?? runtimeDigest({ workspaceStorageKey: scope.workspaceStorageKey }),
	};
}

function isAbsolutePath(value: string): boolean {
	return value.length > 0 && value === resolve(value) && !value.includes("\0");
}

function securityFailure(code: "invalid_request" | "policy_denied", message: string): SecurityResult<never> {
	return { ok: false, error: { code, message, retryable: false } };
}

async function findExecutable(program: string): Promise<string | undefined> {
	if (program.includes("/")) return existsSync(program) ? program : undefined;
	for (const entry of (process.env.PATH ?? "").split(":")) {
		const candidate = join(entry || ".", program);
		if (existsSync(candidate)) return candidate;
	}
	return undefined;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
