/** MCP server 状态机、并发启动、required gate、调用与可靠关闭。 */

import { canonicalDigest } from "../../runtime/protocol/v3/canonical-json.ts";
import type { ExtensionSpillPort } from "../types.ts";
import { McpToolCatalog } from "./tool-catalog.ts";
import { normalizeMcpResult } from "./result-normalizer.ts";
import type {
	McpClientFactoryPort,
	McpClientPort,
	McpDoctorResult,
	McpNormalizedResult,
	McpServerDescriptor,
	McpServerState,
	McpServerStatus,
	McpToolDefinition,
} from "./types.ts";

export interface McpStateEventSinkPort {
	record(input: { server: McpServerDescriptor; serverId: string; oldState: McpServerState; newState: McpServerState; reason?: string; generation: number; occurredAt: string }): Promise<boolean>;
	recordTool(input: { server: McpServerDescriptor; tool: McpToolDefinition; serverId: string; toolName: string; runtimeName: string; inputDigest: string; resultDigest: string; isError: boolean; durationMs: number; occurredAt: string }): Promise<boolean>;
}

export interface McpOperationAuthorizationReceipt {
	receiptId: string;
	serverId: string;
	toolName: string;
	inputDigest: string;
	configDigest: string;
	expiresAt: string;
}

export interface McpOperationAuthorizationPort {
	authorize(input: { server: McpServerDescriptor; tool: McpToolDefinition; rawInput: unknown }, signal?: AbortSignal): Promise<McpOperationAuthorizationReceipt | undefined>;
}

export interface McpAuxiliaryAuthorizationReceipt {
	receiptId: string;
	serverId: string;
	operation: "resources/list" | "resources/templates/list" | "resources/read" | "prompts/list" | "prompts/get";
	requestDigest: string;
	configDigest: string;
	expiresAt: string;
}

export interface McpAuxiliaryAuthorizationPort {
	authorize(input: { server: McpServerDescriptor; operation: McpAuxiliaryAuthorizationReceipt["operation"]; request: unknown }, signal?: AbortSignal): Promise<McpAuxiliaryAuthorizationReceipt | undefined>;
}

export interface McpSchedulerPort {
	delay(milliseconds: number, signal?: AbortSignal): Promise<void>;
}

export type McpManagerResult<T> = { ok: true; value: T } | { ok: false; code: "not_found" | "not_ready" | "denied" | "timeout" | "failed" | "audit_unavailable"; message: string };

interface ConnectionRecord {
	server: McpServerDescriptor;
	state: McpServerState;
	generation: number;
	client?: McpClientPort;
	tools: readonly Omit<McpToolDefinition, "serverId" | "serverName" | "qualifiedName" | "runtimeName" | "pinned">[];
	restartAttempts: number;
	reason?: string;
}

function linkedAbort(signal: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; dispose: () => void } {
	const controller = new AbortController();
	const forward = () => controller.abort(signal?.reason ?? "aborted");
	signal?.addEventListener("abort", forward, { once: true });
	const timer = setTimeout(() => controller.abort("timeout"), timeoutMs);
	return { signal: controller.signal, dispose: () => { clearTimeout(timer); signal?.removeEventListener("abort", forward); } };
}

export class McpConnectionManager {
	readonly #factory?: McpClientFactoryPort;
	readonly #authorization?: McpOperationAuthorizationPort;
	readonly #auxiliaryAuthorization?: McpAuxiliaryAuthorizationPort;
	readonly #events?: McpStateEventSinkPort;
	readonly #spill?: ExtensionSpillPort;
	readonly #scheduler?: McpSchedulerPort;
	readonly #maxConcurrentStarts: number;
	readonly #records = new Map<string, ConnectionRecord>();
	#catalog = new McpToolCatalog([]);
	#closed = false;

	public constructor(options: {
		servers: readonly McpServerDescriptor[];
		factory?: McpClientFactoryPort;
		authorization?: McpOperationAuthorizationPort;
		auxiliaryAuthorization?: McpAuxiliaryAuthorizationPort;
		events?: McpStateEventSinkPort;
		spill?: ExtensionSpillPort;
		scheduler?: McpSchedulerPort;
		maxConcurrentStarts?: number;
	}) {
		this.#factory = options.factory;
		this.#authorization = options.authorization;
		this.#auxiliaryAuthorization = options.auxiliaryAuthorization;
		this.#events = options.events;
		this.#spill = options.spill;
		this.#scheduler = options.scheduler;
		this.#maxConcurrentStarts = Math.max(1, Math.min(options.maxConcurrentStarts ?? 4, 16));
		for (const server of options.servers) {
			const state: McpServerState = !server.descriptor.enabled ? "disabled" : server.descriptor.trust !== "trusted" ? "blocked-untrusted" : "stopped";
			this.#records.set(server.descriptor.identity.qualifiedId, { server, state, generation: 0, tools: [], restartAttempts: 0 });
		}
	}

	async #transition(record: ConnectionRecord, state: McpServerState, reason?: string): Promise<boolean> {
		const oldState = record.state;
		if (!this.#events) {
			record.state = "failed";
			record.reason = "durable MCP event sink unavailable";
			return false;
		}
		const durable = await this.#events.record({ server: record.server, serverId: record.server.descriptor.identity.qualifiedId, oldState, newState: state, ...(reason ? { reason } : {}), generation: record.generation, occurredAt: new Date().toISOString() });
		if (!durable) {
			record.state = "failed";
			record.reason = "MCP state audit append failed";
			return false;
		}
		record.state = state;
		record.reason = reason;
		return true;
	}

	public async startAll(signal?: AbortSignal): Promise<readonly McpServerStatus[]> {
		const queue = [...this.#records.values()].filter((record) => record.state === "stopped");
		let cursor = 0;
		const worker = async (): Promise<void> => {
			while (cursor < queue.length) {
				const index = cursor;
				cursor += 1;
				const record = queue[index];
				if (record) await this.#start(record, signal);
			}
		};
		await Promise.all(Array.from({ length: Math.min(this.#maxConcurrentStarts, queue.length) }, () => worker()));
		this.#rebuildCatalog();
		return this.status();
	}

	async #start(record: ConnectionRecord, signal?: AbortSignal): Promise<void> {
		if (this.#closed || !this.#factory) {
			await this.#transition(record, "failed", "MCP client factory or Runtime Gateway is unavailable");
			return;
		}
		record.generation += 1;
		const generation = record.generation;
		if (!(await this.#transition(record, "starting"))) return;
		const bounded = linkedAbort(signal, record.server.config.startupTimeoutMs);
		let client: McpClientPort | undefined;
		try {
			client = await this.#factory.connect(record.server, bounded.signal);
			if (generation !== record.generation || this.#closed) {
				await client.close().catch(() => undefined);
				return;
			}
			const connectedClient = client;
			connectedClient.onClose(() => {
				void this.#handleUnexpectedClose(record, generation, connectedClient);
			});
			const tools = await connectedClient.listTools(bounded.signal);
			record.client = connectedClient;
			record.tools = tools;
			if (!(await this.#transition(record, "ready"))) {
				await connectedClient.close().catch(() => undefined);
				record.client = undefined;
				record.tools = [];
			}
		} catch (error) {
			if (client && record.client !== client) await client.close().catch(() => undefined);
			const reason = bounded.signal.aborted ? "MCP startup timed out or was aborted" : error instanceof Error ? error.message.slice(0, 512) : "MCP startup failed";
			await this.#transition(record, /auth/iu.test(reason) ? "auth-required" : "failed", reason);
		} finally {
			bounded.dispose();
		}
	}

	async #handleUnexpectedClose(record: ConnectionRecord, generation: number, client: McpClientPort): Promise<void> {
		if (record.generation !== generation || record.client !== client || record.state === "stopping" || record.state === "stopped") return;
		record.client = undefined;
		record.tools = [];
		await this.#transition(record, "failed", "MCP transport closed");
		this.#rebuildCatalog();
	}

	#rebuildCatalog(): void {
		this.#catalog = new McpToolCatalog([...this.#records.values()].filter((record) => record.state === "ready").map((record) => ({ server: record.server, tools: record.tools })));
	}

	public catalog(): McpToolCatalog {
		return this.#catalog;
	}

	public status(): readonly McpServerStatus[] {
		return [...this.#records.values()].map((record) => ({ serverId: record.server.descriptor.identity.qualifiedId, state: record.state, generation: record.generation, ...(record.reason ? { reason: record.reason } : {}), toolCount: record.tools.length, restartAttempts: record.restartAttempts })).sort((left, right) => left.serverId.localeCompare(right.serverId));
	}

	public requiredGate(): McpManagerResult<void> {
		const failed = [...this.#records.values()].find((record) => record.server.config.required && record.state !== "ready" && record.state !== "disabled");
		return failed ? { ok: false, code: "not_ready", message: `required MCP server is not ready: ${failed.server.descriptor.identity.qualifiedId}` } : { ok: true, value: undefined };
	}

	public search(query: string, limit?: number): readonly McpToolDefinition[] {
		return this.#catalog.search(query, limit);
	}

	public async call(serverId: string, rawToolName: string, input: unknown, signal?: AbortSignal): Promise<McpManagerResult<McpNormalizedResult>> {
		const record = this.#records.get(serverId);
		const tool = this.#catalog.resolveExact(serverId, rawToolName);
		if (!record || !tool) return { ok: false, code: "not_found", message: "MCP tool identity was not found" };
		if (record.state !== "ready" || !record.client) return { ok: false, code: "not_ready", message: "MCP server is not ready" };
		if (!this.#authorization) return { ok: false, code: "denied", message: "Runtime Gateway authorization is unavailable" };
		const inputDigest = canonicalDigest(input);
		const receipt = await this.#authorization.authorize({ server: record.server, tool, rawInput: input }, signal);
		if (!receipt || receipt.serverId !== serverId || receipt.toolName !== rawToolName || receipt.inputDigest !== inputDigest || receipt.configDigest !== record.server.descriptor.manifest.combinedDigest || new Date(receipt.expiresAt).getTime() <= Date.now()) return { ok: false, code: "denied", message: "MCP operation authorization is missing or stale" };
		if (!this.#events) return { ok: false, code: "audit_unavailable", message: "durable MCP audit sink is unavailable" };
		const timeoutMs = record.server.config.toolTimeouts[rawToolName] ?? record.server.config.toolTimeoutMs;
		const bounded = linkedAbort(signal, timeoutMs);
		const startedAt = Date.now();
		try {
			const rawResult = await record.client.callTool(rawToolName, input, timeoutMs, bounded.signal);
			const result = await normalizeMcpResult(rawResult, this.#spill);
			const durable = await this.#events.recordTool({ server: record.server, tool, serverId, toolName: rawToolName, runtimeName: tool.runtimeName, inputDigest, resultDigest: result.contentDigest, isError: result.isError, durationMs: Date.now() - startedAt, occurredAt: new Date().toISOString() });
			if (!durable) return { ok: false, code: "audit_unavailable", message: "MCP result audit append failed" };
			return { ok: true, value: result };
		} catch (error) {
			return { ok: false, code: bounded.signal.aborted ? "timeout" : "failed", message: bounded.signal.aborted ? "MCP tool timed out or was aborted" : error instanceof Error ? error.message.slice(0, 512) : "MCP tool failed" };
		} finally {
			bounded.dispose();
		}
	}

	public async doctor(serverId?: string, signal?: AbortSignal): Promise<readonly McpDoctorResult[]> {
		const records = serverId ? [this.#records.get(serverId)].filter((value): value is ConnectionRecord => value !== undefined) : [...this.#records.values()];
		const results: McpDoctorResult[] = [];
		for (const record of records) {
			const started = Date.now();
			if (!record.client || record.state !== "ready") {
				results.push({ serverId: record.server.descriptor.identity.qualifiedId, state: record.state, ok: false, latencyMs: 0, reason: record.reason ?? "server is not ready" });
				continue;
			}
			try {
				await record.client.ping(5_000, signal);
				results.push({ serverId: record.server.descriptor.identity.qualifiedId, state: record.state, ok: true, latencyMs: Date.now() - started });
			} catch (error) {
				results.push({ serverId: record.server.descriptor.identity.qualifiedId, state: record.state, ok: false, latencyMs: Date.now() - started, reason: error instanceof Error ? error.message.slice(0, 512) : "MCP ping failed" });
			}
		}
		return results;
	}

	public async restart(serverId: string, signal?: AbortSignal): Promise<McpManagerResult<McpServerStatus>> {
		const record = this.#records.get(serverId);
		if (!record) return { ok: false, code: "not_found", message: "MCP server not found" };
		if (record.restartAttempts >= 2 || !this.#scheduler) return { ok: false, code: "failed", message: "MCP restart budget or scheduler is unavailable" };
		record.restartAttempts += 1;
		await this.#stop(record);
		await this.#scheduler.delay(Math.min(5_000, 500 * 2 ** (record.restartAttempts - 1)), signal);
		await this.#start(record, signal);
		this.#rebuildCatalog();
		const status = this.status().find((item) => item.serverId === serverId);
		return status && status.state === "ready" ? { ok: true, value: status } : { ok: false, code: "failed", message: status?.reason ?? "MCP restart failed" };
	}

	async #stop(record: ConnectionRecord): Promise<void> {
		if (!record.client) {
			await this.#transition(record, "stopped");
			return;
		}
		await this.#transition(record, "stopping");
		const client = record.client;
		record.client = undefined;
		record.tools = [];
		record.generation += 1;
		await client.close().catch(() => undefined);
		await this.#transition(record, "stopped");
	}

	public async closeAll(): Promise<void> {
		this.#closed = true;
		await Promise.all([...this.#records.values()].map((record) => this.#stop(record)));
		this.#rebuildCatalog();
	}

	async #withReadyClient<T>(serverId: string, operationName: McpAuxiliaryAuthorizationReceipt["operation"], request: unknown, operation: (client: McpClientPort) => Promise<T>, signal?: AbortSignal): Promise<McpManagerResult<T>> {
		const record = this.#records.get(serverId);
		if (!record) return { ok: false, code: "not_found", message: "MCP server not found" };
		if (record.state !== "ready" || !record.client) return { ok: false, code: "not_ready", message: "MCP server is not ready" };
		if (!this.#auxiliaryAuthorization) return { ok: false, code: "denied", message: "Runtime authorization for MCP resources/prompts is unavailable" };
		const requestDigest = canonicalDigest(request);
		const receipt = await this.#auxiliaryAuthorization.authorize({ server: record.server, operation: operationName, request }, signal);
		if (!receipt || receipt.serverId !== serverId || receipt.operation !== operationName || receipt.requestDigest !== requestDigest || receipt.configDigest !== record.server.descriptor.manifest.combinedDigest || new Date(receipt.expiresAt).getTime() <= Date.now()) return { ok: false, code: "denied", message: "MCP auxiliary authorization is missing or stale" };
		try {
			return { ok: true, value: await operation(record.client) };
		} catch (error) {
			return { ok: false, code: "failed", message: error instanceof Error ? error.message.slice(0, 512) : "MCP operation failed" };
		}
	}

	public listResources(serverId: string, signal?: AbortSignal) { return this.#withReadyClient(serverId, "resources/list", {}, (client) => client.listResources(signal), signal); }
	public listResourceTemplates(serverId: string, signal?: AbortSignal) { return this.#withReadyClient(serverId, "resources/templates/list", {}, (client) => client.listResourceTemplates(signal), signal); }
	public readResource(serverId: string, uri: string, signal?: AbortSignal) { return this.#withReadyClient(serverId, "resources/read", { uri }, (client) => client.readResource(uri, signal), signal); }
	public listPrompts(serverId: string, signal?: AbortSignal) { return this.#withReadyClient(serverId, "prompts/list", {}, (client) => client.listPrompts(signal), signal); }
	public getPrompt(serverId: string, name: string, args: Readonly<Record<string, string>>, signal?: AbortSignal) { return this.#withReadyClient(serverId, "prompts/get", { name, args }, (client) => client.getPrompt(name, args, signal), signal); }
}
