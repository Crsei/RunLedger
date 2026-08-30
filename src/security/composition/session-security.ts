/**
 * S2 拆分:Session Security composition root。
 *
 * 只做装配:配置加载(snapshot-loader)、约束 provider、authorizer、
 * governed leaves(fs/network/shell)、managed-process security 与
 * permission requester 在此组合;close() 只关闭 Session 独占的 analyzer。
 */

import { resolve } from "node:path";
import type { ExecutionEnv, Shell } from "../../runtime/execution-env.ts";
import { localExecutionEnv } from "../../runtime/execution-env.ts";
import type { RunledgerLayout } from "../../runtime/contracts/storage-layout.ts";
import { workspaceStorageKey } from "../../runtime/contracts/storage-layout.ts";
import { canonicalDigest } from "../../runtime/protocol/canonical-json.ts";
import { runtimeDigest } from "../../runtime/protocol/foundation.ts";
import { createRuntimeId, parseRuntimeId, type RepositoryId, type WorkspaceId } from "../../runtime/protocol/ids.ts";
import type { OwnerFence } from "../../runtime/session-owner/types.ts";
import type { ToolAuthorizationPolicy } from "../../runtime/types.ts";
import { runtimeWorkspacePlatform } from "../../workspace/runtime-platform.ts";
import type { SecurityConfigSourcePort } from "../config/loader.ts";
import { ExecutionGateway } from "../execution-gateway.ts";
import { ProcessFinalLeafAdapter } from "../integration/runtime-gateway-adapter.ts";
import { GovernedToolAuthorizationPolicy } from "../integration/runtime-tool-authorization.ts";
import {
	createLocalFileSystemBroker,
	createLocalNetworkBroker,
	createLocalSessionProcessLeaf,
	findLocalExecutable,
	prepareLocalGovernedProcessDirectories,
	type SessionProcessLeaf,
} from "../integration/session-local-leaves.ts";
import { ApprovalCoordinator, HeadlessDenyPrompter, type ApprovalAuditPort, type ApprovalStateStorePort } from "../permission/approval-coordinator.ts";
import { PermissionEngine } from "../permission/engine.ts";
import { BashSecurityAnalyzer } from "../permission/bash-ast/classifier.ts";
import type { BashSecurityAnalyzerPort, BashClassificationAuditPort, BashShadowTelemetryPort } from "../permission/bash-ast/types.ts";
import { MemoryPermissionGrantStore } from "../permission/grants.ts";
import type { RequestPermissionsPort } from "../tools/request-permissions.ts";
import type { FileSystemBrokerPort } from "../policy-filesystem.ts";
import type { NetworkBrokerPort } from "../policy-network.ts";
import { createSandboxBackend } from "../sandbox/factory.ts";
import type { SandboxBackend } from "../sandbox/types.ts";
import type { GovernedProcessEnvironment, SessionToolchainProbe, SessionToolchainSnapshot } from "../toolchain.ts";
import type { PermissionPrompter, SecuritySnapshot } from "../types.ts";
import { createConstraintProviders, createWorkspaceEnvelope, type ProcessBinding } from "./constraint-providers.ts";
import { createAuthorizer, createPermissionRequester } from "./permission-requester.ts";
import { createManagedProcessSecurity, type SessionManagedProcessSecurity } from "./managed-process-security.ts";
import { createGovernedFileSystem } from "./governed-filesystem.ts";
import { createGovernedNetwork } from "./governed-network.ts";
import { createGovernedShell } from "./governed-shell.ts";
import { loadSnapshot } from "./snapshot-loader.ts";

export interface SessionSecurityConfigSource extends SecurityConfigSourcePort {
	readonly source: SecurityConfigSourcePort["source"];
}

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
	/** Production composition root 解析一次；缺失时仅保留低层/legacy 测试接缝。 */
	readonly toolchain?: SessionToolchainSnapshot;
	readonly processEnvironment?: GovernedProcessEnvironment;
	readonly toolchainProbe?: SessionToolchainProbe;
	readonly now?: () => Date;
	/** Session Event Store + driver reverse-request 的 production approval ports。 */
	readonly approvalPorts?: {
		readonly prompter: PermissionPrompter;
		readonly stateStore: ApprovalStateStorePort;
		readonly audit: ApprovalAuditPort;
	};
	readonly bashShadowTelemetry?: BashShadowTelemetryPort;
	readonly bashClassificationAudit?: BashClassificationAuditPort;
	/** 测试/受控组合接缝；生产默认创建并独占 Session-scoped analyzer。 */
	readonly bashAnalyzer?: BashSecurityAnalyzerPort;
	readonly approvalTimeoutMs?: number;
}

export interface SessionSecurityComposition {
	readonly snapshot: SecuritySnapshot;
	readonly executionEnv: ExecutionEnv;
	readonly authorizationPolicy: ToolAuthorizationPolicy;
	readonly managedProcess: SessionManagedProcessSecurity;
	readonly permissionRequester: RequestPermissionsPort;
	readonly bashAnalyzer: BashSecurityAnalyzerPort;
	close(): Promise<void>;
}

export interface SessionIdentity {
	readonly authorityId: ReturnType<typeof createRuntimeId<"authority">>;
	readonly tenantId: ReturnType<typeof createRuntimeId<"tenant">>;
	readonly workspaceId: WorkspaceId;
	readonly repositoryId: RepositoryId;
}

export async function createSessionSecurity(
	options: SessionSecurityCompositionOptions,
): Promise<SessionSecurityComposition> {
	if ((options.toolchain === undefined) !== (options.processEnvironment === undefined)) {
		throw new Error("toolchain and governed process environment must be supplied together");
	}
	if (options.processEnvironment !== undefined) {
		if (runtimeDigest(options.processEnvironment.environment).digest !== options.processEnvironment.environmentDigest.digest) {
			throw new Error("governed process environment digest is invalid");
		}
		await prepareLocalGovernedProcessDirectories(options.layout.tmp, options.processEnvironment);
	}
	const cwd = resolve(options.cwd);
	const identity = sessionIdentity(options.workspaceId, options.repositoryId);
	const storageKey = workspaceStorageKey(identity);
	const snapshot = await loadSnapshot(options, storageKey, cwd);
	const ownedBashAnalyzer = options.bashAnalyzer === undefined
		? new BashSecurityAnalyzer({
				...(options.bashShadowTelemetry === undefined ? {} : { telemetry: options.bashShadowTelemetry }),
				...(snapshot.bashAnalyzer === undefined ? {} : { resolution: snapshot.bashAnalyzer }),
			})
		: undefined;
	const bashAnalyzer: BashSecurityAnalyzerPort = options.bashAnalyzer ?? ownedBashAnalyzer!;
	if (snapshot.bashAnalyzer?.mode !== "legacy") await bashAnalyzer.initialize?.();
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
		? {
			prompter: new HeadlessDenyPrompter(),
			...(options.now === undefined ? {} : { clock: options.now }),
			...(options.approvalTimeoutMs === undefined ? {} : { timeoutMs: options.approvalTimeoutMs }),
		}
		: {
			prompter: options.approvalPorts.prompter,
			store: options.approvalPorts.stateStore,
			audit: options.approvalPorts.audit,
			...(options.now === undefined ? {} : { clock: options.now }),
			...(options.approvalTimeoutMs === undefined ? {} : { timeoutMs: options.approvalTimeoutMs }),
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
		...(options.bashClassificationAudit === undefined ? {} : { bashClassificationAudit: options.bashClassificationAudit }),
	});
	const authorize = createAuthorizer({ options, identity, snapshot, gateway, providers, workspace });
	const managedProcess = createManagedProcessSecurity({
		options,
		identity,
		snapshot,
		gateway,
		bashAnalyzer,
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
			bashAnalyzer,
			cwd,
		}),
	};
	return {
		snapshot,
		executionEnv,
		authorizationPolicy: new GovernedToolAuthorizationPolicy(),
		managedProcess,
		permissionRequester: createPermissionRequester({ options, snapshot, workspace, permissionEngine, approvalCoordinator, permissionGrantStore, cwd }),
		bashAnalyzer,
		close: async () => {
			await ownedBashAnalyzer?.close();
		},
	};
}

function sessionIdentity(workspaceId: string, repositoryId: string): SessionIdentity {
	return {
		authorityId: createRuntimeId("authority", "session-owner-runtime"),
		tenantId: createRuntimeId("tenant", "local-user"),
		workspaceId: parseRuntimeId("workspace", workspaceId) ?? createRuntimeId("workspace", canonicalDigest(workspaceId)),
		repositoryId: parseRuntimeId("repository", repositoryId) ?? createRuntimeId("repository", canonicalDigest(repositoryId)),
	};
}
