/**
 * S2 拆分:governed shell leaf —— bash 分类、授权、sandbox plan 与最终执行。
 *
 * 顺序固定:env override 校验 → AST 分类 → authorization → sandbox prepare
 * (binding 登记)→ constraint 评估 → gateway authorize → final leaf 校验 →
 * 执行;任何失败在 `finally` 中清除 binding。限制性 sandbox 永不调用
 * unrestrictedShell,只执行已校验 launch plan。
 */

import { resolve } from "node:path";
import { createRuntimeId } from "../../runtime/protocol/ids.ts";
import { evaluateExecutionConstraints, type ExecutionConstraintProviders } from "../../runtime/process/execution-decision.ts";
import type { Shell, ShellExecOptions } from "../../runtime/execution-env.ts";
import { ExecutionGateway, gatewayRequestDigest } from "../execution-gateway.ts";
import { ProcessFinalLeafAdapter } from "../integration/runtime-gateway-adapter.ts";
import { resolveToolAccessRequestsWithBashAnalyzer } from "../permission/access-resolver.ts";
import type { BashSecurityAnalyzerPort } from "../permission/bash-ast/types.ts";
import {
	prepareLocalGovernedProcessDirectories,
	createLocalSessionToolchainProbe,
	type SessionProcessLeaf,
} from "../integration/session-local-leaves.ts";
import { digestOf } from "../sandbox/common.ts";
import type { SandboxBackend, SandboxLaunchPlan } from "../sandbox/types.ts";
import { validateGovernedEnvironmentOverrides, validateSessionToolchainSnapshot } from "../toolchain.ts";
import type { HostWorkspaceExecutionContext, SecuritySnapshot } from "../types.ts";
import { linkBashClassificationAudit, settleGatewayEffect, unwrapSandboxResult, unwrapSecurityResult } from "./audit-settlement.ts";
import { executionConstraintInput, sandboxRequest, type ProcessBinding } from "./constraint-providers.ts";
import { authorizationRequest } from "./permission-requester.ts";
import type { SessionIdentity, SessionSecurityCompositionOptions } from "./session-security.ts";

export function createGovernedShell(input: {
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
	readonly bashAnalyzer: BashSecurityAnalyzerPort;
	readonly cwd: string;
}): Shell {
	return {
		exec: async (command, opts) => {
			const cwd = resolve(opts?.cwd ?? input.cwd);
			if (input.options.processEnvironment !== undefined) {
				const overrides = validateGovernedEnvironmentOverrides(opts?.env ?? {});
				if (!overrides.ok) throw Object.assign(new Error(overrides.error.message), { code: "invalid_request" });
			}
			const argumentsDigest = digestOf(shellDigestInput(command, opts, cwd));
			const toolCallId = createRuntimeId("toolCall", argumentsDigest.digest.slice(0, 64));
			const workspace = input.workspace(toolCallId, cwd);
			const mode = input.snapshot.bashAnalyzer?.mode ?? "legacy";
			const requests = unwrapSecurityResult(await resolveToolAccessRequestsWithBashAnalyzer(
				"bash",
				{ command },
				cwd,
				mode,
				input.bashAnalyzer,
			));
			const request = authorizationRequest(input.options.fence, input.snapshot, workspace, toolCallId, "bash", requests, {
				argumentsDigest,
				...(input.options.toolchain === undefined ? {} : { toolchainSnapshotDigest: input.options.toolchain.snapshotDigest }),
				...(input.options.processEnvironment === undefined ? {} : { environmentDigest: input.options.processEnvironment.environmentDigest }),
			}, cwd);
			const requestDigest = gatewayRequestDigest(request);
			const restrictive = input.snapshot.profile.sandbox !== "off";
			let plan: SandboxLaunchPlan | undefined;
			if (restrictive || input.options.toolchain !== undefined) {
				plan = unwrapSandboxResult(await input.sandboxBackend.prepare(sandboxRequest(
					input.snapshot,
					workspace,
					requestDigest,
					command,
					opts,
					cwd,
					input.options.processEnvironment?.environment,
				)));
				if (restrictive) input.bindings.set(requestDigest.digest, { plan });
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
				if (input.options.processEnvironment !== undefined) {
					await prepareLocalGovernedProcessDirectories(input.options.layout.tmp, input.options.processEnvironment);
				}
				if (input.options.toolchain !== undefined) {
					const validToolchain = await validateSessionToolchainSnapshot(
						input.options.toolchain,
						input.options.toolchainProbe ?? createLocalSessionToolchainProbe(),
					);
					if (!validToolchain.ok) throw new Error(validToolchain.error.message);
				}
				if (!restrictive && plan !== undefined) {
					const receipt = await input.sandboxBackend.validateFinalLeaf(plan, requestDigest);
					if (receipt.decision !== "off" || receipt.planDigest.digest !== plan.planDigest.digest) {
						throw new Error("off launch plan final-leaf validation failed");
					}
				}
				const leaf = await input.finalLeaf.decide({
					constraintInput,
					constraintSnapshot: constraints.snapshot,
					requestDigest,
					policyDigest: input.snapshot.policyDigest,
					...(restrictive && plan !== undefined ? { sandboxPlan: plan } : {}),
				});
				const leafDecision = unwrapSecurityResult(leaf);
				await linkBashClassificationAudit(
					input.options.bashClassificationAudit,
					input.options.fence.sessionId,
					requestDigest,
					leafDecision,
				);
				if (plan === undefined) {
					return settleGatewayEffect(context, () => input.unrestrictedShell.exec(command, opts));
				}
				return settleGatewayEffect(context, () => input.processLeaf.execute(plan, {
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
