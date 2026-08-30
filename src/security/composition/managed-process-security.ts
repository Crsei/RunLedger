/**
 * S2 拆分:managed process 的 session-scoped security prepare/complete 生命周期。
 *
 * prepare 顺序固定:输入校验 → AST 分类 → authorization request → sandbox
 * prepare(binding 登记)→ constraint 评估 → gateway authorize → 返回
 * validateFinalLeaf/complete;任何失败在 `finally` 中清除 binding,不留残留。
 */

import { isAbsolute } from "node:path";
import { canonicalDigest } from "../../runtime/protocol/canonical-json.ts";
import { runtimeDigest, type RuntimeDigest } from "../../runtime/protocol/foundation.ts";
import { createRuntimeId, parseRuntimeId } from "../../runtime/protocol/ids.ts";
import { evaluateExecutionConstraints, type ExecutionConstraintInput, type ExecutionConstraintProviders, type ExecutionConstraintSnapshot } from "../../runtime/process/execution-decision.ts";
import { createAuthorizedCommandDisplayReceipt } from "../../runtime/process/command-display.ts";
import type { AuthorizedCommandDisplayReceipt } from "../../runtime/process/types.ts";
import { ExecutionGateway, gatewayRequestDigest } from "../execution-gateway.ts";
import { ProcessFinalLeafAdapter } from "../integration/runtime-gateway-adapter.ts";
import { resolveToolAccessRequestsWithBashAnalyzer } from "../permission/access-resolver.ts";
import type { BashSecurityAnalyzerPort } from "../permission/bash-ast/types.ts";
import { prepareLocalGovernedProcessDirectories, createLocalSessionToolchainProbe } from "../integration/session-local-leaves.ts";
import { digestOf } from "../sandbox/common.ts";
import type { SandboxBackend, SandboxLaunchPlan } from "../sandbox/types.ts";
import { validateSessionToolchainSnapshot } from "../toolchain.ts";
import type { HostWorkspaceExecutionContext, SecurityResult, SecuritySnapshot } from "../types.ts";
import { linkBashClassificationAudit, unwrapSecurityResult } from "./audit-settlement.ts";
import { executionConstraintInput, sandboxRequest, type ProcessBinding } from "./constraint-providers.ts";
import { authorizationRequest } from "./permission-requester.ts";
import type { SessionIdentity, SessionSecurityCompositionOptions } from "./session-security.ts";

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
	readonly commandDisplayReceipt: AuthorizedCommandDisplayReceipt;
	readonly sandboxPlan?: SandboxLaunchPlan;
	readonly launchPlan?: SandboxLaunchPlan;
	readonly toolchainSnapshotDigest?: RuntimeDigest;
	readonly environmentDigest?: RuntimeDigest;
	validateFinalLeaf(): ReturnType<ProcessFinalLeafAdapter["decide"]>;
	complete(): Promise<SecurityResult<void>>;
}

export interface SessionManagedProcessSecurity {
	prepare(input: SessionManagedProcessSecurityRequest, signal?: AbortSignal): Promise<SecurityResult<PreparedSessionManagedProcessSecurity>>;
}

function securityError(code: "invalid_request" | "policy_denied", message: string): SecurityResult<never> {
	return { ok: false, error: { code, message, retryable: false } };
}

export function createManagedProcessSecurity(input: {
	readonly options: SessionSecurityCompositionOptions;
	readonly identity: SessionIdentity;
	readonly snapshot: SecuritySnapshot;
	readonly gateway: ExecutionGateway;
	readonly bashAnalyzer: BashSecurityAnalyzerPort;
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
			const environment = input.options.processEnvironment?.environment ?? {};
			if (input.options.processEnvironment !== undefined && runtimeDigest(environment).digest !== input.options.processEnvironment.environmentDigest.digest) {
				return securityError("invalid_request", "governed process environment digest is invalid");
			}
			if ((input.options.toolchain === undefined) !== (input.options.processEnvironment === undefined)) {
				return securityError("invalid_request", "toolchain and governed process environment must be supplied together");
			}
			const mode = input.snapshot.bashAnalyzer?.mode ?? "legacy";
			const requests = unwrapSecurityResult(await resolveToolAccessRequestsWithBashAnalyzer(
				"bash",
				{ command: request.command },
				request.cwd,
				mode,
				input.bashAnalyzer,
			));
			const authorization = {
				...authorizationRequest(
				input.options.fence,
				input.snapshot,
				workspace,
				toolCallId,
				"bash",
				requests,
				{
					command: request.command,
					cwd: request.cwd,
					timeoutMs: request.timeoutMs,
					backend: request.backend,
					executionMode: request.executionMode,
					stdinDigest: digestOf(request.stdin ?? ""),
					...(input.options.toolchain === undefined ? {} : { toolchainSnapshotDigest: input.options.toolchain.snapshotDigest }),
					...(input.options.processEnvironment === undefined ? {} : { environmentDigest: input.options.processEnvironment.environmentDigest }),
				},
				request.cwd,
				),
				requestId: commandId,
			};
			const requestDigest = gatewayRequestDigest(authorization);
			const restrictive = input.snapshot.profile.sandbox !== "off";
			let plan: SandboxLaunchPlan | undefined;
			if (restrictive || input.options.toolchain !== undefined) {
				const prepared = await input.sandboxBackend.prepare(sandboxRequest(
					input.snapshot,
					workspace,
					requestDigest,
					request.command,
					{ timeoutMs: request.timeoutMs, ...(request.stdin === undefined ? {} : { stdin: request.stdin }) },
					request.cwd,
					environment,
				));
				if (!prepared.ok) return securityError("policy_denied", prepared.error.message);
				plan = prepared.value;
				if (restrictive) input.bindings.set(requestDigest.digest, { plan });
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
						commandDisplayReceipt: createAuthorizedCommandDisplayReceipt({
							command: request.command,
							requestDigest,
							constraintSnapshotDigest: constraints.snapshot.snapshotDigest,
						}),
						...(plan === undefined ? {} : { launchPlan: plan }),
						...(restrictive && plan !== undefined ? { sandboxPlan: plan } : {}),
						...(input.options.toolchain === undefined ? {} : { toolchainSnapshotDigest: input.options.toolchain.snapshotDigest }),
						...(input.options.processEnvironment === undefined ? {} : { environmentDigest: input.options.processEnvironment.environmentDigest }),
						validateFinalLeaf: async () => {
							if (input.options.processEnvironment !== undefined) {
								try {
									await prepareLocalGovernedProcessDirectories(input.options.layout.tmp, input.options.processEnvironment);
								} catch (error) {
									return securityError("invalid_request", error instanceof Error ? error.message : "governed process directories are invalid");
								}
							}
							if (input.options.toolchain !== undefined) {
								const validToolchain = await validateSessionToolchainSnapshot(
									input.options.toolchain,
									input.options.toolchainProbe ?? createLocalSessionToolchainProbe(),
								);
								if (!validToolchain.ok) return securityError("invalid_request", validToolchain.error.message);
							}
							if (!restrictive && plan !== undefined) {
								const receipt = await input.sandboxBackend.validateFinalLeaf(plan, requestDigest);
								if (receipt.decision !== "off" || receipt.planDigest.digest !== plan.planDigest.digest) {
									return securityError("invalid_request", "off launch plan final-leaf validation failed");
								}
							}
							const decision = await input.finalLeaf.decide({
								constraintInput,
								constraintSnapshot: constraints.snapshot,
								requestDigest,
								policyDigest: input.snapshot.policyDigest,
								...(restrictive && plan !== undefined ? { sandboxPlan: plan } : {}),
							});
							if (decision.ok) {
								await linkBashClassificationAudit(
									input.options.bashClassificationAudit,
									input.options.fence.sessionId,
									requestDigest,
									decision.value,
								);
							}
							return decision;
						},
						complete: opened.value.complete,
					},
				};
			} finally {
				input.bindings.delete(requestDigest.digest);
			}
		},
	};
}
