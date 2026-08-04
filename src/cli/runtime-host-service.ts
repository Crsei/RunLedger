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
import { runtimeDigest } from "../runtime/protocol/foundation.ts";
import type { HostEndpointRecord } from "../storage/host/endpoint-store.ts";
import type { ExecutionHandleRef } from "../runtime/process/types.ts";
import type { OutputCursor } from "../runtime/process/output.ts";
import type { ControlPlaneActor } from "../storage/process/control-plane.ts";

export type HostSessionOpenMode = "create" | "open" | "continue_recent" | "resume" | "fork";

export interface HostSessionOpenRequest {
	readonly mode: HostSessionOpenMode;
	readonly sessionId?: string;
	readonly sessionPath?: string;
	readonly cwd?: string;
	readonly provider?: string;
	readonly model?: string;
	readonly thinkingLevel?: ModelThinkingLevel;
}

export interface HostSessionRuntime {
	readonly controller: InteractiveSessionControllerPort;
	close(): Promise<void>;
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
	readonly createSession: (input: HostSessionOpenRequest) => Promise<HostSessionRuntime>;
	readonly processPort?: HostProcessPort;
	/** Explicit management shutdown; client detach never invokes this callback. */
	readonly onShutdown?: () => Promise<void>;
	readonly onEndpoint?: (endpoint: HostEndpointRecord) => Promise<void>;
	readonly onConnectionClosed?: (connectionId: string) => Promise<void>;
}

interface SessionState {
	readonly runtime: HostSessionRuntime;
	readonly cwd?: string;
	driver: DriverState;
	sequence: number;
	eventUnsubscribe: () => void;
}

interface CommandResult {
	readonly requestDigest: string;
	readonly response: HostFrameEnvelope;
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
	private readonly subscriptions = new Map<string, Set<string>>();
	private readonly commandResults = new Map<string, CommandResult>();
	private endpoint: HostEndpointRecord | undefined;
	private started = false;
	private admissionOpen = true;
	private closing: Promise<void> | undefined;
	private shutdownRequested = false;

	public constructor(options: ResidentRuntimeHostOptions) {
		this.options = options;
		this.runtimeId = options.hostRuntimeId ?? createRuntimeId("runtime", `host-${process.pid}-${Date.now()}`);
		this.generation = options.hostGeneration ?? 1;
		if (!Number.isSafeInteger(this.generation) || this.generation < 0) throw new Error("hostGeneration must be a non-negative safe integer");
		this.server = new JsonLineHostServer({
			socketPath: options.socketPath,
			scope: options.scope,
			attestor: options.attestor,
			handleFrame: (context) => this.handleFrame(context),
			onConnectionClosed: (connectionId) => this.handleConnectionClosed(connectionId),
		});
	}

	public async start(): Promise<HostEndpointRecord> {
		if (this.started && this.endpoint) return this.endpoint;
		this.endpoint = {
			protocolVersion: 1,
			workspaceStorageKey: this.options.scope.workspaceStorageKey,
			hostRuntimeId: this.runtimeId,
			hostGeneration: this.generation,
			state: "starting",
			compatibilityDigest: this.options.scope.compatibilityDigest,
		};
		this.admissionOpen = true;
		await this.options.onEndpoint?.(this.endpoint);
		await this.server.listen();
		this.endpoint = { ...this.endpoint, state: "ready" };
		await this.options.onEndpoint?.(this.endpoint);
		this.started = true;
		return this.endpoint;
	}

	public endpointRecord(): HostEndpointRecord | undefined {
		return this.endpoint;
	}

	/** R10: block new session/process admission while the resident Host drains. */
	public async closeAdmission(): Promise<void> {
		this.admissionOpen = false;
		if (this.endpoint && this.endpoint.state === "ready") {
			this.endpoint = { ...this.endpoint, state: "draining" };
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
		if (this.endpoint) {
			this.endpoint = { ...this.endpoint, state: "draining" };
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
		if (context.frame.kind !== "command_request") {
			return [this.response(context.frame, { ok: false, code: "unsupported_frame" })];
		}
		const commandId = stringValue(context.frame.body.commandId) ?? context.frame.frameId;
		const commandKey = `${context.principal.principalId}:${commandId}`;
		const requestDigest = runtimeDigest(context.frame.body).digest;
		const prior = this.commandResults.get(commandKey);
		if (prior) {
			if (prior.requestDigest !== requestDigest) return [this.response(context.frame, { ok: false, code: "command_id_conflict" })];
			return [this.rebindResponse(prior.response, context.frame)];
		}
		const response = await this.executeCommand(context.principal, context.frame);
		this.commandResults.set(commandKey, { requestDigest, response });
		return [response];
	}

	private async executeCommand(principal: HostConnectionPrincipal, frame: HostFrameEnvelope): Promise<HostFrameEnvelope> {
		const operation = stringValue(frame.body.operation);
		if (!operation) return this.response(frame, { ok: false, code: "operation_required" });
		try {
			switch (operation) {
				case "session.open": return this.openSession(frame);
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
			case "host.shutdown": return this.requestShutdown(frame);
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
				default: return this.response(frame, { ok: false, code: "unsupported_operation" });
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
			return this.response(frame, { ok: true, sessionId, snapshot: snapshotOf(existing.runtime.controller), driverRevision: existing.driver.driverRevision });
		}
		const state: SessionState = {
			runtime,
			...(stringValue(frame.body.cwd) === undefined ? {} : { cwd: stringValue(frame.body.cwd) }),
			driver: createDriverState({ hostGeneration: this.generation, sessionGeneration: 1 }),
			sequence: 0,
			eventUnsubscribe: () => {},
		};
		state.eventUnsubscribe = runtime.controller.subscribe((event) => this.publishAgentEvent(sessionId, event));
		this.sessions.set(sessionId, state);
		return this.response(frame, { ok: true, sessionId, snapshot: snapshotOf(runtime.controller), driverRevision: state.driver.driverRevision });
	}

	private sessionState(frame: HostFrameEnvelope): SessionState | undefined {
		const sessionId = stringValue(frame.body.sessionId);
		return sessionId === undefined ? undefined : this.sessions.get(sessionId);
	}

	private sessionSnapshot(frame: HostFrameEnvelope): HostFrameEnvelope {
		const state = this.sessionState(frame);
		return state ? this.response(frame, { ok: true, sessionId: state.runtime.controller.sessionId, snapshot: snapshotOf(state.runtime.controller), driverRevision: state.driver.driverRevision }) : this.response(frame, { ok: false, code: "session_not_found" });
	}

	private subscribe(principal: HostConnectionPrincipal, frame: HostFrameEnvelope): HostFrameEnvelope {
		const state = this.sessionState(frame);
		if (!state) return this.response(frame, { ok: false, code: "session_not_found" });
		const set = this.subscriptions.get(principal.connectionId) ?? new Set<string>();
		set.add(state.runtime.controller.sessionId);
		this.subscriptions.set(principal.connectionId, set);
		return this.response(frame, { ok: true, sessionId: state.runtime.controller.sessionId, driverRevision: state.driver.driverRevision });
	}

	private claimSessionDriver(principal: HostConnectionPrincipal, frame: HostFrameEnvelope): HostFrameEnvelope {
		const state = this.sessionState(frame);
		if (!state) return this.response(frame, { ok: false, code: "session_not_found" });
		const result = claimDriver(state.driver, {
			mode: "claim",
			principalId: principal.principalId,
			connectionId: principal.connectionId,
			expectedHostGeneration: state.driver.hostGeneration,
			expectedSessionGeneration: state.driver.sessionGeneration,
			expectedDriverRevision: integerValue(frame.body.expectedDriverRevision) ?? state.driver.driverRevision,
		});
		if (!result.ok) return this.response(frame, { ok: false, code: result.code });
		state.driver = result.state;
		return this.response(frame, { ok: true, driverRevision: state.driver.driverRevision });
	}

	private releaseSessionDriver(principal: HostConnectionPrincipal, frame: HostFrameEnvelope): HostFrameEnvelope {
		const state = this.sessionState(frame);
		if (!state) return this.response(frame, { ok: false, code: "session_not_found" });
		const result = releaseDriver(state.driver, this.driverFence(principal, frame, state));
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
		const authorization = authorizeDriverMutation(state.driver, this.driverFence(principal, frame, state));
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
		const authorization = authorizeDriverMutation(state.driver, this.driverFence(principal, frame, state));
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
		const authorization = authorizeDriverMutation(state.driver, this.driverFence(principal, frame, state));
		if (!authorization.ok) return this.response(frame, { ok: false, code: authorization.code });
		const level = stringValue(frame.body.level);
		if (!isThinkingLevel(level)) return this.response(frame, { ok: false, code: "thinking_level_invalid" });
		const selected = await state.runtime.controller.setThinkingLevel(level);
		return this.response(frame, { ok: true, level: selected, selection: state.runtime.controller.currentSelection, driverRevision: state.driver.driverRevision });
	}

	private async logout(principal: HostConnectionPrincipal, frame: HostFrameEnvelope): Promise<HostFrameEnvelope> {
		const state = this.sessionState(frame);
		if (!state) return this.response(frame, { ok: false, code: "session_not_found" });
		const authorization = authorizeDriverMutation(state.driver, this.driverFence(principal, frame, state));
		if (!authorization.ok) return this.response(frame, { ok: false, code: authorization.code });
		const providerId = stringValue(frame.body.providerId);
		if (!providerId) return this.response(frame, { ok: false, code: "provider_required" });
		await state.runtime.controller.logout(providerId);
		return this.response(frame, { ok: true });
	}

	private requestShutdown(frame: HostFrameEnvelope): HostFrameEnvelope {
		if (this.options.onShutdown === undefined) return this.response(frame, { ok: false, code: "host_shutdown_unavailable" });
		if (this.shutdownRequested) return this.response(frame, { ok: true, accepted: true });
		this.shutdownRequested = true;
		// Let the command response enter the transport outbox before lifecycle
		// release closes the listener and its connections.
		setTimeout(() => { void this.options.onShutdown?.().catch(() => undefined); }, 0);
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
		const authorization = authorizeDriverMutation(state.driver, this.driverFence(principal, frame, state));
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
			const authorization = authorizeDriverMutation(state.driver, this.driverFence(principal, frame, state));
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

	private driverFence(principal: HostConnectionPrincipal, frame: HostFrameEnvelope, state: SessionState) {
		return {
			principalId: principal.principalId,
			connectionId: principal.connectionId,
			expectedHostGeneration: integerValue(frame.body.expectedHostGeneration) ?? state.driver.hostGeneration,
			expectedSessionGeneration: integerValue(frame.body.expectedSessionGeneration) ?? state.driver.sessionGeneration,
			expectedDriverRevision: integerValue(frame.body.expectedDriverRevision) ?? state.driver.driverRevision,
		};
	}

	private publishAgentEvent(sessionId: string, event: AgentEvent): void {
		const state = this.sessions.get(sessionId);
		if (!state) return;
		state.sequence += 1;
		const eventId = createRuntimeId("event", `${sessionId}-${state.sequence}`);
		const body = {
			sessionId,
			eventId,
			sequence: state.sequence,
			eventType: event.type,
			event,
		};
		for (const [connectionId, subscriptions] of this.subscriptions) {
			if (!subscriptions.has(sessionId)) continue;
			this.server.sendToConnection(connectionId, {
				frameId: eventId,
				kind: "subscription_event",
				protocolVersion: 1,
				body,
			});
		}
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
		await this.options.onConnectionClosed?.(connectionId);
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
