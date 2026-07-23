/** Runtime CapabilityGatewayPort 的 authenticated、taint-aware、rate-limited 实现。 */

import { canonicalDigest } from "../../runtime/protocol/v3/canonical-json.ts";
import {
	CapabilityReplayGuard,
	approvalReceiptMatchesTicket,
	gatewayRateLimitReceiptMatchesRequest,
	validateCapabilityGatewayRequest,
	type ApprovalReceiptRef,
	type ApprovalCoordinatorPort,
	type ApprovalTicket,
	type CapabilityAuthenticationPort,
	type CapabilityGatewayPort,
	type CapabilityGatewayRequest,
	type CapabilityGatewayResult,
	type CapabilityName,
	type CapabilityRateLimitPort,
	type GatewayRateLimitRequest,
	type SandboxProfileRef,
	type SecurityPortCancelRequest,
	type SecurityPortCancelResult,
} from "../../runtime/protocol/v3/capability.ts";
import { createRuntimeId } from "../../runtime/protocol/v3/ids.ts";
import { workspaceExecutionEnvelopeDigest } from "../../runtime/protocol/v3/workspace.ts";
import type { ApprovalLifecycleEventPort, ApprovalRequestEventEvidence } from "../../runtime/protocol/v3/security-events.ts";
import { PermissionEngine } from "../permission/engine.ts";
import { resolveBrowserAccessRequests, resolveToolAccessRequests } from "../permission/access-resolver.ts";
import {
	createApprovalReceipt,
	SYSTEM_APPROVAL_PRINCIPAL_ID,
} from "../permission/approval-coordinator.ts";
import { pathWithin } from "../policy-filesystem.ts";
import type {
	AccessRequest,
	BrowserAccessOperation,
	PermissionPrompt,
	SecurityResult,
	SecuritySnapshot,
} from "../types.ts";
import { PendingApprovalRegistry } from "./pending-approval-registry.ts";

export interface SecurityToolManifest {
	manifestDigest: string;
	toolName: string;
	kind: "native" | "browser";
	requiredCapabilities: readonly CapabilityName[];
	browserOperation?: BrowserAccessOperation;
}

export interface SecurityToolManifestResolverPort {
	resolve(manifestDigest: string): Promise<SecurityResult<SecurityToolManifest>>;
}

export interface SecuritySnapshotResolverPort {
	resolve(policyDigest: string, workspaceId: CapabilityGatewayRequest["invocation"]["envelope"]["workspaceId"]): Promise<SecurityResult<SecuritySnapshot>>;
	currentPolicyDigest(workspaceId: CapabilityGatewayRequest["invocation"]["envelope"]["workspaceId"]): Promise<string>;
}

export interface GatewayRateLimitPolicy {
	rateLimitId: GatewayRateLimitRequest["rateLimitId"];
	windowMs: number;
	units: number;
}

export interface RuntimeCapabilityGatewayAdapterOptions {
	authentication: CapabilityAuthenticationPort;
	rateLimiter: CapabilityRateLimitPort;
	rateLimitPolicy(capability: CapabilityName): GatewayRateLimitPolicy;
	manifestResolver: SecurityToolManifestResolverPort;
	snapshotResolver: SecuritySnapshotResolverPort;
	permissionEngine: PermissionEngine;
	approvals: PendingApprovalRegistry;
	approvalEvents: ApprovalLifecycleEventPort;
	approvalCanceller: Pick<ApprovalCoordinatorPort, "cancel">;
	replayGuard?: CapabilityReplayGuard;
	revokedKeyRevisions?: ReadonlySet<number>;
	clock?: () => Date;
	approvalTimeoutMs?: number;
}

interface CachedGatewayResult {
	requestDigest: string;
	result: CapabilityGatewayResult;
	ticket?: ApprovalTicket;
	sandboxProfile?: SandboxProfileRef;
}

function requiredCapability(request: AccessRequest): CapabilityName | undefined {
	switch (request.kind) {
		case "filesystem": return request.operation === "read" ? "repository_read" : "workspace_write";
		case "shell": return "process";
		case "network": return "network";
		case "worktree": return "cross_workspace";
		case "credential": return "credential";
		case "browser": return "browser";
		case "tool": return undefined;
	}
}

function approvalResourceKind(request: AccessRequest): ApprovalRequestEventEvidence["resourceKind"] {
	switch (request.kind) {
		case "filesystem": return "filesystem";
		case "shell": return "process";
		case "network": return "network";
		case "worktree": return "workspace";
		case "credential": return "credential";
		case "browser": return "browser_tool";
		case "tool": return "native_tool";
	}
}

function approvalOperation(request: AccessRequest): ApprovalRequestEventEvidence["summary"]["operation"] {
	switch (request.kind) {
		case "filesystem": return request.operation === "read" ? "read" : "write";
		case "shell": return "execute";
		case "network": return "connect";
		case "worktree": return "cross_workspace";
		case "credential": return "credential_use";
		case "browser": return "connect";
		case "tool": return "execute";
	}
}

function denialTicket(request: CapabilityGatewayRequest, now: string): ApprovalTicket {
	return {
		authorityId: request.request.authorityId,
		tenantId: request.request.tenantId,
		principalId: request.request.principalId,
		approvalId: request.request.approvalId,
		request: request.request,
		scope: "once",
		createdAt: now,
	};
}

function deniedResult(request: CapabilityGatewayRequest, reason: string, now: string): CapabilityGatewayResult {
	const ticket = denialTicket(request, now);
	const approvalReceipt = createApprovalReceipt(
		ticket,
		{ decision: "deny", decidedBy: SYSTEM_APPROVAL_PRINCIPAL_ID, reason },
		now,
	);
	return {
		requestId: request.request.requestId,
		decision: "deny",
		decisionDigest: canonicalDigest({ request: request.request, reason, approvalReceipt }),
		approvalReceipt,
	};
}

function browserResourceDigest(request: CapabilityGatewayRequest): string | undefined {
	return request.invocation.requestedClaims.find((claim) => claim.resourceKind === "browser_tool")?.resourceDigest;
}

export class RuntimeCapabilityGatewayAdapter implements CapabilityGatewayPort {
	readonly #options: RuntimeCapabilityGatewayAdapterOptions;
	readonly #replayGuard: CapabilityReplayGuard;
	readonly #clock: () => Date;
	readonly #cache = new Map<string, CachedGatewayResult>();

	public constructor(options: RuntimeCapabilityGatewayAdapterOptions) {
		this.#options = options;
		this.#replayGuard = options.replayGuard ?? new CapabilityReplayGuard();
		this.#clock = options.clock ?? (() => new Date());
	}

	#cacheKey(request: CapabilityGatewayRequest): string {
		return [request.request.authorityId, request.request.tenantId, request.request.principalId, request.idempotencyKey].join("/");
	}

	#promoteCached(cached: CachedGatewayResult): CapabilityGatewayResult {
		if (cached.result.decision !== "ask" || !cached.ticket || !cached.sandboxProfile) return cached.result;
		const receipt = this.#options.approvals.terminal(cached.ticket.approvalId);
		if (!receipt || !approvalReceiptMatchesTicket(receipt, cached.ticket)) return cached.result;
		return receipt.decision === "allowed"
			? {
				requestId: cached.ticket.request.requestId,
				decision: "allow",
				decisionDigest: canonicalDigest({ ticket: cached.ticket, receipt, decision: "allow" }),
				approvalReceipt: receipt,
				sandboxProfile: cached.sandboxProfile,
			}
			: {
				requestId: cached.ticket.request.requestId,
				decision: "deny",
				decisionDigest: canonicalDigest({ ticket: cached.ticket, receipt, decision: "deny" }),
				approvalReceipt: receipt,
			};
	}

	async #reserveRateLimit(request: CapabilityGatewayRequest, at: Date): Promise<boolean> {
		const policy = this.#options.rateLimitPolicy(request.request.capability);
		if (!Number.isSafeInteger(policy.windowMs) || policy.windowMs <= 0 || !Number.isFinite(policy.units) || policy.units <= 0) return false;
		const startedMs = Math.floor(at.getTime() / policy.windowMs) * policy.windowMs;
		const rateRequest: GatewayRateLimitRequest = {
			authorityId: request.request.authorityId,
			tenantId: request.request.tenantId,
			principalId: request.request.principalId,
			rateLimitId: policy.rateLimitId,
			requestId: request.request.requestId,
			operation: "reserve",
			capability: request.request.capability,
			resourceDigest: request.invocation.requestedClaims.find((claim) => claim.name === request.request.capability)?.resourceDigest ?? canonicalDigest(request.request),
			windowStartedAt: new Date(startedMs).toISOString(),
			windowExpiresAt: new Date(startedMs + policy.windowMs).toISOString(),
			units: policy.units,
			idempotencyKey: createRuntimeId("command", `rate-${request.idempotencyKey}`),
		};
		try {
			const receipt = await this.#options.rateLimiter.apply(rateRequest);
			return gatewayRateLimitReceiptMatchesRequest(receipt, rateRequest) && receipt.outcome === "reserved";
		} catch {
			return false;
		}
	}

	async #accessRequests(
		request: CapabilityGatewayRequest,
		manifest: SecurityToolManifest,
	): Promise<SecurityResult<readonly AccessRequest[]>> {
		if (manifest.kind === "native") {
			return resolveToolAccessRequests(manifest.toolName, request.invocation.rawArguments, request.invocation.envelope.cwd);
		}
		const digest = browserResourceDigest(request);
		if (!digest) return { ok: false, error: { code: "invalid_request", message: "browser tool lacks a browser resource claim", retryable: false } };
		return resolveBrowserAccessRequests(manifest.browserOperation ?? "unknown", request.invocation.rawArguments, digest);
	}

	public async authorize(request: CapabilityGatewayRequest, signal?: AbortSignal): Promise<CapabilityGatewayResult> {
		const now = this.#clock();
		const nowText = now.toISOString();
		const requestDigest = canonicalDigest(request);
		const cacheKey = this.#cacheKey(request);
		const cached = this.#cache.get(cacheKey);
		if (cached) return cached.requestDigest === requestDigest
			? this.#promoteCached(cached)
			: deniedResult(request, "idempotency key collision", nowText);
		const structural = validateCapabilityGatewayRequest(request, {
			at: now,
			revokedKeyRevisions: this.#options.revokedKeyRevisions,
		});
		if (!structural.ok) return deniedResult(request, structural.reason, nowText);
		if (
			request.request.argumentsDigest !== canonicalDigest(request.invocation.rawArguments) ||
			request.request.workspaceEnvelopeDigest !== workspaceExecutionEnvelopeDigest(request.invocation.envelope) ||
			!request.invocation.requestedClaims.some((claim) => claim.name === request.request.capability)
		) return deniedResult(request, "capability request correlation failed", nowText);
		let authentication: Awaited<ReturnType<CapabilityAuthenticationPort["verify"]>>;
		try {
			authentication = await this.#options.authentication.verify(request, signal);
		} catch {
			return deniedResult(request, "capability authentication unavailable", nowText);
		}
		if (
			authentication.status !== "authenticated" || authentication.requestId !== request.request.requestId ||
			authentication.requestDigest !== request.authentication.requestDigest
		) return deniedResult(request, `capability authentication ${authentication.status}`, nowText);
		const replayChecked = validateCapabilityGatewayRequest(request, {
			at: now,
			replayGuard: this.#replayGuard,
			revokedKeyRevisions: this.#options.revokedKeyRevisions,
		});
		if (!replayChecked.ok) return deniedResult(request, replayChecked.reason, nowText);
		if (!await this.#reserveRateLimit(request, now)) return deniedResult(request, "capability rate limit rejected", nowText);
		const manifest = await this.#options.manifestResolver.resolve(request.invocation.toolManifestDigest);
		if (!manifest.ok || manifest.value.manifestDigest !== request.invocation.toolManifestDigest) {
			return deniedResult(request, "tool manifest could not be resolved exactly", nowText);
		}
		const claimNames = new Set(request.invocation.requestedClaims.map((claim) => claim.name));
		if (manifest.value.requiredCapabilities.some((capability) => !claimNames.has(capability))) {
			return deniedResult(request, "tool manifest capability claim is incomplete", nowText);
		}
		const snapshot = await this.#options.snapshotResolver.resolve(request.request.policyDigest, request.invocation.envelope.workspaceId);
		if (!snapshot.ok || snapshot.value.policyDigest !== request.request.policyDigest ||
			snapshot.value.workspaceRoot !== request.invocation.envelope.worktreePath ||
			!pathWithin(snapshot.value.workspaceRoot, request.invocation.envelope.cwd)) {
			return deniedResult(request, "security snapshot or workspace binding is stale", nowText);
		}
		const access = await this.#accessRequests(request, manifest.value);
		if (!access.ok) return deniedResult(request, access.error.message, nowText);
		const required = access.value.map(requiredCapability).filter((capability): capability is CapabilityName => capability !== undefined);
		if (required.some((capability) => !claimNames.has(capability))) {
			return deniedResult(request, "derived access lacks a declared capability claim", nowText);
		}
		const evaluation = this.#options.permissionEngine.evaluate(access.value, snapshot.value);
		const sandboxProfile: SandboxProfileRef = {
			authorityId: request.request.authorityId,
			tenantId: request.request.tenantId,
			profileId: createRuntimeId("resource", `sandbox-${snapshot.value.policyDigest.slice(0, 48)}`),
			requested: snapshot.value.profile.sandbox,
			policyDigest: snapshot.value.policyDigest,
		};
		let result: CapabilityGatewayResult;
		let ticket: ApprovalTicket | undefined;
		if (evaluation.decision === "allow") {
			result = {
				requestId: request.request.requestId,
				decision: "allow",
				decisionDigest: canonicalDigest({ request: request.request, evaluation, sandboxProfile }),
				sandboxProfile,
			};
		} else if (evaluation.decision === "deny") {
			result = deniedResult(request, evaluation.reason, nowText);
		} else {
			const expiresAt = new Date(now.getTime() + (this.#options.approvalTimeoutMs ?? 60_000)).toISOString();
			ticket = {
				authorityId: request.request.authorityId,
				tenantId: request.request.tenantId,
				principalId: request.request.principalId,
				approvalId: request.request.approvalId,
				request: request.request,
				scope: "once",
				createdAt: nowText,
				expiresAt,
			};
			const prompt: PermissionPrompt = {
				requestId: request.request.requestId,
				sessionId: request.invocation.envelope.sessionId,
				toolCallId: request.invocation.envelope.toolCallId,
				toolName: manifest.value.toolName,
				summary: evaluation.reason.slice(0, 512),
				requests: access.value,
				argumentsDigest: request.request.argumentsDigest,
				cwd: request.invocation.envelope.cwd,
				policyDigest: snapshot.value.policyDigest,
				createdAt: nowText,
				expiresAt,
			};
			if (!this.#options.approvals.register({
				ticket,
				prompt,
				revalidate: async () => ({
					argumentsDigest: canonicalDigest(request.invocation.rawArguments),
					cwd: request.invocation.envelope.cwd,
					policyDigest: await this.#options.snapshotResolver.currentPolicyDigest(request.invocation.envelope.workspaceId),
				}),
			})) return deniedResult(request, "approval registry collision", nowText);
			const primaryAccess = access.value[0];
			if (!primaryAccess) {
				this.#options.approvals.remove(ticket);
				throw new Error("approval request lacks a derived access target");
			}
			try {
				await this.#options.approvalEvents.recordApprovalRequested(ticket, {
					attemptId: request.idempotencyKey,
					resourceKind: approvalResourceKind(primaryAccess),
					summary: {
						operation: approvalOperation(primaryAccess),
						toolIdentityDigest: manifest.value.manifestDigest,
						targetDigest: canonicalDigest(access.value),
						environmentKeyDigests: [],
					},
				});
			} catch {
				this.#options.approvals.remove(ticket);
				throw new Error("canonical approval request could not be committed");
			}
			result = {
				requestId: request.request.requestId,
				decision: "ask",
				decisionDigest: canonicalDigest({ request: request.request, evaluation, ticket }),
				approvalTicket: ticket,
			};
		}
		this.#cache.set(cacheKey, { requestDigest, result, ...(ticket ? { ticket, sandboxProfile } : {}) });
		return result;
	}

	public async cancel(request: SecurityPortCancelRequest): Promise<SecurityPortCancelResult> {
		return this.#options.approvalCanceller.cancel(request);
	}
}
