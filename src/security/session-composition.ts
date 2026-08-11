/**
 * Session Owner Runtime 的 session-scoped Security/ExecutionGateway 组合。
 *
 * 每个 owned session 以 sessionId + runtimeId + generation 构造 workspace
 * fence。文件、网络与进程最终叶均由 policy-aware port 提供；限制性 sandbox
 * 必须执行已校验 launch plan，不能回退执行原始 shell command。
 */

import { isAbsolute, join, resolve } from "node:path";
import type {
	ExecutionEnv,
	FileSystem,
	Network,
	NetworkRequest,
	NetworkResponse,
	Shell,
	ShellExecOptions,
} from "../runtime/execution-env.ts";
import { localExecutionEnv } from "../runtime/execution-env.ts";
import type { RunledgerLayout } from "../runtime/contracts/storage-layout.ts";
import { workspaceStorageKey } from "../runtime/contracts/storage-layout.ts";
import {
	createExecutionConstraintReceipt,
	evaluateExecutionConstraints,
	type ExecutionConstraintInput,
	type ExecutionConstraintProviders,
	type ExecutionConstraintSnapshot,
} from "../runtime/process/execution-decision.ts";
import { canonicalDigest } from "../runtime/protocol/canonical-json.ts";
import { runtimeDigest, type RuntimeDigest } from "../runtime/protocol/foundation.ts";
import {
	createRuntimeId,
	parseRuntimeId,
	type RepositoryId,
	type WorkspaceId,
} from "../runtime/protocol/ids.ts";
import type { OwnerFence } from "../runtime/session-owner/types.ts";
import type { ToolAuthorizationPolicy } from "../runtime/types.ts";
import { runtimeWorkspacePlatform } from "../workspace/runtime-platform.ts";
import { loadSecurityConfigLayers, type SecurityConfigSourcePort } from "./config/loader.ts";
import { resolveSecuritySnapshot } from "./config/resolver.ts";
import { ExecutionGateway, gatewayRequestDigest, type ExecutionGatewayContext } from "./execution-gateway.ts";
import { ProcessFinalLeafAdapter } from "./integration/runtime-gateway-adapter.ts";
import { GovernedToolAuthorizationPolicy } from "./integration/runtime-tool-authorization.ts";
import {
	createLocalFileSystemBroker,
	createLocalNetworkBroker,
	createLocalSessionProcessLeaf,
	existingLocalPaths,
	findLocalExecutable,
	readLocalUtf8File,
	type SessionProcessLeaf,
} from "./integration/session-local-leaves.ts";
import { ApprovalCoordinator, HeadlessDenyPrompter, type ApprovalAuditPort, type ApprovalStateStorePort } from "./permission/approval-coordinator.ts";
import { analyzeShellCommand } from "./permission/shell-analyzer.ts";
import { PermissionEngine } from "./permission/engine.ts";
import { MemoryPermissionGrantStore } from "./permission/grants.ts";
import type { RequestPermissionsPort, GovernedPermissionRequest } from "./tools/request-permissions.ts";
import { pathWithin, type FileSystemBrokerPort } from "./policy-filesystem.ts";
import type { NetworkBrokerPort } from "./policy-network.ts";
import { createSandboxBackend } from "./sandbox/factory.ts";
import { digestOf } from "./sandbox/common.ts";
import type { SandboxBackend, SandboxLaunchPlan, SandboxPrepareRequest } from "./sandbox/types.ts";
import type {
	AccessRequest,
	AuthorizationRequest,
	HostWorkspaceExecutionContext,
	PermissionPrompter,
	SecurityResult,
	SecuritySnapshot,
} from "./types.ts";

export interface SessionSecurityConfigSource extends SecurityConfigSourcePort {
	readonly source: SecurityConfigSourcePort["source"];
}

export type { SessionProcessIo, SessionProcessLeaf } from "./integration/session-local-leaves.ts";

export interface SessionSecurityCompositionOptions {
	readonly layout: RunledgerLayout;
	readonly cwd: string;
	readonly fence: OwnerFence;
	readonly workspaceId: string;
	readonly repositoryId: string;
	readonly securitySources?: readonly SessionSecurityConfigSource[];
	readonly sandboxBackend?: SandboxBackend;
	readonly filesystemBroker?: FileSystemBrokerPort;
	readonly networkBroker?: NetworkBrokerPort;
	readonly processLeaf?: SessionProcessLeaf;
	/** 仅 sandbox=off 时使用；限制性 sandbox 永不调用此 port。 */
	readonly unrestrictedShell?: Shell;
	readonly now?: () => Date;
	/** Session Event Store + driver reverse-request 的 production approval ports。 */
	readonly approvalPorts?: {
		readonly prompter: PermissionPrompter;
		readonly stateStore: ApprovalStateStorePort;
		readonly audit: ApprovalAuditPort;
	};
}

export interface SessionSecurityComposition {
	readonly snapshot: SecuritySnapshot;
	readonly executionEnv: ExecutionEnv;
	readonly authorizationPolicy: ToolAuthorizationPolicy;
	readonly managedProcess: SessionManagedProcessSecurity;
	readonly permissionRequester: RequestPermissionsPort;
}

export interface SessionManagedProcessSecurityRequest {
	readonly commandId: string;
	readonly command: string;
	readonly cwd: string;
	readonly timeoutMs: number;
	readonly backend: "pipe" | "pty";
	readonly executionMode: "foreground" | "background";
	readonly requestDigest: RuntimeDigest;
	readonly stdin?: string;
}

export interface PreparedSessionManagedProcessSecurity {
	readonly constraintInput: ExecutionConstraintInput;
	readonly constraintSnapshot: ExecutionConstraintSnapshot;
	readonly requestDigest: RuntimeDigest;
	readonly sandboxPlan?: SandboxLaunchPlan;
	validateFinalLeaf(): ReturnType<ProcessFinalLeafAdapter["decide"]>;
	complete(): Promise<SecurityResult<void>>;
}

export interface SessionManagedProcessSecurity {
	prepare(input: SessionManagedProcessSecurityRequest, signal?: AbortSignal): Promise<SecurityResult<PreparedSessionManagedProcessSecurity>>;
}

interface SessionIdentity {
	readonly authorityId: ReturnType<typeof createRuntimeId<"authority">>;
	readonly tenantId: ReturnType<typeof createRuntimeId<"tenant">>;
	readonly workspaceId: WorkspaceId;
	readonly repositoryId: RepositoryId;
}

interface ProcessBinding {
	readonly plan: SandboxLaunchPlan;
}

export async function createSessionSecurity(
	options: SessionSecurityCompositionOptions,
): Promise<SessionSecurityComposition> {
	const cwd = resolve(options.cwd);
	const identity = sessionIdentity(options.workspaceId, options.repositoryId);
	const storageKey = workspaceStorageKey(identity);
	const snapshot = await loadSnapshot(options, storageKey, cwd);
	const sandboxBackend = options.sandboxBackend ?? createSandboxBackend(
		runtimeWorkspacePlatform(),
		{ probe: { which: findLocalExecutable } },
	);
	const filesystemBroker = options.filesystemBroker ?? createLocalFileSystemBroker();
	const networkBroker = options.networkBroker ?? createLocalNetworkBroker();
	const processLeaf = options.processLeaf ?? createLocalSessionProcessLeaf();
	const unrestrictedShell = options.unrestrictedShell ?? localExecutionEnv(cwd).shell;
	const bindings = new Map<string, ProcessBinding>();
	const providers = createConstraintProviders(bindings);
	const workspace = (toolCallId: string, requestCwd = cwd) => createWorkspaceEnvelope(
		identity,
		options.fence,
		toolCallId,
		cwd,
		requestCwd,
	);
	const finalLeaf = new ProcessFinalLeafAdapter({
		sandboxBackend,
		currentPolicyDigest: () => snapshot.policyDigest,
	});
	const permissionEngine = new PermissionEngine();
	const approvalCoordinator = new ApprovalCoordinator(options.approvalPorts === undefined
		? { prompter: new HeadlessDenyPrompter() }
		: {
			prompter: options.approvalPorts.prompter,
			store: options.approvalPorts.stateStore,
			audit: options.approvalPorts.audit,
		});
	const permissionGrantStore = new MemoryPermissionGrantStore(options.now ?? (() => new Date()));
	const gateway = new ExecutionGateway({
		snapshot,
		workspace: workspace("toolCall_session-security"),
		filesystemBroker,
		networkBroker,
		permissionEngine,
		approvalCoordinator,
		permissionGrantStore,
		finalLeaf,
	});
	const authorize = createAuthorizer({ options, identity, snapshot, gateway, providers, workspace });
	const managedProcess = createManagedProcessSecurity({
		options,
		identity,
		snapshot,
		gateway,
		providers,
		workspace,
		bindings,
		finalLeaf,
		sandboxBackend,
	});
	const executionEnv: ExecutionEnv = {
		cwd,
		fs: createGovernedFileSystem(authorize, cwd),
		network: createGovernedNetwork(authorize, cwd),
		shell: createGovernedShell({
			options,
			identity,
			snapshot,
			gateway,
			providers,
			workspace,
			bindings,
			finalLeaf,
			sandboxBackend,
			processLeaf,
			unrestrictedShell,
			cwd,
		}),
	};
	return {
		snapshot,
		executionEnv,
		authorizationPolicy: new GovernedToolAuthorizationPolicy(),
		managedProcess,
		permissionRequester: createPermissionRequester({ options, snapshot, workspace, permissionEngine, approvalCoordinator, permissionGrantStore, cwd }),
	};
}

function createPermissionRequester(input: {
	readonly options: SessionSecurityCompositionOptions;
	readonly snapshot: SecuritySnapshot;
	readonly workspace: (toolCallId: string, cwd?: string) => HostWorkspaceExecutionContext;
	readonly permissionEngine: PermissionEngine;
	readonly approvalCoordinator: ApprovalCoordinator;
	readonly permissionGrantStore: MemoryPermissionGrantStore;
	readonly cwd: string;
}): RequestPermissionsPort {
	return {
		request: async (request, signal) => {
			const requests = permissionGrantRequests(request);
			if (!requests.ok) return requests;
			const toolCallId = createRuntimeId("toolCall", canonicalDigest(request.toolCallId).slice(0, 64));
			const workspace = input.workspace(toolCallId, input.cwd);
			const authorization = authorizationRequest(input.options.fence, input.snapshot, workspace, toolCallId, "request_permissions", requests.value, request, input.cwd);
			const category = input.permissionEngine.evaluate([{ kind: "tool", toolName: "request_permissions" }], input.snapshot);
			const evaluation = { ...category, requests: requests.value };
			const approved = await input.approvalCoordinator.authorize(authorization, evaluation, () => ({
				argumentsDigest: authorization.argumentsDigest,
				cwd: authorization.cwd,
				policyDigest: authorization.snapshot.policyDigest,
			}), signal);
			if (!approved.ok) return approved;
			if (approved.value.outcome !== "allow") return { ok: false, error: { code: "policy_denied", message: approved.value.reason, retryable: false } };
			return { ok: true, value: await input.permissionGrantStore.issue({
				scope: request.scope,
				sessionId: authorization.sessionId,
				turnId: authorization.turnId,
				policyDigest: authorization.snapshot.policyDigest,
				requests: requests.value,
			}) };
		},
	};
}

function permissionGrantRequests(input: GovernedPermissionRequest): SecurityResult<readonly AccessRequest[]> {
	const requests: AccessRequest[] = [];
	for (const permission of input.permissions.filesystem ?? []) {
		if (permission.access === "deny") return { ok: false, error: { code: "invalid_request", message: "request_permissions cannot elevate a deny filesystem entry", retryable: false } };
		requests.push({ kind: "filesystem", operation: permission.access, path: permission.path });
	}
	for (const permission of input.permissions.network ?? []) {
		if (permission.access === "deny") return { ok: false, error: { code: "invalid_request", message: "request_permissions cannot elevate a deny network entry", retryable: false } };
		requests.push({ kind: "network", operation: "connect", host: permission.host, protocol: permission.protocol, ...(permission.port === undefined ? {} : { port: permission.port }) });
	}
	return requests.length === 0
		? { ok: false, error: { code: "invalid_request", message: "request_permissions requires at least one permission", retryable: false } }
		: { ok: true, value: requests };
}

function createManagedProcessSecurity(input: {
	readonly options: SessionSecurityCompositionOptions;
	readonly identity: SessionIdentity;
	readonly snapshot: SecuritySnapshot;
	readonly gateway: ExecutionGateway;
	readonly providers: ExecutionConstraintProviders;
	readonly workspace: (toolCallId: string, cwd?: string) => HostWorkspaceExecutionContext;
	readonly bindings: Map<string, ProcessBinding>;
	readonly finalLeaf: ProcessFinalLeafAdapter;
	readonly sandboxBackend: SandboxBackend;
}): SessionManagedProcessSecurity {
	return {
		prepare: async (request, signal) => {
			if (!isAbsolute(request.cwd) || !Number.isSafeInteger(request.timeoutMs) || request.timeoutMs < 1) {
				return securityError("invalid_request", "managed process request is malformed");
			}
			const commandId = parseRuntimeId("command", request.commandId)
				?? createRuntimeId("command", canonicalDigest(request.commandId).slice(0, 64));
			const toolCallId = createRuntimeId("toolCall", `process-${request.requestDigest.digest.slice(0, 48)}`);
			const workspace = input.workspace(toolCallId, request.cwd);
			const authorization = {
				...authorizationRequest(
				input.options.fence,
				input.snapshot,
				workspace,
				toolCallId,
				"bash",
				[{ kind: "shell", command: request.command, cwd: request.cwd, analysis: analyzeShellCommand(request.command).analysis }],
				{
					command: request.command,
					cwd: request.cwd,
					timeoutMs: request.timeoutMs,
					backend: request.backend,
					executionMode: request.executionMode,
					stdinDigest: digestOf(request.stdin ?? ""),
				},
				request.cwd,
				),
				requestId: commandId,
			};
			const requestDigest = gatewayRequestDigest(authorization);
			const restrictive = input.snapshot.profile.sandbox !== "off";
			let plan: SandboxLaunchPlan | undefined;
			if (restrictive) {
				const prepared = await input.sandboxBackend.prepare(sandboxRequest(
					input.snapshot,
					workspace,
					requestDigest,
					request.command,
					{ timeoutMs: request.timeoutMs, ...(request.stdin === undefined ? {} : { stdin: request.stdin }) },
					request.cwd,
				));
				if (!prepared.ok) return securityError("policy_denied", prepared.error.message);
				plan = prepared.value;
				input.bindings.set(requestDigest.digest, { plan });
			}
			try {
				const baseConstraintInput = executionConstraintInput(
					input.identity,
					input.options.fence,
					commandId,
					requestDigest,
					input.snapshot,
					restrictive ? "profile" : "none",
				);
				const executionIdentityDigest = canonicalDigest({ commandId, requestDigest });
				const constraintInput: ExecutionConstraintInput = {
					...baseConstraintInput,
					executionId: createRuntimeId("execution", executionIdentityDigest),
					attemptId: createRuntimeId("attempt", `${executionIdentityDigest}_1`),
				};
				const constraints = await evaluateExecutionConstraints(constraintInput, input.providers);
				if (!constraints.ok) {
					return securityError(
						constraints.code === "constraint_denied" ? "policy_denied" : "invalid_request",
						`managed process constraint ${constraints.code} at ${constraints.dimension}`,
					);
				}
				const opened = await input.gateway.authorize({
					request: authorization,
					requestDigest,
					constraintInput,
					constraintSnapshot: constraints.snapshot,
				}, signal);
				if (!opened.ok) return opened;
				return {
					ok: true,
					value: {
						constraintInput,
						constraintSnapshot: constraints.snapshot,
						requestDigest,
						...(plan === undefined ? {} : { sandboxPlan: plan }),
						validateFinalLeaf: () => input.finalLeaf.decide({
							constraintInput,
							constraintSnapshot: constraints.snapshot,
							requestDigest,
							policyDigest: input.snapshot.policyDigest,
							...(plan === undefined ? {} : { sandboxPlan: plan }),
						}),
						complete: opened.value.complete,
					},
				};
			} finally {
				input.bindings.delete(requestDigest.digest);
			}
		},
	};
}

function securityError(code: "invalid_request" | "policy_denied", message: string): SecurityResult<never> {
	return { ok: false, error: { code, message, retryable: false } };
}

function sessionIdentity(workspaceId: string, repositoryId: string): SessionIdentity {
	return {
		authorityId: createRuntimeId("authority", "session-owner-runtime"),
		tenantId: createRuntimeId("tenant", "local-user"),
		workspaceId: parseRuntimeId("workspace", workspaceId) ?? createRuntimeId("workspace", canonicalDigest(workspaceId)),
		repositoryId: parseRuntimeId("repository", repositoryId) ?? createRuntimeId("repository", canonicalDigest(repositoryId)),
	};
}

async function loadSnapshot(
	options: SessionSecurityCompositionOptions,
	storageKey: string,
	cwd: string,
): Promise<SecuritySnapshot> {
	const loaded = await loadSecurityConfigLayers([
		...(options.securitySources ?? []),
		jsonFileSource("managed", "/etc/runledger/security.json", false),
		jsonFileSource("project", join(options.layout.projects, storageKey, "settings.json"), true),
		jsonFileSource("user", options.layout.settings, true),
	]);
	if (!loaded.ok) throw new Error(loaded.error.message);
	const resolved = resolveSecuritySnapshot({
		layers: loaded.value,
		workspaceRoot: cwd,
		tempRoot: resolve(options.layout.tmp, options.fence.sessionId),
		createdAt: (options.now ?? (() => new Date()))().toISOString(),
	});
	if (!resolved.ok) throw new Error(resolved.error.message);
	return resolved.value;
}

function jsonFileSource(
	source: SessionSecurityConfigSource["source"],
	path: string,
	section: boolean,
): SessionSecurityConfigSource {
	return {
		source,
		read: async () => {
			let text: string;
			try {
				text = await readLocalUtf8File(path);
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

function createAuthorizer(input: {
	readonly options: SessionSecurityCompositionOptions;
	readonly identity: SessionIdentity;
	readonly snapshot: SecuritySnapshot;
	readonly gateway: ExecutionGateway;
	readonly providers: ExecutionConstraintProviders;
	readonly workspace: (toolCallId: string, cwd?: string) => HostWorkspaceExecutionContext;
}) {
	return async (
		toolName: string,
		requests: readonly AccessRequest[],
		args: unknown,
		requestCwd: string,
		signal?: AbortSignal,
	): Promise<ExecutionGatewayContext> => {
		const toolCallId = createRuntimeId("toolCall", canonicalDigest({ toolName, requests, args, requestCwd }).slice(0, 64));
		const workspace = input.workspace(toolCallId, requestCwd);
		const request = authorizationRequest(input.options.fence, input.snapshot, workspace, toolCallId, toolName, requests, args, requestCwd);
		const requestDigest = gatewayRequestDigest(request);
		const constraintInput = executionConstraintInput(input.identity, input.options.fence, request.requestId, requestDigest, input.snapshot, "none");
		const constraints = await evaluateExecutionConstraints(constraintInput, input.providers);
		if (!constraints.ok) throw new Error(`execution constraint ${constraints.code} at ${constraints.dimension}`);
		const opened = await input.gateway.authorize({ request, requestDigest, constraintInput, constraintSnapshot: constraints.snapshot }, signal);
		return unwrapSecurityResult(opened);
	};
}

function createGovernedFileSystem(
	authorize: ReturnType<typeof createAuthorizer>,
	cwd: string,
): FileSystem {
	return {
		readFile: async (path) => {
			const context = await authorize("read", [{ kind: "filesystem", operation: "read", path }], { path }, cwd);
			return settleGatewayEffect(context, async () => unwrapSecurityResult(await context.fs.readFile(path)));
		},
		writeFile: async (path, data) => {
			const context = await authorize("write", [{ kind: "filesystem", operation: "write", path }], { path, dataDigest: digestOf(data) }, cwd);
			return settleGatewayEffect(context, async () => unwrapSecurityResult(await context.fs.writeFile(path, data)));
		},
		stat: async (path) => {
			const context = await authorize("stat", [{ kind: "filesystem", operation: "read", path }], { path }, cwd);
			const value = await settleGatewayEffect(context, async () => unwrapSecurityResult(await context.fs.stat(path)));
			return { size: value.size, mtimeMs: value.mtimeMs, isFile: value.isFile, isDirectory: value.isDirectory, isSymbolicLink: value.isSymbolicLink };
		},
		readdir: async (path) => {
			const context = await authorize("readdir", [{ kind: "filesystem", operation: "read", path }], { path }, cwd);
			return [...await settleGatewayEffect(context, async () => unwrapSecurityResult(await context.fs.readdir(path)))];
		},
		mkdir: async (path, opts) => {
			const context = await authorize("mkdir", [{ kind: "filesystem", operation: "write", path }], { path, opts: opts ?? {} }, cwd);
			return settleGatewayEffect(context, async () => unwrapSecurityResult(await context.fs.mkdir(path, opts)));
		},
		rm: async (path, opts) => {
			const context = await authorize("rm", [{ kind: "filesystem", operation: "delete", path }], { path, opts: opts ?? {} }, cwd);
			return settleGatewayEffect(context, async () => unwrapSecurityResult(await context.fs.rm(path, opts)));
		},
	};
}

function createGovernedNetwork(
	authorize: ReturnType<typeof createAuthorizer>,
	cwd: string,
): Network {
	return {
		request: async (request: NetworkRequest, signal?: AbortSignal): Promise<NetworkResponse> => {
			const url = new URL(request.url);
			const context = await authorize(
				"WebFetch",
				[{ kind: "network", operation: "fetch", host: url.hostname, protocol: url.protocol === "http:" ? "http" : "https", ...(url.port ? { port: Number(url.port) } : {}) }],
				networkDigestInput(request),
				cwd,
				signal,
			);
			return settleGatewayEffect(context, async () => unwrapSecurityResult(await context.network.request(request, signal)));
		},
	};
}

function createGovernedShell(input: {
	readonly options: SessionSecurityCompositionOptions;
	readonly identity: SessionIdentity;
	readonly snapshot: SecuritySnapshot;
	readonly gateway: ExecutionGateway;
	readonly providers: ExecutionConstraintProviders;
	readonly workspace: (toolCallId: string, cwd?: string) => HostWorkspaceExecutionContext;
	readonly bindings: Map<string, ProcessBinding>;
	readonly finalLeaf: ProcessFinalLeafAdapter;
	readonly sandboxBackend: SandboxBackend;
	readonly processLeaf: SessionProcessLeaf;
	readonly unrestrictedShell: Shell;
	readonly cwd: string;
}): Shell {
	return {
		exec: async (command, opts) => {
			const cwd = resolve(opts?.cwd ?? input.cwd);
			const argumentsDigest = digestOf(shellDigestInput(command, opts, cwd));
			const toolCallId = createRuntimeId("toolCall", argumentsDigest.digest.slice(0, 64));
			const workspace = input.workspace(toolCallId, cwd);
			const requests: readonly AccessRequest[] = [{ kind: "shell", command, cwd, analysis: analyzeShellCommand(command).analysis }];
			const request = authorizationRequest(input.options.fence, input.snapshot, workspace, toolCallId, "bash", requests, argumentsDigest, cwd);
			const requestDigest = gatewayRequestDigest(request);
			const restrictive = input.snapshot.profile.sandbox !== "off";
			let plan: SandboxLaunchPlan | undefined;
			if (restrictive) {
				plan = unwrapSandboxResult(await input.sandboxBackend.prepare(sandboxRequest(input.snapshot, workspace, requestDigest, command, opts, cwd)));
				input.bindings.set(requestDigest.digest, { plan });
			}
			try {
				const constraintInput = executionConstraintInput(
					input.identity,
					input.options.fence,
					request.requestId,
					requestDigest,
					input.snapshot,
					restrictive ? "profile" : "none",
				);
				const constraints = await evaluateExecutionConstraints(constraintInput, input.providers);
				if (!constraints.ok) throw new Error(`execution constraint ${constraints.code} at ${constraints.dimension}`);
				const context = unwrapSecurityResult(await input.gateway.authorize({ request, requestDigest, constraintInput, constraintSnapshot: constraints.snapshot }, opts?.signal));
				const leaf = await input.finalLeaf.decide({
					constraintInput,
					constraintSnapshot: constraints.snapshot,
					requestDigest,
					policyDigest: input.snapshot.policyDigest,
					...(plan === undefined ? {} : { sandboxPlan: plan }),
				});
				unwrapSecurityResult(leaf);
				if (!restrictive) {
					return settleGatewayEffect(context, () => input.unrestrictedShell.exec(command, opts));
				}
				return settleGatewayEffect(context, () => input.processLeaf.execute(plan!, {
					...(opts?.signal === undefined ? {} : { signal: opts.signal }),
					...(opts?.maxOutputChars === undefined ? {} : { maxOutputChars: opts.maxOutputChars }),
					...(opts?.onStdout === undefined ? {} : { onStdout: opts.onStdout }),
					...(opts?.onStderr === undefined ? {} : { onStderr: opts.onStderr }),
				}));
			} finally {
				input.bindings.delete(requestDigest.digest);
			}
		},
	};
}

function authorizationRequest(
	fence: OwnerFence,
	snapshot: SecuritySnapshot,
	workspace: HostWorkspaceExecutionContext,
	toolCallId: ReturnType<typeof createRuntimeId<"toolCall">>,
	toolName: string,
	requests: readonly AccessRequest[],
	args: unknown,
	cwd: string,
): AuthorizationRequest {
	const requestId = createRuntimeId("command", canonicalDigest({ sessionId: fence.sessionId, toolCallId, toolName, requests, args, cwd }).slice(0, 64));
	return {
		requestId,
		sessionId: fence.sessionId,
		turnId: createRuntimeId("turn", canonicalDigest({ requestId, toolCallId, fence }).slice(0, 64)),
		toolCallId,
		toolName,
		argumentsDigest: digestOf(args),
		cwd,
		requests,
		workspace,
		snapshot,
	};
}

function executionConstraintInput(
	identity: SessionIdentity,
	fence: OwnerFence,
	commandId: ReturnType<typeof createRuntimeId<"command">>,
	requestDigest: RuntimeDigest,
	snapshot: SecuritySnapshot,
	sandbox: "none" | "profile",
): ExecutionConstraintInput {
	return {
		authorityId: identity.authorityId,
		tenantId: identity.tenantId,
		workspaceId: identity.workspaceId,
		principalId: createRuntimeId("principal", "session-agent"),
		executionId: createRuntimeId("execution", requestDigest.digest.slice(0, 64)),
		attemptId: createRuntimeId("attempt", `${requestDigest.digest.slice(0, 48)}_1`),
		commandId,
		requestDigest,
		policyDigest: snapshot.policyDigest,
		modes: {
			permission: "policy",
			approval: snapshot.profile.approvalPolicy === "never" ? "none" : "required",
			sandbox,
			gateway: "mediated",
			containment: "none",
		},
	};
}

function createConstraintProviders(bindings: ReadonlyMap<string, ProcessBinding>): ExecutionConstraintProviders {
	return {
		permission: { decide: async (input) => createExecutionConstraintReceipt({ dimension: "permission", mode: input.modes.permission, decision: "allow", providerId: "runledger.session.permission", providerRevision: 1, policyDigest: input.policyDigest, invocationDigest: input.requestDigest }) },
		approval: { decide: async (input) => createExecutionConstraintReceipt({ dimension: "approval", mode: input.modes.approval, decision: input.modes.approval === "none" ? "not_required" : "allow", providerId: input.modes.approval === "none" ? "builtin-none.approval" : "runledger.session.approval", providerRevision: 1, policyDigest: input.policyDigest, invocationDigest: input.requestDigest }) },
		sandbox: {
			decide: async (input) => {
				if (input.modes.sandbox === "none") return createExecutionConstraintReceipt({ dimension: "sandbox", mode: "none", decision: "not_required", enforcement: "off", providerId: "builtin-none.sandbox", providerRevision: 1, policyDigest: input.policyDigest, invocationDigest: input.requestDigest });
				const plan = bindings.get(input.requestDigest.digest)?.plan;
				if (plan?.enforcement !== "enforced") return undefined;
				return createExecutionConstraintReceipt({ dimension: "sandbox", mode: "profile", decision: "allow", enforcement: "enforced", providerId: `runledger.session.sandbox.${plan.backendId}`, providerRevision: 1, policyDigest: input.policyDigest, invocationDigest: input.requestDigest });
			},
		},
		gateway: { decide: async (input) => createExecutionConstraintReceipt({ dimension: "gateway", mode: input.modes.gateway, decision: "allow", route: "mediated", providerId: "runledger.session.gateway", providerRevision: 1, policyDigest: input.policyDigest, invocationDigest: input.requestDigest }) },
		containment: { decide: async (input) => createExecutionConstraintReceipt({ dimension: "containment", mode: "none", decision: "not_required", settlement: "not_requested", providerId: "builtin-none.containment", providerRevision: 1, policyDigest: input.policyDigest, invocationDigest: input.requestDigest }) },
	};
}

function sandboxRequest(
	snapshot: SecuritySnapshot,
	workspace: HostWorkspaceExecutionContext,
	requestDigest: RuntimeDigest,
	command: string,
	opts: ShellExecOptions | undefined,
	cwd: string,
): SandboxPrepareRequest {
	return {
		requested: snapshot.profile.sandbox,
		resolved: snapshot.profile.sandbox,
		policyDigest: snapshot.policyDigest,
		requestDigest,
		workspace,
		readRoots: existingLocalPaths(snapshot.filesystem.readRoots),
		writeRoots: existingLocalPaths(snapshot.filesystem.writeRoots.filter((path) => pathWithin(workspace.worktreePath, path))),
		denyRead: existingLocalPaths(snapshot.filesystem.denyRead),
		denyWrite: existingLocalPaths(snapshot.filesystem.denyWrite),
		protectedPaths: existingLocalPaths(snapshot.filesystem.protectedPaths),
		network: snapshot.profile.network.mode === "deny" ? "deny" : "allow",
		command,
		cwd,
		environment: opts?.env ?? {},
		timeoutMs: opts?.timeoutMs ?? 60_000,
		...(opts?.stdin === undefined ? {} : { stdin: opts.stdin }),
	};
}

function createWorkspaceEnvelope(
	identity: SessionIdentity,
	fence: OwnerFence,
	toolCallId: string,
	workspaceRoot: string,
	cwd: string,
): HostWorkspaceExecutionContext {
	const worktreePath = resolve(workspaceRoot);
	const canonicalCwd = resolve(cwd);
	return {
		authorityId: identity.authorityId,
		tenantId: identity.tenantId,
		principalId: createRuntimeId("principal", "session-agent"),
		sessionId: fence.sessionId,
		workspaceId: identity.workspaceId,
		repositoryId: identity.repositoryId,
		worktreePathDigest: runtimeDigest(worktreePath),
		branch: `runledger/session/${fence.sessionId.slice(0, 96)}`,
		baseCommit: "0".repeat(40),
		agentId: createRuntimeId("agent", "session-owner-agent"),
		toolCallId: createRuntimeId("toolCall", toolCallId.startsWith("toolCall_") ? toolCallId.slice(9) : toolCallId),
		traceId: createRuntimeId("trace", canonicalDigest({ fence, toolCallId, cwd: canonicalCwd }).slice(0, 64)),
		cwdDigest: runtimeDigest(canonicalCwd),
		ownerRuntimeId: fence.runtimeId,
		leaseRevision: fence.generation,
		fencingTokenDigest: runtimeDigest(fence),
		worktreePath,
		cwd: canonicalCwd,
	};
}

function networkDigestInput(request: NetworkRequest): Record<string, unknown> {
	return {
		url: request.url,
		method: request.method,
		headers: request.headers,
		bodyDigest: digestOf(request.body ?? ""),
		maxBytes: request.maxBytes,
	};
}

function shellDigestInput(command: string, opts: ShellExecOptions | undefined, cwd: string): Record<string, unknown> {
	return {
		command,
		cwd,
		env: opts?.env ?? {},
		timeoutMs: opts?.timeoutMs ?? 60_000,
		maxOutputChars: opts?.maxOutputChars ?? 1_000_000,
		stdinDigest: digestOf(opts?.stdin ?? ""),
	};
}

async function settleGatewayEffect<T>(context: ExecutionGatewayContext, effect: () => Promise<T>): Promise<T> {
	try {
		const value = await effect();
		unwrapSecurityResult(await context.complete());
		return value;
	} catch (error) {
		unwrapSecurityResult(await context.complete());
		throw error;
	}
}

function unwrapSecurityResult<T>(result: SecurityResult<T>): T {
	if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
	return result.value;
}

function unwrapSandboxResult<T>(result: { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } }): T {
	if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
	return result.value;
}

function isMissing(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
