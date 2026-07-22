/** Production Agent supervisor composition：所有 durable graph 与 child gate 绑定同一父 session。 */

import { isAbsolute, resolve } from "node:path";
import type { ArtifactAccessService } from "../../artifacts/access.ts";
import type { BudgetGuard } from "../../orchestrator/budget-guard.ts";
import { canonicalDigest } from "../../protocol/v3/canonical-json.ts";
import { createIdempotencyKey } from "../../protocol/v3/coordination.ts";
import { createRuntimeId } from "../../protocol/v3/ids.ts";
import type { RuntimeFeatureFlags } from "../../runtime-features.ts";
import type { SessionMutationAdmissionGatePort } from "../../lifecycle/mutation-gate.ts";
import type { DeclassificationReceiptRef, InputSourceRef } from "../../protocol/v3/taint.ts";
import type { V3SessionManager } from "../../../storage/v3-session-manager.ts";
import type { WorktreeManager } from "../../../worktree/manager.ts";
import { GitOperations } from "../../../worktree/git-operations.ts";
import type { WorktreeCreateResult } from "../../../worktree/types.ts";
import { NodeGitCommandPort } from "../../../storage/worktree-node-adapter.ts";
import { SessionAgentGraphStore } from "../session-graph-store.ts";
import { AgentSupervisor, RootBudgetGuardAdapter } from "../supervisor.ts";
import type {
	AgentGraphLimits,
	AgentRole,
	AgentSupervisorPorts,
	AgentWorkspaceStrategyRef,
	ParentCapabilityGrantRef,
	RegisterRootAgentRequest,
} from "../types.ts";
import {
	GatewayBoundCapabilitySubsetEvaluator,
	type ProductionCapabilityGrantPolicy,
} from "./capability-subset.ts";
import {
	ProductionChildSessionLauncher,
	type ChildSessionRuntimeSnapshot,
	type ProductionChildSessionLauncherOptions,
} from "./child-session-launcher.ts";
import {
	ProductionAgentDenialEvaluator,
	type ProductionAgentDenialPolicy,
} from "./denial-evaluator.ts";
import { ProductionArtifactMergeAdapter } from "./artifact-merge.ts";
import { ProductionAgentWorkspaceAdapter } from "./worktree-workspace.ts";

export interface ProductionAgentSupervisorCompositionOptions {
	/** 父 manager 是 graph 的唯一 writer owner；composition 不接管其 close。 */
	manager: V3SessionManager;
	/** 必须是 active parent runtime 正在使用的 canonical mutation gate。 */
	parentMutationGate: SessionMutationAdmissionGatePort;
	root: Omit<RegisterRootAgentRequest, "sessionId">;
	adapters: Omit<
		AgentSupervisorPorts,
		"graphStore" | "launcher" | "workspace" | "capabilitySubset"
	> & {
		workspace: ProductionAgentWorkspaceAdapter;
		capabilitySubset: GatewayBoundCapabilitySubsetEvaluator;
	};
	child: Omit<
		ProductionChildSessionLauncherOptions,
		"workspace" | "capabilitySubset" | "parentMutationGate" | "identity"
	>;
	limits?: Partial<AgentGraphLimits>;
	clock?: () => Date;
}

export interface ProductionAgentSupervisorComposition {
	readonly supervisor: AgentSupervisor;
	/** 只暴露脱敏 residency snapshot；writer、launcher 与 canonical gate 保持私有。 */
	childSnapshots(): readonly ChildSessionRuntimeSnapshot[];
	/** 只关闭 composition 自己持有的 child runtime，不关闭父 manager。 */
	close(): Promise<void>;
}

/** Interactive runtime 只提供 Supervisor 控制面；shutdown 始终由父 runtime 统一编排。 */
export interface ProductionAgentSupervisorRuntimeHandle {
	readonly supervisor: AgentSupervisor;
	childSnapshots(): readonly ChildSessionRuntimeSnapshot[];
}

export interface ProductionAgentSupervisorConfiguration {
	root: {
		role: AgentRole;
		capabilityGrant: ParentCapabilityGrantRef;
		capabilityPolicies: readonly ProductionCapabilityGrantPolicy[];
		denialPolicy: ProductionAgentDenialPolicy;
		inputSources: readonly InputSourceRef[];
		declassificationReceipts: readonly DeclassificationReceiptRef[];
	};
	child: {
		sessionDir: string;
		features: Readonly<RuntimeFeatureFlags>;
		maxActiveChildren: number;
		processIsolation?: ProductionChildSessionLauncherOptions["processIsolation"];
	};
	limits?: Partial<AgentGraphLimits>;
	maxPatchBytes?: number;
}

export interface ProductionAgentSupervisorRuntimeOptions {
	manager: V3SessionManager;
	parentMutationGate: SessionMutationAdmissionGatePort;
	workspaceManager: WorktreeManager;
	rootWorkspace: WorktreeCreateResult;
	artifactAccess: ArtifactAccessService;
	budget: BudgetGuard;
	configuration: ProductionAgentSupervisorConfiguration;
	clock?: () => Date;
}

async function closeLauncherAfterStartupFailure(
	launcher: ProductionChildSessionLauncher,
	primaryError: unknown,
): Promise<never> {
	try {
		await launcher.close();
	} catch (cleanupError) {
		throw new AggregateError(
			[primaryError, cleanupError],
			"production Agent supervisor startup failed and child cleanup was incomplete",
		);
	}
	throw primaryError;
}

function assertParentScope(options: ProductionAgentSupervisorCompositionOptions): void {
	if (options.manager.isClosed()) {
		throw new Error("production Agent supervisor requires an open parent V3 session");
	}
	const lineage = options.manager.sessionEvents().lineage();
	if (
		options.root.agentId !== lineage.agentId ||
		options.root.goalId !== lineage.goalId ||
		options.root.workspaceReceipt.sessionId !== options.manager.sessionId()
	) {
		throw new Error("production Agent supervisor root is outside the active parent session scope");
	}
}

/**
 * 构造顺序固定为 graph store -> launcher -> supervisor -> durable root registration。
 * 任一 registration 失败都会先关闭 launcher；父 manager 的所有权始终留给 caller。
 */
export async function createProductionAgentSupervisorComposition(
	options: ProductionAgentSupervisorCompositionOptions,
): Promise<ProductionAgentSupervisorComposition> {
	assertParentScope(options);
	const identity = options.manager.identity();
	const graphStore = new SessionAgentGraphStore({
		writer: options.manager.writer(),
		store: options.manager.eventStore(),
		principalId: identity.principalId,
	});
	const launcher = new ProductionChildSessionLauncher({
		...options.child,
		workspace: options.adapters.workspace,
		capabilitySubset: options.adapters.capabilitySubset,
		parentMutationGate: options.parentMutationGate,
		identity,
	});
	const supervisor = new AgentSupervisor({
		rootAgentId: options.root.agentId,
		ports: { ...options.adapters, graphStore, launcher },
		...(options.limits ? { limits: options.limits } : {}),
		...(options.clock ? { clock: options.clock } : {}),
	});
	let registered: Awaited<ReturnType<AgentSupervisor["registerRoot"]>>;
	try {
		registered = await supervisor.registerRoot({
			...options.root,
			sessionId: options.manager.sessionId(),
		});
	} catch (error) {
		return closeLauncherAfterStartupFailure(launcher, error);
	}
	if (!registered.ok) {
		return closeLauncherAfterStartupFailure(
			launcher,
			new Error(`production Agent supervisor root registration failed: ${registered.error.code}`),
		);
	}
	let closePromise: Promise<void> | undefined;
	return {
		supervisor,
		childSnapshots: () => launcher.snapshots(),
		close: () => {
			closePromise ??= launcher.close().catch((error: unknown) => {
				closePromise = undefined;
				throw error;
			});
			return closePromise;
		},
	};
}

/**
 * Interactive/daemon production runtime 使用的高层入口。所有 adapter 都从父 runtime
 * 已探测的 Workspace、Artifact、Budget 和 identity 构造，caller 不能替换 graph store、
 * launcher 或 parent mutation gate。
 */
export async function createProductionAgentSupervisorRuntime(
	options: ProductionAgentSupervisorRuntimeOptions,
): Promise<ProductionAgentSupervisorComposition> {
	const { manager, configuration } = options;
	if (manager.isClosed()) throw new Error("production Agent runtime requires an open parent manager");
	if (!isAbsolute(configuration.child.sessionDir) || resolve(configuration.child.sessionDir) !== configuration.child.sessionDir) {
		throw new Error("production Agent child session directory must be an exact absolute path");
	}
	const identity = manager.identity();
	const lineage = manager.sessionEvents().lineage();
	const binding = options.rootWorkspace.binding;
	const clock = options.clock ?? (() => new Date());
	const workspace = new ProductionAgentWorkspaceAdapter({
		manager: options.workspaceManager,
		authorityId: identity.authorityId,
		tenantId: identity.tenantId,
		principalId: identity.principalId,
		repositoryId: binding.repositoryId,
		sourceRepo: binding.sourceRepo,
		sourceCwd: binding.sourceCwd,
		rootAgentId: lineage.agentId,
		rootOwnerRuntimeId: manager.runtimeId(),
		clock,
	});
	const rootStrategyKind = binding.bindingKind === "source" ? "isolated_lease" : binding.bindingKind;
	const rootStrategy: AgentWorkspaceStrategyRef = {
		strategyId: createRuntimeId(
			"resource",
			`production-root-workspace-${canonicalDigest({ sessionId: manager.sessionId(), workspaceId: binding.workspaceId }).slice(0, 40)}`,
		),
		kind: rootStrategyKind,
		strategyDigest: canonicalDigest({
			bindingKind: binding.bindingKind,
			workspaceId: binding.workspaceId,
			repositoryId: binding.repositoryId,
			sourceRepo: binding.sourceRepo,
			sourceCwd: binding.sourceCwd,
		}),
	};
	const rootWorkspace = await workspace.adoptRoot({
		requestId: createRuntimeId(
			"command",
			`production-root-workspace-${canonicalDigest(manager.sessionId()).slice(0, 40)}`,
		),
		agentId: lineage.agentId,
		sessionId: manager.sessionId(),
		strategy: rootStrategy,
	}, options.rootWorkspace);
	if (!rootWorkspace.ok) throw new Error(`production Agent root Workspace adoption failed: ${rootWorkspace.error.code}`);
	const capabilitySubset = new GatewayBoundCapabilitySubsetEvaluator(configuration.root.capabilityPolicies, clock);
	const deniedAgents = new ProductionAgentDenialEvaluator(configuration.root.denialPolicy, clock);
	const merge = new ProductionArtifactMergeAdapter({
		workspace,
		artifactAccess: options.artifactAccess,
		git: new GitOperations(new NodeGitCommandPort()),
		principalId: identity.principalId,
		...(configuration.maxPatchBytes === undefined ? {} : { maxPatchBytes: configuration.maxPatchBytes }),
		clock,
	});
	const registrationSeed = canonicalDigest({
		sessionId: manager.sessionId(),
		agentId: lineage.agentId,
		goalId: lineage.goalId,
		workspaceReceipt: rootWorkspace.value,
		capabilityGrant: configuration.root.capabilityGrant,
	});
	return createProductionAgentSupervisorComposition({
		manager,
		parentMutationGate: options.parentMutationGate,
		root: {
			requestId: createRuntimeId("command", `production-agent-root-${registrationSeed.slice(0, 40)}`),
			idempotencyKey: createIdempotencyKey(`production-agent-root-${registrationSeed.slice(0, 48)}`),
			agentId: lineage.agentId,
			goalId: lineage.goalId,
			role: configuration.root.role,
			workspaceReceipt: rootWorkspace.value,
			capabilityGrant: configuration.root.capabilityGrant,
			inputSources: configuration.root.inputSources,
			declassificationReceipts: configuration.root.declassificationReceipts,
			registeredAt: clock().toISOString(),
		},
		adapters: {
			capabilitySubset,
			workspace,
			deniedAgents,
			budget: new RootBudgetGuardAdapter(options.budget),
			merge,
		},
		child: {
			...configuration.child,
			clock,
		},
		...(configuration.limits ? { limits: configuration.limits } : {}),
		clock,
	});
}
