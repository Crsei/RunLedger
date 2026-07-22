/** Workspace -> Capability/Approval -> restricted ExecutionEnv 的唯一工具执行编排。 */

import { Check } from "typebox/value";
import { canonicalDigest } from "../../runtime/protocol/v3/canonical-json.ts";
import {
	ApprovalCoordinatorResultSchema,
	CapabilityGatewayRequestSchema,
	CapabilityGatewayResultSchema,
	SandboxEffectiveEnforcementSchema,
	SandboxProfileNameSchema,
	approvalReceiptMatchesTicket,
	capabilityGatewayRequestDigest,
	isSandboxExecutionReceiptRef,
	type ApprovalCoordinatorPort,
	type ApprovalReceiptRef,
	type CapabilityGatewayPort,
	type CapabilityGatewayRequest,
	type CapabilityGatewayResult,
	type SandboxExecutionReceiptRef,
} from "../../runtime/protocol/v3/capability.ts";
import { createRuntimeId, isRuntimeId } from "../../runtime/protocol/v3/ids.ts";
import {
	isWorkspaceExecutionEnvelope,
	isWorkspaceServiceResult,
	isWorkspaceValidationReceiptForEnvelope,
	workspaceExecutionEnvelopeDigest,
	type WorkspaceExecutionEnvelope,
	type WorkspaceServicePort,
	type WorkspaceValidationReceiptRef,
} from "../../runtime/protocol/v3/workspace.ts";
import {
	isGovernedExecutionEnv,
	type GovernedExecutionEnv,
} from "../../runtime/execution-env.ts";
import { makeToolContext } from "../../runtime/tool-context.ts";
import type {
	AgentToolResult,
	AgentToolUpdateCallback,
	ToolExecutionAuthorizationGrant,
	ToolExecutionAuthorizationResult,
	ToolExecutionGatewayExecuteRequest,
	ToolExecutionGatewayExecuteResult,
	ToolExecutionGatewayPort,
	ToolExecutionGatewayRequest,
	ToolSandboxResolutionReceiptRef,
} from "../../runtime/types.ts";

export interface ToolExecutionWorkspaceResolverPort {
	/** raw fencing token 仅存在于此 adapter-owned envelope，不进入 grant/event。 */
	resolve(request: ToolExecutionGatewayRequest, signal?: AbortSignal): Promise<WorkspaceExecutionEnvelope | undefined>;
}

export interface ToolExecutionCapabilityRequestFactoryPort {
	create(
		request: ToolExecutionGatewayRequest,
		envelope: WorkspaceExecutionEnvelope,
		signal?: AbortSignal,
	): Promise<CapabilityGatewayRequest>;
}

export interface RestrictedToolExecutionSettlement {
	outcomeCertain: boolean;
	sandboxReceipt?: SandboxExecutionReceiptRef;
}

/** Lease 是 adapter-owned handle；grant/event 永不暴露 broker、backend 或 fencing token。 */
export interface RestrictedToolExecutionLease {
	resolution: ToolSandboxResolutionReceiptRef;
	/** 只有 adapter 明确批准的非 secret 环境项才会进入 ToolContext。 */
	toolEnvironment?: Readonly<Record<string, string>>;
	open(grant: ToolExecutionAuthorizationGrant, signal?: AbortSignal): Promise<GovernedExecutionEnv>;
	settle(
		status: "completed" | "failed" | "aborted",
		grant: ToolExecutionAuthorizationGrant,
		signal?: AbortSignal,
	): Promise<RestrictedToolExecutionSettlement>;
}

export type RestrictedToolExecutionPrepareResult =
	| { status: "ready"; lease: RestrictedToolExecutionLease }
	| { status: "unavailable"; reason: string };

export interface RestrictedToolExecutionEnvironmentPort {
	prepare(input: {
		request: ToolExecutionGatewayRequest;
		envelope: WorkspaceExecutionEnvelope;
		workspaceValidation: WorkspaceValidationReceiptRef;
		authorization: Extract<CapabilityGatewayResult, { decision: "allow" }>;
	}, signal?: AbortSignal): Promise<RestrictedToolExecutionPrepareResult>;
}

export type ToolExecutionAttemptRecord =
	| { status: "started"; invocationDigest: string }
	| { status: "completed"; invocationDigest: string; result: ToolExecutionGatewayExecuteResult }
	| { status: "uncertain"; invocationDigest: string; reason: string };

export interface ToolExecutionAttemptStorePort {
	read(grantDigest: string): Promise<ToolExecutionAttemptRecord | undefined>;
	claim(grantDigest: string, invocationDigest: string): Promise<"claimed" | ToolExecutionAttemptRecord>;
	complete(grantDigest: string, expectedInvocationDigest: string, record: ToolExecutionAttemptRecord): Promise<boolean>;
}

export class MemoryToolExecutionAttemptStore implements ToolExecutionAttemptStorePort {
	readonly #records = new Map<string, ToolExecutionAttemptRecord>();

	public async read(grantDigest: string): Promise<ToolExecutionAttemptRecord | undefined> {
		return this.#records.get(grantDigest);
	}

	public async claim(grantDigest: string, invocationDigest: string): Promise<"claimed" | ToolExecutionAttemptRecord> {
		const current = this.#records.get(grantDigest);
		if (current) return current;
		this.#records.set(grantDigest, { status: "started", invocationDigest });
		return "claimed";
	}

	public async complete(
		grantDigest: string,
		expectedInvocationDigest: string,
		record: ToolExecutionAttemptRecord,
	): Promise<boolean> {
		const current = this.#records.get(grantDigest);
		if (!current || current.status !== "started" || current.invocationDigest !== expectedInvocationDigest) return false;
		this.#records.set(grantDigest, record);
		return true;
	}
}

export interface PortBackedToolExecutionGatewayOptions {
	workspace: WorkspaceServicePort;
	workspaceResolver: ToolExecutionWorkspaceResolverPort;
	capability: CapabilityGatewayPort;
	capabilityRequestFactory: ToolExecutionCapabilityRequestFactoryPort;
	approval?: ApprovalCoordinatorPort;
	environment: RestrictedToolExecutionEnvironmentPort;
	attempts: ToolExecutionAttemptStorePort;
}

interface PreparedAuthorization {
	requestDigest: string;
	sessionId: WorkspaceExecutionEnvelope["sessionId"];
	result: ToolExecutionAuthorizationResult;
	lease?: RestrictedToolExecutionLease;
}

function resolutionBody(
	resolution: ToolSandboxResolutionReceiptRef,
): Omit<ToolSandboxResolutionReceiptRef, "resolutionDigest"> {
	const { resolutionDigest: _resolutionDigest, ...body } = resolution;
	return body;
}

function authorizationReceiptBody(
	receipt: ToolExecutionAuthorizationGrant["authorization"],
): Omit<ToolExecutionAuthorizationGrant["authorization"], "receiptDigest"> {
	const { receiptDigest: _receiptDigest, ...body } = receipt;
	return body;
}

function approvalReceiptBody(receipt: ApprovalReceiptRef): Omit<ApprovalReceiptRef, "receiptDigest"> {
	const { receiptDigest: _receiptDigest, ...body } = receipt;
	return body;
}

function approvalReceiptIsCorrelated(receipt: ApprovalReceiptRef, request: CapabilityGatewayRequest): boolean {
	return (
		receipt.authorityId === request.request.authorityId &&
		receipt.tenantId === request.request.tenantId &&
		receipt.principalId === request.request.principalId &&
		receipt.approvalId === request.request.approvalId &&
		receipt.requestId === request.request.requestId &&
		receipt.originalInputDigest === request.request.argumentsDigest &&
		receipt.evidenceComplete &&
		!receipt.evidenceTruncated &&
		receipt.requestDigest === canonicalDigest(request.request) &&
		receipt.receiptDigest === canonicalDigest(approvalReceiptBody(receipt))
	);
}

function grantBody(
	grant: ToolExecutionAuthorizationGrant,
): Omit<ToolExecutionAuthorizationGrant, "grantDigest"> {
	const { grantDigest: _grantDigest, ...body } = grant;
	return body;
}

function requestDigest(request: ToolExecutionGatewayRequest): string {
	return canonicalDigest({
		toolCallId: request.toolCallId,
		providerToolCallId: request.providerToolCallId,
		toolName: request.tool.name,
		arguments: request.arguments,
		cwd: request.cwd,
		environmentKeys: Object.keys(request.envVars).sort(),
		environmentDigest: canonicalDigest(request.envVars),
	});
}

function resolutionIsCorrelated(
	resolution: ToolSandboxResolutionReceiptRef,
	authorization: Extract<CapabilityGatewayResult, { decision: "allow" }>,
): boolean {
	return (
		isRuntimeId(resolution.receiptId, "receipt") &&
		isRuntimeId(resolution.profileId, "resource") &&
		Check(SandboxProfileNameSchema, resolution.resolved) &&
		Check(SandboxEffectiveEnforcementSchema, resolution.effectiveEnforcement) &&
		typeof resolution.backendId === "string" &&
		resolution.backendId.trim().length > 0 &&
		resolution.backendId.length <= 128 &&
		resolution.profileId === authorization.sandboxProfile.profileId &&
		resolution.requested === authorization.sandboxProfile.requested &&
		resolution.policyDigest === authorization.sandboxProfile.policyDigest &&
		resolution.effectiveEnforcement !== "unavailable" &&
		resolution.resolutionDigest === canonicalDigest(resolutionBody(resolution)) &&
		((resolution.effectiveEnforcement !== "degraded" && resolution.reasonDigest === undefined) ||
			(resolution.effectiveEnforcement === "degraded" && /^[a-f0-9]{64}$/u.test(resolution.reasonDigest ?? "")))
	);
}

function grantMatchesRequest(
	grant: ToolExecutionAuthorizationGrant,
	request: ToolExecutionGatewayRequest,
): boolean {
	const expectedInvocationDigest = canonicalDigest({
		providerToolCallId: request.providerToolCallId,
		toolName: request.tool.name,
		arguments: request.arguments,
		environmentDigest: canonicalDigest(request.envVars),
		workspaceEnvelopeDigest: grant.workspaceEnvelopeDigest,
		decisionDigest: grant.authorization.decisionDigest,
		resolutionDigest: grant.sandbox.resolutionDigest,
	});
	return (
		grant.schemaVersion === 1 &&
		grant.toolCallId === request.toolCallId &&
		grant.authorization.toolCallId === request.toolCallId &&
		grant.authorization.turnId === request.turnId &&
		grant.providerToolCallDigest === canonicalDigest(request.providerToolCallId) &&
		grant.toolIdentityDigest === canonicalDigest(request.tool.name.trim() || "unknown") &&
		grant.argumentsDigest === canonicalDigest(JSON.stringify(request.arguments)) &&
		grant.invocationDigest === expectedInvocationDigest &&
		grant.authorization.receiptDigest === canonicalDigest(authorizationReceiptBody(grant.authorization)) &&
		grant.sandbox.resolutionDigest === canonicalDigest(resolutionBody(grant.sandbox)) &&
		grant.grantDigest === canonicalDigest(grantBody(grant))
	);
}

function terminal(
	status: Exclude<ToolExecutionAuthorizationResult["status"], "authorized" | "approval_required">,
	requestId: CapabilityGatewayRequest["request"]["requestId"],
	reason: string,
): ToolExecutionAuthorizationResult {
	return { status, requestId, reason };
}

export class PortBackedToolExecutionGateway implements ToolExecutionGatewayPort {
	readonly #options: PortBackedToolExecutionGatewayOptions;
	readonly #authorizations = new Map<string, PreparedAuthorization>();
	readonly #leases = new Map<string, RestrictedToolExecutionLease>();

	public constructor(options: PortBackedToolExecutionGatewayOptions) {
		this.#options = options;
	}

	public async authorize(
		request: ToolExecutionGatewayRequest,
		signal?: AbortSignal,
	): Promise<ToolExecutionAuthorizationResult> {
		const digest = requestDigest(request);
		const cached = this.#authorizations.get(request.toolCallId);
		if (cached) return cached.requestDigest === digest
			? cached.result
			: terminal("denied", createRuntimeId("command", `tool-collision-${request.toolCallId}`), "tool call id was reused with different input");
		const fallbackRequestId = createRuntimeId("command", `tool-${canonicalDigest({ toolCallId: request.toolCallId, digest }).slice(0, 48)}`);
		if (signal?.aborted) return terminal("aborted", fallbackRequestId, "tool authorization was aborted");
		if (request.tool.governedExecution !== "tool-context") {
			return terminal("denied", fallbackRequestId, "tool is not declared as ToolContext-bound");
		}

		let envelope: WorkspaceExecutionEnvelope | undefined;
		try {
			envelope = await this.#options.workspaceResolver.resolve(request, signal);
		} catch {
			return terminal("unavailable", fallbackRequestId, "workspace execution handle is unavailable");
		}
		if (
			!envelope || !isWorkspaceExecutionEnvelope(envelope) ||
			envelope.toolCallId !== request.toolCallId || envelope.cwd !== request.cwd
		) return terminal("denied", fallbackRequestId, "workspace execution envelope is invalid or uncorrelated");

		const envelopeDigest = workspaceExecutionEnvelopeDigest(envelope);
		const workspaceRequestId = createRuntimeId("command", `tool-workspace-${canonicalDigest({ envelopeDigest, toolCallId: request.toolCallId }).slice(0, 48)}`);
		let workspaceResult: Awaited<ReturnType<WorkspaceServicePort["request"]>>;
		try {
			workspaceResult = await this.#options.workspace.request({
				schemaVersion: 1,
				requestId: workspaceRequestId,
				authorityId: envelope.authorityId,
				tenantId: envelope.tenantId,
				principalId: envelope.principalId,
				sessionId: envelope.sessionId,
				agentId: envelope.agentId,
				traceId: envelope.traceId,
				kind: "validate",
				envelope,
				envelopeDigest,
			}, signal);
		} catch {
			return terminal("unavailable", fallbackRequestId, "workspace validation is unavailable");
		}
		if (
			!isWorkspaceServiceResult(workspaceResult) || workspaceResult.kind !== "validated" ||
			workspaceResult.requestId !== workspaceRequestId || workspaceResult.validation.outcome !== "valid" ||
			!isWorkspaceValidationReceiptForEnvelope(workspaceResult.validation, envelope)
		) return terminal("denied", fallbackRequestId, "workspace validation did not return a correlated valid receipt");

		let capabilityRequest: CapabilityGatewayRequest;
		try {
			capabilityRequest = await this.#options.capabilityRequestFactory.create(request, envelope, signal);
		} catch {
			return terminal("unavailable", fallbackRequestId, "capability request construction is unavailable");
		}
		if (
			!Check(CapabilityGatewayRequestSchema, capabilityRequest) ||
			capabilityRequest.request.argumentsDigest !== canonicalDigest(request.arguments) ||
			capabilityRequest.request.workspaceEnvelopeDigest !== envelopeDigest ||
			workspaceExecutionEnvelopeDigest(capabilityRequest.invocation.envelope) !== envelopeDigest ||
			canonicalDigest(capabilityRequest.invocation.rawArguments) !== canonicalDigest(request.arguments) ||
			capabilityRequest.invocation.requestId !== capabilityRequest.request.requestId ||
			capabilityRequest.authentication.requestDigest !== capabilityGatewayRequestDigest({
				request: capabilityRequest.request,
				invocation: capabilityRequest.invocation,
				idempotencyKey: capabilityRequest.idempotencyKey,
				inputSources: capabilityRequest.inputSources,
				targetSink: capabilityRequest.targetSink,
				declassificationReceipts: capabilityRequest.declassificationReceipts,
			})
		) return terminal("denied", fallbackRequestId, "capability request is invalid or not bound to final tool input");

		let authorization: CapabilityGatewayResult;
		try {
			authorization = await this.#options.capability.authorize(capabilityRequest, signal);
		} catch {
			return terminal("unavailable", capabilityRequest.request.requestId, "capability gateway is unavailable");
		}
		if (!Check(CapabilityGatewayResultSchema, authorization) || authorization.requestId !== capabilityRequest.request.requestId) {
			return terminal("denied", capabilityRequest.request.requestId, "capability gateway returned an invalid or uncorrelated result");
		}
		if (authorization.decision === "ask") {
			const ticket = authorization.approvalTicket;
			if (canonicalDigest(ticket.request) !== canonicalDigest(capabilityRequest.request)) {
				return terminal("denied", authorization.requestId, "approval ticket is not bound to the capability request");
			}
			if (!this.#options.approval) {
				return { status: "approval_required", requestId: authorization.requestId, ticket, reason: "approval is required" };
			}
			let approval: Awaited<ReturnType<ApprovalCoordinatorPort["request"]>>;
			try {
				approval = await this.#options.approval.request({
					ticket,
					expectedDecisionRevision: 0,
					idempotencyKey: capabilityRequest.idempotencyKey,
				}, signal);
			} catch {
				return terminal(signal?.aborted ? "aborted" : "unavailable", authorization.requestId, "approval coordinator is unavailable");
			}
			if (
				!Check(ApprovalCoordinatorResultSchema, approval) ||
				approval.approvalId !== ticket.approvalId ||
				approval.ticketDigest !== canonicalDigest(ticket) ||
				!approvalReceiptMatchesTicket(approval.receipt, ticket) ||
				!approvalReceiptIsCorrelated(approval.receipt, capabilityRequest)
			) return terminal("denied", authorization.requestId, "approval receipt is invalid or uncorrelated");
			if (approval.receipt.decision !== "allowed") {
				return {
					status: approval.receipt.decision === "cancelled" ? "aborted" : "denied",
					requestId: authorization.requestId,
					reason: `approval ${approval.receipt.decision}`,
					approvalReceipt: approval.receipt,
				};
			}
			try {
				authorization = await this.#options.capability.authorize(capabilityRequest, signal);
			} catch {
				return terminal("unavailable", capabilityRequest.request.requestId, "capability decision could not be resumed after approval");
			}
			if (
				!Check(CapabilityGatewayResultSchema, authorization) || authorization.decision !== "allow" ||
				authorization.requestId !== capabilityRequest.request.requestId ||
				!authorization.approvalReceipt ||
				!approvalReceiptMatchesTicket(authorization.approvalReceipt, ticket) ||
				!approvalReceiptIsCorrelated(authorization.approvalReceipt, capabilityRequest) ||
				canonicalDigest(authorization.approvalReceipt) !== canonicalDigest(approval.receipt)
			) return terminal("denied", capabilityRequest.request.requestId, "approved capability decision is not correlated to the approval receipt");
		}
		if (authorization.decision === "deny") {
			if (!approvalReceiptIsCorrelated(authorization.approvalReceipt, capabilityRequest)) {
				return terminal("denied", authorization.requestId, "capability denial receipt is invalid or uncorrelated");
			}
			return {
				status: authorization.approvalReceipt.decision === "cancelled" ? "aborted" : "denied",
				requestId: authorization.requestId,
				reason: `capability ${authorization.approvalReceipt.decision}`,
				approvalReceipt: authorization.approvalReceipt,
			};
		}
		if (
			authorization.sandboxProfile.authorityId !== envelope.authorityId ||
			authorization.sandboxProfile.tenantId !== envelope.tenantId ||
			authorization.sandboxProfile.policyDigest !== capabilityRequest.request.policyDigest
		) return terminal("denied", authorization.requestId, "authorized sandbox profile is outside the request scope");

		let prepared: RestrictedToolExecutionPrepareResult;
		try {
			prepared = await this.#options.environment.prepare({
				request,
				envelope,
				workspaceValidation: workspaceResult.validation,
				authorization,
			}, signal);
		} catch {
			return terminal("unavailable", authorization.requestId, "restricted execution environment is unavailable");
		}
		if (prepared.status === "unavailable") return terminal("unavailable", authorization.requestId, prepared.reason);
		if (!resolutionIsCorrelated(prepared.lease.resolution, authorization)) {
			return terminal("denied", authorization.requestId, "sandbox resolution receipt is invalid or uncorrelated");
		}

		const authBody = {
			receiptId: createRuntimeId("receipt", `tool-authorization-${canonicalDigest({
				request: capabilityRequest.request,
				decision: authorization.decisionDigest,
				workspace: workspaceResult.validation.receiptId,
				sandbox: prepared.lease.resolution.receiptId,
			}).slice(0, 48)}`),
			requestId: authorization.requestId,
			approvalId: capabilityRequest.request.approvalId,
			sessionId: capabilityRequest.request.sessionId,
			runtimeId: capabilityRequest.request.runtimeId,
			runtimeGeneration: capabilityRequest.request.runtimeGeneration,
			turnId: capabilityRequest.request.turnId,
			toolCallId: capabilityRequest.request.toolCallId,
			requestDigest: capabilityRequest.authentication.requestDigest,
			decisionDigest: authorization.decisionDigest,
		};
		const authorizationReceipt = { ...authBody, receiptDigest: canonicalDigest(authBody) };
		const invocationDigest = canonicalDigest({
			providerToolCallId: request.providerToolCallId,
			toolName: request.tool.name,
			arguments: request.arguments,
			environmentDigest: canonicalDigest(request.envVars),
			workspaceEnvelopeDigest: envelopeDigest,
			decisionDigest: authorization.decisionDigest,
			resolutionDigest: prepared.lease.resolution.resolutionDigest,
		});
		const body: Omit<ToolExecutionAuthorizationGrant, "grantDigest"> = {
			schemaVersion: 1,
			toolCallId: request.toolCallId,
			providerToolCallDigest: canonicalDigest(request.providerToolCallId),
			toolIdentityDigest: canonicalDigest(request.tool.name.trim() || "unknown"),
			argumentsDigest: canonicalDigest(JSON.stringify(request.arguments)),
			invocationDigest,
			workspaceEnvelopeDigest: envelopeDigest,
			workspaceValidation: workspaceResult.validation,
			authorization: authorizationReceipt,
			capability: capabilityRequest.request.capability,
			policyDigest: authorization.sandboxProfile.policyDigest,
			sandbox: prepared.lease.resolution,
		};
		const grant: ToolExecutionAuthorizationGrant = { ...body, grantDigest: canonicalDigest(body) };
		const result: ToolExecutionAuthorizationResult = { status: "authorized", grant };
		this.#authorizations.set(request.toolCallId, {
			requestDigest: digest,
			sessionId: envelope.sessionId,
			result,
			lease: prepared.lease,
		});
		this.#leases.set(grant.grantDigest, prepared.lease);
		return result;
	}

	async #completeAttempt(
		grantDigest: string,
		expectedInvocationDigest: string,
		record: ToolExecutionAttemptRecord,
	): Promise<boolean> {
		try {
			return await this.#options.attempts.complete(grantDigest, expectedInvocationDigest, record);
		} catch {
			return false;
		}
	}

	public async execute(
		request: ToolExecutionGatewayExecuteRequest,
		onUpdate: AgentToolUpdateCallback,
		signal?: AbortSignal,
	): Promise<ToolExecutionGatewayExecuteResult> {
		const { grant, invocation } = request;
		if (!grantMatchesRequest(grant, invocation)) {
			return { status: "unavailable", grantDigest: grant.grantDigest, reason: "authorization grant is invalid or uncorrelated", outcomeCertain: true };
		}
		let existing: ToolExecutionAttemptRecord | undefined;
		try {
			existing = await this.#options.attempts.read(grant.grantDigest);
		} catch {
			return { status: "unavailable", grantDigest: grant.grantDigest, reason: "tool execution idempotency state is unavailable", outcomeCertain: true };
		}
		if (existing?.status === "completed") return existing.result;
		if (existing?.status === "started" || existing?.status === "uncertain") {
			return { status: "uncertain", grantDigest: grant.grantDigest, reason: "a prior side-effect attempt has no replay-safe terminal receipt", outcomeCertain: false };
		}
		let claimed: "claimed" | ToolExecutionAttemptRecord;
		try {
			claimed = await this.#options.attempts.claim(grant.grantDigest, grant.invocationDigest);
		} catch {
			return { status: "unavailable", grantDigest: grant.grantDigest, reason: "tool execution idempotency claim is unavailable", outcomeCertain: true };
		}
		if (claimed !== "claimed") {
			if (claimed.status === "completed") return claimed.result;
			return { status: "uncertain", grantDigest: grant.grantDigest, reason: "tool execution idempotency claim is already active", outcomeCertain: false };
		}
		const lease = this.#leases.get(grant.grantDigest);
		const preparedAuthorization = this.#authorizations.get(invocation.toolCallId);
		if (
			!lease || !preparedAuthorization || preparedAuthorization.result.status !== "authorized" ||
			preparedAuthorization.result.grant.grantDigest !== grant.grantDigest
		) {
			const result: ToolExecutionGatewayExecuteResult = { status: "uncertain", grantDigest: grant.grantDigest, reason: "authorized execution lease is unavailable after claim", outcomeCertain: false };
			await this.#completeAttempt(grant.grantDigest, grant.invocationDigest, { status: "uncertain", invocationDigest: grant.invocationDigest, reason: result.reason });
			return result;
		}
		let env: GovernedExecutionEnv;
		try {
			env = await lease.open(grant, signal);
		} catch {
			const result: ToolExecutionGatewayExecuteResult = { status: "uncertain", grantDigest: grant.grantDigest, reason: "restricted execution environment failed after claim", outcomeCertain: false };
			await this.#completeAttempt(grant.grantDigest, grant.invocationDigest, { status: "uncertain", invocationDigest: grant.invocationDigest, reason: result.reason });
			return result;
		}
		if (
			!isGovernedExecutionEnv(env) || env.cwd !== invocation.cwd ||
			env.governance.grantDigest !== grant.grantDigest ||
			env.governance.workspaceEnvelopeDigest !== grant.workspaceEnvelopeDigest ||
			env.governance.workspaceValidationReceiptId !== grant.workspaceValidation.receiptId ||
			env.governance.authorizationReceiptId !== grant.authorization.receiptId ||
			env.governance.sandboxResolutionReceiptId !== grant.sandbox.receiptId
		) {
			const result: ToolExecutionGatewayExecuteResult = { status: "uncertain", grantDigest: grant.grantDigest, reason: "restricted ExecutionEnv proof is invalid or uncorrelated", outcomeCertain: false };
			await this.#completeAttempt(grant.grantDigest, grant.invocationDigest, { status: "uncertain", invocationDigest: grant.invocationDigest, reason: result.reason });
			return result;
		}

		let toolResult: AgentToolResult;
		try {
			if (signal?.aborted) throw new Error("tool execution aborted before invocation");
			toolResult = await invocation.tool.execute(
				invocation.providerToolCallId,
				invocation.arguments as never,
				signal,
				onUpdate,
				makeToolContext({
					cwd: invocation.cwd,
					env,
					envVars: { ...(lease.toolEnvironment ?? {}) },
					signal: signal ?? new AbortController().signal,
					sessionId: preparedAuthorization.sessionId,
					toolCallId: invocation.providerToolCallId,
					authorizationGrant: grant,
				}),
			);
		} catch (error) {
			let settlement: RestrictedToolExecutionSettlement;
			try {
				settlement = await lease.settle(signal?.aborted ? "aborted" : "failed", grant, signal);
			} catch {
				settlement = { outcomeCertain: false };
			}
			const reason = error instanceof Error ? error.message : String(error);
			const result: ToolExecutionGatewayExecuteResult = settlement.outcomeCertain
				? { status: signal?.aborted ? "aborted" : "unavailable", grantDigest: grant.grantDigest, reason, outcomeCertain: true }
				: { status: "uncertain", grantDigest: grant.grantDigest, reason, outcomeCertain: false };
			const committed = await this.#completeAttempt(
				grant.grantDigest,
				grant.invocationDigest,
				result.status === "uncertain"
					? { status: "uncertain", invocationDigest: grant.invocationDigest, reason }
					: { status: "completed", invocationDigest: grant.invocationDigest, result },
			);
			return committed
				? result
				: { status: "uncertain", grantDigest: grant.grantDigest, reason: "tool terminal result could not be durably committed", outcomeCertain: false };
		}

		let settlement: RestrictedToolExecutionSettlement;
		try {
			settlement = await lease.settle("completed", grant, signal);
		} catch {
			settlement = { outcomeCertain: false };
		}
		if (!settlement.outcomeCertain) {
			const result: ToolExecutionGatewayExecuteResult = { status: "uncertain", grantDigest: grant.grantDigest, reason: "tool completed but enforcement settlement is uncertain", outcomeCertain: false };
			await this.#completeAttempt(grant.grantDigest, grant.invocationDigest, { status: "uncertain", invocationDigest: grant.invocationDigest, reason: result.reason });
			return result;
		}
		if (settlement.sandboxReceipt && (
			!isSandboxExecutionReceiptRef(settlement.sandboxReceipt) ||
			settlement.sandboxReceipt.requestId !== grant.authorization.requestId ||
			settlement.sandboxReceipt.profileId !== grant.sandbox.profileId ||
			settlement.sandboxReceipt.policyDigest !== grant.policyDigest ||
			settlement.sandboxReceipt.invocationDigest !== grant.invocationDigest ||
			settlement.sandboxReceipt.effectiveEnforcement === "unavailable"
		)) {
			const result: ToolExecutionGatewayExecuteResult = { status: "uncertain", grantDigest: grant.grantDigest, reason: "sandbox execution receipt is invalid or uncorrelated", outcomeCertain: false };
			await this.#completeAttempt(grant.grantDigest, grant.invocationDigest, { status: "uncertain", invocationDigest: grant.invocationDigest, reason: result.reason });
			return result;
		}
		if (grant.capability === "process" && !settlement.sandboxReceipt) {
			const result: ToolExecutionGatewayExecuteResult = { status: "uncertain", grantDigest: grant.grantDigest, reason: "process execution lacks a sandbox receipt", outcomeCertain: false };
			await this.#completeAttempt(grant.grantDigest, grant.invocationDigest, { status: "uncertain", invocationDigest: grant.invocationDigest, reason: result.reason });
			return result;
		}
		const result: ToolExecutionGatewayExecuteResult = {
			status: "completed",
			grantDigest: grant.grantDigest,
			result: toolResult,
			...(settlement.sandboxReceipt ? { sandboxReceipt: settlement.sandboxReceipt } : {}),
		};
		if (!await this.#completeAttempt(grant.grantDigest, grant.invocationDigest, { status: "completed", invocationDigest: grant.invocationDigest, result })) {
			return { status: "uncertain", grantDigest: grant.grantDigest, reason: "tool result could not be durably committed to the idempotency store", outcomeCertain: false };
		}
		try {
			const durable = await this.#options.attempts.read(grant.grantDigest);
			return durable?.status === "completed" && durable.invocationDigest === grant.invocationDigest
				? durable.result
				: { status: "uncertain", grantDigest: grant.grantDigest, reason: "durable tool result could not be read back after commit", outcomeCertain: false };
		} catch {
			return { status: "uncertain", grantDigest: grant.grantDigest, reason: "durable tool result read-back is unavailable", outcomeCertain: false };
		}
	}
}
