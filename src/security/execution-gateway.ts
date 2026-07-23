/** 唯一 policy-aware 执行面；filesystem/network/shell 均由受限 adapter 返回。 */

import { canonicalDigest } from "../runtime/protocol/v3/canonical-json.ts";
import type { SandboxExecutionReceiptRef } from "../runtime/protocol/v3/capability.ts";
import type { WorkspaceExecutionEnvelope } from "../runtime/protocol/v3/workspace.ts";
import { ApprovalCoordinator } from "./permission/approval-coordinator.ts";
import { resolveToolAccessRequests } from "./permission/access-resolver.ts";
import { PermissionEngine } from "./permission/engine.ts";
import { PolicyFileSystem, type FileSystemBrokerPort } from "./policy-filesystem.ts";
import { PolicyNetworkClient, type NetworkBrokerPort } from "./policy-network.ts";
import type { AuthorizationResult, SecurityResult, SecuritySnapshot } from "./types.ts";

export interface GatewayShellRequest {
	command: string;
	cwd: string;
	environment: Readonly<Record<string, string>>;
	timeoutMs: number;
	stdin?: string;
}

export interface GatewayShellResult {
	stdout: string;
	stderr: string;
	exitCode: number;
	signaled: boolean;
	receipt: SandboxExecutionReceiptRef;
}

export interface SandboxedShellPort {
	exec(request: GatewayShellRequest, envelope: WorkspaceExecutionEnvelope, signal?: AbortSignal): Promise<SecurityResult<GatewayShellResult>>;
}

export interface ManagedProcessRegistryPort {
	register(processId: string, requestDigest: string): SecurityResult<void>;
	complete(processId: string): SecurityResult<void>;
	cancelAll(reason: string): Promise<SecurityResult<number>>;
}

export interface ExecutionGatewayContext {
	authorization: AuthorizationResult;
	authorizationDigest: string;
	filesystem: PolicyFileSystem;
	network: PolicyNetworkClient;
	shell: SandboxedShellPort;
	processes: ManagedProcessRegistryPort;
}

export interface ExecutionGatewayOptions {
	snapshot: SecuritySnapshot;
	workspace: WorkspaceExecutionEnvelope;
	filesystemBroker: FileSystemBrokerPort;
	networkBroker: NetworkBrokerPort;
	shell: SandboxedShellPort;
	processes: ManagedProcessRegistryPort;
	permissionEngine: PermissionEngine;
	approvalCoordinator: ApprovalCoordinator;
}

export class ExecutionGateway {
	readonly #options: ExecutionGatewayOptions;

	public constructor(options: ExecutionGatewayOptions) {
		this.#options = options;
	}

	public async authorize(input: {
		requestId: Parameters<ApprovalCoordinator["authorize"]>[0]["requestId"];
		sessionId: Parameters<ApprovalCoordinator["authorize"]>[0]["sessionId"];
		turnId: Parameters<ApprovalCoordinator["authorize"]>[0]["turnId"];
		toolCallId: Parameters<ApprovalCoordinator["authorize"]>[0]["toolCallId"];
		toolName: string;
		arguments: unknown;
		cwd: string;
	}, signal?: AbortSignal): Promise<SecurityResult<ExecutionGatewayContext>> {
		const requests = resolveToolAccessRequests(input.toolName, input.arguments, input.cwd);
		if (!requests.ok) return requests;
		const evaluation = this.#options.permissionEngine.evaluate(requests.value, this.#options.snapshot);
		const argumentsDigest = canonicalDigest(input.arguments);
		const authorizationRequest = {
			...input,
			argumentsDigest,
			requests: requests.value,
			workspace: this.#options.workspace,
			snapshot: this.#options.snapshot,
		};
		const authorized = await this.#options.approvalCoordinator.authorize(
			authorizationRequest,
			evaluation,
			() => ({ argumentsDigest: canonicalDigest(input.arguments), cwd: input.cwd, policyDigest: this.#options.snapshot.policyDigest }),
			signal,
		);
		if (!authorized.ok) return authorized;
		if (authorized.value.outcome !== "allow") {
			return { ok: false, error: { code: "policy_denied", message: authorized.value.reason, retryable: false } };
		}
		return {
			ok: true,
			value: {
				authorization: authorized.value,
				authorizationDigest: canonicalDigest(authorized.value),
				filesystem: new PolicyFileSystem(this.#options.filesystemBroker, input.cwd, this.#options.snapshot),
				network: new PolicyNetworkClient(this.#options.networkBroker, this.#options.snapshot.profile.network),
				shell: this.#options.shell,
				processes: this.#options.processes,
			},
		};
	}
}
