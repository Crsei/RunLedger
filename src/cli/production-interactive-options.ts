/** CLI 到 production interactive composition 的严格 adapter 边界。 */

import { isAbsolute, resolve } from "node:path";
import type { Models } from "../models.ts";
import type { InteractiveSessionControllerOptions } from "../runtime/interactive-session-controller.ts";
import type { AgentLoopConfig, AgentTool, ToolResultArtifactSink } from "../runtime/types.ts";
import type { AgentLoopSessionEvents } from "../runtime/session/agent-loop-events.ts";
import type { SessionMutationAdmissionGatePort } from "../runtime/lifecycle/mutation-gate.ts";
import type {
	ProductionInteractiveRuntime,
	ProductionInteractiveRuntimeOptions,
} from "../storage/production-interactive-runtime.ts";
import type { V3SessionManager } from "../storage/v3-session-manager.ts";

export const REQUIRED_PRODUCTION_INTERACTIVE_ADAPTERS = [
	"governed_tools_and_manifests",
	"workspace_liveness",
	"artifact_access_and_forensic_authorization",
	"security_snapshot_resolver",
	"capability_peer_binding",
	"persistent_capability_rate_limiter",
	"permission_prompter",
	"credential_broker_ports",
	"restrictive_sandbox_backend",
	"production_verification_services",
	"compaction_sampler",
	"orchestrator_bindings",
] as const;

export type RequiredProductionInteractiveAdapter =
	(typeof REQUIRED_PRODUCTION_INTERACTIVE_ADAPTERS)[number];

/**
 * 默认 CLI 不为缺失端口制造 allow-all、memory 或 test adapter。部署层必须显式
 * 提供完整 provider，随后仍由 createProductionInteractiveRuntime 做 probe。
 */
export class ProductionInteractiveAdaptersUnavailableError extends Error {
	public readonly code = "production_interactive_adapters_unavailable";
	public readonly missingAdapters: readonly RequiredProductionInteractiveAdapter[];

	public constructor(
		missingAdapters: readonly RequiredProductionInteractiveAdapter[] = REQUIRED_PRODUCTION_INTERACTIVE_ADAPTERS,
	) {
		super(`production interactive runtime adapters are unavailable: ${missingAdapters.join(", ")}`);
		this.name = "ProductionInteractiveAdaptersUnavailableError";
		this.missingAdapters = Object.freeze([...missingAdapters]);
	}
}

export interface ProductionInteractiveOptionsRequest {
	readonly cwd: string;
	readonly manager: V3SessionManager;
	readonly models: Models;
	readonly mutationGate: SessionMutationAdmissionGatePort;
}

export type ProductionInteractiveAdapterOptions = Omit<
	ProductionInteractiveRuntimeOptions,
	"manager" | "models" | "mutationGate"
>;

/** 部署层的 production adapter provider；测试替身不得注册到 CLI 默认入口。 */
export interface ProductionInteractiveOptionsProvider {
	readonly implementation: "production";
	readonly providerId: string;
	readonly evidenceDigest: string;
	/** Admission 前声明，startup auditor 与 workspace/tool-gateway 必须共用此 root。 */
	readonly workspaceStateRoot: string;
	create(
		request: Readonly<ProductionInteractiveOptionsRequest>,
	): ProductionInteractiveAdapterOptions | Promise<ProductionInteractiveAdapterOptions>;
}

function validProviderIdentity(
	provider: ProductionInteractiveOptionsProvider,
	workspaceStateRoot: unknown,
): workspaceStateRoot is string {
	const tokens = provider.providerId.toLowerCase().split(/[^a-z0-9]+/u).filter(Boolean);
	return (
		provider.implementation === "production" &&
		provider.providerId.length > 0 &&
		provider.providerId.length <= 256 &&
		!tokens.some((token) => ["fake", "memory", "mock", "stub", "test"].includes(token)) &&
		/^[a-f0-9]{64}$/u.test(provider.evidenceDigest) &&
		new Set(provider.evidenceDigest).size >= 4 &&
		typeof workspaceStateRoot === "string" &&
		isAbsolute(workspaceStateRoot) &&
		resolve(workspaceStateRoot) === workspaceStateRoot &&
		!workspaceStateRoot.includes("\0")
	);
}

/** 只读取已通过 identity/evidence admission 的 root，不触发 provider create。 */
export function productionInteractiveWorkspaceStateRoot(
	provider?: ProductionInteractiveOptionsProvider,
): string | undefined {
	if (!provider) return undefined;
	const workspaceStateRoot: unknown = provider.workspaceStateRoot;
	if (!validProviderIdentity(provider, workspaceStateRoot)) {
		throw new ProductionInteractiveAdaptersUnavailableError();
	}
	return workspaceStateRoot;
}

export async function createCliProductionInteractiveOptions(
	request: ProductionInteractiveOptionsRequest,
	provider?: ProductionInteractiveOptionsProvider,
	admittedWorkspaceStateRoot?: string,
): Promise<ProductionInteractiveRuntimeOptions> {
	if (!provider) throw new ProductionInteractiveAdaptersUnavailableError();
	const providerWorkspaceStateRoot = productionInteractiveWorkspaceStateRoot(provider);
	if (!providerWorkspaceStateRoot) throw new ProductionInteractiveAdaptersUnavailableError();
	if (
		admittedWorkspaceStateRoot !== undefined &&
		providerWorkspaceStateRoot !== admittedWorkspaceStateRoot
	) {
		throw new Error("production interactive provider workspace state root changed after admission");
	}
	const workspaceStateRoot = admittedWorkspaceStateRoot ?? providerWorkspaceStateRoot;
	if (request.manager.isClosed()) {
		throw new Error("production interactive options require an open V3 session manager");
	}
	const adapters = await provider.create(Object.freeze({ ...request }));
	if (!adapters || typeof adapters !== "object") {
		throw new ProductionInteractiveAdaptersUnavailableError();
	}
	if (!adapters.workspace || adapters.workspace.stateRoot !== workspaceStateRoot) {
		throw new Error("production interactive workspace state root does not match the admitted provider root");
	}
	return {
		...adapters,
		// manager/models/gate 始终由当前 CLI session 注入，provider 不能替换所有权。
		manager: request.manager,
		models: request.models,
		mutationGate: request.mutationGate,
	};
}

export interface ProductionInteractiveControllerBindings {
	readonly cwd: string;
	readonly sessionId: string;
	readonly tools: AgentTool[];
	readonly beforeToolCall?: NonNullable<AgentLoopConfig["beforeToolCall"]>;
	readonly afterToolCall?: NonNullable<AgentLoopConfig["afterToolCall"]>;
	readonly prepareModelRequest: NonNullable<AgentLoopConfig["prepareModelRequest"]>;
	readonly toolExecutionGateway: NonNullable<AgentLoopConfig["toolExecutionGateway"]>;
	readonly sessionEvents: AgentLoopSessionEvents;
	readonly toolResultArtifactSink: ToolResultArtifactSink;
	readonly operationBudget: NonNullable<AgentLoopConfig["operationBudget"]>;
	readonly extensionLifecycle?: NonNullable<InteractiveSessionControllerOptions["extensionLifecycle"]>;
	readonly extensionControl?: NonNullable<InteractiveSessionControllerOptions["extensionControl"]>;
	readonly toolProvider?: NonNullable<InteractiveSessionControllerOptions["toolProvider"]>;
}

/** Controller 的所有治理字段只能从已激活 composition 原样投影。 */
export function productionInteractiveControllerBindings(
	runtime: ProductionInteractiveRuntime,
): ProductionInteractiveControllerBindings {
	return {
		cwd: runtime.cwd,
		sessionId: runtime.sessionId,
		tools: runtime.tools,
		...(runtime.beforeToolCall ? { beforeToolCall: runtime.beforeToolCall } : {}),
		...(runtime.afterToolCall ? { afterToolCall: runtime.afterToolCall } : {}),
		prepareModelRequest: runtime.prepareModelRequest,
		toolExecutionGateway: runtime.toolExecutionGateway,
		sessionEvents: runtime.sessionEvents,
		toolResultArtifactSink: runtime.toolResultArtifactSink,
		operationBudget: runtime.operationBudget,
		...(runtime.extensionRuntime ? {
			extensionLifecycle: runtime.extensionRuntime,
			toolProvider: () => runtime.toolRegistry.toContext(),
		} : {}),
		...(runtime.extensionControlPlane ? {
			extensionControl: {
				mutate: async (input) => {
					const kind = input.action === "trust"
						? "trust-grant"
						: input.action === "untrust"
							? "trust-revoke"
							: input.action === "login"
								? "mcp-login"
								: input.action === "logout"
									? "mcp-logout"
									: `${input.kind === "mcp-server" ? "mcp" : input.kind}-${input.action}`;
					const response = await runtime.extensionControlPlane!.execute({
						kind: kind as
							| "trust-grant"
							| "trust-revoke"
							| "plugin-enable"
							| "plugin-disable"
							| "hook-enable"
							| "hook-disable"
							| "mcp-enable"
							| "mcp-disable"
							| "mcp-login"
							| "mcp-logout",
						resourceId: input.resourceId,
						json: true,
						yes: true,
						digest: input.digest,
					});
					return {
						ok: response.ok,
						status: response.ok ? "pending" as const : "failed" as const,
						message: response.ok
							? "Extension mutation accepted; reload pending"
							: response.error?.message ?? "Extension mutation failed",
					};
				},
			},
		} : {}),
	};
}
