/** Resident Host-owned MCP lifecycle and meta-tool composition. */

import { Type } from "typebox";
import type { Static } from "typebox";
import type { AgentTool, AgentToolResult } from "../runtime/types.ts";
import { ToolRegistry } from "../runtime/tool-registry.ts";
import type { AdapterIdentityRef } from "../runtime/protocol/adapter.ts";
import { runtimeDigest, type RuntimeContentRef, type RuntimeDigest } from "../runtime/protocol/foundation.ts";
import type { RuntimeResourceInvocationPort } from "../runtime/contracts/ports.ts";
import type { RuntimeErrorCode } from "../runtime/protocol/errors.ts";
import type { AuthorityId, CommandId, PrincipalId, SessionId, SnapshotId, TenantId, TraceId } from "../runtime/protocol/ids.ts";
import type { IdentityContext } from "../runtime/identity/types.ts";
import type { ResourceIdentity, RuntimeToolDescriptor, RuntimeToolInvocation } from "../runtime/resources/types.ts";
import { createRuntimeId } from "../runtime/protocol/ids.ts";
import { RuntimeMcpAdapter, type McpInvocationValue } from "../extensions/integration/runtime-mcp-adapter.ts";
import type { RuntimeExtensionResourcePorts } from "../extensions/integration/runtime-resource-adapter.ts";
import { McpConnectionManager, type McpServerConfig, type McpServerSnapshot, type McpToolDescriptor } from "../extensions/mcp/connection-manager.ts";
import type { HostResourceAuthorization, HostResourceAuthorizationRequest } from "./runtime-host-security.ts";
import type { SecurityResult } from "../security/types.ts";

const MCP_NAMESPACE = "mcp";
const DEFAULT_DEADLINE_MS = 120_000;
const DEFAULT_MAX_SEARCH_RESULTS = 32;
const MAX_DESCRIPTION_BYTES = 1_024;

const mcpCatalogSchema = Type.Object({}, { additionalProperties: false });
const mcpSearchSchema = Type.Object({
	query: Type.String({ minLength: 0, maxLength: 512 }),
	maxResults: Type.Optional(Type.Integer({ minimum: 1, maximum: DEFAULT_MAX_SEARCH_RESULTS })),
}, { additionalProperties: false });
const mcpCallSchema = Type.Object({
	serverId: Type.String({ minLength: 1, maxLength: 128 }),
	toolName: Type.String({ minLength: 1, maxLength: 256 }),
	input: Type.Unknown(),
}, { additionalProperties: false });

export type McpCatalogInput = Static<typeof mcpCatalogSchema>;
export type McpSearchInput = Static<typeof mcpSearchSchema>;
export type McpCallInput = Static<typeof mcpCallSchema>;

export interface HostMcpRuntimeOptions {
	readonly manager: McpConnectionManager;
	readonly resources: RuntimeExtensionResourcePorts;
	/** Session composition injects the single Host-owned registry. */
	readonly toolRegistry?: ToolRegistry;
	readonly adapter: AdapterIdentityRef;
	readonly authorityId: AuthorityId;
	readonly tenantId: TenantId;
	readonly principalId: PrincipalId;
	readonly sessionId: SessionId;
	readonly snapshotId: SnapshotId;
	readonly now?: () => Date;
	readonly maxSearchResults?: number;
}

export interface HostMcpStartResult {
	readonly ok: boolean;
	readonly snapshots: readonly McpServerSnapshot[];
	readonly requiredFailures: readonly { readonly serverId: string; readonly code: string; readonly message: string }[];
}

export interface HostMcpDoctorResult {
	readonly serverId: string;
	readonly displayName?: string;
	readonly state: McpServerSnapshot["state"] | "not_configured";
	readonly connectivity: "ready" | "disabled" | "blocked" | "failed" | "unavailable";
	readonly generation: number;
	readonly diagnostics: readonly { readonly code: string; readonly message: string; readonly severity: "info" | "warning" | "error" }[];
}

export type HostMcpInvocationResult =
	| { readonly ok: true; readonly value: McpInvocationValue }
	| { readonly ok: false; readonly error: { readonly code: string; readonly message: string; readonly retryable: boolean } };

export interface HostMcpResourceInvocationPortOptions {
	readonly adapter: AdapterIdentityRef;
	readonly sessionId: string;
	readonly principalId: string;
	readonly cwd: string;
	readonly authorize: (request: HostResourceAuthorizationRequest) => Promise<SecurityResult<HostResourceAuthorization>>;
}

/** Bridges MCP's resource gate to the resident Host Gateway authorization receipt. */
export function createHostMcpResourceInvocationPort(options: HostMcpResourceInvocationPortOptions): RuntimeResourceInvocationPort {
	return {
		execute: async (request) => {
			const authorized = await options.authorize({
				sessionId: options.sessionId,
				principalId: options.principalId,
				requestId: request.requestId,
				traceId: request.traceId,
				toolName: "mcp",
				cwd: options.cwd,
				argumentsDigest: request.inputDigest,
			});
			if (!authorized.ok) {
				return {
					port: request.port,
					action: request.action,
					requestId: request.requestId,
					outcome: "denied",
					effect: "none",
					adapter: options.adapter,
					outputDigest: runtimeDigest({ requestId: request.requestId, code: authorized.error.code }),
					error: {
						code: resourceRuntimeErrorCode(authorized.error.code),
						message: authorized.error.message,
						retryable: authorized.error.retryable,
						correlationId: request.traceId,
					},
					completedAt: new Date().toISOString(),
				};
			}
			const receiptRef: RuntimeContentRef = {
				subjectKind: "receipt",
				digest: authorized.value.authorizationDigest,
				mediaType: "application/vnd.runledger.authorization+json",
				size: 0,
			};
			return {
				port: request.port,
				action: request.action,
				requestId: request.requestId,
				outcome: "ok",
				effect: "terminal",
				adapter: options.adapter,
				outputDigest: runtimeDigest({ requestId: request.requestId, authorizationDigest: authorized.value.authorizationDigest }),
				receiptRef,
				completedAt: new Date().toISOString(),
			};
		},
	};
}

function resourceRuntimeErrorCode(code: string): RuntimeErrorCode {
	if (code === "policy_denied" || code === "network_denied" || code === "path_escape" || code === "protected_path") return "capability_denied";
	if (code === "approval_cancelled" || code === "approval_expired") return "operation_cancelled";
	if (code === "approval_stale") return "expected_revision_conflict";
	if (code === "registry_failed" || code === "cleanup_failed") return "adapter_unavailable";
	return "boundary_violation";
}

interface HostMcpIdentity {
	readonly identity: IdentityContext;
	readonly requestId: CommandId;
	readonly traceId: TraceId;
	readonly deadline: string;
}

function boundedDescription(value: string | undefined): string {
	if (value === undefined) return "";
	if (Buffer.byteLength(value, "utf8") <= MAX_DESCRIPTION_BYTES) return value;
	let clipped = value;
	while (clipped.length > 0 && Buffer.byteLength(clipped, "utf8") > MAX_DESCRIPTION_BYTES) clipped = clipped.slice(0, -1);
	return clipped;
}

function jsonText(value: unknown): string {
	try {
		const encoded = JSON.stringify(value);
		return encoded === undefined ? "null" : encoded;
	} catch {
		return "[unserializable MCP result]";
	}
}

function result<T>(details: T, content: string, isError = false): AgentToolResult<T> {
	return {
		content: [{ type: "text", text: content }],
		details,
		...(isError ? { isError: true } : {}),
	};
}

function invocationRef(value: unknown): RuntimeContentRef {
	return { subjectKind: "receipt", digest: runtimeDigest(value), mediaType: "application/json", size: 0 };
}

function resourceIdentity(serverId: string, descriptor: McpToolDescriptor): ResourceIdentity {
	const owner = serverId.startsWith("mcp-server:") ? serverId.slice("mcp-server:".length) : serverId;
	const qualifiedId = `mcp-tool:${owner}:${descriptor.rawName}`;
	const digest = runtimeDigest({ serverId, tool: descriptor });
	return {
		resourceId: createRuntimeId("resource", digest.digest.slice(0, 48)),
		kind: "mcp-tool",
		qualifiedId,
		version: "1.0.0",
		source: "project",
		digest,
	};
}

function claims(descriptor: McpToolDescriptor): [] {
	// MCP annotations are advisory metadata. The Host resource port remains the
	// authorization authority, so an absent or contradictory claim cannot grant access.
	void descriptor;
	return [];
}

export function createHostMcpRuntime(options: HostMcpRuntimeOptions): HostMcpRuntime {
	return new HostMcpRuntime(options);
}

export class HostMcpRuntime {
	readonly #options: HostMcpRuntimeOptions;
	readonly #manager: McpConnectionManager;
	readonly #adapter: RuntimeMcpAdapter;
	readonly #tools: ToolRegistry;
	readonly #configs = new Map<string, McpServerConfig>();
	readonly #now: () => Date;
	readonly #maxSearchResults: number;

	public constructor(options: HostMcpRuntimeOptions) {
		this.#options = options;
		this.#manager = options.manager;
		this.#now = options.now ?? (() => new Date());
		this.#maxSearchResults = Number.isSafeInteger(options.maxSearchResults) && (options.maxSearchResults ?? 0) > 0
			? Math.min(options.maxSearchResults ?? DEFAULT_MAX_SEARCH_RESULTS, DEFAULT_MAX_SEARCH_RESULTS)
			: DEFAULT_MAX_SEARCH_RESULTS;
		this.#adapter = new RuntimeMcpAdapter({ manager: this.#manager, resources: options.resources, adapter: options.adapter });
		this.#tools = options.toolRegistry ?? new ToolRegistry();
		this.#tools.register(this.#createCatalogTool(), { namespace: MCP_NAMESPACE });
		this.#tools.register(this.#createCallTool(), { namespace: MCP_NAMESPACE });
		this.#tools.register(this.#createSearchTool(), { namespace: MCP_NAMESPACE });
	}

	public toolRegistry(): ToolRegistry {
		return this.#tools;
	}

	public catalog(): readonly McpServerSnapshot[] {
		return this.#manager.snapshots();
	}

	public doctor(serverId?: string): readonly HostMcpDoctorResult[] {
		const snapshots = serverId === undefined ? this.catalog() : [this.#manager.snapshot(serverId)].filter((item): item is McpServerSnapshot => item !== undefined);
		if (serverId !== undefined && snapshots.length === 0) return [{ serverId, state: "not_configured", connectivity: "unavailable", generation: 0, diagnostics: [{ code: "mcp.not_configured", message: "MCP server is not configured", severity: "error" }] }];
		return snapshots.map((snapshot) => ({
			serverId: snapshot.serverId,
			displayName: snapshot.displayName,
			state: snapshot.state,
			connectivity: snapshot.state === "ready" ? "ready" : snapshot.state === "disabled" ? "disabled" : snapshot.state === "blocked-untrusted" ? "blocked" : snapshot.state === "failed" ? "failed" : "unavailable",
			generation: snapshot.generation,
			diagnostics: snapshot.diagnostics,
		}));
	}

	public async start(configs: readonly McpServerConfig[]): Promise<HostMcpStartResult> {
		this.#configs.clear();
		for (const config of [...configs].sort((left, right) => left.serverId.localeCompare(right.serverId))) this.#configs.set(config.serverId, config);
		const requiredFailures: Array<{ readonly serverId: string; readonly code: string; readonly message: string }> = [];
		for (const config of this.#configs.values()) {
			const started = await this.#manager.start(config);
			if (!started.ok && config.required) requiredFailures.push({ serverId: config.serverId, code: started.error.code, message: started.error.message });
		}
		return { ok: requiredFailures.length === 0, snapshots: this.catalog(), requiredFailures };
	}

	public async restart(serverId: string): Promise<{ readonly ok: true; readonly value: McpServerSnapshot } | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } }> {
		const config = this.#configs.get(serverId);
		if (config === undefined) return { ok: false, error: { code: "not_configured", message: "MCP server is not configured" } };
		const restarted = await this.#manager.start(config);
		return restarted.ok ? restarted : { ok: false, error: { code: restarted.error.code, message: restarted.error.message } };
	}

	public async invoke(serverId: string, toolName: string, input: unknown, signal?: AbortSignal): Promise<HostMcpInvocationResult> {
		const snapshot = this.#manager.snapshot(serverId);
		const descriptor = snapshot?.tools.find((tool) => tool.rawName === toolName);
		if (snapshot === undefined || descriptor === undefined) return { ok: false, error: { code: "not_found", message: "MCP server or tool is not available", retryable: false } };
		const request = this.#requestIdentity(serverId, toolName, input);
		const invocation: RuntimeToolInvocation = {
			requestId: request.requestId,
			tool: resourceIdentity(serverId, descriptor),
			inputDigest: runtimeDigest(input),
			decisionReceiptRef: invocationRef({ requestId: request.requestId, policy: "resource-port" }),
			snapshotId: this.#options.snapshotId,
			correlationId: request.traceId,
			requestedClaims: claims(descriptor),
		};
		const called = await this.#adapter.invoke({
			identity: request.identity,
			deadline: request.deadline,
			invocation,
			serverId,
			toolName,
			runtimeName: descriptor.runtimeName,
			input,
			signal,
		});
		return called.ok ? called : { ok: false, error: called.error };
	}

	public async close(): Promise<void> {
		await this.#manager.closeAll();
	}

	#createCatalogTool(): AgentTool<typeof mcpCatalogSchema> {
		return {
			name: "mcp_catalog",
			label: "MCP catalog",
			description: "List the bounded, Host-owned MCP server and tool catalog.",
			parameters: mcpCatalogSchema,
			isReadOnly: () => true,
			isConcurrencySafe: () => true,
			execute: async () => result({ servers: this.catalog() }, jsonText({ servers: this.catalog() })),
		};
	}

	#createSearchTool(): AgentTool<typeof mcpSearchSchema> {
		return {
			name: "mcp_search",
			label: "MCP search",
			description: "Search the bounded Host-owned MCP tool catalog without invoking a server.",
			parameters: mcpSearchSchema,
			isReadOnly: () => true,
			isConcurrencySafe: () => true,
			execute: async (_toolCallId, input) => {
				const query = input.query.toLocaleLowerCase();
				const matches = this.catalog().flatMap((server) => server.tools
					.filter((tool) => `${server.serverId} ${tool.rawName} ${tool.runtimeName} ${tool.description ?? ""}`.toLocaleLowerCase().includes(query))
					.map((tool) => this.publicTool(server.serverId, tool)))
					.slice(0, input.maxResults ?? this.#maxSearchResults);
				return result({ query: input.query, results: matches }, jsonText({ query: input.query, results: matches }));
			},
		};
	}

	#createCallTool(): AgentTool<typeof mcpCallSchema> {
		return {
			name: "mcp_call",
			label: "MCP call",
			description: "Invoke one MCP tool through the Host Runtime resource and capability ports.",
			parameters: mcpCallSchema,
			isDestructive: () => true,
			execute: async (toolCallId, input, signal) => {
				const invoked = await this.invoke(input.serverId, input.toolName, input.input, signal);
				if (!invoked.ok) return result(invoked.error, jsonText(invoked.error), true);
				return result(invoked.value.runtimeResult, jsonText(invoked.value.runtimeResult), invoked.value.runtimeResult.outcome !== "ok");
			},
		};
	}

	#requestIdentity(serverId: string, toolName: string, input: unknown): HostMcpIdentity {
		const requestId = createRuntimeId("command", runtimeDigest({ sessionId: this.#options.sessionId, serverId, toolName, input }).digest.slice(0, 48));
		const traceId = createRuntimeId("trace", runtimeDigest({ requestId, serverId, toolName }).digest.slice(0, 48));
		const issuedAt = this.#now();
		const deadline = new Date(issuedAt.getTime() + DEFAULT_DEADLINE_MS).toISOString();
		return {
			requestId,
			traceId,
			deadline,
			identity: {
				authorityId: this.#options.authorityId,
				tenantId: this.#options.tenantId,
				principalId: this.#options.principalId,
				principalKind: "local",
				issuedAt: issuedAt.toISOString(),
			},
		};
	}

	privateToolIdentity(serverId: string, descriptor: McpToolDescriptor): RuntimeToolDescriptor {
		const identity = resourceIdentity(serverId, descriptor);
		return {
			identity,
			provenance: { source: "project", sourceLocatorDigest: runtimeDigest(serverId) },
			runtimeName: descriptor.runtimeName,
			description: boundedDescription(descriptor.description),
			parametersSchemaRef: { subjectKind: "content", digest: runtimeDigest(descriptor.inputSchema), mediaType: "application/schema+json", size: 0 },
			claims: [],
			exposure: "direct",
			isReadOnly: descriptor.isReadOnly,
			isDestructive: descriptor.isDestructive,
			isConcurrencySafe: descriptor.isConcurrencySafe,
			trust: "trusted",
			activation: "ready",
			descriptorDigest: runtimeDigest(descriptor),
		};
	}

	private publicTool(serverId: string, descriptor: McpToolDescriptor): Record<string, unknown> {
		const tool = this.privateToolIdentity(serverId, descriptor);
		return {
			serverId,
			runtimeName: descriptor.runtimeName,
			rawName: descriptor.rawName,
			description: tool.description,
			inputSchema: descriptor.inputSchema,
			readOnly: descriptor.isReadOnly,
			destructive: descriptor.isDestructive,
			concurrencySafe: descriptor.isConcurrencySafe,
			resourceId: tool.identity.resourceId,
		};
	}
}
