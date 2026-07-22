/** Remote-only executor gateway；缺 port、坏 receipt 或 attestation 失败均不回退本地执行。 */

import { canonicalDigest } from "../protocol/v3/canonical-json.ts";
import { createRuntimeId } from "../protocol/v3/ids.ts";
import {
	credentialAudienceReceiptMatchesRequest,
	isCredentialAudienceValidationReceiptRef,
} from "../identity/enterprise-schemas.ts";
import type { CredentialBrokerPort } from "../identity/enterprise-ports.ts";
import type { CredentialAudienceValidationRequest } from "../identity/enterprise-types.ts";
import {
	attestationVerificationMatches,
	isRemoteAttestationVerificationReceipt,
	isRemoteExecutorInvocation,
	isRemoteExecutorResultReceipt,
	isSessionHandoffManifest,
	isSessionHandoffReceipt,
	handoffReceiptMatchesManifest,
	remoteExecutorResultMatchesInvocation,
} from "./receipts.ts";
import type {
	RemoteAttestationVerificationReceipt,
	RemoteExecutorAttestationRef,
	RemoteExecutorInvocation,
	RemoteExecutorKind,
	RemoteExecutorResultReceipt,
	SessionHandoffManifest,
	SessionHandoffReceipt,
} from "./types.ts";

export interface ExecutorPortError {
	code: "invalid_invocation" | "unavailable" | "remote_rejected" | "invalid_receipt" | "attestation_rejected" | "handoff_rejected";
	retryable: boolean;
	reasonDigest: string;
}

export type ExecutorPortResult<T> = { ok: true; value: T } | { ok: false; error: ExecutorPortError };

export interface RemoteExecutorPort {
	readonly kind: RemoteExecutorKind;
	execute(invocation: RemoteExecutorInvocation, signal?: AbortSignal): Promise<ExecutorPortResult<RemoteExecutorResultReceipt>>;
}

export interface RemoteAttestationVerifierPort {
	verify(
		attestation: RemoteExecutorAttestationRef,
		invocation: RemoteExecutorInvocation,
		signal?: AbortSignal,
	): Promise<ExecutorPortResult<RemoteAttestationVerificationReceipt>>;
}

export interface SessionHandoffPort {
	transfer(manifest: SessionHandoffManifest, signal?: AbortSignal): Promise<ExecutorPortResult<SessionHandoffReceipt>>;
}

export interface AcceptedRemoteExecution {
	result: RemoteExecutorResultReceipt;
	attestationVerification: RemoteAttestationVerificationReceipt;
}

function failure(code: ExecutorPortError["code"], reason: string, retryable = false): ExecutorPortResult<never> {
	return { ok: false, error: { code, retryable, reasonDigest: /^[a-f0-9]{64}$/.test(reason) ? reason : canonicalDigest(reason) } };
}

export class FailClosedRemoteExecutorGateway {
	readonly #ports = new Map<RemoteExecutorKind, RemoteExecutorPort>();
	readonly #attestation: RemoteAttestationVerifierPort;
	readonly #credentials: Pick<CredentialBrokerPort, "validateAudience">;

	public constructor(
		ports: readonly RemoteExecutorPort[],
		attestation: RemoteAttestationVerifierPort,
		credentials: Pick<CredentialBrokerPort, "validateAudience">,
	) {
		for (const port of ports) {
			if (this.#ports.has(port.kind)) throw new TypeError(`duplicate remote executor port: ${port.kind}`);
			this.#ports.set(port.kind, port);
		}
		this.#attestation = attestation;
		this.#credentials = credentials;
	}

	public async execute(invocation: RemoteExecutorInvocation, signal?: AbortSignal): Promise<ExecutorPortResult<AcceptedRemoteExecution>> {
		if (!isRemoteExecutorInvocation(invocation)) return failure("invalid_invocation", "remote executor invocation is invalid");
		if (invocation.credentialGrant) {
			const audienceRequest: CredentialAudienceValidationRequest = {
				schemaVersion: 1,
				authorityId: invocation.authorityId,
				tenantId: invocation.tenantId,
				requestId: createRuntimeId("command", `credential-${invocation.requestId.slice("command_".length)}`),
				principalId: invocation.principal.principalId,
				sessionId: invocation.sessionId,
				grant: invocation.credentialGrant,
				targetKind: invocation.executorKind,
				targetExecutorId: invocation.executorId,
				invocationDigest: invocation.invocationDigest,
				requestedAt: invocation.requestedAt,
			};
			let validated: Awaited<ReturnType<CredentialBrokerPort["validateAudience"]>>;
			try {
				validated = await this.#credentials.validateAudience(audienceRequest, signal);
			} catch (error) {
				return failure("remote_rejected", error instanceof Error ? error.name : "UnknownError", true);
			}
			if (!validated.ok) return failure("remote_rejected", validated.error.reasonDigest, validated.error.retryable);
			if (
				!isCredentialAudienceValidationReceiptRef(validated.value) ||
				!credentialAudienceReceiptMatchesRequest(validated.value, audienceRequest) ||
				validated.value.outcome !== "valid"
			) return failure("remote_rejected", "remote credential audience was not independently validated");
		}
		const port = this.#ports.get(invocation.executorKind);
		if (!port) return failure("unavailable", `remote executor ${invocation.executorKind} is not configured`, true);
		let executed: ExecutorPortResult<RemoteExecutorResultReceipt>;
		try {
			executed = await port.execute(invocation, signal);
		} catch (error) {
			return failure("unavailable", error instanceof Error ? error.name : "UnknownError", true);
		}
		if (!executed.ok) return executed;
		if (!isRemoteExecutorResultReceipt(executed.value) || !remoteExecutorResultMatchesInvocation(executed.value, invocation)) {
			return failure("invalid_receipt", "remote executor returned an uncorrelated receipt");
		}
		let verified: ExecutorPortResult<RemoteAttestationVerificationReceipt>;
		try {
			verified = await this.#attestation.verify(executed.value.attestation, invocation, signal);
		} catch (error) {
			return failure("attestation_rejected", error instanceof Error ? error.name : "UnknownError", true);
		}
		if (!verified.ok) return failure("attestation_rejected", verified.error.reasonDigest, verified.error.retryable);
		if (
			!isRemoteAttestationVerificationReceipt(verified.value) ||
			!attestationVerificationMatches(verified.value, executed.value) ||
			verified.value.status !== "verified"
		) return failure("attestation_rejected", "remote attestation was not externally verified");
		return { ok: true, value: { result: executed.value, attestationVerification: verified.value } };
	}
}

export async function transferSessionHandoff(
	port: SessionHandoffPort,
	manifest: SessionHandoffManifest,
	signal?: AbortSignal,
): Promise<ExecutorPortResult<SessionHandoffReceipt>> {
	if (!isSessionHandoffManifest(manifest)) return failure("handoff_rejected", "session handoff manifest is invalid");
	try {
		const transferred = await port.transfer(manifest, signal);
		if (!transferred.ok) return transferred;
		if (!isSessionHandoffReceipt(transferred.value) || !handoffReceiptMatchesManifest(transferred.value, manifest) || transferred.value.status !== "accepted") {
			return failure("handoff_rejected", "session handoff receipt is invalid or rejected");
		}
		return transferred;
	} catch (error) {
		return failure("handoff_rejected", error instanceof Error ? error.name : "UnknownError", true);
	}
}
