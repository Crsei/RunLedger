/**
 * R4/R6:Session Client(06 §2/§8)。
 *
 * - resolve/create/open/fork 走受限 SessionStore 只读 catalog;owner discovery
 *   与 claim 走 SessionOwner(统一 attach/takeover 路径),不提供 direct-controller
 *   fallback;
 * - 所有 mutation 都通过 localhost TCP facade(SessionClientTransport)发给
 *   RuntimeServer;本地 owner view 与 remote view 走完全相同的代码路径;
 * - OwnedSessionHandle 是 Client 内的生命周期集合:同进程可因 /new、多 tab
 *   持有多个 handle,但不构成 machine-wide registry。
 */

import type { SessionStore } from "../storage/session-store/session-store.ts";
import { OwnerStore } from "../storage/session-store/owner-store.ts";
import { SessionOwner, type SessionOwnerOptions } from "../runtime/session-owner/session-owner.ts";
import { SessionClientTransport } from "../runtime/session-server/client-transport.ts";
import {
	SESSION_PROTOCOL_VERSION,
	type ClientId,
	type SessionFrameEnvelope,
	type SessionHandshakeRequest,
} from "../runtime/session-server/protocol.ts";
import type { OwnerClaimResult, OwnerEndpoint, OwnerFence, SessionOwnerRecord } from "../runtime/session-owner/types.ts";
import { createRuntimeId, type ConnectionId, type SessionId } from "../runtime/protocol/ids.ts";

const clientIdSeed = (): string => `client_local_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

export interface SessionClientOptions {
	readonly store: SessionStore;
	readonly ownerStore: OwnerStore;
	/** claim 用 transport;生产由 embedded SessionRuntime 提供(bind-before-publish)。 */
	readonly claimTransport: SessionOwnerOptions["transport"];
	readonly clientId?: ClientId;
	/**
	 * 客户端收到 reverse_request(credential/approval UI)时的处理回调。
	 * TUI 注入后,`/login` 的密钥输入/选择经此在 driver 连接上渲染并返回
	 * reverse_response;headless 不注入则 server 侧 fail closed。
	 */
	readonly reverseRequestHandler?: (frame: SessionFrameEnvelope, signal: AbortSignal) => Promise<Record<string, unknown>> | Record<string, unknown>;
}

export interface OwnedSessionHandle {
	readonly sessionId: SessionId;
	readonly generation: number;
	readonly runtimeId: string;
	/** true 表示本 Client 进程是该 Session 的 owner(embedded runtime)。 */
	readonly isOwner: boolean;
	readonly transport: SessionClientTransport;
	readonly connectionId: ConnectionId;
	readonly ownerRecord: SessionOwnerRecord;
	close(): Promise<void>;
}

export type OpenSessionResult =
	| { readonly ok: true; readonly handle: OwnedSessionHandle }
	| { readonly ok: false; readonly code: string; readonly retryable: boolean };

export class SessionClient {
	private readonly options: SessionClientOptions;
	private readonly clientId: ClientId;

	public constructor(options: SessionClientOptions) {
		this.options = options;
		this.clientId = options.clientId ?? (clientIdSeed() as ClientId);
	}

	public get id(): ClientId {
		return this.clientId;
	}

	/** §8.1 统一 open:resolve → probe → attach → claim/takeover → TCP facade。 */
	public async openSession(
		sessionId: SessionId,
		opts: {
			/**
			 * claimed 后由 embedded-session-runtime 接线:restore runtime、
			 * publish owner state、activate server,并返回 server endpoint + token。
			 */
			readonly claimHandler?: (ctx: { readonly result: Extract<OwnerClaimResult, { readonly ok: true; readonly outcome: "claimed" }>; readonly owner: SessionOwner }) => Promise<{ readonly endpoint: OwnerEndpoint; readonly token: string }>;
			/** attach 失败时的重试上限(健康 owner 通常一次成功;失败多因 read-attach 间隙死亡)。 */
			readonly attachRetries?: number;
		} = {},
	): Promise<OpenSessionResult> {
		const record = this.options.store.getSession(sessionId);
		if (record === undefined) {
			return { ok: false, code: "session_not_found", retryable: false };
		}
		const owner = new SessionOwner({
			store: this.options.store,
			ownerStore: this.options.ownerStore,
			transport: this.options.claimTransport,
		});
		const result = await owner.open(sessionId);
		if (!result.ok) return result;
			if (result.outcome === "attached") {
				return this.attachDiscovered(sessionId, result.record, opts.attachRetries ?? 5);
		}
		// claimed:调用方(embedded-session-runtime)负责 restore runtime + activate server。
		if (opts.claimHandler !== undefined) {
			const server = await opts.claimHandler({ result, owner });
			const freshRecord = this.options.ownerStore.readOwner(sessionId);
			if (freshRecord === undefined) return { ok: false, code: "owner_claim_lost", retryable: true };
			return this.attachTo(freshRecord, server.endpoint, server.token);
		}
		// 无 claimHandler 时仅返回 claimed 事实,由上层继续。
		return { ok: false, code: "owner_claim_requires_runtime", retryable: true };
	}

	/**
	 * 已发现 owner 的 bounded attach。每次失败后重新读取 SQLite owner row，
	 * 避免对已死亡 endpoint 或 starting/stopping identity 重复握手。
	 */
	public async attachDiscovered(sessionId: SessionId, initial: SessionOwnerRecord, retries = 5): Promise<OpenSessionResult> {
		let candidate: SessionOwnerRecord | undefined = initial;
		let lastFailure: OpenSessionResult = { ok: false, code: "owner_attach_failed", retryable: true };
		for (let attempt = 0; attempt < retries; attempt += 1) {
			if (candidate === undefined || candidate.state === "unowned") {
				return { ok: false, code: "owner_claim_lost", retryable: true };
			}
			const opened = await this.attachTo(candidate);
			if (opened.ok) return opened;
			lastFailure = opened;
			if (!opened.retryable) return opened;
			await sleep(100 * (attempt + 1));
			candidate = this.options.ownerStore.readOwner(sessionId);
		}
		return lastFailure;
	}

	/** 通过 TCP facade attach 一个已存在的 owner row(endpoint 缺省用 row 的 port)。 */
	public async attachTo(record: SessionOwnerRecord, overrideEndpoint?: OwnerEndpoint, overrideToken?: string): Promise<OpenSessionResult> {
		const endpoint = overrideEndpoint ?? record.endpoint;
		if (endpoint === undefined) {
			return { ok: false, code: "owner_claim_lost", retryable: true };
		}
		let transport: SessionClientTransport | undefined;
		try {
			transport = await SessionClientTransport.connect(endpoint.port, { reverseRequestHandler: this.options.reverseRequestHandler });
		} catch {
			return { ok: false, code: "owner_connect_failed", retryable: true };
		}
		const request: SessionHandshakeRequest = {
			protocolVersion: SESSION_PROTOCOL_VERSION,
			sessionId: record.sessionId,
			expectedRuntimeId: record.runtimeId,
			expectedGeneration: record.generation,
			authToken: overrideToken ?? this.readToken(record),
			clientId: this.clientId,
			clientCapabilities: ["session.core"],
		};
		let response: Awaited<ReturnType<SessionClient["initialize"]>>;
		try {
			response = await this.initialize(transport, request);
		} catch {
			await transport.close().catch(() => undefined);
			return { ok: false, code: "owner_connect_failed", retryable: true };
		}
		if (!response.accepted) {
			await transport.close();
			return { ok: false, code: response.code, retryable: isRetryableAttachCode(response.code) };
		}
		return {
			ok: true,
			handle: {
				sessionId: record.sessionId,
				generation: response.generation,
				runtimeId: response.runtimeId,
				isOwner: false,
				transport,
				connectionId: createRuntimeId("connection", `client-${Date.now().toString(36)}`),
				ownerRecord: record,
				close: () => transport.close(),
			},
		};
	}

	/** 只读 catalog 操作;mutation(create/fork)在 R6 composition 中经 SessionStore。 */
	public resolveSession(sessionId: SessionId): ReturnType<SessionStore["getSession"]> {
		return this.options.store.getSession(sessionId);
	}

	private readToken(record: SessionOwnerRecord): string {
		// attach 需要 row 中的 token;通过 OwnerStore 只读读取(同用户本机边界)。
		return this.options.ownerStore.readProbeSecret(record.sessionId)?.authTokenHex ?? "";
	}

	private async initialize(		transport: SessionClientTransport,
		request: SessionHandshakeRequest,
	): Promise<
		| { readonly accepted: true; readonly runtimeId: string; readonly generation: number; readonly snapshotCursor: number; readonly driverRevision: number; readonly sessionStatus: string }
		| { readonly accepted: false; readonly code: string }
	> {
		const frame: SessionFrameEnvelope = {
			frameId: `init_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
			kind: "initialize_request",
			protocolVersion: SESSION_PROTOCOL_VERSION,
			body: { ...request },
		};
		const response = await transport.request(frame);
		if (response.kind !== "initialize_response") return { accepted: false, code: "frame_malformed" };
		const body = response.body as Record<string, unknown>;
		if (body.accepted === true) {
			return {
				accepted: true,
				runtimeId: String(body.runtimeId),
				generation: Number(body.generation),
				snapshotCursor: Number(body.snapshotCursor ?? 0),
				driverRevision: Number(body.driverRevision ?? 0),
				sessionStatus: String(body.sessionStatus ?? "active"),
			};
		}
		return { accepted: false, code: typeof body.code === "string" ? body.code : "frame_malformed" };
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableAttachCode(code: string): boolean {
	return code === "owner_starting" || code === "owner_stopping" || code === "handshake_identity_mismatch" || code === "owner_claim_lost" || code === "owner_connect_failed";
}
