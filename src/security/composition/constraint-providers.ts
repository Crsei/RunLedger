/**
 * S2 拆分:execution/sandbox 约束提供者与 sandbox 请求/workspace envelope 构造。
 *
 * `ProcessBinding` 是 prepare 期间在 session-scoped bindings map 中登记的
 * sandbox plan;managed-process-security 与 governed-shell 通过
 * `createConstraintProviders(bindings)` 读到的窄只读视图获得约束 receipt。
 */

import { resolve } from "node:path";
import type { ExecutionConstraintInput, ExecutionConstraintProviders } from "../../runtime/process/execution-decision.ts";
import { createExecutionConstraintReceipt } from "../../runtime/process/execution-decision.ts";
import { createRuntimeId } from "../../runtime/protocol/ids.ts";
import { canonicalDigest } from "../../runtime/protocol/canonical-json.ts";
import { runtimeDigest, type RuntimeDigest } from "../../runtime/protocol/foundation.ts";
import type { OwnerFence } from "../../runtime/session-owner/types.ts";
import type { ShellExecOptions } from "../../runtime/execution-env.ts";
import { pathWithin } from "../policy-filesystem.ts";
import { existingLocalPaths } from "../integration/session-local-leaves.ts";
import type { SandboxLaunchPlan, SandboxPrepareRequest } from "../sandbox/types.ts";
import type { HostWorkspaceExecutionContext, SecuritySnapshot } from "../types.ts";
import type { SessionIdentity } from "./session-security.ts";

export interface ProcessBinding {
	readonly plan: SandboxLaunchPlan;
}

export function executionConstraintInput(
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

export function createConstraintProviders(bindings: ReadonlyMap<string, ProcessBinding>): ExecutionConstraintProviders {
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

export function sandboxRequest(
	snapshot: SecuritySnapshot,
	workspace: HostWorkspaceExecutionContext,
	requestDigest: RuntimeDigest,
	command: string,
	opts: ShellExecOptions | undefined,
	cwd: string,
	baseEnvironment: Readonly<Record<string, string>> = {},
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
		environment: { ...baseEnvironment, ...(opts?.env ?? {}) },
		timeoutMs: opts?.timeoutMs ?? 60_000,
		...(opts?.stdin === undefined ? {} : { stdin: opts.stdin }),
	};
}

export function createWorkspaceEnvelope(
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
