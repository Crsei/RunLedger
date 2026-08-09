/**
 * R6:embedded SessionRuntime composition(06 §7.1/§8.3)。
 *
 * - 与 R7 相同的 production factory:resolve store → attach/claim → restore →
 *   SessionRuntime + RuntimeServer → 本地 view 经同一 TCP facade;
 * - 一个 SessionRuntime 只装配一个 Session:Agent/model/tool/process/worktree
 *   全部绑定 sessionId + generation;不构成 machine-wide registry;
 * - 统一 open:健康 owner 即时 attach(本进程成为 remote client,runtime 为
 *   undefined);只有 claim 成功才装配本地 SessionRuntime;
 * - attachment-count lifetime:本地 view detach 后若仍有 remote attachment,
 *   owner 保持运行;attachment count 归零才 pause/checkpoint/release;
 * - P0-4:生产 wiring 传入 onFenced → SessionRuntime.selfStopFenced(server 关闭、
 *   领域中断、所有客户端断开);
 * - P0-2:领域工具副作用经 attempt gateway 进入 recovery barrier;
 * - 本模块是唯一允许组合 SessionRuntime 的生产入口(边界检查
 *   RUNTIME_COMPOSITION_ALLOWLIST 只允许 session-runtime/ 与 cli 组合层)。
 */

import type { SessionStore } from "../storage/session-store/session-store.ts";
import type { OwnerStore } from "../storage/session-store/owner-store.ts";
import { SessionOwner } from "../runtime/session-owner/session-owner.ts";
import { SessionRuntimeServer } from "../runtime/session-server/runtime-server.ts";
import { SessionRuntime, type SessionDomainPort } from "../runtime/session-runtime/session-runtime.ts";
import { assembleSessionDomain, type SessionDomainCompositionOptions } from "../runtime/session-runtime/domain.ts";
import { LateBoundAttemptPort } from "../runtime/session-runtime/attempt-gateway.ts";
import { createSessionApprovalPorts } from "../runtime/session-runtime/approval-reverse-request.ts";
import { restoreSession } from "../runtime/session-runtime/restore.ts";
import { SessionClient, type OwnedSessionHandle } from "./session-client.ts";
import { SESSION_CORE_PROTOCOL_MANIFEST, SESSION_PROTOCOL_BOUNDS, type SessionFrameEnvelope } from "../runtime/session-server/protocol.ts";
import { createRuntimeId, type ExecutionId, type SessionId } from "../runtime/protocol/ids.ts";

export type SessionReverseRequestHandler = (frame: SessionFrameEnvelope, signal: AbortSignal) => Promise<Record<string, unknown>> | Record<string, unknown>;

export interface EmbeddedSessionRuntimeOptions {
	readonly sessionId: SessionId;
	readonly store: SessionStore;
	readonly ownerStore: OwnerStore;
	/** §7.3 barrier 收口前的 last-attachment pause 延迟(默认立即)。 */
	readonly pauseDelayMs?: number;
	/** R7:真实领域装配(InteractiveSessionController + Agent/model/tool/ledger)。 */
	readonly domain?: SessionDomainCompositionOptions;
	/** 本地 view 连接收到的 reverse_request(credential/approval UI)处理器;TUI 注入。 */
	readonly reverseRequestHandler?: SessionReverseRequestHandler;
	/** Session-scoped worktree open/lease lifecycle；不得由 TUI 直接持有。 */
	readonly workspace?: SessionWorkspaceFactory;
}

export interface SessionWorkspaceHandle {
	readonly effectiveCwd: string;
	release(reason: "paused" | "detached" | "error" | "fenced"): Promise<void>;
}

export interface SessionWorkspaceFactory {
	open(input: {
		readonly sessionId: SessionId;
		readonly store: SessionStore;
		readonly fence: import("../runtime/session-owner/types.ts").OwnerFence;
	}): Promise<SessionWorkspaceHandle>;
}

export interface EmbeddedSessionRuntimeResult {
	readonly handle: OwnedSessionHandle;
	/**
	 * claim 成功(本进程是 owner)时为装配好的 SessionRuntime;
	 * attach 健康 owner 时为 undefined(本进程只是 remote client,不拥有 runtime)。
	 */
	readonly runtime: SessionRuntime | undefined;
	readonly server: SessionRuntimeServer;
	readonly owner: SessionOwner;
	readonly processRegistry: SessionProcessRegistry;
}

// ── session-scoped process capacity(§7.4)─────────────────────────────────

export type SessionProcessStatus = "running" | "settled" | "lost" | "uncertain";

export interface SessionProcessRecord {
	readonly processId: ExecutionId;
	readonly sessionId: SessionId;
	readonly generation: number;
	status: SessionProcessStatus;
	readonly createdAtMs: number;
}

/**
 * §7.4 每个 owned SessionRuntime 的 process capacity:
 * - 容量受 maxProcessesPerSession 限制,不共享全局 manager;
 * - owner crash 后新 owner 不按 PID/port/PTY handle reattach;旧句柄投影为
 *   lost/uncertain,并保留 output/checkpoint/receipt 引用;
 * - 本层只做投影与容量,不持有 child process(领域 spawn 由上层注入)。
 */
export class SessionProcessRegistry {
	private readonly capacity: number;
	private readonly entries = new Map<string, SessionProcessRecord>();

	public constructor(capacity: number = SESSION_PROTOCOL_BOUNDS.maxProcessesPerSession) {
		this.capacity = capacity;
	}

	public register(sessionId: SessionId, generation: number): SessionProcessRecord | { readonly error: "process_capacity_exceeded" } {
		if (this.entries.size >= this.capacity) return { error: "process_capacity_exceeded" };
		const processId = createRuntimeId("execution", `proc-${this.entries.size + 1}-${Date.now().toString(36)}`);
		const record: SessionProcessRecord = {
			processId,
			sessionId,
			generation,
			status: "running",
			createdAtMs: Date.now(),
		};
		this.entries.set(processId, record);
		return record;
	}

	public settle(processId: string, status: "settled" | "lost" | "uncertain"): boolean {
		const record = this.entries.get(processId);
		if (!record) return false;
		record.status = status;
		return true;
	}

	/** §7.4 owner crash:本 generation 的全部 in-flight 句柄投影 lost/uncertain。 */
	public projectLostOrUncertain(sessionId: SessionId, generation: number): readonly SessionProcessRecord[] {
		const affected: SessionProcessRecord[] = [];
		for (const record of this.entries.values()) {
			if (record.sessionId === sessionId && record.generation === generation && record.status === "running") {
				record.status = "uncertain";
				affected.push({ ...record });
			}
		}
		return affected;
	}

	public count(): number {
		return this.entries.size;
	}

	public snapshot(): readonly SessionProcessRecord[] {
		return [...this.entries.values()].map((record) => ({ ...record }));
	}
}

// ── composition ──────────────────────────────────────────────────────────

/**
 * §8.1/§R6 统一 open:
 * - 健康 owner 存在 → 立即 attach(本地 view 走 TCP facade,不 claim);
 * - 无 owner / stale 且 probe 失败 → claim/takeover → restore runtime、
 *   publish owner state、activate server,再把本地 view 通过同一 TCP facade 接回;
 * - 不提供 direct-controller fallback(边界检查)。
 */
export async function createEmbeddedSessionRuntime(options: EmbeddedSessionRuntimeOptions): Promise<EmbeddedSessionRuntimeResult> {
	const { sessionId, store, ownerStore } = options;
	const attemptPort = new LateBoundAttemptPort();
	const server = new SessionRuntimeServer({
		sessionId,
		store,
		controller: nullController(sessionId),
		onAttachmentCountChange: (count) => {
			// §8.3 headless-attached owner loop:本地 view 已 detach 但仍有
			// remote attachment → 保持运行;归零才 pause/release。
			if (count === 0 && runtime !== undefined) {
				void runtime.shutdownAfterLastAttachment("paused");
			}
		},
	});
	let owner: SessionOwner | undefined;
	let runtime: SessionRuntime | undefined;
	const claimOwner = new SessionOwner({
		store,
		ownerStore,
		transport: server,
		// P0-4:生产 wiring 必须传入 onFenced:旧 generation 被 fence 后完整
		// self-stop(server 关闭 + 领域中断 + 客户端断开)。
		onFenced: () => {
			runtime?.selfStopFenced();
		},
	});
	owner = claimOwner;
	const result = await claimOwner.open(sessionId);
	if (!result.ok) throw new Error(`owner open failed: ${result.code}`);
	const processRegistry = new SessionProcessRegistry();
	if (result.outcome === "attached") {
		// P0-1:健康 owner 即时 attach —— 本进程是 remote client,不装配 runtime。
		const client = new SessionClient({ store, ownerStore, claimTransport: server, ...(options.reverseRequestHandler === undefined ? {} : { reverseRequestHandler: options.reverseRequestHandler }) });
		const opened = await client.attachDiscovered(sessionId, result.record);
		if (!opened.ok) throw new Error(`local attach failed: ${opened.code}`);
		return {
			handle: opened.handle,
			runtime: undefined,
			server,
			owner: claimOwner,
			processRegistry,
		};
	}
	// claimed:装配本地 SessionRuntime。
	const restored = restoreSession(store, sessionId);
	if (!restored.ok) throw new Error(`restore failed: ${restored.code}`);
	// §5.1:只有 crash takeover(active stale row 经 probe + CAS)才进
	// RECOVERY_REQUIRED;clean create / clean release resume 直接 READY。
	const crashTakeover = claimOwner.lastClaimWasTakeover;
	const workspace = await options.workspace?.open({ sessionId, store, fence: result.fence });
	const approvalPorts = options.domain === undefined
		? undefined
		: createSessionApprovalPorts({
			store,
			fence: result.fence,
			sender: server,
			driverConnectionId: () => server.driverConnectionId(),
		});
	const domainOptions = options.domain === undefined
		? undefined
		: {
				...options.domain,
				...(workspace === undefined ? {} : { cwd: workspace.effectiveCwd }),
				...(approvalPorts === undefined ? {} : { approvalPorts }),
			};
	let domain: SessionDomainPort | undefined;
	try {
		domain = domainOptions === undefined ? undefined : await assembleSessionDomain(domainOptions, sessionId, store, result.fence, restored, attemptPort);
		if (crashTakeover) await domain?.process?.recoverUnattached?.();
	} catch (error) {
		await workspace?.release("error").catch(() => undefined);
		throw error;
	}
	runtime = new SessionRuntime({
		sessionId,
		store,
		ownerStore,
		owner: claimOwner,
		server,
		fence: result.fence,
		crashTakeover,
		restored,
		domain,
		attemptPortRef: attemptPort,
		...((workspace === undefined && domain?.process?.shutdown === undefined && domain?.shutdown === undefined) ? {} : {
			lifecycleCleanup: async (reason) => {
				await domain?.shutdown?.(reason);
				await domain?.process?.shutdown?.(reason);
				await workspace?.release(reason);
			},
		}),
	});
	try {
		await domain?.start?.();
		server.bindController(runtime);
		runtime.start();
	} catch (error) {
		await domain?.shutdown?.("error").catch(() => undefined);
		await domain?.process?.shutdown?.("error").catch(() => undefined);
		await workspace?.release("error").catch(() => undefined);
		claimOwner.release("error");
		await server.closeCandidate().catch(() => undefined);
		throw error;
	}
	// 本地 view 也走 TCP facade(不直接调 controller)。
	const client = new SessionClient({ store, ownerStore, claimTransport: server, ...(options.reverseRequestHandler === undefined ? {} : { reverseRequestHandler: options.reverseRequestHandler }) });
	const opened = await client.attachTo(ownerStore.readOwner(sessionId)!, server.endpoint, claimOwner.currentAuthToken);
	if (!opened.ok) throw new Error(`local attach failed: ${opened.code}`);
	return {
		handle: opened.handle,
		runtime,
		server,
		owner: claimOwner,
		processRegistry,
	};
}

function nullController(sessionId: SessionId) {
	return {
		sessionId,
		protocolManifest: () => SESSION_CORE_PROTOCOL_MANIFEST,
		snapshot: () => ({ sessionId, headSequence: 0, sessionStatus: "active", runtimeState: "starting", agentRuns: [] }),
		handleCommand: async () => ({ ok: false as const, code: "not_bound" }),
		handleQuery: async () => ({ ok: false, kind: "not_bound" }),
		onEvent: () => () => undefined,
		isMutatingKind: () => false,
	};
}
