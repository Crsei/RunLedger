/** Host-owned Security/Worktree query and command adapters. */

import type { WorkspaceId, SessionId } from "../runtime/contracts/public.ts";
import { parseRuntimeId, runtimeDigest } from "../runtime/contracts/public.ts";
import { createRuntimeId } from "../runtime/protocol/ids.ts";
import type { RuntimeEventPayloadFor } from "../runtime/protocol/events.ts";
import type { RuntimeEventAppendInput } from "../storage/host/runtime-event-store.ts";
import type { ExtensionHostManager, ExtensionPublicSnapshot, ExtensionReloadResult } from "../extensions/host-manager.ts";
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
	readonly extensions?: ExtensionDomainOptions;
	/** Host-owned Plan/Context/Compaction/Memory adapter. */
	readonly modelContext?: HostRuntimeDomainPort;
}

/** Builds the complete Security/Worktree Host domain surface in one place. */
export function createHostDomainPorts(options: HostDomainPortCompositionOptions): readonly HostRuntimeDomainPort[] {
	const ports: HostRuntimeDomainPort[] = [createSecurityDomainPort(options.security), createWorkspaceDomainPort(options.workspace)];
	if (options.extensions !== undefined) ports.push(createExtensionDomainPort(options.extensions));
	if (options.modelContext !== undefined) ports.push(options.modelContext);
	return ports;
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
		if (context.frame.body.confirm !== true) return rejected("confirmation_required");
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

export interface ExtensionManagerDomainPort {
	publicSnapshot(): ExtensionPublicSnapshot | undefined;
	reload(): Promise<ExtensionReloadResult>;
	setEnabled(pluginId: string, enabled: boolean): Promise<ExtensionReloadResult>;
	trust(pluginId: string): Promise<ExtensionReloadResult>;
	untrust(pluginId: string): Promise<ExtensionReloadResult>;
}

export interface ExtensionDomainOptions {
	readonly manager: ExtensionManagerDomainPort | ExtensionHostManager;
	readonly authorityId: RuntimeEventAppendInput["authorityId"];
	readonly tenantId: RuntimeEventAppendInput["tenantId"];
}

/** Builds the single Runtime event shape used for Host extension snapshots. */
export function createExtensionSnapshotEvent(input: {
	readonly authorityId: RuntimeEventAppendInput["authorityId"];
	readonly tenantId: RuntimeEventAppendInput["tenantId"];
	readonly principalId: RuntimeEventAppendInput["principalId"];
	readonly sessionId: string;
	readonly snapshot: ExtensionPublicSnapshot;
}): RuntimeEventAppendInput | undefined {
	const sessionId = parseRuntimeId("session", input.sessionId);
	const snapshotId = parseRuntimeId("snapshot", input.snapshot.snapshotId);
	if (!sessionId || !snapshotId) return undefined;
	const resourceId = createRuntimeId("resource", `extension-snapshot-${input.snapshot.generation}-${input.snapshot.digest.slice(0, 24)}`);
	const payload: RuntimeEventPayloadFor<"resource.snapshot_acquired"> = {
		subject: { kind: "resource", id: resourceId },
		correlationId: createRuntimeId("trace", `extensions-${input.snapshot.generation}-${input.snapshot.digest.slice(0, 24)}`),
		effect: "committed",
		idempotencyKey: `extensions:snapshot:${input.snapshot.digest}`,
		transition: { revision: input.snapshot.generation, previousStatus: null, nextStatus: "active" },
		bindings: [{ role: "session", subjectId: sessionId }],
		refs: [{ subjectKind: "snapshot", digest: runtimeDigest(input.snapshot), mediaType: "application/json", size: 0 }],
	};
	return {
		authorityId: input.authorityId,
		tenantId: input.tenantId,
		principalId: input.principalId,
		sessionId,
		traceId: payload.correlationId,
		type: "resource.snapshot_acquired",
		payload,
	};
}

const EXTENSION_QUERY_OPERATIONS = new Set(["extension.inspect", "plugin.list", "skill.list", "hook.list", "mcp.list"]);
const EXTENSION_MUTATION_OPERATIONS = new Set(["extension.reload", "plugin.enable", "plugin.disable", "plugin.trust", "plugin.untrust"]);

export function createExtensionDomainPort(options: ExtensionDomainOptions): HostRuntimeDomainPort {
	return {
		name: "extensions",
		queryOperations: EXTENSION_QUERY_OPERATIONS,
		mutationOperations: EXTENSION_MUTATION_OPERATIONS,
		execute: (context) => executeExtensionDomain(options, context),
	};
}

async function executeExtensionDomain(options: ExtensionDomainOptions, context: HostRuntimeDomainContext): Promise<HostRuntimeDomainResult> {
	const snapshot = options.manager.publicSnapshot();
	if (EXTENSION_QUERY_OPERATIONS.has(context.operation)) {
		if (!snapshot) return rejected("extension_snapshot_unavailable");
		if (context.operation === "extension.inspect") return { ok: true, body: { snapshot } };
		const kind = context.operation === "plugin.list" ? "plugin" : context.operation === "skill.list" ? "skill" : context.operation === "hook.list" ? "hook" : undefined;
		const descriptors = kind === undefined ? snapshot.descriptors.filter((descriptor) => descriptor.kind === "mcp" || descriptor.kind === "mcp-server" || descriptor.kind === "mcp-tool") : snapshot.descriptors.filter((descriptor) => descriptor.kind === kind);
		return { ok: true, body: { snapshotId: snapshot.snapshotId, generation: snapshot.generation, digest: snapshot.digest, descriptors } };
	}

	const pluginId = stringValue(context.frame.body.pluginId);
	let result: ExtensionReloadResult;
	if (context.operation === "extension.reload") result = await options.manager.reload();
	else if (!pluginId) return rejected("plugin_id_required");
	else if (context.operation === "plugin.enable") result = await options.manager.setEnabled(pluginId, true);
	else if (context.operation === "plugin.disable") result = await options.manager.setEnabled(pluginId, false);
	else if (context.operation === "plugin.trust") result = await options.manager.trust(pluginId);
	else if (context.operation === "plugin.untrust") result = await options.manager.untrust(pluginId);
	else return rejected("unsupported_operation");

	if (result.status === "failed") return { ok: false, body: { code: "extension_operation_failed", error: result.error ?? "extension operation failed" } };
	const next = result.snapshot ?? result.retained ?? options.manager.publicSnapshot();
	const event = result.snapshot === undefined ? undefined : snapshotEvent(options, context, result.snapshot);
	return {
		ok: true,
		body: {
			status: result.status,
			...(next === undefined ? {} : { snapshot: next }),
		},
		mutated: true,
		...(event === undefined ? {} : { events: [event] }),
	};
}

function snapshotEvent(options: ExtensionDomainOptions, context: HostRuntimeDomainContext, snapshot: ExtensionPublicSnapshot): RuntimeEventAppendInput | undefined {
	return createExtensionSnapshotEvent({
		authorityId: options.authorityId,
		tenantId: options.tenantId,
		principalId: context.principal.principalId,
		sessionId: context.sessionId,
		snapshot,
	});
}
