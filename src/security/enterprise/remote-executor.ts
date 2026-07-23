/** CI/SSH/relay 安全 adapter；验证失败只返回 remote error，绝不回退本地执行。 */

import { canonicalDigest } from "../../runtime/protocol/v3/canonical-json.ts";
import {
	isRemoteExecutorInvocation,
	isRemoteExecutorResultReceipt,
	isSessionHandoffManifest,
	isSessionHandoffReceipt,
	remoteExecutorResultMatchesInvocation,
	handoffReceiptMatchesManifest,
} from "../../runtime/executors/receipts.ts";
import type {
	ExecutorPortResult,
	RemoteExecutorPort,
	SessionHandoffPort,
} from "../../runtime/executors/ports.ts";
import type {
	RemoteExecutorInvocation,
	RemoteExecutorKind,
	RemoteExecutorResultReceipt,
	SessionHandoffManifest,
	SessionHandoffReceipt,
} from "../../runtime/executors/types.ts";

export interface RemoteExecutionTrustPort {
	verifyPolicy(invocation: RemoteExecutorInvocation, signal?: AbortSignal): Promise<boolean>;
	verifyGate(invocation: RemoteExecutorInvocation, signal?: AbortSignal): Promise<boolean>;
	verifyWorkspaceLease(invocation: RemoteExecutorInvocation, signal?: AbortSignal): Promise<boolean>;
	verifyCredentialAudience(invocation: RemoteExecutorInvocation, signal?: AbortSignal): Promise<boolean>;
}

export interface RemoteExecutionBrokerPort {
	execute(invocation: RemoteExecutorInvocation, signal?: AbortSignal): Promise<ExecutorPortResult<RemoteExecutorResultReceipt>>;
}

export interface SessionHandoffTrustPort {
	verifyManifest(manifest: SessionHandoffManifest, signal?: AbortSignal): Promise<boolean>;
	transferLease(manifest: SessionHandoffManifest, signal?: AbortSignal): Promise<boolean>;
}

export interface SessionHandoffBrokerPort {
	transfer(manifest: SessionHandoffManifest, signal?: AbortSignal): Promise<ExecutorPortResult<SessionHandoffReceipt>>;
}

function failure(
	code: "invalid_invocation" | "unavailable" | "remote_rejected" | "invalid_receipt" | "handoff_rejected",
	reason: string,
	retryable = false,
): ExecutorPortResult<never> {
	return { ok: false, error: { code, retryable, reasonDigest: canonicalDigest(reason) } };
}

export class SecureRemoteExecutorPort implements RemoteExecutorPort {
	readonly kind: RemoteExecutorKind;
	readonly #trust: RemoteExecutionTrustPort;
	readonly #broker: RemoteExecutionBrokerPort;
	readonly #terminal = new Map<RemoteExecutorInvocation["idempotencyKey"], { invocationDigest: string; result: ExecutorPortResult<RemoteExecutorResultReceipt> }>();

	public constructor(kind: RemoteExecutorKind, trust: RemoteExecutionTrustPort, broker: RemoteExecutionBrokerPort) {
		this.kind = kind;
		this.#trust = trust;
		this.#broker = broker;
	}

	public async execute(invocation: RemoteExecutorInvocation, signal?: AbortSignal): Promise<ExecutorPortResult<RemoteExecutorResultReceipt>> {
		if (!isRemoteExecutorInvocation(invocation) || invocation.executorKind !== this.kind) return failure("invalid_invocation", "remote invocation contract or executor kind is invalid");
		const terminal = this.#terminal.get(invocation.idempotencyKey);
		if (terminal) return terminal.invocationDigest === invocation.invocationDigest
			? terminal.result
			: failure("remote_rejected", "remote idempotency key collision");
		let trusted: boolean;
		try {
			const checks = await Promise.all([
				this.#trust.verifyPolicy(invocation, signal),
				this.#trust.verifyGate(invocation, signal),
				this.#trust.verifyWorkspaceLease(invocation, signal),
				this.#trust.verifyCredentialAudience(invocation, signal),
			]);
			trusted = checks.every(Boolean);
		} catch {
			return failure("unavailable", "remote trust verifier is unavailable", true);
		}
		if (!trusted) return failure("remote_rejected", "remote policy, gate, workspace, or credential trust check failed");
		let executed: ExecutorPortResult<RemoteExecutorResultReceipt>;
		try {
			executed = await this.#broker.execute(invocation, signal);
		} catch {
			executed = failure("unavailable", "remote execution broker outcome is uncertain", true);
		}
		if (executed.ok && (!isRemoteExecutorResultReceipt(executed.value) || !remoteExecutorResultMatchesInvocation(executed.value, invocation))) {
			executed = failure("invalid_receipt", "remote execution receipt does not match invocation");
		}
		this.#terminal.set(invocation.idempotencyKey, { invocationDigest: invocation.invocationDigest, result: executed });
		return executed;
	}
}

export class SecureSessionHandoffPort implements SessionHandoffPort {
	readonly #trust: SessionHandoffTrustPort;
	readonly #broker: SessionHandoffBrokerPort;
	readonly #terminal = new Map<SessionHandoffManifest["manifestDigest"], ExecutorPortResult<SessionHandoffReceipt>>();

	public constructor(trust: SessionHandoffTrustPort, broker: SessionHandoffBrokerPort) {
		this.#trust = trust;
		this.#broker = broker;
	}

	public async transfer(manifest: SessionHandoffManifest, signal?: AbortSignal): Promise<ExecutorPortResult<SessionHandoffReceipt>> {
		if (!isSessionHandoffManifest(manifest)) return failure("handoff_rejected", "session handoff manifest is invalid");
		const terminal = this.#terminal.get(manifest.manifestDigest);
		if (terminal) return terminal;
		let trusted = false;
		try {
			trusted = await this.#trust.verifyManifest(manifest, signal) && await this.#trust.transferLease(manifest, signal);
		} catch {
			return failure("handoff_rejected", "handoff trust or lease service is unavailable", true);
		}
		if (!trusted) return failure("handoff_rejected", "handoff signature or lease transfer was rejected");
		let transferred: ExecutorPortResult<SessionHandoffReceipt>;
		try {
			transferred = await this.#broker.transfer(manifest, signal);
		} catch {
			transferred = failure("handoff_rejected", "handoff broker outcome is uncertain", true);
		}
		if (transferred.ok && (!isSessionHandoffReceipt(transferred.value) || !handoffReceiptMatchesManifest(transferred.value, manifest))) {
			transferred = failure("handoff_rejected", "handoff receipt does not match signed manifest");
		}
		this.#terminal.set(manifest.manifestDigest, transferred);
		return transferred;
	}
}
