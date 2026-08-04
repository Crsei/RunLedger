/** Host-owned Security/Worktree query and command adapters. */

import type { WorkspaceId, SessionId } from "../runtime/contracts/public.ts";
import { parseRuntimeId, runtimeDigest } from "../runtime/contracts/public.ts";
import type { SecuritySnapshot } from "../security/types.ts";
import type { HostRuntimeDomainContext, HostRuntimeDomainPort, HostRuntimeDomainResult } from "./runtime-host-service.ts";
import type { HostWorkspaceBindingService } from "../worktree/host-binding.ts";
import type { PersistedWorkspaceBinding } from "../worktree/persisted-binding.ts";

export interface SecurityDomainSource {
	readonly snapshot: SecuritySnapshot;
}

export interface HostDomainPortCompositionOptions {
	readonly security: SecurityDomainSource;
	readonly workspace: WorkspaceDomainOptions;
}

/** Builds the complete Security/Worktree Host domain surface in one place. */
export function createHostDomainPorts(options: HostDomainPortCompositionOptions): readonly HostRuntimeDomainPort[] {
	return [createSecurityDomainPort(options.security), createWorkspaceDomainPort(options.workspace)];
}

export function createSecurityDomainPort(source: SecurityDomainSource): HostRuntimeDomainPort {
	return {
		name: "security",
		queryOperations: new Set(["security.inspect"]),
		execute: async (context) => {
			if (context.operation !== "security.inspect") return rejected("unsupported_operation");
			return { ok: true, body: securityProjection(source.snapshot) };
		},
	};
}

export interface WorkspaceDomainOptions {
	readonly workspaceId: WorkspaceId;
	readonly defaultCwd: string;
	readonly service?: HostWorkspaceBindingService;
}

const WORKSPACE_QUERY_OPERATIONS = new Set(["worktree.inspect", "worktree.list"]);
const WORKSPACE_MUTATION_OPERATIONS = new Set(["worktree.create", "worktree.resume", "worktree.release"]);

export function createWorkspaceDomainPort(options: WorkspaceDomainOptions): HostRuntimeDomainPort {
	return {
		name: "workspace",
		queryOperations: WORKSPACE_QUERY_OPERATIONS,
		mutationOperations: WORKSPACE_MUTATION_OPERATIONS,
		execute: (context) => executeWorkspace(options, context),
	};
}

function securityProjection(snapshot: SecuritySnapshot): Record<string, unknown> {
	return {
		policyDigest: snapshot.policyDigest,
		profile: snapshot.profile.name,
		approvalPolicy: snapshot.profile.approvalPolicy,
		filesystem: snapshot.profile.filesystemMode,
		network: snapshot.profile.network.mode,
		sandbox: snapshot.profile.sandbox,
		networkAllowedHostCount: snapshot.profile.network.allowedHosts.length,
		ruleCount: snapshot.rules.length,
		sources: snapshot.sources,
	};
}

async function executeWorkspace(options: WorkspaceDomainOptions, context: HostRuntimeDomainContext): Promise<HostRuntimeDomainResult> {
	const service = options.service;
	if (service === undefined) return rejected("workspace_binding_unavailable");
	if (context.operation === "worktree.inspect" || context.operation === "worktree.list") {
		const result = await service.read();
		if (!result.ok) return rejected(result.error.code);
		return { ok: true, body: { binding: result.value === undefined ? null : publicBinding(result.value) } };
	}
	if (context.operation === "worktree.resume") {
		const resumed = await service.resume({ cwd: stringValue(context.frame.body.cwd) ?? options.defaultCwd });
		return resumed.ok ? { ok: true, body: { binding: publicBinding(resumed.value) }, mutated: false } : rejected(resumed.error.code);
	}
	if (context.operation === "worktree.release") {
		const released = await service.release(stringValue(context.frame.body.reason) ?? "host_command");
		return released.ok ? { ok: true, body: { binding: released.value === undefined ? null : publicBinding(released.value) } } : rejected(released.error.code);
	}
	if (context.operation === "worktree.create") {
		const sessionId = parseRuntimeId("session", context.sessionId);
		const sourceCwd = stringValue(context.frame.body.sourceCwd);
		const label = stringValue(context.frame.body.label);
		if (!sessionId || !sourceCwd || !label) return rejected("invalid_request");
		const created = await service.create({
			sessionId: sessionId as SessionId,
			workspaceId: options.workspaceId,
			sourceCwd,
			label,
			...(stringValue(context.frame.body.baseRef) === undefined ? {} : { baseRef: stringValue(context.frame.body.baseRef) }),
			...(stringValue(context.frame.body.branch) === undefined ? {} : { branch: stringValue(context.frame.body.branch) }),
		});
		return created.ok ? { ok: true, body: { binding: publicBinding(created.value) } } : rejected(created.error.code);
	}
	return rejected("unsupported_operation");
}

function publicBinding(binding: PersistedWorkspaceBinding): Record<string, unknown> {
	return {
		workspaceId: binding.binding.workspaceId,
		repositoryId: binding.binding.repositoryId,
		worktreeId: binding.worktreeId,
		baseCommit: binding.baseCommit,
		headCommit: binding.headCommit,
		leaseRevision: binding.lease.leaseRevision,
		leaseState: binding.lease.state,
		bindingDigest: binding.bindingDigest,
		effectiveCwdDigest: runtimeDigest(binding.effectiveCwd),
		sourceRepositoryDigest: runtimeDigest(binding.sourceRepositoryPath),
		worktreePathDigest: runtimeDigest(binding.worktreePath),
	};
}

function rejected(code: string): HostRuntimeDomainResult {
	return { ok: false, body: { code } };
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}
