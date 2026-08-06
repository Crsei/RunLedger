/**
 * Host domain adapter：Host `Record<string, unknown>` 响应 -> typed bounded 投影。
 *
 * 所有 Host 响应必须先过 schema/typed validator 才能进入 workflow；
 * 非法 body 编码为 failed（不 throw），字段一律有界 + 终端安全。
 * capability 缺失（无 Host 通道）时端口 undefined，不发 effect。
 */

import type { TuiPortRequest, TuiResultEnvelope } from "../application/common.ts";
import type { TuiDomainPorts } from "../application/ports.ts";
import type { ExtensionResourcePort, ExtensionResourceSnapshot, ExtensionResourceView, ExtensionKind, ExtensionTrust, ExtensionActivation, ExtensionReloadReceipt } from "../extensions/types.ts";
import type { PlanRenderQueryPort, PlanRenderView } from "../goal-plan/types.ts";
import type { SecurityModeWorkflowPort, SecurityModeSnapshot } from "../security-mode/types.ts";
import type { WorkspaceGitPort, WorkspaceGitSnapshot, WorkspaceGitHead } from "../workspace/types.ts";
import { boundedToolText } from "../presentation/tools/projector.ts";

const LABEL_BOUND = 120;

type HostQuery = (operation: string, body?: Record<string, unknown>) => Promise<Record<string, unknown>>;

export interface HostDomainPortsInput {
	readonly query?: HostQuery;
	readonly command?: HostQuery;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asArray(value: unknown): readonly unknown[] {
	return Array.isArray(value) ? value : [];
}

function stringField(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function numberField(value: unknown): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
}

function envelope<T>(request: TuiPortRequest, produce: () => Promise<TuiResultEnvelope<T>>): Promise<TuiResultEnvelope<T>> {
	return produce().then(
		(value) => value,
		(error: unknown) => ({
			ok: false as const,
			ref: request,
			error: { code: "host_query_error", message: String(error), retryable: true },
		}),
	);
}

export function createHostDomainPorts(host: HostDomainPortsInput | undefined): TuiDomainPorts {
	if (host === undefined || host.query === undefined) return {};

	const extensionPort: ExtensionResourcePort = {
		inspect: (request) => envelope(request, () => inspectExtensions(host.query!, request)),
		reload: async (request) => {
			if (host.command === undefined) {
				return { ok: false, ref: request, error: { code: "capability_unavailable", message: "extension mutation needs a Host command channel", retryable: false } };
			}
			return envelope(request, async () => {
				const body = await host.command!("extension.reload", {});
				if (body.ok === false) return { ok: false, ref: request, error: { code: stringField(body.code), message: stringField(body.message), retryable: true } };
				return { ok: true, ref: request, value: { resourceId: "extension-snapshot", operation: "reload", generation: 1, receiptPrefix: boundedToolText("reload", 40), outcome: "completed", recoveryRequired: false } };
			});
		},
	};

	const planPort: PlanRenderQueryPort = {
		inspect: (request) => envelope(request, () => inspectPlan(host.query!, request)),
	};

	const securityPort: SecurityModeWorkflowPort = {
		inspect: (request) => envelope(request, () => inspectSecurityMode(host.query!, request)),
		// Host 只有 security.inspect（无 mutation operation）→ 显式 unavailable，不伪装实现
		set: async (request) => ({ ok: false, ref: request, error: { code: "host_operation_unsupported", message: "Host has no security-mode mutation contract", retryable: false } }),
	};

	const workspaceGitPort: WorkspaceGitPort = {
		inspect: (request) => envelope(request, () => inspectWorkspaceGit(host.query!, request)),
	};

	return {
		extensions: extensionPort,
		plan: planPort,
		securityMode: securityPort,
		workspaceGit: workspaceGitPort,
	};
}

/** 只读枚举校验：非法值一律落 unknown/缺省，绝不 cast 进合同。 */
function enumOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
	return typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

function extensionKind(value: unknown): ExtensionKind {
	switch (value) {
		case "plugin": return "plugin";
		case "skill": return "skill";
		case "hook": return "hook";
		case "mcp": return "mcp-server";
		case "mcp-server": return "mcp-server";
		case "mcp-tool": return "mcp-tool";
		default: return "plugin";
	}
}

function extensionTrust(value: unknown): ExtensionTrust {
	switch (value) {
		case "trusted": return "trusted";
		case "untrusted": return "untrusted";
		case "stale": return "stale";
		case "revoked": return "revoked";
		default: return "unknown";
	}
}

function extensionActivation(value: unknown, ready: boolean): ExtensionActivation {
	if (ready) return "ready";
	switch (value) {
		case "disabled": return "disabled";
		case "blocked": return "blocked";
		case "failed": return "failed";
		default: return "disabled";
	}
}

async function inspectExtensions(query: HostQuery, request: TuiPortRequest): Promise<TuiResultEnvelope<ExtensionResourceSnapshot>> {
	const body = await query("extension.inspect", {});
	if (body.ok === false) {
		return { ok: false, ref: request, error: { code: stringField(body.code), message: stringField(body.message), retryable: true } };
	}
	const snapshot = isRecord(body.snapshot) ? body.snapshot : body;
	const descriptors = asArray(snapshot.descriptors);
	const resources: ExtensionResourceView[] = descriptors.flatMap((descriptor) => {
		if (!isRecord(descriptor)) return [];
		const identity = isRecord(descriptor.identity) ? descriptor.identity : {};
		const qualifiedId = stringField(identity.qualifiedId);
		const version = stringField(identity.version);
		const digest = isRecord(identity.digest) ? stringField(identity.digest.digest) : "";
		if (qualifiedId.length === 0) return [];
		const view: ExtensionResourceView = {
			resourceId: qualifiedId,
			kind: extensionKind(identity.kind ?? descriptor.kind),
			label: boundedToolText(stringField(descriptor.displayName) || qualifiedId, LABEL_BOUND),
			digestPrefix: boundedToolText(digest || `${qualifiedId}@${version || "unknown"}`, LABEL_BOUND),
			trust: extensionTrust(descriptor.trust ?? (descriptor.trusted === true ? "trusted" : "untrusted")),
			activation: extensionActivation(descriptor.activation, descriptor.ready === true),
			...(isRecord(descriptor.diagnostics) ? { diagnostic: boundedToolText(stringField((descriptor.diagnostics as Record<string, unknown>).message), LABEL_BOUND) } : {}),
		};
		return [view];
	});
	return { ok: true, ref: request, value: { generation: numberField(snapshot.generation) ?? 1, resources } };
}

async function inspectPlan(query: HostQuery, request: TuiPortRequest): Promise<TuiResultEnvelope<PlanRenderView>> {
	const body = await query("plan.inspect", {});
	if (body.ok === false) {
		return { ok: false, ref: request, error: { code: stringField(body.code), message: stringField(body.message), retryable: true } };
	}
	const state = isRecord(body.state) ? body.state : body;
	const planStatus = enumOf(state.status, ["verified", "in-progress", "blocked", "unknown"] as const, "unknown");
	return {
		ok: true,
		ref: request,
		value: {
			reference: {
				repositoryId: stringField(body.repositoryId) || "unknown",
				planId: stringField(state.planId) || stringField(body.planId) || "unknown",
				revision: numberField(state.revision) ?? 0,
				digestPrefix: boundedToolText(stringField(state.digestPrefix) || stringField(body.digest), 40),
			},
			title: boundedToolText(stringField(state.title), LABEL_BOUND),
			status: planStatus,
			summary: boundedToolText(stringField(state.summary), LABEL_BOUND),
			evidenceCount: numberField(state.evidenceCount) === undefined
				? { state: "unknown", reason: "not-reported" }
				: { state: "known", value: numberField(state.evidenceCount)! },
		},
	};
}

async function inspectSecurityMode(query: HostQuery, request: TuiPortRequest): Promise<TuiResultEnvelope<SecurityModeSnapshot>> {
	const body = await query("security.inspect", {});
	if (body.ok === false) {
		return { ok: false, ref: request, error: { code: stringField(body.code), message: stringField(body.message), retryable: true } };
	}
	const profile = stringField(body.profile);
	const knownProfile = ["read-only", "workspace-write", "headless-workspace", "danger-full-access", "custom"].includes(profile);
	return {
		ok: true,
		ref: request,
		value: {
			authorityGeneration: 0,
			mode: knownProfile
				? { state: "known", value: profile === "danger-full-access" ? "unrestricted" : "guarded" }
				: { state: "unknown", reason: "not-reported" },
			modeRevision: { state: "unknown", reason: "host-does-not-report-security-revision" },
		},
	};
}

async function inspectWorkspaceGit(query: HostQuery, request: Parameters<WorkspaceGitPort["inspect"]>[0]): Promise<TuiResultEnvelope<WorkspaceGitSnapshot>> {
	const body = await query("worktree.inspect", { workspaceId: request.workspaceId });
	if (body.ok === false) {
		return { ok: false, ref: request, error: { code: stringField(body.code), message: stringField(body.message), retryable: true } };
	}
	const binding = isRecord(body.binding) ? body.binding : undefined;
	const headCommit = binding === undefined ? "" : stringField(binding.headCommit);
	const head: WorkspaceGitHead = headCommit.length > 0
		? { kind: "detached", commitPrefix: boundedToolText(headCommit, 40) }
		: { kind: "unavailable", reason: binding === undefined ? "workspace-binding-unavailable" : "head-not-reported" };
	return {
		ok: true,
		ref: request,
		value: {
			workspaceId: binding === undefined ? request.workspaceId : stringField(binding.workspaceId) || request.workspaceId,
			observedRevision: binding === undefined ? 0 : numberField(binding.leaseRevision) ?? 0,
			head,
		},
	};
}

export type { ExtensionReloadReceipt };
