/** Resident Runtime Host service.
 *
 * 该模块是 production JSONL listener 与 Host-owned session runtime 的连接点。
 * Client 只看到 snapshot/event/receipt；SessionManager、Agent、ledger 与
 * provider 实例都留在这里。In-memory map 只做路由缓存，session 内容仍由
 * canonical SessionManager 负责恢复。
 */

import type { HostTransportAttestor, HostTransportFrameContext } from "./runtime-host-transport.ts";
import { JsonLineHostServer } from "./runtime-host-transport.ts";
import {
	type HostCompatibilityEnvelope,
} from "../runtime/host/contracts.ts";
import {
	claimDriver,
	authorizeDriverMutation,
	createDriverState,
	releaseDriver,
	type DriverState,
} from "../runtime/host/driver.ts";
import type { AgentEvent } from "../runtime/types.ts";
import type {
	InteractiveSessionControllerPort,
	RuntimeSelection,
} from "../runtime/interactive-session-controller.ts";
import type { ModelThinkingLevel } from "../types.ts";
import { RUNTIME_HOST_BOUNDS, type HostConnectionPrincipal, type HostFrameEnvelope } from "../runtime/host/types.ts";
import type { RuntimeInstanceId } from "../runtime/protocol/ids.ts";
import { createRuntimeId } from "../runtime/protocol/ids.ts";
import { runtimeDigest, type RuntimeDigest } from "../runtime/protocol/foundation.ts";
import { createHostEndpointRecord, type HostEndpointRecord } from "../storage/host/endpoint-store.ts";
import type { ExecutionHandleRef } from "../runtime/process/types.ts";
import type { OutputCursor } from "../runtime/process/output.ts";
import type { ControlPlaneActor } from "../storage/process/control-plane.ts";
import type { HostEventStore, StoredHostEvent } from "../storage/host/event-store.ts";
import { BoundedHostCommandStore, type HostCommandStore } from "../storage/host/command-store.ts";
import type { HostDomainRevisionStore } from "../storage/host/domain-revision-store.ts";
import type { RuntimeEventAppendInput, RuntimeEventWriter } from "../storage/host/runtime-event-store.ts";
import { SYSTEM_APPROVAL_PRINCIPAL_ID } from "../security/permission/approval-coordinator.ts";
import type { PermissionPrompt, PermissionPromptResponse, PermissionPrompter } from "../security/types.ts";
import type { HostMcpRuntime } from "./runtime-host-mcp.ts";

export type HostSessionOpenMode = "create" | "open" | "continue_recent" | "resume" | "fork";

export interface HostSessionOpenRequest {
	readonly mode: HostSessionOpenMode;
	/** Host-internal generation for a rebuilt resident session; never accepted from client frames. */
	readonly sessionGeneration?: number;
	readonly sessionId?: string;
	readonly sessionPath?: string;
	readonly cwd?: string;
	readonly provider?: string;
	readonly model?: string;
	readonly thinkingLevel?: ModelThinkingLevel;
}

export interface HostSessionRuntime {
	readonly controller: InteractiveSessionControllerPort;
	/** Optional Host-owned extension runtime; never constructed by a client. */
	readonly mcp?: HostMcpRuntime;
	close(): Promise<void>;
}

/**
 * Host domain port.  Domain implementations own their reducer/service, while
 * the resident Host owns admission, driver fencing, command idempotency and
 * the canonical event writer around them.
 */
export interface HostRuntimeDomainContext {
	readonly principal: HostConnectionPrincipal;
	readonly frame: HostFrameEnvelope;
	readonly operation: string;
	readonly mutation: boolean;
	readonly sessionId: string;
	readonly controller: InteractiveSessionControllerPort;
	readonly hostGeneration: number;
	readonly sessionGeneration: number;
	readonly driverRevision: number;
	readonly domainRevision: number;
	readonly mcp?: HostMcpRuntime;
}

export interface HostRuntimeDomainResult {
	readonly ok: boolean;
	readonly body?: Record<string, unknown>;
	readonly mutated?: boolean;
	readonly events?: readonly RuntimeEventAppendInput[];
}

export interface HostRuntimeDomainPort {
	readonly name: string;
	readonly queryOperations?: ReadonlySet<string>;
	readonly mutationOperations?: ReadonlySet<string>;
	execute(context: HostRuntimeDomainContext): Promise<HostRuntimeDomainResult>;
}

export interface HostDriverResponse {
	readonly body: Record<string, unknown>;
	readonly principalId: string;
}

export interface HostDriverResponseOptions {
	readonly timeoutMs?: number;
	readonly signal?: AbortSignal;
}

export interface HostDriverResponseRequester {
	requestDriverResponse(
		sessionId: string,
		body: Record<string, unknown>,
		options?: HostDriverResponseOptions,
	): Promise<HostDriverResponse>;
}

/** PermissionPrompter adapter whose authority remains in the resident Host. */
export class HostReversePermissionPrompter implements PermissionPrompter {
	private readonly host: () => HostDriverResponseRequester | undefined;

	public constructor(host: () => HostDriverResponseRequester | undefined) {
		this.host = host;
	}

	public async request(prompt: PermissionPrompt, signal?: AbortSignal): Promise<PermissionPromptResponse> {
		const host = this.host();
		if (!host) return { decision: "deny", decidedBy: SYSTEM_APPROVAL_PRINCIPAL_ID, reason: "approval Host is unavailable" };
		let response: HostDriverResponse;
		try {
			response = await host.requestDriverResponse(prompt.sessionId, {
				requestType: "permission",
				requestId: prompt.requestId,
				toolCallId: prompt.toolCallId,
				toolName: prompt.toolName,
				summary: prompt.summary,
				requests: prompt.requests,
				argumentsDigest: prompt.argumentsDigest,
				cwd: prompt.cwd,
				policyDigest: prompt.policyDigest,
				expiresAt: prompt.expiresAt,
			}, { signal });
		} catch (error) {
			return {
				decision: "cancel",
				decidedBy: SYSTEM_APPROVAL_PRINCIPAL_ID,
			};
		}
		if (response.body.ok !== true) {
			return {
				decision: "deny",
				decidedBy: SYSTEM_APPROVAL_PRINCIPAL_ID,
				reason: stringValue(response.body.code) ?? "approval was not accepted",
			};
		}
		const decision = response.body.decision;
		if (decision === "allow-once" || decision === "deny" || decision === "cancel") {
			return {
				decision,
				decidedBy: response.principalId as PermissionPromptResponse["decidedBy"],
				...(typeof response.body.reason === "string" ? { reason: response.body.reason } : {}),
			};
		}
		return { decision: "deny", decidedBy: SYSTEM_APPROVAL_PRINCIPAL_ID, reason: "approval decision is invalid" };
	}
}

export interface HostProcessCreateInput {
	readonly sessionId: string;
	readonly commandId?: string;
	readonly sessionGeneration: number;
	readonly command: string;
	readonly cwd: string;
	readonly timeoutMs: number;
	readonly stdin?: string;
	readonly backend: "pipe" | "pty";
	readonly executionMode: "foreground" | "background";
	readonly principalId: string;
	readonly containment?: "none" | "process_group" | "supervisor";
}

export interface HostProcessPort {
	create(input: HostProcessCreateInput): Promise<Record<string, unknown>>;
	list(sessionId: string): Promise<readonly Record<string, unknown>[]>;
	output(sessionId: string, executionId: string, cursor: OutputCursor, maxBytes: number): Promise<Record<string, unknown>>;
	wait(sessionId: string, executionId: string, timeoutMs: number, actor: ControlPlaneActor): Promise<Record<string, unknown>>;
	write(sessionId: string, executionId: string, actor: ControlPlaneActor, input: string): Promise<Record<string, unknown>>;
	eof(sessionId: string, executionId: string, actor: ControlPlaneActor): Promise<Record<string, unknown>>;
	resize(sessionId: string, executionId: string, actor: ControlPlaneActor, columns: number, rows: number): Promise<Record<string, unknown>>;
	stop(sessionId: string, executionId: string, actor: ControlPlaneActor, signal?: NodeJS.Signals): Promise<Record<string, unknown>>;
	planRetention?(sessionId: string, executionId: string, cursor: OutputCursor): Promise<Record<string, unknown>>;
	commitRetention?(sessionId: string, executionId: string, plan: unknown): Promise<Record<string, unknown>>;
	pinOutput?(sessionId: string, executionId: string, pinId: string, cursor: OutputCursor): Promise<Record<string, unknown>>;
	unpinOutput?(sessionId: string, executionId: string, pinId: string): Promise<Record<string, unknown>>;
	findHandle?(sessionId: string, executionId: string): ExecutionHandleRef | undefined;
}

export interface ResidentRuntimeHostOptions {
	readonly socketPath: string;
	readonly scope: HostCompatibilityEnvelope;
	readonly attestor: HostTransportAttestor;
	readonly hostRuntimeId?: RuntimeInstanceId;
	readonly hostGeneration?: number;
	readonly hostProcessStartIdentityDigest?: RuntimeDigest;
	readonly createSession: (input: HostSessionOpenRequest) => Promise<HostSessionRuntime>;
	/** Host-private resolver used after a workspace binding mutation. */
	readonly resolveWorkspaceCwd?: (sessionId: string) => Promise<string>;
	readonly processPort?: HostProcessPort;
	readonly domainPorts?: readonly HostRuntimeDomainPort[];
	/** The only Runtime event writer used by Host domain adapters. */
	readonly runtimeEventWriter?: RuntimeEventWriter;
	readonly eventStore?: HostEventStore;
	readonly commandStore?: HostCommandStore;
	/** Durable per-session domain revisions used after Host cold restart. */
	readonly domainRevisionStore?: HostDomainRevisionStore;
	/** Explicit management shutdown; client detach never invokes this callback. */
	readonly onShutdown?: (request: HostShutdownRequest) => Promise<void>;
	readonly onEndpoint?: (endpoint: HostEndpointRecord) => Promise<void>;
	readonly onConnectionClosed?: (connectionId: string) => Promise<void>;
}

export type HostShutdownReason = "manual_stop" | "maintenance_restart" | "external_signal" | "auto_update";

export interface HostShutdownRequest {
	readonly reason: HostShutdownReason;
	readonly targetBuildDigest?: RuntimeDigest;
}

export type HostShutdownActivityDecision =
	| { readonly ok: true; readonly activeTurnCount: number; readonly managedProcessCount: number }
	| { readonly ok: false; readonly code: "host_busy"; readonly activeTurnCount: number; readonly managedProcessCount: number };

export function evaluateHostShutdownActivity(input: {
	readonly activeTurnCount: number;
	readonly managedProcessCount: number;
	readonly confirmActive: boolean;
}): HostShutdownActivityDecision {
	const counts = { activeTurnCount: input.activeTurnCount, managedProcessCount: input.managedProcessCount };
	return (input.activeTurnCount > 0 || input.managedProcessCount > 0) && !input.confirmActive
		? { ok: false, code: "host_busy", ...counts }
		: { ok: true, ...counts };
}

interface SessionState {
	runtime: HostSessionRuntime;
	mcp?: HostMcpRuntime;
	cwd?: string;
	driver: DriverState;
	sequence: number;
	history: HostSubscriptionEvent[];
	eventTail: Promise<void>;
	eventUnsubscribe: () => void;
	readonly domainRevisions: Map<string, number>;
}

interface HostSubscriptionEvent {
	readonly sessionId: string;
	readonly eventId: string;
	readonly sequence: number;
	readonly eventType: string;
	readonly event: AgentEvent;
}

interface HostSubscriptionState {
	ackCursor: number;
	sentCursor: number;
}

interface PendingHostDriverResponse {
	readonly requestId: string;
	readonly sessionId: string;
	readonly body: Record<string, unknown>;
	readonly deadline: number;
	readonly timeoutId: ReturnType<typeof setTimeout>;
	readonly resolve: (response: HostDriverResponse) => void;
	readonly reject: (error: Error) => void;
	readonly removeAbortListener?: () => void;
	connectionId?: string;
	deliveryFrameId?: string;
	deliveryCount: number;
}

export interface HostSessionSnapshot {
	readonly sessionId: string;
	readonly selection: RuntimeSelection;
	readonly messages: readonly unknown[];
	readonly warnings: readonly string[];
	readonly auditEntries: readonly unknown[];
	readonly toolCount: number;
}

export class ResidentRuntimeHost {
	private readonly options: ResidentRuntimeHostOptions;
	private readonly server: JsonLineHostServer;
	private readonly runtimeId: RuntimeInstanceId;
	private readonly generation: number;
	private readonly sessions = new Map<string, SessionState>();
	private readonly subscriptions = new Map<string, Map<string, HostSubscriptionState>>();
	private readonly reverseRequests = new Map<string, PendingHostDriverResponse>();
	private readonly commandStore: HostCommandStore;
	private reverseRequestSequence = 0;
	private endpoint: HostEndpointRecord | undefined;
	private started = false;
	private admissionOpen = true;
	private closing: Promise<void> | undefined;
	private shutdownRequested = false;

	public constructor(options: ResidentRuntimeHostOptions) {
		this.options = options;
		this.runtimeId = options.hostRuntimeId ?? createRuntimeId("runtime", `host-${process.pid}-${Date.now()}`);
		this.generation = options.hostGeneration ?? 1;
		this.commandStore = options.commandStore ?? new BoundedHostCommandStore();
		if (!Number.isSafeInteger(this.generation) || this.generation < 0) throw new Error("hostGeneration must be a non-negative safe integer");
		this.server = new JsonLineHostServer({
			socketPath: options.socketPath,
			scope: options.scope,
			management: { protocolVersion: 1, hostRuntimeId: this.runtimeId, hostGeneration: this.generation },
			attestor: options.attestor,
			handleFrame: (context) => this.handleFrame(context),
			onConnectionClosed: (connectionId) => this.handleConnectionClosed(connectionId),
		});
	}

	public async start(): Promise<HostEndpointRecord> {
		if (this.started && this.endpoint) return this.endpoint;
		const publishedAt = new Date().toISOString();
		this.endpoint = createHostEndpointRecord({
			protocolVersion: 1,
			managementProtocolVersion: 1,
			workspaceStorageKey: this.options.scope.workspaceStorageKey,
			hostRuntimeId: this.runtimeId,
			hostGeneration: this.generation,
			hostProcessId: process.pid,
			hostProcessStartIdentityDigest: this.options.hostProcessStartIdentityDigest ?? runtimeDigest({ kind: "unverified-test-process", pid: process.pid }),
			hostBuildDigest: this.options.scope.hostBuildDigest,
			state: "starting",
			compatibilityDigest: this.options.scope.compatibilityDigest,
			publishedAt,
		});
		this.admissionOpen = true;
		await this.options.onEndpoint?.(this.endpoint);
		await this.server.listen();
		const { metadataDigest: _metadataDigest, ...endpoint } = this.endpoint;
		this.endpoint = createHostEndpointRecord({ ...endpoint, state: "ready" });
		await this.options.onEndpoint?.(this.endpoint);
		this.started = true;
		return this.endpoint;
	}

	public endpointRecord(): HostEndpointRecord | undefined {
		return this.endpoint;
	}

	/**
	 * Sends a reverse request to the active driver without making the logical
	 * waiter depend on one client socket. A disconnected driver leaves the
	 * request pending until a replacement explicitly claims the session.
	 */
	public requestDriverResponse(
		sessionId: string,
		body: Record<string, unknown>,
		options: HostDriverResponseOptions = {},
	): Promise<HostDriverResponse> {
		if (!this.sessions.has(sessionId)) return Promise.reject(new Error("session_not_found"));
		const timeoutMs = options.timeoutMs ?? RUNTIME_HOST_BOUNDS.maxWaitMs;
		if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > RUNTIME_HOST_BOUNDS.maxWaitMs) {
			return Promise.reject(new Error("invalid reverse request timeout"));
		}
		const requestId = `reverse_${Date.now().toString(36)}_${++this.reverseRequestSequence}`;
		const deadline = Date.now() + timeoutMs;
		return new Promise<HostDriverResponse>((resolve, reject) => {
			let pending: PendingHostDriverResponse;
			const timeoutId = setTimeout(() => {
				if (this.reverseRequests.get(requestId) !== pending) return;
				this.reverseRequests.delete(requestId);
				pending.removeAbortListener?.();
				reject(new Error("Host reverse request timed out"));
			}, timeoutMs);
			const abortListener = (): void => {
				if (this.reverseRequests.get(requestId) !== pending) return;
				clearTimeout(timeoutId);
				this.reverseRequests.delete(requestId);
				pending.removeAbortListener?.();
				reject(new Error("Host reverse request aborted"));
			};
			pending = {
				requestId,
				sessionId,
				body: { ...body },
				deadline,
				timeoutId,
				resolve,
				reject,
				...(options.signal === undefined ? {} : { removeAbortListener: () => options.signal?.removeEventListener("abort", abortListener) }),
				deliveryCount: 0,
			};
			this.reverseRequests.set(requestId, pending);
			if (options.signal?.aborted) {
				abortListener();
				return;
			}
			options.signal?.addEventListener("abort", abortListener, { once: true });
			void this.dispatchDriverResponse(pending);
		});
	}

	/** R10: block new session/process admission while the resident Host drains. */
	public async closeAdmission(): Promise<void> {
		this.admissionOpen = false;
		if (this.endpoint && this.endpoint.state === "ready") {
			const { metadataDigest: _metadataDigest, ...endpoint } = this.endpoint;
			this.endpoint = createHostEndpointRecord({ ...endpoint, state: "draining" });
			await this.options.onEndpoint?.(this.endpoint);
		}
	}

	/** R10: wait for every Host-owned Agent turn before process/output phases. */
	public async drainTurns(): Promise<void> {
		await Promise.all([...this.sessions.values()].map((session) => session.runtime.controller.waitForIdle()));
	}

	/** R10: force the canonical ledger sinks to be observed before release. */
	public async flushWriters(): Promise<void> {
		for (const session of this.sessions.values()) {
			const ledger = session.runtime.controller.ledger;
			if (ledger === undefined) continue;
			await ledger.entries();
			if (ledger.lastError !== undefined) throw new Error("Host ledger writer has an error");
		}
	}

	public async close(): Promise<void> {
		this.closing ??= this.closeOnce();
		return this.closing;
	}

	private async closeOnce(): Promise<void> {
		this.admissionOpen = false;
		this.rejectReverseRequests(new Error("Host is closing"));
		if (this.endpoint) {
			const { metadataDigest: _metadataDigest, ...endpoint } = this.endpoint;
			this.endpoint = createHostEndpointRecord({ ...endpoint, state: "draining" });
			try {
				await this.options.onEndpoint?.(this.endpoint);
			} catch {
				// endpoint cleanup is best effort during shutdown
			}
		}
		await this.server.close();
		for (const session of this.sessions.values()) {
			session.eventUnsubscribe();
			session.runtime.controller.dispose();
			await session.runtime.close().catch(() => undefined);
		}
		this.sessions.clear();
		this.subscriptions.clear();
		this.started = false;
	}

	private async handleFrame(context: HostTransportFrameContext): Promise<readonly HostFrameEnvelope[]> {
		if (context.mode === "management") return [await this.handleManagementFrame(context)];
		if (context.frame.kind === "ack_cursor") {
			this.ackCursor(context.principal, context.frame);
			return [];
		}
		if (context.frame.kind === "query_request") {
			return [await this.executeDomainQuery(context.principal, context.frame)];
		}
		if (context.frame.kind !== "command_request") {
			return [this.response(context.frame, { ok: false, code: "unsupported_frame" })];
		}
		const commandId = stringValue(context.frame.body.commandId) ?? context.frame.frameId;
		const requestDigest = runtimeDigest(context.frame.body).digest;
		const reservation = await this.commandStore.begin(context.principal.principalId, commandId, requestDigest);
		if (reservation.status === "conflict") return [this.response(context.frame, { ok: false, code: "command_id_conflict" })];
		if (reservation.status === "uncertain") return [this.response(context.frame, { ok: false, code: "uncertain_outcome" })];
		if (reservation.status === "capacity") return [this.response(context.frame, { ok: false, code: "command_journal_capacity" })];
		if (reservation.status === "replay") return [this.rebindResponse(reservation.response, context.frame)];
		let response: HostFrameEnvelope;
		try {
			response = await this.executeCommand(context.principal, context.frame);
		} catch (error) {
			// executeCommand 的 switch 分支可能直接返回一个随后拒绝的 Promise；
			// 在 durable intent 边界统一收敛，避免把领域错误升级为连接断开。
			response = this.response(context.frame, { ok: false, code: errorCode(error) });
		}
		try {
			await this.commandStore.complete(context.principal.principalId, commandId, requestDigest, response);
		} catch {
			return [this.response(context.frame, { ok: false, code: "uncertain_outcome" })];
		}
		return [response];
	}

	private async handleManagementFrame(context: HostTransportFrameContext): Promise<HostFrameEnvelope> {
		const operation = stringValue(context.frame.body.operation);
		if (context.frame.kind === "query_request" && operation === "host.inspect") {
			const counts = this.server.connectionCounts();
			const activeTurnCount = [...this.sessions.values()].filter((session) => session.runtime.controller.inFlight).length;
			let managedProcessCount = 0;
			if (this.options.processPort) {
				for (const session of this.sessions.values()) managedProcessCount += (await this.options.processPort.list(session.runtime.controller.sessionId)).length;
			}
			return this.response(context.frame, {
				ok: true,
				hostRuntimeId: this.runtimeId,
				hostGeneration: this.generation,
				state: this.endpoint?.state ?? "starting",
				workspaceStorageKey: this.options.scope.workspaceStorageKey,
				protocolVersion: this.options.scope.protocolVersion,
				managementProtocolVersion: 1,
				buildDigest: this.options.scope.hostBuildDigest,
				runtimeClientCount: counts.runtime,
				managementClientCount: counts.management,
				loadedSessionCount: this.sessions.size,
				activeTurnCount,
				managedProcessCount,
			});
		}
		if (context.frame.kind !== "command_request" || operation !== "host.shutdown") {
			return this.response(context.frame, { ok: false, code: "management_operation_forbidden" });
		}
		const commandId = stringValue(context.frame.body.commandId) ?? context.frame.frameId;
		const requestDigest = runtimeDigest(context.frame.body).digest;
		const reservation = await this.commandStore.begin(context.principal.principalId, commandId, requestDigest);
		if (reservation.status === "replay") return this.rebindResponse(reservation.response, context.frame);
		if (reservation.status !== "execute") return this.response(context.frame, { ok: false, code: reservation.status === "conflict" ? "command_id_conflict" : reservation.status === "capacity" ? "command_journal_capacity" : "uncertain_outcome" });
		const response = await this.managementShutdown(context.frame);
		await this.commandStore.complete(context.principal.principalId, commandId, requestDigest, response);
		return response;
	}

	private async managementShutdown(frame: HostFrameEnvelope): Promise<HostFrameEnvelope> {
		if (frame.body.expectedHostRuntimeId !== this.runtimeId || frame.body.expectedHostGeneration !== this.generation) {
			return this.response(frame, { ok: false, code: "host_identity_conflict" });
		}
		const reason = frame.body.reason;
		if (reason === "auto_update") return this.response(frame, { ok: false, code: "updater_unavailable" });
		if (reason !== "manual_stop" && reason !== "maintenance_restart") return this.response(frame, { ok: false, code: "shutdown_reason_invalid" });
		const targetBuildDigest = isRuntimeDigest(frame.body.targetBuildDigest) ? frame.body.targetBuildDigest : undefined;
		if (reason === "maintenance_restart" && targetBuildDigest === undefined) {
			return this.response(frame, { ok: false, code: "host_restart_target_required" });
		}
		const activeTurnCount = [...this.sessions.values()].filter((session) => session.runtime.controller.inFlight).length;
		let managedProcessCount = 0;
		if (this.options.processPort) {
			for (const session of this.sessions.values()) managedProcessCount += (await this.options.processPort.list(session.runtime.controller.sessionId)).length;
		}
		const activity = evaluateHostShutdownActivity({ activeTurnCount, managedProcessCount, confirmActive: frame.body.confirmActive === true });
		if (!activity.ok) {
			return this.response(frame, activity);
		}
		if (this.options.onShutdown === undefined) return this.response(frame, { ok: false, code: "host_shutdown_unavailable" });
		if (!this.shutdownRequested) {
			this.shutdownRequested = true;
			setTimeout(() => { void this.options.onShutdown?.({ reason, ...(targetBuildDigest === undefined ? {} : { targetBuildDigest }) }).catch(() => undefined); }, 0);
		}
		return this.response(frame, { ok: true, accepted: true, reason });
	}

	private async executeCommand(principal: HostConnectionPrincipal, frame: HostFrameEnvelope): Promise<HostFrameEnvelope> {
		const operation = stringValue(frame.body.operation);
		if (!operation) return this.response(frame, { ok: false, code: "operation_required" });
		try {
			switch (operation) {
			case "session.open": return this.openSession(frame);
				case "session.rebind_workspace": return this.rebindSessionWorkspace(principal, frame);
				case "session.snapshot": return this.sessionSnapshot(frame);
				case "session.subscribe": return this.subscribe(principal, frame);
				case "session.claim_driver": return this.claimSessionDriver(principal, frame);
				case "session.release_driver": return this.releaseSessionDriver(principal, frame);
				case "session.prompt": return this.mutateSession(principal, frame, "prompt");
				case "session.steer": return this.mutateSession(principal, frame, "steer");
				case "session.follow_up": return this.mutateSession(principal, frame, "follow_up");
				case "session.interrupt": return this.mutateSession(principal, frame, "interrupt");
				case "session.clear_queues": return this.mutateSession(principal, frame, "clear_queues");
				case "session.provider_status": return this.providerStatuses(frame);
				case "session.models": return this.models(frame);
				case "session.select_model": return this.selectModel(principal, frame);
				case "session.set_thinking": return this.setThinking(principal, frame);
			case "session.logout": return this.logout(principal, frame);
				case "host.shutdown": return this.requestShutdown(principal, frame);
			case "process.list": return this.processList(frame);
				case "process.output": return this.processOutput(frame);
				case "process.wait": return this.processWait(frame);
				case "process.create": return this.processMutation(principal, frame, "create");
				case "process.write": return this.processMutation(principal, frame, "write");
				case "process.eof": return this.processMutation(principal, frame, "eof");
				case "process.resize": return this.processMutation(principal, frame, "resize");
				case "process.stop": return this.processMutation(principal, frame, "stop");
				case "process.retention_plan": return this.processRetention(frame, "plan");
				case "process.retention_commit": return this.processRetention(principal, frame, "commit");
				case "process.retention_pin": return this.processRetention(principal, frame, "pin");
				case "process.retention_unpin": return this.processRetention(principal, frame, "unpin");
				default: return this.executeDomainCommand(principal, frame);
			}
		} catch (error) {
			return this.response(frame, { ok: false, code: errorCode(error) });
		}
	}

	private async openSession(frame: HostFrameEnvelope): Promise<HostFrameEnvelope> {
		if (!this.admissionOpen) return this.response(frame, { ok: false, code: "host_admission_closed" });
		const mode = stringValue(frame.body.mode) as HostSessionOpenMode | undefined;
		if (!mode || !isOpenMode(mode)) return this.response(frame, { ok: false, code: "invalid_session_open_mode" });
		const requestedSessionId = stringValue(frame.body.sessionId);
		if (requestedSessionId !== undefined) {
			const existing = this.sessions.get(requestedSessionId);
			if (existing) {
				return this.response(frame, {
					ok: true,
					sessionId: requestedSessionId,
						snapshot: snapshotOf(existing.runtime.controller),
						hostGeneration: existing.driver.hostGeneration,
						sessionGeneration: existing.driver.sessionGeneration,
						eventCursor: existing.sequence,
						driverRevision: existing.driver.driverRevision,
				});
			}
		}
		if (requestedSessionId === undefined && (mode === "resume" || mode === "continue_recent")) {
			const requestedCwd = stringValue(frame.body.cwd);
			const resident = [...this.sessions.values()]
				.reverse()
				.find((candidate) => requestedCwd === undefined || candidate.cwd === undefined || candidate.cwd === requestedCwd);
			if (resident) {
				return this.response(frame, {
					ok: true,
					sessionId: resident.runtime.controller.sessionId,
						snapshot: snapshotOf(resident.runtime.controller),
						hostGeneration: resident.driver.hostGeneration,
						sessionGeneration: resident.driver.sessionGeneration,
						eventCursor: resident.sequence,
					driverRevision: resident.driver.driverRevision,
				});
			}
		}
		const thinkingLevel = stringValue(frame.body.thinkingLevel);
		const input: HostSessionOpenRequest = {
			mode,
			...(stringValue(frame.body.sessionId) === undefined ? {} : { sessionId: stringValue(frame.body.sessionId) }),
			...(stringValue(frame.body.sessionPath) === undefined ? {} : { sessionPath: stringValue(frame.body.sessionPath) }),
			...(stringValue(frame.body.cwd) === undefined ? {} : { cwd: stringValue(frame.body.cwd) }),
			...(stringValue(frame.body.provider) === undefined ? {} : { provider: stringValue(frame.body.provider) }),
			...(stringValue(frame.body.model) === undefined ? {} : { model: stringValue(frame.body.model) }),
			...(isThinkingLevel(thinkingLevel) ? { thinkingLevel } : {}),
		};
		const runtime = await this.options.createSession(input);
		const sessionId = runtime.controller.sessionId;
		const existing = this.sessions.get(sessionId);
		if (existing) {
			runtime.controller.dispose();
			await runtime.close();
			return this.response(frame, { ok: true, sessionId, snapshot: snapshotOf(existing.runtime.controller), hostGeneration: existing.driver.hostGeneration, sessionGeneration: existing.driver.sessionGeneration, eventCursor: existing.sequence, driverRevision: existing.driver.driverRevision });
		}
		const sequence = this.options.eventStore === undefined ? 0 : await this.options.eventStore.head(sessionId);
		const domainRevisions = this.options.domainRevisionStore === undefined
			? new Map<string, number>()
			: new Map(await this.options.domainRevisionStore.load(sessionId));
		const state: SessionState = {
			runtime,
			...(runtime.mcp === undefined ? {} : { mcp: runtime.mcp }),
			...(stringValue(frame.body.cwd) === undefined ? {} : { cwd: stringValue(frame.body.cwd) }),
			driver: createDriverState({ hostGeneration: this.generation, sessionGeneration: 1 }),
			sequence,
			history: [],
			eventTail: Promise.resolve(),
			eventUnsubscribe: () => {},
			domainRevisions,
		};
		state.eventUnsubscribe = runtime.controller.subscribe((event) => this.publishAgentEvent(sessionId, event));
		this.sessions.set(sessionId, state);
		return this.response(frame, { ok: true, sessionId, snapshot: snapshotOf(runtime.controller), hostGeneration: state.driver.hostGeneration, sessionGeneration: state.driver.sessionGeneration, eventCursor: state.sequence, driverRevision: state.driver.driverRevision });
	}

	private sessionState(frame: HostFrameEnvelope): SessionState | undefined {
		const sessionId = stringValue(frame.body.sessionId);
		return sessionId === undefined ? undefined : this.sessions.get(sessionId);
	}

	private async rebindSessionWorkspace(principal: HostConnectionPrincipal, frame: HostFrameEnvelope): Promise<HostFrameEnvelope> {
		const state = this.sessionState(frame);
		if (!state) return this.response(frame, { ok: false, code: "session_not_found" });
		const authorization = this.authorizeMutation(principal, frame, state);
		if (!authorization.ok) return this.response(frame, { ok: false, code: authorization.code });
		const resolveWorkspaceCwd = this.options.resolveWorkspaceCwd;
		if (resolveWorkspaceCwd === undefined) return this.response(frame, { ok: false, code: "workspace_rebind_unavailable" });
		return this.serialSession(state, async () => {
			await state.runtime.controller.waitForIdle();
			const sessionId = state.runtime.controller.sessionId;
			const cwd = await resolveWorkspaceCwd(sessionId);
			const sessionGeneration = state.driver.sessionGeneration + 1;
			if (cwd.length === 0) return this.response(frame, { ok: false, code: "workspace_binding_unavailable" });
			state.eventUnsubscribe();
			state.runtime.controller.dispose();
			await state.runtime.close();
			let runtime: HostSessionRuntime;
			try {
				runtime = await this.options.createSession({ mode: "open", sessionId, cwd, sessionGeneration });
			} catch (error) {
				this.sessions.delete(sessionId);
				throw error;
			}
			if (runtime.controller.sessionId !== sessionId) {
				runtime.controller.dispose();
				await runtime.close().catch(() => undefined);
				this.sessions.delete(sessionId);
				throw new Error("workspace rebind changed the session identity");
			}
			state.runtime = runtime;
			state.mcp = runtime.mcp;
			state.cwd = cwd;
			state.driver = createDriverState({
				hostGeneration: this.generation,
				sessionGeneration,
			});
			state.eventUnsubscribe = runtime.controller.subscribe((event) => this.publishAgentEvent(sessionId, event));
			return this.response(frame, {
				ok: true,
				sessionId,
				snapshot: snapshotOf(runtime.controller),
				hostGeneration: state.driver.hostGeneration,
				sessionGeneration: state.driver.sessionGeneration,
				driverRevision: state.driver.driverRevision,
				eventCursor: state.sequence,
				cwdDigest: runtimeDigest(cwd),
			});
		});
	}

	private sessionSnapshot(frame: HostFrameEnvelope): HostFrameEnvelope {
		const state = this.sessionState(frame);
		return state ? this.response(frame, { ok: true, sessionId: state.runtime.controller.sessionId, snapshot: snapshotOf(state.runtime.controller), hostGeneration: state.driver.hostGeneration, sessionGeneration: state.driver.sessionGeneration, eventCursor: state.sequence, driverRevision: state.driver.driverRevision }) : this.response(frame, { ok: false, code: "session_not_found" });
	}

	private async subscribe(principal: HostConnectionPrincipal, frame: HostFrameEnvelope): Promise<HostFrameEnvelope> {
		const state = this.sessionState(frame);
		if (!state) return this.response(frame, { ok: false, code: "session_not_found" });
		return this.serialSession(state, async () => {
			const requestedCursor = frame.body.cursor === undefined ? state.sequence : integerValue(frame.body.cursor);
			if (requestedCursor === undefined || requestedCursor < 0 || requestedCursor > state.sequence) {
				return this.response(frame, { ok: false, code: "subscription_cursor_invalid" });
			}
			let events: readonly HostSubscriptionEvent[];
			if (this.options.eventStore !== undefined) {
				const replay = await this.options.eventStore.readAfter(state.runtime.controller.sessionId, requestedCursor);
				if (!replay.ok) return this.response(frame, { ok: false, code: replay.code, safeCursor: replay.safeCursor });
				state.sequence = replay.head;
				events = replay.events;
			} else {
				const earliest = state.history[0]?.sequence ?? state.sequence + 1;
				if (requestedCursor < earliest - 1) return this.response(frame, { ok: false, code: "resync_required", safeCursor: state.sequence });
				events = state.history.filter((event) => event.sequence > requestedCursor);
				if (events.length > RUNTIME_HOST_BOUNDS.maxConnectionOutbox || Buffer.byteLength(JSON.stringify(events), "utf8") > Math.floor(RUNTIME_HOST_BOUNDS.maxFrameBytes / 2)) {
					return this.response(frame, { ok: false, code: "resync_required", safeCursor: state.sequence });
				}
			}
			const set = this.subscriptions.get(principal.connectionId) ?? new Map<string, HostSubscriptionState>();
			if (!set.has(state.runtime.controller.sessionId) && set.size >= RUNTIME_HOST_BOUNDS.maxSubscriptionsPerPrincipalSession) {
				return this.response(frame, { ok: false, code: "subscription_capacity_exceeded" });
			}
			set.set(state.runtime.controller.sessionId, { ackCursor: requestedCursor, sentCursor: state.sequence });
			this.subscriptions.set(principal.connectionId, set);
			return this.response(frame, { ok: true, sessionId: state.runtime.controller.sessionId, cursor: state.sequence, events, driverRevision: state.driver.driverRevision });
		});
	}

	private claimSessionDriver(principal: HostConnectionPrincipal, frame: HostFrameEnvelope): HostFrameEnvelope {
		const state = this.sessionState(frame);
		if (!state) return this.response(frame, { ok: false, code: "session_not_found" });
		const fence = this.driverFence(principal, frame, state);
		if (!fence) return this.response(frame, { ok: false, code: "driver_fence_required" });
		const result = claimDriver(state.driver, { mode: "claim", ...fence });
		if (!result.ok) return this.response(frame, { ok: false, code: result.code });
		state.driver = result.state;
		void this.dispatchPendingDriverResponses(state.runtime.controller.sessionId);
		return this.response(frame, { ok: true, hostGeneration: state.driver.hostGeneration, sessionGeneration: state.driver.sessionGeneration, driverRevision: state.driver.driverRevision });
	}

	private releaseSessionDriver(principal: HostConnectionPrincipal, frame: HostFrameEnvelope): HostFrameEnvelope {
		const state = this.sessionState(frame);
		if (!state) return this.response(frame, { ok: false, code: "session_not_found" });
		const fence = this.driverFence(principal, frame, state);
		if (!fence) return this.response(frame, { ok: false, code: "driver_fence_required" });
		const result = releaseDriver(state.driver, fence);
		if (!result.ok) return this.response(frame, { ok: false, code: result.code });
		state.driver = result.state;
		return this.response(frame, { ok: true, driverRevision: state.driver.driverRevision });
	}

	private async mutateSession(
		principal: HostConnectionPrincipal,
		frame: HostFrameEnvelope,
		operation: "prompt" | "steer" | "follow_up" | "interrupt" | "clear_queues",
	): Promise<HostFrameEnvelope> {
		const state = this.sessionState(frame);
		if (!state) return this.response(frame, { ok: false, code: "session_not_found" });
		const authorization = this.authorizeMutation(principal, frame, state);
		if (!authorization.ok) return this.response(frame, { ok: false, code: authorization.code });
		const controller = state.runtime.controller;
		if (operation === "prompt" || operation === "steer" || operation === "follow_up") {
			const text = stringValue(frame.body.text);
			if (!text) return this.response(frame, { ok: false, code: "prompt_text_required" });
			await controller.prompt(text, operation === "steer" ? "steer" : operation === "follow_up" ? "followUp" : undefined);
		} else if (operation === "interrupt") {
			controller.interrupt();
		} else {
			controller.clearAllQueues();
		}
		return this.response(frame, { ok: true, driverRevision: state.driver.driverRevision });
	}

	private async providerStatuses(frame: HostFrameEnvelope): Promise<HostFrameEnvelope> {
		const state = this.sessionState(frame);
		return state ? this.response(frame, { ok: true, providers: await state.runtime.controller.getProviderStatuses() }) : this.response(frame, { ok: false, code: "session_not_found" });
	}

	private async models(frame: HostFrameEnvelope): Promise<HostFrameEnvelope> {
		const state = this.sessionState(frame);
		if (!state) return this.response(frame, { ok: false, code: "session_not_found" });
		const provider = stringValue(frame.body.provider);
		return this.response(frame, { ok: true, models: await state.runtime.controller.getAvailableModels(provider) });
	}

	private async selectModel(principal: HostConnectionPrincipal, frame: HostFrameEnvelope): Promise<HostFrameEnvelope> {
		const state = this.sessionState(frame);
		if (!state) return this.response(frame, { ok: false, code: "session_not_found" });
		const authorization = this.authorizeMutation(principal, frame, state);
		if (!authorization.ok) return this.response(frame, { ok: false, code: authorization.code });
		const provider = stringValue(frame.body.provider);
		const modelId = stringValue(frame.body.model);
		if (!provider || !modelId) return this.response(frame, { ok: false, code: "model_required" });
		const model = (await state.runtime.controller.getAvailableModels(provider)).find((candidate) => candidate.id === modelId);
		if (!model) return this.response(frame, { ok: false, code: "model_not_found" });
		await state.runtime.controller.selectModel(model);
		return this.response(frame, { ok: true, selection: state.runtime.controller.currentSelection, driverRevision: state.driver.driverRevision });
	}

	private async setThinking(principal: HostConnectionPrincipal, frame: HostFrameEnvelope): Promise<HostFrameEnvelope> {
		const state = this.sessionState(frame);
		if (!state) return this.response(frame, { ok: false, code: "session_not_found" });
		const authorization = this.authorizeMutation(principal, frame, state);
		if (!authorization.ok) return this.response(frame, { ok: false, code: authorization.code });
		const level = stringValue(frame.body.level);
		if (!isThinkingLevel(level)) return this.response(frame, { ok: false, code: "thinking_level_invalid" });
		const selected = await state.runtime.controller.setThinkingLevel(level);
		return this.response(frame, { ok: true, level: selected, selection: state.runtime.controller.currentSelection, driverRevision: state.driver.driverRevision });
	}

	private async logout(principal: HostConnectionPrincipal, frame: HostFrameEnvelope): Promise<HostFrameEnvelope> {
		const state = this.sessionState(frame);
		if (!state) return this.response(frame, { ok: false, code: "session_not_found" });
		const authorization = this.authorizeMutation(principal, frame, state);
		if (!authorization.ok) return this.response(frame, { ok: false, code: authorization.code });
		const providerId = stringValue(frame.body.providerId);
		if (!providerId) return this.response(frame, { ok: false, code: "provider_required" });
		await state.runtime.controller.logout(providerId);
		return this.response(frame, { ok: true });
	}

	private requestShutdown(principal: HostConnectionPrincipal, frame: HostFrameEnvelope): HostFrameEnvelope {
		if (this.options.onShutdown === undefined) return this.response(frame, { ok: false, code: "host_shutdown_unavailable" });
		const state = this.sessionState(frame);
		if (!state) return this.response(frame, { ok: false, code: "session_not_found" });
		const authorization = this.authorizeMutation(principal, frame, state);
		if (!authorization.ok) return this.response(frame, { ok: false, code: authorization.code });
		if (this.shutdownRequested) return this.response(frame, { ok: true, accepted: true });
		this.shutdownRequested = true;
		// Let the command response enter the transport outbox before lifecycle
		// release closes the listener and its connections.
		setTimeout(() => { void this.options.onShutdown?.({ reason: "manual_stop" }).catch(() => undefined); }, 0);
		return this.response(frame, { ok: true, accepted: true });
	}

	private async processList(frame: HostFrameEnvelope): Promise<HostFrameEnvelope> {
		const port = this.options.processPort;
		const sessionId = stringValue(frame.body.sessionId);
		if (!port || !sessionId) return this.response(frame, { ok: false, code: !port ? "process_unavailable" : "session_required" });
		return this.response(frame, { ok: true, processes: await port.list(sessionId) });
	}

	private async processOutput(frame: HostFrameEnvelope): Promise<HostFrameEnvelope> {
		const port = this.options.processPort;
		const sessionId = stringValue(frame.body.sessionId);
		const executionId = stringValue(frame.body.executionId);
		const cursor = frame.body.cursor === undefined ? { sequence: 0, byteOffset: 0 } : outputCursorValue(frame.body.cursor);
		const maxBytes = frame.body.maxBytes === undefined ? RUNTIME_HOST_BOUNDS.maxOutputPageBytes : integerValue(frame.body.maxBytes);
		if (!port || !sessionId || !executionId) return this.response(frame, { ok: false, code: !port ? "process_unavailable" : "process_reference_required" });
		if (cursor === undefined || maxBytes === undefined || maxBytes < 0 || maxBytes > RUNTIME_HOST_BOUNDS.maxOutputPageBytes) {
			return this.response(frame, { ok: false, code: "output_cursor_invalid" });
		}
		const result = await port.output(sessionId, executionId, cursor, maxBytes);
		return this.response(frame, result.ok === false ? result : { ok: true, ...result });
	}

	private async processWait(frame: HostFrameEnvelope): Promise<HostFrameEnvelope> {
		const port = this.options.processPort;
		const sessionId = stringValue(frame.body.sessionId);
		const executionId = stringValue(frame.body.executionId);
		const timeoutMs = integerValue(frame.body.timeoutMs);
		if (!port || !sessionId || !executionId) return this.response(frame, { ok: false, code: !port ? "process_unavailable" : "process_reference_required" });
		if (timeoutMs === undefined || timeoutMs < 1 || timeoutMs > RUNTIME_HOST_BOUNDS.maxWaitMs) {
			return this.response(frame, { ok: false, code: "invalid_timeout" });
		}
		return this.response(frame, { ok: true, ...(await port.wait(sessionId, executionId, timeoutMs, "observer")) });
	}

	private async processMutation(
		principal: HostConnectionPrincipal,
		frame: HostFrameEnvelope,
		operation: "create" | "write" | "eof" | "resize" | "stop",
	): Promise<HostFrameEnvelope> {
		const port = this.options.processPort;
		const sessionId = stringValue(frame.body.sessionId);
		if (!port || !sessionId) return this.response(frame, { ok: false, code: !port ? "process_unavailable" : "session_required" });
		const state = this.sessions.get(sessionId);
		if (!state) return this.response(frame, { ok: false, code: "session_not_found" });
		if (operation === "create" && !this.admissionOpen) return this.response(frame, { ok: false, code: "host_admission_closed" });
		const authorization = this.authorizeMutation(principal, frame, state);
		if (!authorization.ok) return this.response(frame, { ok: false, code: authorization.code });
		let result: Record<string, unknown>;
		if (operation === "create") {
			const command = stringValue(frame.body.command);
			const cwd = stringValue(frame.body.cwd);
			const backend = stringValue(frame.body.backend);
			if (!command || !cwd || (backend !== "pipe" && backend !== "pty")) return this.response(frame, { ok: false, code: "process_request_invalid" });
			result = await port.create({
				sessionId,
				commandId: stringValue(frame.body.commandId),
				sessionGeneration: state.driver.sessionGeneration,
				command,
				cwd,
				timeoutMs: integerValue(frame.body.timeoutMs) ?? 60_000,
				...(stringValue(frame.body.stdin) === undefined ? {} : { stdin: stringValue(frame.body.stdin) }),
				backend,
					executionMode: stringValue(frame.body.executionMode) === "foreground" ? "foreground" : "background",
					principalId: principal.principalId,
					...(containmentValue(frame.body.containment) === undefined ? {} : { containment: containmentValue(frame.body.containment) }),
				});
		} else {
			const executionId = stringValue(frame.body.executionId);
			if (!executionId) return this.response(frame, { ok: false, code: "process_reference_required" });
			if (operation === "write") result = await port.write(sessionId, executionId, "driver", stringValue(frame.body.input) ?? "");
			else if (operation === "eof") result = await port.eof(sessionId, executionId, "driver");
			else if (operation === "resize") result = await port.resize(sessionId, executionId, "driver", integerValue(frame.body.columns) ?? 0, integerValue(frame.body.rows) ?? 0);
			else result = await port.stop(sessionId, executionId, "driver", stringValue(frame.body.signal) as NodeJS.Signals | undefined);
		}
		return this.response(frame, result);
	}

	private async processRetention(
		principalOrFrame: HostConnectionPrincipal | HostFrameEnvelope,
		frameOrOperation: HostFrameEnvelope | "plan" | "commit" | "pin" | "unpin",
		maybeOperation?: "plan" | "commit" | "pin" | "unpin",
	): Promise<HostFrameEnvelope> {
		const isQuery = typeof frameOrOperation === "string";
		const frame = (isQuery ? principalOrFrame : frameOrOperation) as HostFrameEnvelope;
		const principal = isQuery ? undefined : principalOrFrame as HostConnectionPrincipal;
		const operation = (isQuery ? frameOrOperation : maybeOperation) as "plan" | "commit" | "pin" | "unpin";
		const port = this.options.processPort;
		const sessionId = stringValue(frame.body.sessionId);
		const executionId = stringValue(frame.body.executionId);
		if (!port || !sessionId || !executionId) return this.response(frame, { ok: false, code: !port ? "process_unavailable" : "process_reference_required" });
		if (operation !== "plan") {
			const state = this.sessions.get(sessionId);
			if (!state || principal === undefined) return this.response(frame, { ok: false, code: "session_not_found" });
			const authorization = this.authorizeMutation(principal, frame, state);
			if (!authorization.ok) return this.response(frame, { ok: false, code: authorization.code });
		}
		if (operation === "plan") {
			const cursor = outputCursorValue(frame.body.cursor);
			if (!cursor || !port.planRetention) return this.response(frame, { ok: false, code: !cursor ? "output_cursor_invalid" : "process_retention_unavailable" });
			return this.response(frame, await port.planRetention(sessionId, executionId, cursor));
		}
		if (operation === "commit") {
			if (!port.commitRetention || frame.body.plan === undefined) return this.response(frame, { ok: false, code: "process_retention_request_invalid" });
			return this.response(frame, await port.commitRetention(sessionId, executionId, frame.body.plan));
		}
		if (operation === "pin") {
			const pinId = stringValue(frame.body.pinId);
			const cursor = outputCursorValue(frame.body.cursor);
			if (!pinId || !cursor || !port.pinOutput) return this.response(frame, { ok: false, code: !pinId || !cursor ? "process_retention_request_invalid" : "process_retention_unavailable" });
			return this.response(frame, await port.pinOutput(sessionId, executionId, pinId, cursor));
		}
		const pinId = stringValue(frame.body.pinId);
		if (!pinId || !port.unpinOutput) return this.response(frame, { ok: false, code: !pinId ? "process_retention_request_invalid" : "process_retention_unavailable" });
		return this.response(frame, await port.unpinOutput(sessionId, executionId, pinId));
	}

	private async executeDomainQuery(principal: HostConnectionPrincipal, frame: HostFrameEnvelope): Promise<HostFrameEnvelope> {
		const response = await this.executeDomainCommand(principal, frame, false);
		return { ...response, kind: "query_result", body: { ...response.body, requestFrameId: frame.frameId } };
	}

	private async executeDomainCommand(
		principal: HostConnectionPrincipal,
		frame: HostFrameEnvelope,
		allowMutation = true,
	): Promise<HostFrameEnvelope> {
		const operation = stringValue(frame.body.operation);
		if (operation === undefined) return this.response(frame, { ok: false, code: "operation_required" });
		const matches = (this.options.domainPorts ?? []).filter((port) =>
			port.queryOperations?.has(operation) === true || port.mutationOperations?.has(operation) === true,
		);
		if (matches.length === 0) return this.response(frame, { ok: false, code: "unsupported_operation" });
		if (matches.length > 1) return this.response(frame, { ok: false, code: "domain_operation_conflict" });
		const port = matches[0]!;
		const mutation = port.mutationOperations?.has(operation) === true;
		if (port.queryOperations?.has(operation) === true && mutation) return this.response(frame, { ok: false, code: "domain_operation_conflict" });
		if (mutation && !allowMutation) return this.response(frame, { ok: false, code: "query_mutation_forbidden" });
		const state = this.sessionState(frame);
		if (!state) return this.response(frame, { ok: false, code: "session_not_found" });
		const authorization = mutation ? this.authorizeMutation(principal, frame, state) : { ok: true as const };
		if (!authorization.ok) return this.response(frame, { ok: false, code: authorization.code });
		const key = `${port.name}:${state.runtime.controller.sessionId}`;
		const domainRevision = state.domainRevisions.get(key) ?? 0;
		if (mutation) {
			const expectedDomainRevision = integerValue(frame.body.expectedDomainRevision);
			if (expectedDomainRevision === undefined) return this.response(frame, { ok: false, code: "domain_revision_required", domainRevision });
			if (expectedDomainRevision !== domainRevision) return this.response(frame, { ok: false, code: "stale_domain_revision", domainRevision });
		}
		let result: HostRuntimeDomainResult;
		try {
			result = await port.execute({
				principal,
				frame,
				operation,
				mutation,
				sessionId: state.runtime.controller.sessionId,
				controller: state.runtime.controller,
				hostGeneration: state.driver.hostGeneration,
				sessionGeneration: state.driver.sessionGeneration,
				driverRevision: state.driver.driverRevision,
				domainRevision,
				...(state.mcp === undefined ? {} : { mcp: state.mcp }),
			});
		} catch {
			return this.response(frame, { ok: false, code: "uncertain_outcome" });
		}
		if (!result.ok) return this.response(frame, { ok: false, ...(result.body ?? { code: "domain_command_rejected" }) });
		let receipts: readonly string[];
		let nextDomainRevision: number;
		try {
			receipts = await this.appendDomainEvents(result.events ?? []);
			const changed = result.mutated ?? mutation;
			nextDomainRevision = changed ? domainRevision + 1 : domainRevision;
			if (changed) {
				const nextRevisions = new Map(state.domainRevisions);
				nextRevisions.set(key, nextDomainRevision);
				await this.options.domainRevisionStore?.save(state.runtime.controller.sessionId, nextRevisions);
				state.domainRevisions.set(key, nextDomainRevision);
			}
		} catch {
			// The domain adapter may already have changed durable or external state,
			// and an event/revision write may have committed only a prefix.  The
			// command receipt therefore becomes the single retry fence: callers must
			// reconcile the uncertain outcome instead of executing the command again.
			return this.response(frame, { ok: false, code: "uncertain_outcome" });
		}
		return this.response(frame, {
			ok: true,
			...(result.body ?? {}),
			domainRevision: nextDomainRevision,
			...(receipts.length === 0 ? {} : { eventReceipts: receipts }),
			driverRevision: state.driver.driverRevision,
		});
	}

	private async appendDomainEvents(events: readonly RuntimeEventAppendInput[]): Promise<readonly string[]> {
		if (events.length === 0) return [];
		const writer = this.options.runtimeEventWriter;
		if (writer === undefined) throw new Error("canonical Runtime event writer is required for domain events");
		const receipts: string[] = [];
		for (const event of events) receipts.push((await writer.append(event)).receipt.receiptId);
		return receipts;
	}

	private authorizeMutation(principal: HostConnectionPrincipal, frame: HostFrameEnvelope, state: SessionState) {
		const fence = this.driverFence(principal, frame, state);
		return fence === undefined
			? { ok: false as const, code: "driver_fence_required" as const }
			: authorizeDriverMutation(state.driver, fence);
	}

	private driverFence(principal: HostConnectionPrincipal, frame: HostFrameEnvelope, _state: SessionState) {
		const expectedHostGeneration = integerValue(frame.body.expectedHostGeneration);
		const expectedSessionGeneration = integerValue(frame.body.expectedSessionGeneration);
		const expectedDriverRevision = integerValue(frame.body.expectedDriverRevision);
		if (expectedHostGeneration === undefined || expectedSessionGeneration === undefined || expectedDriverRevision === undefined) return undefined;
		return {
			principalId: principal.principalId,
			connectionId: principal.connectionId,
			expectedHostGeneration,
			expectedSessionGeneration,
			expectedDriverRevision,
		};
	}

	private publishAgentEvent(sessionId: string, event: AgentEvent): Promise<void> {
		const state = this.sessions.get(sessionId);
		if (!state) return Promise.resolve();
		return this.serialSession(state, async () => {
			let body: HostSubscriptionEvent | StoredHostEvent;
			if (this.options.eventStore !== undefined) {
				body = await this.options.eventStore.append(sessionId, event);
				state.sequence = body.sequence;
			} else {
				state.sequence += 1;
				body = { sessionId, eventId: createRuntimeId("event", `${sessionId}-${state.sequence}`), sequence: state.sequence, eventType: event.type, event };
				state.history.push(body);
				while (state.history.length > RUNTIME_HOST_BOUNDS.maxSubscriptionReplay) state.history.shift();
			}
			for (const [connectionId, subscriptions] of this.subscriptions) {
				const subscription = subscriptions.get(sessionId);
				if (!subscription) continue;
				if (body.sequence - subscription.ackCursor > RUNTIME_HOST_BOUNDS.maxAckWindow) {
					this.server.sendToConnection(connectionId, {
						frameId: `resync_${sessionId}_${body.sequence}`,
						kind: "resync_required",
						protocolVersion: 1,
						body: { sessionId, safeCursor: body.sequence },
					});
					subscriptions.delete(sessionId);
					continue;
				}
				if (this.server.sendToConnection(connectionId, { frameId: body.eventId, kind: "subscription_event", protocolVersion: 1, body: { ...body } })) {
					subscription.sentCursor = body.sequence;
				}
			}
		});
	}

	private ackCursor(principal: HostConnectionPrincipal, frame: HostFrameEnvelope): void {
		const sessionId = stringValue(frame.body.sessionId);
		const cursor = integerValue(frame.body.cursor);
		if (!sessionId || cursor === undefined || cursor < 0) return;
		const subscription = this.subscriptions.get(principal.connectionId)?.get(sessionId);
		if (!subscription) return;
		if (cursor < subscription.ackCursor || cursor > subscription.sentCursor) {
			this.server.sendToConnection(principal.connectionId, {
				frameId: `resync_${sessionId}_${subscription.sentCursor}`,
				kind: "resync_required",
				protocolVersion: 1,
				body: { sessionId, safeCursor: subscription.sentCursor },
			});
			return;
		}
		subscription.ackCursor = cursor;
	}

	private serialSession<T>(state: SessionState, operation: () => Promise<T>): Promise<T> {
		const result = state.eventTail.then(operation);
		state.eventTail = result.then(() => undefined, () => undefined);
		return result;
	}

	private async handleConnectionClosed(connectionId: string): Promise<void> {
		this.subscriptions.delete(connectionId);
		for (const state of this.sessions.values()) {
			if (state.driver.driver?.connectionId !== connectionId) continue;
			state.driver = {
				...state.driver,
				 driver: undefined,
				 driverRevision: state.driver.driverRevision + 1,
			};
		}
		for (const pending of this.reverseRequests.values()) {
			if (pending.connectionId === connectionId) {
				pending.connectionId = undefined;
				pending.deliveryFrameId = undefined;
			}
		}
		await this.options.onConnectionClosed?.(connectionId);
	}

	private async dispatchPendingDriverResponses(sessionId: string): Promise<void> {
		for (const pending of this.reverseRequests.values()) {
			if (pending.sessionId === sessionId) await this.dispatchDriverResponse(pending);
		}
	}

	private async dispatchDriverResponse(pending: PendingHostDriverResponse): Promise<void> {
		if (this.reverseRequests.get(pending.requestId) !== pending) return;
		const state = this.sessions.get(pending.sessionId);
		const driver = state?.driver.driver;
		if (!state || !driver || pending.connectionId !== undefined) return;
		const remaining = pending.deadline - Date.now();
		if (remaining <= 0) return;
		pending.deliveryCount += 1;
		const deliveryFrameId = `${pending.requestId}_d${pending.deliveryCount}`;
		pending.connectionId = driver.connectionId;
		pending.deliveryFrameId = deliveryFrameId;
		try {
			const response = await this.server.requestToConnection(driver.connectionId, {
				frameId: deliveryFrameId,
				kind: "reverse_request",
				protocolVersion: 1,
				body: { ...pending.body, requestId: pending.requestId },
			}, Math.min(remaining, RUNTIME_HOST_BOUNDS.maxWaitMs));
			if (this.reverseRequests.get(pending.requestId) !== pending || pending.deliveryFrameId !== deliveryFrameId) return;
			const currentDriver = this.sessions.get(pending.sessionId)?.driver.driver;
			if (!currentDriver || currentDriver.connectionId !== driver.connectionId) return;
			clearTimeout(pending.timeoutId);
			pending.removeAbortListener?.();
			this.reverseRequests.delete(pending.requestId);
			const { requestFrameId: _requestFrameId, ...body } = response.body;
			pending.resolve({ body, principalId: driver.principalId });
		} catch {
			if (this.reverseRequests.get(pending.requestId) !== pending) return;
			if (pending.connectionId === driver.connectionId) {
				pending.connectionId = undefined;
				pending.deliveryFrameId = undefined;
			}
		}
	}

	private rejectReverseRequests(error: Error): void {
		for (const pending of this.reverseRequests.values()) {
			clearTimeout(pending.timeoutId);
			pending.removeAbortListener?.();
			pending.reject(error);
		}
		this.reverseRequests.clear();
	}

	private response(frame: HostFrameEnvelope, body: Record<string, unknown>): HostFrameEnvelope {
		return {
			frameId: `response_${frame.frameId}`,
			kind: "command_result",
			protocolVersion: 1,
			body: { requestFrameId: frame.frameId, ...body },
		};
	}

	private rebindResponse(prior: HostFrameEnvelope, frame: HostFrameEnvelope): HostFrameEnvelope {
		return {
			...prior,
			frameId: `response_${frame.frameId}`,
			body: { ...prior.body, requestFrameId: frame.frameId },
		};
	}
}

function snapshotOf(controller: InteractiveSessionControllerPort): HostSessionSnapshot {
	return {
		sessionId: controller.sessionId,
		selection: controller.currentSelection,
		messages: controller.messages,
		warnings: controller.warnings,
		auditEntries: controller.auditEntries,
		toolCount: controller.toolCount,
	};
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function integerValue(value: unknown): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
}

function outputCursorValue(value: unknown): OutputCursor | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	const sequence = integerValue(record.sequence);
	const byteOffset = integerValue(record.byteOffset);
	return sequence !== undefined && sequence >= 0 && byteOffset !== undefined && byteOffset >= 0
		? { sequence, byteOffset }
		: undefined;
}

function isOpenMode(value: HostSessionOpenMode): boolean {
	return value === "create" || value === "open" || value === "continue_recent" || value === "resume" || value === "fork";
}

function isThinkingLevel(value: string | undefined): value is ModelThinkingLevel {
	return value === "off" || value === "minimal" || value === "low" || value === "medium" || value === "high" || value === "xhigh" || value === "max";
}

function containmentValue(value: unknown): HostProcessCreateInput["containment"] {
	return value === "none" || value === "process_group" || value === "supervisor" ? value : undefined;
}

function errorCode(error: unknown): string {
	return error instanceof Error && error.message.length > 0 ? error.message : "host_command_failed";
}

function isRuntimeDigest(value: unknown): value is RuntimeDigest {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const digest = value as Record<string, unknown>;
	return digest.algorithm === "sha256" && typeof digest.digest === "string" && /^[a-f0-9]{64}$/u.test(digest.digest);
}
