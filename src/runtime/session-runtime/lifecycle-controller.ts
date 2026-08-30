/**
 * S5 拆分:SessionRuntime 生命周期(start/pause/fenced/orderly shutdown)。
 *
 * 本控制器拥有 runtime state 与 stopped/shutdown promise:attachment 归零
 * 后的唯一有序 shutdown 先停 admission,再中断并 bounded 等待领域执行,
 * 最后 checkpoint/release/server/domain 收口;fence 路径不写 durable truth。
 */

import type { SessionOwner } from "../session-owner/session-owner.ts";
import type { SessionRuntimeServer } from "../session-server/runtime-server.ts";
import type { SessionControllerEvent } from "../session-server/runtime-server.ts";
import type { OwnerFence } from "../session-owner/types.ts";
import type { SessionId } from "../protocol/ids.ts";
import type { SessionEventPersistence } from "./event-persistence.ts";
import type { SessionIdleRecapController } from "./idle-recap-controller.ts";
import type { SessionDomainPort, SessionRuntimeOptions, SessionRuntimeState } from "./session-runtime.ts";

export interface SessionLifecyclePort {
	readonly owner: SessionOwner;
	readonly server: SessionRuntimeServer;
	readonly domain: SessionDomainPort | undefined;
	readonly fence: OwnerFence;
	readonly sessionId: SessionId;
	readonly lifecycleCleanup: SessionRuntimeOptions["lifecycleCleanup"];
	readonly emit: (event: SessionControllerEvent) => void;
	readonly persistence: SessionEventPersistence;
	readonly idleRecap: SessionIdleRecapController;
	readonly onDomainListenersDisposed: () => void;
}

export class SessionLifecycleController {
	private readonly port: SessionLifecyclePort;
	private state: SessionRuntimeState;
	private started = false;
	private shutdownPromise: Promise<void> | undefined;
	private readonly stoppedPromise: Promise<void>;
	private resolveStopped: (() => void) | undefined;

	public constructor(initialState: SessionRuntimeState, port: SessionLifecyclePort) {
		this.state = initialState;
		this.port = port;
		this.stoppedPromise = new Promise<void>((resolve) => {
			this.resolveStopped = resolve;
		});
	}

	public get currentState(): SessionRuntimeState {
		return this.state;
	}

	public setState(state: SessionRuntimeState): void {
		this.state = state;
	}

	/**
	 * §5.1:restore 完成后 CAS publish owner state + activate server + heartbeat。
	 * crash takeover publish recovery_required;clean publish running。
	 */
	public start(): void {
		if (this.started) return;
		this.started = true;
		const ownerState = this.state === "recovery_required" ? "recovery_required" : "running";
		this.port.owner.publish(ownerState);
		this.port.server.activate(this.port.fence, this.port.owner.currentAuthToken, ownerState);
		this.port.owner.startHeartbeat();
	}

	/** §5.4 owner 被 fence:关 server、断开连接、不再 heartbeat、不写回 durable truth。 */
	public selfStopFenced(): void {
		if (this.state === "fenced" || this.state === "stopping") return;
		this.state = "fenced";
		this.port.idleRecap.invalidateIdleRecap();
		this.port.owner.selfStopFenced();
		// P0-4:生产 onFenced 必须中断领域 Runtime(中断 in-flight turn),再关 server。
		this.port.emit({ eventType: "runtime.fenced", payload: { sessionId: this.port.sessionId, generation: this.port.fence.generation } });
		void this.finishFencedStop();
	}

	/** §8.3 兼容入口；真实 shutdown 由 async 方法完成。 */
	public pause(reason: "paused" | "detached" | "error" = "paused"): void {
		void this.shutdownAfterLastAttachment(reason);
	}

	/**
	 * attachment 归零后的唯一有序 shutdown：先停止 admission，再中断并 bounded
	 * 等待领域执行，最后 checkpoint/release/server/domain 收口。
	 */
	public shutdownAfterLastAttachment(reason: "paused" | "detached" | "error" = "paused"): Promise<void> {
		if (this.shutdownPromise !== undefined) return this.shutdownPromise;
		if (this.state === "fenced") return this.stoppedPromise;
		this.state = "stopping";
		this.port.owner.stopHeartbeat();
		this.shutdownPromise = this.performOrderlyShutdown(reason);
		return this.shutdownPromise;
	}

	public waitForStopped(): Promise<void> {
		return this.stoppedPromise;
	}

	private async performOrderlyShutdown(reason: "paused" | "detached" | "error"): Promise<void> {
		try {
			this.port.idleRecap.dispose();
			this.port.idleRecap.clearIdleRecapStatus();
			try {
				this.port.domain?.controller.interrupt();
			} catch {
				// interrupt 是 best-effort；后续 bounded wait 保证 shutdown 可收口。
			}
			if (this.port.domain !== undefined && typeof this.port.domain.controller.waitForIdle === "function") {
				await boundedWait(this.port.domain.controller.waitForIdle(), 3_000);
			}
			this.port.persistence.flush();
			this.port.persistence.persistAbortedRunIfNeeded();
			await this.port.lifecycleCleanup?.(reason).catch(() => undefined);
			this.port.persistence.putCheckpoint("paused", { reason, ...this.port.persistence.checkpointState("paused", Date.now(), true) });
			this.port.owner.release(reason);
			await this.port.server.close();
			this.port.onDomainListenersDisposed();
			this.port.persistence.dispose();
			if (this.port.domain !== undefined && typeof this.port.domain.controller.dispose === "function") this.port.domain.controller.dispose();
		} finally {
			this.resolveStopped?.();
			this.resolveStopped = undefined;
		}
	}

	private async finishFencedStop(): Promise<void> {
		try {
			this.port.idleRecap.dispose();
			this.port.idleRecap.clearIdleRecapStatus();
			try {
				this.port.domain?.controller.interrupt();
			} catch {
				// fence 收口不依赖领域中断成功。
			}
			if (this.port.domain !== undefined && typeof this.port.domain.controller.waitForIdle === "function") {
				await boundedWait(this.port.domain.controller.waitForIdle(), 3_000);
			}
			this.port.persistence.flush();
			this.port.persistence.persistAbortedRunIfNeeded();
			await this.port.lifecycleCleanup?.("fenced").catch(() => undefined);
			await this.port.server.close();
			this.port.onDomainListenersDisposed();
			this.port.persistence.dispose();
			if (this.port.domain !== undefined && typeof this.port.domain.controller.dispose === "function") this.port.domain.controller.dispose();
		} finally {
			this.resolveStopped?.();
			this.resolveStopped = undefined;
		}
	}
}

async function boundedWait(promise: Promise<void>, timeoutMs: number): Promise<void> {
	let timeout: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			promise.catch(() => undefined),
			new Promise<void>((resolve) => {
				timeout = setTimeout(resolve, timeoutMs);
				timeout.unref?.();
			}),
		]);
	} finally {
		if (timeout !== undefined) clearTimeout(timeout);
	}
}
