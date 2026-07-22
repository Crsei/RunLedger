/** SandboxExecutorPort 的真实 adapter；失败也返回 unavailable receipt，不伪造成执行成功。 */

import { canonicalDigest } from "../../runtime/protocol/v3/canonical-json.ts";
import {
	type SandboxExecutionReceiptRef,
	type SandboxExecutorPort,
	type SandboxExecutorRequest,
	type SandboxExecutorResult,
	type SecurityPortCancelRequest,
	type SecurityPortCancelResult,
} from "../../runtime/protocol/v3/capability.ts";
import { createRuntimeId } from "../../runtime/protocol/v3/ids.ts";
import type { WorkspaceExecutionEnvelope } from "../../runtime/protocol/v3/workspace.ts";
import { pathWithin } from "../policy-filesystem.ts";
import type { SandboxBackend, SandboxPrepareRequest } from "../sandbox/types.ts";
import { resolveSandboxPolicy } from "../sandbox/policy-resolver.ts";
import type { SecuritySnapshot } from "../types.ts";

export interface RuntimeSandboxInvocation {
	command: string;
	cwd: string;
	environment: Readonly<Record<string, string>>;
	timeoutMs: number;
	stdin?: string;
}

export interface RuntimeSandboxContextPort {
	resolveEnvelope(requestId: SandboxExecutorRequest["requestId"]): Promise<WorkspaceExecutionEnvelope | undefined>;
	resolveSnapshot(policyDigest: string): Promise<SecuritySnapshot | undefined>;
}

function decodeInvocation(value: unknown): RuntimeSandboxInvocation | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const input = value as Readonly<Record<string, unknown>>;
	if (
		typeof input.command !== "string" ||
		typeof input.cwd !== "string" ||
		typeof input.timeoutMs !== "number" ||
		!Number.isSafeInteger(input.timeoutMs) ||
		input.timeoutMs <= 0 ||
		typeof input.environment !== "object" ||
		input.environment === null ||
		Array.isArray(input.environment) ||
		(input.stdin !== undefined && typeof input.stdin !== "string")
	) return undefined;
	const environment: Record<string, string> = {};
	for (const [key, entry] of Object.entries(input.environment)) {
		if (typeof entry !== "string") return undefined;
		environment[key] = entry;
	}
	return {
		command: input.command,
		cwd: input.cwd,
		environment,
		timeoutMs: input.timeoutMs,
		...(typeof input.stdin === "string" ? { stdin: input.stdin } : {}),
	};
}

function unavailableReceipt(request: SandboxExecutorRequest, backendId: string, reason: string): SandboxExecutionReceiptRef {
	return {
		authorityId: request.authorityId,
		tenantId: request.tenantId,
		principalId: request.principalId,
		receiptId: createRuntimeId("receipt", `sandbox-unavailable-${canonicalDigest({ requestId: request.requestId, reason }).slice(0, 48)}`),
		requestId: request.requestId,
		profileId: request.profile.profileId,
		requested: request.profile.requested,
		resolved: request.profile.requested,
		policyDigest: request.profile.policyDigest,
		backendId,
		effectiveEnforcement: "unavailable",
		invocationDigest: request.invocationDigest,
		reasonDigest: canonicalDigest(reason),
	};
}

export class RuntimeSandboxExecutorAdapter implements SandboxExecutorPort {
	readonly #backend: SandboxBackend;
	readonly #context: RuntimeSandboxContextPort;
	readonly #terminal = new Map<SandboxExecutorRequest["requestId"], SandboxExecutorResult>();
	readonly #cancelled = new Set<SandboxExecutorRequest["requestId"]>();

	public constructor(backend: SandboxBackend, context: RuntimeSandboxContextPort) {
		this.#backend = backend;
		this.#context = context;
	}

	public async execute(request: SandboxExecutorRequest, signal?: AbortSignal): Promise<SandboxExecutorResult> {
		const existing = this.#terminal.get(request.requestId);
		if (existing) return existing;
		const resolutionReceiptId = createRuntimeId("receipt", `sandbox-resolution-${canonicalDigest({ requestId: request.requestId, resolutionDigest: request.resolutionDigest }).slice(0, 48)}`);
		const finish = (executionReceipt: SandboxExecutionReceiptRef): SandboxExecutorResult => {
			const result: SandboxExecutorResult = {
				authorityId: request.authorityId,
				tenantId: request.tenantId,
				principalId: request.principalId,
				requestId: request.requestId,
				resolutionReceiptId,
				executionReceipt,
			};
			this.#terminal.set(request.requestId, result);
			return result;
		};
		if (signal?.aborted || this.#cancelled.has(request.requestId)) {
			return finish(unavailableReceipt(request, "cancelled", "sandbox request was cancelled"));
		}
		const invocation = decodeInvocation(request.opaqueInvocation);
		const envelope = await this.#context.resolveEnvelope(request.requestId);
		const snapshot = await this.#context.resolveSnapshot(request.profile.policyDigest);
		if (!invocation || !envelope || !snapshot) return finish(unavailableReceipt(request, "unresolved", "sandbox invocation context is unavailable"));
		if (
			request.profile.authorityId !== request.authorityId || request.profile.tenantId !== request.tenantId ||
			envelope.authorityId !== request.authorityId || envelope.tenantId !== request.tenantId ||
			envelope.principalId !== request.principalId || snapshot.policyDigest !== request.profile.policyDigest ||
			request.invocationDigest !== canonicalDigest(request.opaqueInvocation) || invocation.cwd !== envelope.cwd ||
			!pathWithin(envelope.worktreePath, invocation.cwd) || request.profile.requested !== snapshot.profile.sandbox
		) return finish(unavailableReceipt(request, "correlation-rejected", "sandbox request correlation failed"));
		const capability = await this.#backend.probe();
		const resolved = resolveSandboxPolicy(request.profile.requested, capability);
		if (!resolved.ok) return finish(unavailableReceipt(request, capability.backendId, resolved.error.message));
		if (
			snapshot.profile.network.mode === "allowlist" &&
			request.profile.requested !== "off" &&
			request.profile.requested !== "external"
		) return finish(unavailableReceipt(request, capability.backendId, "shell network allowlist requires a controlled proxy"));
		const prepareRequest: SandboxPrepareRequest = {
			requested: request.profile.requested,
			policyDigest: request.profile.policyDigest,
			envelope,
			readRoots: snapshot.filesystem.readRoots,
			writeRoots: snapshot.filesystem.writeRoots,
			denyRead: snapshot.filesystem.denyRead,
			denyWrite: snapshot.filesystem.denyWrite,
			protectedPaths: snapshot.filesystem.protectedPaths,
			network: snapshot.profile.network.mode === "deny" ? "deny" : "allow",
			command: invocation.command,
			cwd: invocation.cwd,
			environment: invocation.environment,
			timeoutMs: invocation.timeoutMs,
			...(invocation.stdin === undefined ? {} : { stdin: invocation.stdin }),
		};
		let prepared: Awaited<ReturnType<SandboxBackend["prepare"]>>;
		try {
			prepared = await this.#backend.prepare(prepareRequest);
		} catch {
			return finish(unavailableReceipt(request, capability.backendId, "sandbox prepare failed unexpectedly"));
		}
		if (!prepared.ok) return finish(unavailableReceipt(request, capability.backendId, prepared.error.message));
		if (
			prepared.value.requested !== request.profile.requested || prepared.value.policyDigest !== request.profile.policyDigest ||
			prepared.value.cwd !== invocation.cwd ||
			(request.profile.requested !== "off" && request.profile.requested !== "external" && prepared.value.effectiveEnforcement !== "enforced")
		) return finish(unavailableReceipt(request, capability.backendId, "sandbox launch plan correlation failed"));
		let spawned: Awaited<ReturnType<SandboxBackend["spawn"]>>;
		try {
			spawned = await this.#backend.spawn(prepared.value, signal);
		} catch {
			return finish(unavailableReceipt(request, capability.backendId, "sandbox spawn outcome is uncertain"));
		}
		if (!spawned.ok) return finish(unavailableReceipt(request, capability.backendId, spawned.error.message));
		const reason = prepared.value.reason;
		const body = {
			authorityId: request.authorityId,
			tenantId: request.tenantId,
			principalId: request.principalId,
			receiptId: createRuntimeId("receipt", `sandbox-execution-${canonicalDigest({ requestId: request.requestId, plan: prepared.value, result: spawned.value }).slice(0, 48)}`),
			requestId: request.requestId,
			profileId: request.profile.profileId,
			requested: request.profile.requested,
			resolved: prepared.value.resolved,
			policyDigest: request.profile.policyDigest,
			backendId: prepared.value.backendId,
			effectiveEnforcement: prepared.value.effectiveEnforcement,
			invocationDigest: request.invocationDigest,
		};
		const receipt: SandboxExecutionReceiptRef = prepared.value.effectiveEnforcement === "degraded"
			? { ...body, effectiveEnforcement: "degraded", reasonDigest: canonicalDigest(reason ?? "external enforcement") }
			: prepared.value.effectiveEnforcement === "unavailable"
				? { ...body, effectiveEnforcement: "unavailable", reasonDigest: canonicalDigest(reason ?? "sandbox unavailable") }
				: { ...body, effectiveEnforcement: prepared.value.effectiveEnforcement };
		return finish(receipt);
	}

	public async cancel(request: SecurityPortCancelRequest): Promise<SecurityPortCancelResult> {
		const terminal = this.#terminal.get(request.requestId);
		if (terminal) {
			return { ...request, status: "already_terminal", receiptId: terminal.executionReceipt.receiptId };
		}
		this.#cancelled.add(request.requestId);
		return { ...request, status: "accepted", receiptId: createRuntimeId("receipt", `sandbox-cancel-${canonicalDigest(request).slice(0, 48)}`) };
	}
}
