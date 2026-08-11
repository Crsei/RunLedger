/**
 * Session resource adapter：Session Domain Router 响应 -> typed bounded 投影。
 *
 * 所有 Session 响应必须先过 schema/typed validator 才能进入 workflow；
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
import type { SessionDomainResult } from "../../runtime/session-runtime/domain-router.ts";
import { isValidPlanModeState } from "../../runtime/modes/plan/reducer.ts";
import type { PlanModeStatus } from "../../runtime/modes/plan/types.ts";

const LABEL_BOUND = 120;

type ResourceQuery = (operation: string, body: Record<string, unknown> | undefined, request: TuiPortRequest) => Promise<Record<string, unknown>>;

export interface SessionResourcePortsInput {
	readonly query?: ResourceQuery;
	readonly command?: ResourceQuery;
	readonly supports?: (operation: string) => boolean;
}

export interface SessionResourceControllerInput {
	readonly supports?: (operation: string) => boolean;
	readonly querySessionDomain?: (operation: string, payload: Record<string, unknown>, context: { readonly correlationId: string; readonly effectId: string }) => Promise<SessionDomainResult>;
}

/** S1:Session 命名的 read-only resource adapter；未协商 operation 不构造 port。 */
export function createSessionResourcePortsFromController(controller: SessionResourceControllerInput | undefined): TuiDomainPorts {
	if (controller?.supports === undefined || controller.querySessionDomain === undefined) return {};
	return createSessionResourcePorts({
		supports: (operation) => controller.supports!(operation),
		query: async (operation, payload, request) => {
			const result = await controller.querySessionDomain!(operation, payload ?? {}, {
				correlationId: request.correlationId,
				effectId: request.effectId,
			});
			return result.ok ? result.value : { ok: false, code: result.code, message: result.code };
		},
	});
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
			error: { code: "session_query_error", message: String(error), retryable: true },
		}),
	);
}

export function createSessionResourcePorts(resources: SessionResourcePortsInput | undefined): TuiDomainPorts {
	if (resources === undefined || resources.query === undefined) return {};
	const supports = (operation: string): boolean => resources.supports?.(operation) === true;

	const extensionPort: ExtensionResourcePort = {
		inspect: (request) => envelope(request, () => inspectExtensions(resources.query!, request)),
		reload: async (request) => {
			if (resources.command === undefined || !supports("extension.reload")) {
				return { ok: false, ref: request, error: { code: "capability_unavailable", message: "extension mutation needs a Session command channel", retryable: false } };
			}
			return envelope(request, async () => {
				const body = await resources.command!("extension.reload", {}, request);
				if (body.ok === false) return { ok: false, ref: request, error: { code: stringField(body.code), message: stringField(body.message), retryable: true } };
				return { ok: true, ref: request, value: { resourceId: "extension-snapshot", operation: "reload", generation: 1, receiptPrefix: boundedToolText("reload", 40), outcome: "completed", recoveryRequired: false } };
			});
		},
	};

	const planPort: PlanRenderQueryPort = {
		inspect: (request) => envelope(request, () => inspectPlan(resources.query!, request)),
	};

	const securityPort: SecurityModeWorkflowPort = {
		inspect: (request) => envelope(request, () => inspectSecurityMode(resources.query!, request)),
		// 当前 Session 只有 session.security.inspect（无 mutation operation）→ 显式 unavailable。
		set: async (request) => ({ ok: false, ref: request, error: { code: "session_operation_unsupported", message: "Session has no security-mode mutation contract", retryable: false } }),
	};

	const workspaceGitPort: WorkspaceGitPort = {
		inspect: (request) => envelope(request, () => inspectWorkspaceGit(resources.query!, request)),
	};

	return {
		...(supports("extension.inspect") ? { extensions: extensionPort } : {}),
		...(supports("plan.inspect") ? { plan: planPort } : {}),
		...(supports("session.security.inspect") ? { securityMode: securityPort } : {}),
		...(supports("worktree.inspect") ? { workspaceGit: workspaceGitPort } : {}),
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

async function inspectExtensions(query: ResourceQuery, request: TuiPortRequest): Promise<TuiResultEnvelope<ExtensionResourceSnapshot>> {
	const body = await query("extension.inspect", {}, request);
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

async function inspectPlan(query: ResourceQuery, request: TuiPortRequest): Promise<TuiResultEnvelope<PlanRenderView>> {
	const body = await query("plan.inspect", {}, request);
	if (body.ok === false) {
		return { ok: false, ref: request, error: { code: stringField(body.code), message: stringField(body.message), retryable: true } };
	}
	const state = isRecord(body.state) ? body.state : body;
	if (!isValidPlanModeState(state)) {
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
				status: enumOf(state.status, ["verified", "in-progress", "blocked", "unknown"] as const, "unknown"),
				summary: boundedToolText(stringField(state.summary), LABEL_BOUND),
				evidenceCount: numberField(state.evidenceCount) === undefined
					? { state: "unknown", reason: "not-reported" }
					: { state: "known", value: numberField(state.evidenceCount)! },
			},
		};
	}
	const content = stringField(body.content);
	return {
		ok: true,
		ref: request,
		value: {
			reference: {
				repositoryId: stringField(body.repositoryId) || "unknown",
				planId: state.goalId,
				revision: state.revision,
				digestPrefix: boundedToolText((state.plan?.digest.digest ?? state.projectionDigest.digest).slice(0, 40), 40),
			},
			title: boundedToolText(planTitle(content), LABEL_BOUND),
			status: planRenderStatus(state.status),
			summary: boundedToolText(planSummary(state.status, content), LABEL_BOUND),
			evidenceCount: state.status === "inactive"
				? { state: "unavailable", reason: "plan-mode-inactive" }
				: { state: "unknown", reason: "not-reported" },
		},
	};
}

function planRenderStatus(status: PlanModeStatus): PlanRenderView["status"] {
	switch (status) {
		case "inactive": return "unknown";
		case "pending":
		case "active": return "in-progress";
		case "awaiting_approval": return "blocked";
		case "exit_pending": return "verified";
	}
}

function planTitle(content: string): string {
	const heading = content.split(/\r?\n/u).find((line) => /^#{1,6}\s+\S/u.test(line.trim()));
	return heading?.trim().replace(/^#{1,6}\s+/u, "") || "Plan mode";
}

function planSummary(status: PlanModeStatus, content: string): string {
	const summary = content.split(/\r?\n/u).map((line) => line.trim()).find((line) => line.length > 0 && !line.startsWith("#"));
	if (summary !== undefined) return summary;
	switch (status) {
		case "inactive": return "Plan mode is inactive.";
		case "pending": return "Plan mode is waiting to activate.";
		case "active": return "Plan mode is active.";
		case "awaiting_approval": return "Plan mode is awaiting approval.";
		case "exit_pending": return "The approved plan is waiting to exit Plan mode.";
	}
}

async function inspectSecurityMode(query: ResourceQuery, request: TuiPortRequest): Promise<TuiResultEnvelope<SecurityModeSnapshot>> {
	const body = await query("session.security.inspect", {}, request);
	if (body.ok === false) {
		return { ok: false, ref: request, error: { code: stringField(body.code), message: stringField(body.message), retryable: true } };
	}
	const profile = stringField(body.profile);
	const knownProfile = ["read-only", "workspace-write", "headless-workspace", "danger-full-access", "custom"].includes(profile);
	return {
		ok: true,
		ref: request,
		value: {
			authorityGeneration: numberField(body.ownerGeneration) ?? 0,
			mode: knownProfile
				? { state: "known", value: profile === "danger-full-access" ? "unrestricted" : "guarded" }
				: { state: "unknown", reason: "not-reported" },
			modeRevision: { state: "unknown", reason: "session-does-not-report-security-revision" },
		},
	};
}

async function inspectWorkspaceGit(query: ResourceQuery, request: Parameters<WorkspaceGitPort["inspect"]>[0]): Promise<TuiResultEnvelope<WorkspaceGitSnapshot>> {
	const body = await query("worktree.inspect", { workspaceId: request.workspaceId }, request);
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
