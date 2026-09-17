/**
 * ExtensionHostSupervisor：一个 owned Session 的 extension host generation
 * 生命周期。
 *
 * 职责边界：
 *   - 用既有 governed managed process 启停 host（经 `channel.ts`）；
 *   - 校验握手与注册表，产出不可变 generation；
 *   - 崩溃/协议违规/超预算一律把 generation 记为 `failed` 并回退
 *     last-known-good，**新 turn 不再装配扩展**（D2）；
 *   - idle 边界交换：与 `ExtensionSnapshotStore` 相同，运行中的 turn 继续
 *     使用旧 generation，`endTurn` 之后才允许 `swap`（D11）。
 *
 * 本模块不 import `node:child_process`，也不执行扩展代码。
 */

import type { ExtensionHostLimits } from "../../contracts/extensions/registry.ts";
import { EXTENSION_DEFAULT_HOST_LIMITS } from "../../contracts/extensions/registry.ts";
import type { ExtensionHostShutdownReason } from "../../contracts/extensions/host-protocol.ts";
import { runtimeDigest } from "../../runtime/protocol/foundation.ts";
import type { ExtensionHostBootstrap } from "./bootstrap.ts";
import { connectExtensionHost, type ExtensionEventOutcome, type ExtensionHostActionHandler, type ExtensionHostClient, type ExtensionHostClientState } from "./client.ts";
import { startManagedExtensionHostChannel, type ExtensionHostChannelOptions, type ExtensionHostManagedProcessPort } from "./channel.ts";

export interface ExtensionHostGenerationDescriptor {
	readonly generation: number;
	readonly packageId: string;
	readonly digest: string;
	readonly rootPath: string;
	readonly entrypoint: string;
}

export interface ExtensionHostStartCommand {
	/** 可执行文件（例如 node/bun 的绝对路径）。 */
	readonly runtimeCommand: string;
	readonly runtimeArgs: readonly string[];
	/** host 程序自身的绝对路径；进入 dist 后是 `dist/extensions/host/entry.js`。 */
	readonly hostEntrypoint: string;
}

export interface ExtensionHostSupervisorOptions {
	readonly managedProcess: ExtensionHostManagedProcessPort;
	readonly startCommand: ExtensionHostStartCommand;
	readonly apiVersion: string;
	readonly limits?: ExtensionHostLimits;
	readonly startupTimeoutMs?: number;
	readonly actionHandler: ExtensionHostActionHandler;
	readonly audit?: (event: { readonly eventType: string; readonly payload: Record<string, unknown> }) => Promise<void>;
	readonly now?: () => number;
}

export type ExtensionHostSupervisorStatus =
	| { readonly status: "idle" }
	| { readonly status: "starting"; readonly generation: number }
	| { readonly status: "ready"; readonly generation: number; readonly registryDigest: string; readonly hostPid: number; readonly activatedAt: string }
	| { readonly status: "failed"; readonly generation: number; readonly code: string; readonly message: string; readonly retainedGeneration?: number }
	| { readonly status: "stopped"; readonly generation: number; readonly reason: ExtensionHostShutdownReason };

function shellQuote(value: string): string {
	return value.length === 0 ? "''" : `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * 构造 host 命令行。argv 里只有一个 bootstrap JSON；扩展代码不经 argv 传参，
 * 也不继承任何 `RUNLEDGER_*` 环境变量。
 */
export function buildExtensionHostCommand(startCommand: ExtensionHostStartCommand, bootstrap: ExtensionHostBootstrap): string {
	const encoded = JSON.stringify(bootstrap);
	if (encoded === undefined) throw new Error("extension host bootstrap is not serializable");
	return [
		shellQuote(startCommand.runtimeCommand),
		...startCommand.runtimeArgs.map(shellQuote),
		shellQuote(startCommand.hostEntrypoint),
		shellQuote(encoded),
	].join(" ");
}

export class ExtensionHostSupervisor {
	readonly #options: ExtensionHostSupervisorOptions;
	#status: ExtensionHostSupervisorStatus = { status: "idle" };
	#client: ExtensionHostClient | undefined;
	#activeTurns = 0;
	#pendingReload = false;
	#lastKnownGood: { readonly generation: number; readonly registryDigest: string } | undefined;

	public constructor(options: ExtensionHostSupervisorOptions) {
		this.#options = options;
	}

	public status(): ExtensionHostSupervisorStatus {
		return this.#status;
	}

	public client(): ExtensionHostClient | undefined {
		return this.#status.status === "ready" ? this.#client : undefined;
	}

	/** 当前可装配的 generation；`failed` 后返回 last-known-good，而不是新代码。 */
	public activeGeneration(): number | undefined {
		if (this.#status.status === "ready") return this.#status.generation;
		return this.#lastKnownGood?.generation;
	}

	public beginTurn(): void {
		this.#activeTurns += 1;
	}

	/** 与 `ExtensionSnapshotStore.endTurn` 相同：回到 idle 时报告有待处理的 reload。 */
	public endTurn(): boolean {
		this.#activeTurns = Math.max(0, this.#activeTurns - 1);
		return this.#activeTurns === 0 && this.#pendingReload;
	}

	/**
	 * 启动一个 generation。失败（工厂抛错、握手超时、协议违规、装不上注册表）
	 * 只把该 generation 记为 failed，让 session 继续；不会抛出到调用方，
	 * 也不会在主进程内 fallback 执行扩展（D2）。
	 */
	public async start(descriptor: ExtensionHostGenerationDescriptor): Promise<ExtensionHostSupervisorStatus> {
		if (this.#status.status === "starting") throw new Error("extension host already starting");
		if (this.#activeTurns > 0) {
			this.#pendingReload = true;
			return this.#status;
		}
		// 真正尝试交换时清掉 pending：与 snapshot store 的 `swap()` 语义一致。
		this.#pendingReload = false;
		const limits = this.#options.limits ?? EXTENSION_DEFAULT_HOST_LIMITS;
		const bootstrap: ExtensionHostBootstrap = {
			packageId: descriptor.packageId,
			digest: descriptor.digest,
			generation: descriptor.generation,
			apiVersion: this.#options.apiVersion,
			limits,
			rootPath: descriptor.rootPath,
			entrypoint: descriptor.entrypoint,
		};
		this.#status = { status: "starting", generation: descriptor.generation };
		await this.#audit("extension.host.starting", { generation: descriptor.generation, packageId: descriptor.packageId, digest: descriptor.digest });

		const channelOptions: ExtensionHostChannelOptions = {
			managedProcess: this.#options.managedProcess,
			command: buildExtensionHostCommand(this.#options.startCommand, bootstrap),
			cwd: descriptor.rootPath,
			startupTimeoutMs: this.#options.startupTimeoutMs ?? 10_000,
		};
		const started = await startManagedExtensionHostChannel(channelOptions);
		if (!started.ok) {
			await this.#markFailed(descriptor.generation, started.code, started.message);
			return this.#status;
		}
		const connected = await connectExtensionHost({
			channel: started.channel,
			bootstrap,
			onAction: this.#options.actionHandler,
			onDiagnostic: (diagnostic) => { void this.#audit("extension.host.diagnostic", { generation: descriptor.generation, code: diagnostic.code }); },
			handshakeTimeoutMs: this.#options.startupTimeoutMs ?? 10_000,
		});
		if (!connected.ok) {
			await started.channel.close();
			await this.#markFailed(descriptor.generation, connected.code, connected.message);
			return this.#status;
		}
		this.#client = connected.client;
		const registry = connected.client.state();
		if (registry.status !== "ready") {
			await connected.client.close("protocol-violation");
			await this.#markFailed(descriptor.generation, "handshake_failed", "extension host did not publish a registry");
			return this.#status;
		}
		this.#lastKnownGood = { generation: descriptor.generation, registryDigest: registry.registryDigest };
		this.#status = {
			status: "ready",
			generation: descriptor.generation,
			registryDigest: registry.registryDigest,
			hostPid: registry.hello.hostPid,
			activatedAt: new Date(this.#now()).toISOString(),
		};
		this.#pendingReload = false;
		await this.#audit("extension.host.started", {
			generation: descriptor.generation,
			packageId: descriptor.packageId,
			hostPid: registry.hello.hostPid,
			registryDigest: registry.registryDigest,
		});
		return this.#status;
	}

	/** 派发一个投影事件；host 不可用时返回 `host_unavailable`，不静默吞掉。 */
	public async dispatchEvent(input: { readonly name: string; readonly cancelable: boolean; readonly payload: Readonly<Record<string, unknown>>; readonly deadlineMs?: number }): Promise<ExtensionEventOutcome> {
		const client = this.client();
		if (client === undefined) return { ok: false, code: "host_unavailable", message: "extension host is not in a ready generation" };
		const limits = this.#options.limits ?? EXTENSION_DEFAULT_HOST_LIMITS;
		const outcome = await client.requestEvent({
			name: input.name,
			cancelable: input.cancelable,
			payload: input.payload,
			deadlineMs: Math.max(1, Math.min(input.deadlineMs ?? limits.handlerTimeoutMs, limits.eventBudgetMs)),
		});
		if (!outcome.ok && client.state().status !== "ready") {
			await this.#onClientFailure(outcome.code, outcome.message);
		}
		return outcome;
	}

	/** 正常停止当前 generation；幂等。 */
	public async stop(reason: ExtensionHostShutdownReason = "owner-request"): Promise<ExtensionHostSupervisorStatus> {
		const client = this.#client;
		const generation = this.#status.status === "ready" || this.#status.status === "starting" ? this.#status.generation : undefined;
		this.#client = undefined;
		if (client !== undefined) await client.close(reason).catch(() => undefined);
		if (generation !== undefined) {
			this.#status = { status: "stopped", generation, reason };
			await this.#audit("extension.host.stopped", { generation, reason });
		}
		return this.#status;
	}

	/**
	 * idle 边界的崩溃对账：host 进程已经退出、协议违规或握手后再失败时，
	 * 把 generation 记为 failed 并回退 last-known-good。owner 在 `endTurn`
	 * 之后调用它，不依赖后台 watchdog 线程。
	 */
	public async reconcile(): Promise<ExtensionHostSupervisorStatus> {
		if (this.#status.status !== "ready") return this.#status;
		const client = this.#client;
		if (client === undefined) return this.#status;
		const clientState = client.state();
		if (clientState.status === "ready") return this.#status;
		const code = clientState.status === "failed" ? clientState.code : "host_exited";
		const message = clientState.status === "failed" ? clientState.message : "extension host exited without a shutdown handshake";
		await this.#onClientFailure(code, message);
		return this.#status;
	}

	/**
	 * 观测到 host 侧异常后的收敛：标记 failed、回退 last-known-good。
	 * 由 `dispatchEvent` 与 idle 边界的 `reconcile` 调用。
	 */
	async #onClientFailure(code: string, message: string): Promise<void> {
		const generation = this.#status.status === "ready" ? this.#status.generation : undefined;
		if (generation === undefined) return;
		this.#client = undefined;
		await this.#markFailed(generation, code, message);
	}

	async #markFailed(generation: number, code: string, message: string): Promise<void> {
		this.#status = {
			status: "failed",
			generation,
			code,
			message,
			...(this.#lastKnownGood === undefined ? {} : { retainedGeneration: this.#lastKnownGood.generation }),
		};
		await this.#audit("extension.host.failed", {
			generation,
			code,
			...(this.#lastKnownGood === undefined ? {} : { retainedGeneration: this.#lastKnownGood.generation }),
			messageDigest: runtimeDigest(message).digest,
		});
	}

	#now(): number {
		return (this.#options.now ?? Date.now)();
	}

	async #audit(eventType: string, payload: Record<string, unknown>): Promise<void> {
		await this.#options.audit?.({ eventType, payload });
	}
}

/** 便于诊断的脚本化状态投影（不用于授权）。 */
export function describeSupervisorStatus(status: ExtensionHostSupervisorStatus): string {
	switch (status.status) {
		case "idle": return "idle";
		case "starting": return `starting:${status.generation}`;
		case "ready": return `ready:${status.generation}:${status.registryDigest.slice(0, 12)}`;
		case "failed": return `failed:${status.generation}:${status.code}`;
		case "stopped": return `stopped:${status.generation}:${status.reason}`;
	}
}

export type { ExtensionHostClientState };
