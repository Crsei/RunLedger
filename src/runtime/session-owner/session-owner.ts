/**
 * R3:SessionOwner 编排(06 §5)。
 *
 * - 候选 owner 必须先绑定 listener(bind-before-publish),再 BEGIN IMMEDIATE
 *   claim;失败时关闭候选并重新读取 winner attach/retry;
 * - heartbeat 3s 一次;对非 unowned row 的 crash takeover 必须同时满足:
 *   heartbeat stale + 对 row 中 exact 127.0.0.1:port 连续 3 次 authenticated
 *   probe 失败/超时 + claim 事务内 exact row CAS;
 * - 本模块是纯编排,不持有 TCP:listener 绑定与 probe 由注入的 OwnerTransport
 *   提供(node:net 只允许出现在 session-server transport,见边界检查);
 * - 同一 Session 同进程只允许一个 SessionOwner 实例;不跨 Session 调度。
 */

import type { SessionStore } from "../../storage/session-store/session-store.ts";
import { OwnerStore } from "../../storage/session-store/owner-store.ts";
import {
	SESSION_OWNER_HEARTBEAT_PARAMS,
	type OwnerClaimAttempt,
	type OwnerClaimResult,
	type OwnerClaimTarget,
	type OwnerEndpoint,
	type OwnerFence,
	type OwnerReleaseReason,
	type SessionOwnerRecord,
} from "./types.ts";
import type { SessionId } from "../protocol/ids.ts";
import { generateOwnerAuthToken, isHeartbeatStale } from "./fence.ts";
import { createRuntimeId } from "../protocol/ids.ts";

const HEARTBEAT_STORE_FAILURE_LIMIT = 3;

export class SessionOwnerOpenError extends Error {
	public readonly code: string;
	public constructor(code: string, message: string) {
		super(message);
		this.name = "SessionOwnerOpenError";
		this.code = code;
	}
}

export type OwnerProbeResult =
	| { readonly ok: true }
	| { readonly ok: false; readonly code: "connect_failed" | "timeout" | "rejected" | "malformed" };

export interface OwnerProbeInput {
	readonly sessionId: OwnerFence["sessionId"];
	readonly expectedRuntimeId: OwnerFence["runtimeId"];
	readonly expectedGeneration: number;
	readonly authToken: string;
}

export interface OwnerTransport {
	/** §5.1 bind-before-publish:绑定 127.0.0.1:0 并把端口回写给调用方。 */
	bindCandidate(): Promise<OwnerEndpoint>;
	closeCandidate(): Promise<void>;
	/** §5.3 authenticated health probe;accept 成功但认证无响应只记一次失败。 */
	probe(endpoint: OwnerEndpoint, input: OwnerProbeInput, timeoutMs: number): Promise<OwnerProbeResult>;
}

export interface SessionOwnerOptions {
	readonly store: SessionStore;
	readonly ownerStore: OwnerStore;
	readonly transport: OwnerTransport;
	/** 可选:每次成功 claim 的回调(R4 起 server 需要发布 snapshot cursor)。 */
	readonly onClaimed?: (fence: OwnerFence) => void;
	/** 可选:heartbeat 检测到被 fence 时的自停回调。 */
	readonly onFenced?: (fence: OwnerFence) => void;
}

export type OwnerEvaluation =
	| { readonly outcome: "claim"; readonly attempt: OwnerClaimAttempt }
	| { readonly outcome: "attach"; readonly record: SessionOwnerRecord }
	| {
			readonly outcome: "probe";
			readonly record: SessionOwnerRecord;
			readonly probeInput: OwnerProbeInput;
			readonly expected: OwnerClaimTarget;
	  };

function targetFromRecord(record: SessionOwnerRecord): OwnerClaimTarget {
	return {
		runtimeId: record.runtimeId,
		generation: record.generation,
		heartbeatAtMs: record.heartbeatAtMs,
		state: record.state,
	};
}

/**
 * §5.3 评估一个非 unowned row:
 * - heartbeat 未 stale → 立即 attach(统一 open path 必须能即时观察健康 owner,
 *   不能无限 retry 等待 owner 死亡;不抢占,也不把自己变成 waiting contender);
 * - heartbeat stale → 进入 probe 评估;任一次 authenticated probe 成功都立即
 *   attach/重新读取,不继续抢占。
 */
export function evaluateOwnerRow(record: SessionOwnerRecord, nowMs: number, probeSecret: string): OwnerEvaluation {
	if (!isHeartbeatStale(record.heartbeatAtMs, nowMs)) {
		return { outcome: "attach", record };
	}
	const probeInput: OwnerProbeInput = {
		sessionId: record.sessionId,
		expectedRuntimeId: record.runtimeId,
		expectedGeneration: record.generation,
		authToken: probeSecret,
	};
	return { outcome: "probe", record, probeInput, expected: targetFromRecord(record) };
}

/**
 * R3:SessionOwner 实例。一个实例对应一个 Session 的 claim/heartbeat/release;
 * 不跨 Session 调度,不构成 machine-wide registry。
 */
export class SessionOwner {
	private readonly options: SessionOwnerOptions;
	private readonly params: typeof SESSION_OWNER_HEARTBEAT_PARAMS;
	private fence: OwnerFence | undefined;
	private authTokenHex = "";
	private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
	private heartbeatStoreFailures = 0;
	private stopping = false;
	private lastClaimMode: "fresh" | "takeover" | undefined;

	public constructor(options: SessionOwnerOptions, params: typeof SESSION_OWNER_HEARTBEAT_PARAMS = SESSION_OWNER_HEARTBEAT_PARAMS) {
		this.options = options;
		this.params = params;
	}

	public get currentFence(): OwnerFence | undefined {
		return this.fence;
	}

	public get currentAuthToken(): string {
		return this.authTokenHex;
	}

	public get isStopping(): boolean {
		return this.stopping;
	}

	/** §5.1 crash vs clean 判定:最近一次 claim 是否 takeover(restore 用)。 */
	public get lastClaimWasTakeover(): boolean {
		return this.lastClaimMode === "takeover";
	}

	/**
	 * §8.1 统一 open 路径:resolve → probe → attach/retry → claim/takeover。
	 * 返回 claimed 后调用方必须继续 restore runtime,再 CAS publish;
	 * 本地 owner 也通过同一 facade,不提供 direct-controller fallback。
	 */
	public async open(sessionId: SessionId): Promise<OwnerClaimResult> {
		for (;;) {
			const record = this.options.ownerStore.readOwner(sessionId);
			const evaluation =
				record === undefined || record.state === "unowned"
					? ({ outcome: "claim", attempt: { mode: "fresh", sessionId } } as const)
					: evaluateOwnerRow(record, Date.now(), this.readProbeSecret(sessionId));
			switch (evaluation.outcome) {
				case "claim": {
					this.lastClaimMode = "fresh";
					const result = await this.tryClaim(evaluation.attempt);
					if (result.ok || !result.retryable) return result;
					await sleep(this.backoff());
					continue;
				}
			case "attach":
				return { ok: true, outcome: "attached", record: evaluation.record };
			case "probe": {
					const healthy = await this.runTakeoverProbes(evaluation);
					if (healthy) {
						// authenticated probe 成功:重新读取 winner 并 attach。
						const winner = this.options.ownerStore.readOwner(sessionId);
						if (winner !== undefined) return { ok: true, outcome: "attached", record: winner };
						continue;
					}
					this.lastClaimMode = "takeover";
					const result = await this.tryClaim({
						mode: "takeover",
						sessionId,
						expected: evaluation.expected,
					});
					if (result.ok || !result.retryable) return result;
					await sleep(this.backoff());
					continue;
				}
			}
		}
	}

	/** §5.2 bind-before-publish + BEGIN IMMEDIATE claim;失败时关闭候选 listener。 */
	public async tryClaim(attempt: OwnerClaimAttempt): Promise<OwnerClaimResult> {
		const endpoint = await this.options.transport.bindCandidate();
		const authToken = generateOwnerAuthToken();
		const outcome = this.options.ownerStore.tryClaim(attempt, {
			runtimeId: createRuntimeId("runtime", `owner-${endpoint.port}`),
			endpoint,
			authTokenHex: authToken,
			ownerStartedAtMs: Date.now(),
		});
		if (outcome.ok && outcome.outcome === "claimed") {
			this.fence = outcome.fence;
			this.authTokenHex = authToken;
			this.heartbeatStoreFailures = 0;
			this.options.onClaimed?.(outcome.fence);
			return { ok: true, outcome: "claimed", fence: outcome.fence, endpoint: outcome.endpoint };
		}
		await this.options.transport.closeCandidate();
		if (outcome.ok && outcome.outcome === "attached") {
			return { ok: true, outcome: "attached", record: outcome.record };
		}
		if (!outcome.ok) {
			if (outcome.code === "admission_blocked") {
				// §4.2:migration gate 激活后新 Session 只能得到 upgrade_requires_sessions_closed。
				return { ok: false, code: "upgrade_requires_sessions_closed", retryable: false };
			}
			if (outcome.code === "session_not_found") {
				throw new SessionOwnerOpenError("session_not_found", `session not found: ${attempt.sessionId}`);
			}
			return { ok: false, code: outcome.code, retryable: outcome.retryable };
		}
		return { ok: false, code: "owner_claim_lost", retryable: true };
	}

	/** §5.4 heartbeat 循环;changes = 0 立即自停并回调 onFenced。 */
	public startHeartbeat(): void {
		if (this.heartbeatTimer !== undefined) return;
		this.heartbeatTimer = setInterval(() => {
			if (this.stopping || this.fence === undefined) return;
			let result: { readonly ok: boolean } | undefined;
			try {
				result = this.options.ownerStore.touchHeartbeat(this.fence, Date.now());
			} catch {
				// 同步 SQLite 的短暂 busy/IO 错误不能永久关闭 fencing 检测。
				// 连续失败达到上限时，在 stale threshold 前 fail closed。
				this.heartbeatStoreFailures += 1;
				if (this.heartbeatStoreFailures >= HEARTBEAT_STORE_FAILURE_LIMIT) this.selfStopFenced();
				return;
			}
			this.heartbeatStoreFailures = 0;
			if (result !== undefined && !result.ok) this.selfStopFenced();
		}, this.params.heartbeatIntervalMs);
		this.heartbeatTimer.unref?.();
	}

	public stopHeartbeat(): void {
		if (this.heartbeatTimer !== undefined) {
			clearInterval(this.heartbeatTimer);
			this.heartbeatTimer = undefined;
		}
	}

	/** §5.1 publish starting → running / recovery_required。 */
	public publish(state: "running" | "recovery_required"): void {
		if (this.fence === undefined) throw new Error("owner is not claimed");
		this.options.ownerStore.publishState(this.fence, state);
	}

	/** §8.3 release:清空 owner row 到 unowned(保留 generation),停止 heartbeat。 */
	public release(reason: OwnerReleaseReason): void {
		if (this.fence === undefined) return;
		this.stopHeartbeat();
		this.options.ownerStore.releaseOwner(this.fence, reason);
		this.fence = undefined;
		this.heartbeatStoreFailures = 0;
	}

	/**
	 * §5.4 fence 检测到后:不再 heartbeat、不尝试把进程内状态写回 durable truth;
	 * 调用方(R4 server)应关闭 listener 并断开所有连接。
	 */
	public selfStopFenced(): void {
		if (this.stopping) return;
		this.stopping = true;
		this.stopHeartbeat();
		const fence = this.fence;
		this.fence = undefined;
		this.options.onFenced?.(fence as OwnerFence);
	}

	/** §5.3 连续 3 次 authenticated probe;probe 间隔 ≥ 250ms + jitter。 */
	private async runTakeoverProbes(evaluation: Extract<OwnerEvaluation, { readonly outcome: "probe" }>): Promise<boolean> {
		const { record, probeInput } = evaluation;
		if (record.endpoint === undefined) return false;
		for (let attempt = 0; attempt < this.params.takeoverProbes; attempt += 1) {
			const result = await this.options.transport.probe(record.endpoint, probeInput, this.params.connectTimeoutMs);
			if (result.ok) return true;
			if (attempt + 1 < this.params.takeoverProbes) {
				const jitter = Math.floor(Math.random() * this.params.probeSpacingMinMs);
				await sleep(this.params.probeSpacingMinMs + jitter);
			}
		}
		return false;
	}

	private readProbeSecret(sessionId: string): string {
		const secret = this.options.ownerStore.readProbeSecret(sessionId);
		return secret?.authTokenHex ?? "";
	}

	private backoff(): number {
		return this.params.retryBackoffBaseMs + Math.floor(Math.random() * this.params.retryBackoffBaseMs);
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
