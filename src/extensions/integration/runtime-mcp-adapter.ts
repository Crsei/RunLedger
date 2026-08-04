/** 将已连接的 MCP manager 投影为 Host 可消费的 bounded Runtime result。 */

import type { AdapterIdentityRef } from "../../runtime/protocol/adapter.ts";
import type { RuntimeContentRef, RuntimeDigest } from "../../runtime/protocol/foundation.ts";
import { runtimeDigest } from "../../runtime/protocol/foundation.ts";
import type { RuntimeToolInvocation, RuntimeToolResult, ResourceContent } from "../../runtime/resources/types.ts";
import type { McpCallValue, McpNormalizedContent } from "../mcp/types.ts";
import { McpConnectionManager } from "../mcp/connection-manager.ts";
import {
	boundedCanonicalInput,
	checkResourceInvocationPort,
	type ExtensionAdapterRequestBase,
	type ExtensionAdapterResult,
	type RuntimeExtensionResourcePorts,
	DEFAULT_EXTENSION_ADAPTER_INPUT_BYTES,
	sameResourceIdentity,
} from "./runtime-resource-adapter.ts";
import { createInvocationAudit } from "./runtime-audit-adapter.ts";

const MAX_RUNTIME_TEXT_BYTES = 4_096;
const MAX_RUNTIME_CONTENT_ITEMS = 32;

export interface McpInvocationRequest extends ExtensionAdapterRequestBase {
	readonly serverId: string;
	readonly toolName: string;
	readonly runtimeName: string;
	readonly input: unknown;
}

export interface McpInvocationValue {
	readonly invocation: RuntimeToolInvocation;
	readonly serverId: string;
	readonly toolName: string;
	readonly runtimeName: string;
	readonly runtimeResult: RuntimeToolResult;
}

export interface RuntimeMcpAdapterOptions {
	readonly manager: McpConnectionManager;
	readonly resources: RuntimeExtensionResourcePorts;
	readonly adapter: AdapterIdentityRef;
	readonly maxInputBytes?: number;
}

function sameDigest(left: RuntimeDigest, right: RuntimeDigest): boolean {
	return left.algorithm === right.algorithm && left.digest === right.digest;
}

function truncateUtf8(value: string, maxBytes: number): { readonly value: string; readonly truncated: boolean } {
	if (Buffer.byteLength(value, "utf8") <= maxBytes) return { value, truncated: false };
	let clipped = value;
	while (clipped.length > 0 && Buffer.byteLength(clipped, "utf8") > maxBytes) clipped = clipped.slice(0, -1);
	return { value: clipped, truncated: true };
}

function contentRef(content: McpNormalizedContent): RuntimeContentRef {
	return {
		subjectKind: "content",
		digest: runtimeDigest(content),
		...(content.type === "image" ? { mediaType: content.mimeType, size: Buffer.byteLength(content.data, "utf8") } : {}),
	};
}

function mapContent(content: McpNormalizedContent): { readonly value: ResourceContent; readonly bytes: number; readonly truncated: boolean } {
	if (content.type === "text") {
		const clipped = truncateUtf8(content.text, MAX_RUNTIME_TEXT_BYTES);
		return { value: { type: "text", text: clipped.value }, bytes: Buffer.byteLength(clipped.value, "utf8"), truncated: clipped.truncated };
	}
	return { value: { type: "content_ref", ref: contentRef(content) }, bytes: 0, truncated: false };
}

function expectedQualifiedId(serverId: string, toolName: string): string {
	const owner = serverId.startsWith("mcp-server:") ? serverId.slice("mcp-server:".length) : serverId;
	return `mcp-tool:${owner}:${toolName}`;
}

function failureMessage(code: import("./runtime-resource-adapter.ts").ExtensionAdapterErrorCode): string {
	switch (code) {
		case "authorization_denied": return "MCP tool authorization was denied";
		case "cancelled": return "MCP tool invocation was cancelled";
		case "not_found": return "MCP server or tool was not found in the current snapshot";
		case "unavailable": return "MCP server is unavailable";
		case "blocked": return "MCP server is blocked";
		case "stale": return "MCP tool identity is stale";
		case "oversized": return "MCP result exceeded the Runtime content bound";
		case "invalid_input": return "MCP tool input is not canonical JSON";
		case "invalid_request": return "MCP invocation request is invalid";
		case "execution_failed": return "MCP tool invocation failed";
		case "unsupported": return "MCP tool invocation is unsupported";
		case "ambiguous": return "MCP tool identity is ambiguous";
		case "unknown_effect": return "MCP resource port returned an unknown effect";
	}
}

function mapManagerError(code: string): import("./runtime-resource-adapter.ts").ExtensionAdapterErrorCode {
	if (code === "authorization_denied") return "authorization_denied";
	if (code === "server_not_ready" || code === "startup_failed") return "unavailable";
	if (code === "tool_not_found") return "not_found";
	if (code === "blocked_untrusted") return "blocked";
	if (code === "tool_timeout" || code === "tool_failed") return "execution_failed";
	return "unsupported";
}

export class RuntimeMcpAdapter {
	readonly #manager: McpConnectionManager;
	readonly #resources: RuntimeExtensionResourcePorts;
	readonly #adapter: AdapterIdentityRef;
	readonly #maxInputBytes: number;

	public constructor(options: RuntimeMcpAdapterOptions) {
		this.#manager = options.manager;
		this.#resources = options.resources;
		this.#adapter = options.adapter;
		this.#maxInputBytes = options.maxInputBytes ?? DEFAULT_EXTENSION_ADAPTER_INPUT_BYTES;
	}

	public async invoke(request: McpInvocationRequest): Promise<ExtensionAdapterResult<McpInvocationValue>> {
		const startedAt = Date.now();
		const input = boundedCanonicalInput(request.input, this.#maxInputBytes);
		const inputDigest = input.ok ? input.value.digest : input.digest;
		const inputBytes = input.ok ? input.value.bytes : input.bytes;
		if (request.invocation.tool.kind !== "mcp-tool") return this.#failure(request, "invalid_request", inputDigest, inputBytes, startedAt);
		if (!sameDigest(request.invocation.inputDigest, inputDigest)) return this.#failure(request, "invalid_request", inputDigest, inputBytes, startedAt);
		if (!input.ok) return this.#failure(request, input.error.code, inputDigest, inputBytes, startedAt);

		const server = this.#manager.snapshot(request.serverId);
		if (!server) return this.#failure(request, "not_found", inputDigest, inputBytes, startedAt);
		if (server.state === "blocked-untrusted") return this.#failure(request, "blocked", inputDigest, inputBytes, startedAt);
		if (server.state !== "ready") return this.#failure(request, "unavailable", inputDigest, inputBytes, startedAt);
		const descriptor = server.tools.find((tool) => tool.rawName === request.toolName && tool.runtimeName === request.runtimeName);
		if (!descriptor) return this.#failure(request, "not_found", inputDigest, inputBytes, startedAt);
		if (request.invocation.tool.qualifiedId !== expectedQualifiedId(request.serverId, request.toolName)) return this.#failure(request, "stale", inputDigest, inputBytes, startedAt);

		const gate = await checkResourceInvocationPort({
			port: this.#resources.invocation,
			identity: request.identity,
			requestId: request.invocation.requestId,
			traceId: request.invocation.correlationId,
			deadline: request.deadline,
			inputDigest,
			...(request.invocation.inputRef ? { inputRef: request.invocation.inputRef } : {}),
			signal: request.signal,
		});
		if (!gate.ok) return this.#failure(request, gate.error.code, inputDigest, inputBytes, startedAt, gate.outputDigest);

		const called = await this.#manager.call({ serverId: request.serverId, toolName: request.toolName, input: input.value.value }, request.signal);
		if (!called.ok) {
			const code = mapManagerError(called.error.code);
			return this.#failure(request, code, inputDigest, inputBytes, startedAt, gate.outputDigest);
		}

		const mapped = called.value.content.slice(0, MAX_RUNTIME_CONTENT_ITEMS).map(mapContent);
		const content: ResourceContent[] = mapped.map((item) => item.value);
		const truncated = called.value.truncated || called.value.content.length > MAX_RUNTIME_CONTENT_ITEMS || mapped.some((item) => item.truncated);
		const contentDigest = runtimeDigest(content);
		const runtimeResult: RuntimeToolResult = {
			requestId: request.invocation.requestId,
			tool: request.invocation.tool,
			content,
			outcome: called.value.outcome === "ok" ? "ok" : "error",
			originalBytes: called.value.originalBytes,
			truncated,
			contentDigest,
		};
		const audit = createInvocationAudit({
			kind: "mcp.tool",
			requestId: request.invocation.requestId,
			correlationId: request.invocation.correlationId,
			snapshotId: request.invocation.snapshotId,
			resource: request.invocation.tool,
			outcome: runtimeResult.outcome,
			inputDigest,
			outputDigest: contentDigest,
			metadata: { serverId: request.serverId, toolName: request.toolName, runtimeName: request.runtimeName, adapter: this.#adapter, managerContentDigest: called.value.contentDigest, descriptor: { readOnly: descriptor.isReadOnly, destructive: descriptor.isDestructive, concurrencySafe: descriptor.isConcurrencySafe } },
			portDigest: gate.outputDigest,
				bodyDigest: runtimeDigest(called.value.content),
			originalBytes: inputBytes,
			resultBytes: mapped.reduce((sum, item) => sum + item.bytes, 0),
			truncated,
			durationMs: Date.now() - startedAt,
			...(runtimeResult.outcome === "error" ? { errorCode: "execution_failed" as const } : {}),
		});
		return {
			ok: true,
			value: { invocation: request.invocation, serverId: request.serverId, toolName: request.toolName, runtimeName: request.runtimeName, runtimeResult },
			audit: audit.audit,
			auditDigest: audit.auditDigest,
		};
	}

	#failure(
		request: McpInvocationRequest,
		code: Parameters<typeof failureMessage>[0],
		inputDigest: RuntimeDigest,
		inputBytes: number,
		startedAt: number,
		portDigest = runtimeDigest("extension-mcp-not-invoked"),
	): ExtensionAdapterResult<McpInvocationValue> {
		const audit = createInvocationAudit({
			kind: "mcp.tool",
			requestId: request.invocation.requestId,
			correlationId: request.invocation.correlationId,
			snapshotId: request.invocation.snapshotId,
			resource: request.invocation.tool,
			outcome: code === "authorization_denied" ? "denied" : code === "cancelled" ? "cancelled" : code === "unsupported" ? "unsupported" : "error",
			inputDigest,
			outputDigest: runtimeDigest({ code }),
			metadata: { code, adapter: this.#adapter },
			portDigest,
			originalBytes: inputBytes,
			resultBytes: 0,
			durationMs: Date.now() - startedAt,
			errorCode: code,
		});
		return { ok: false, error: { code, message: failureMessage(code), retryable: code === "unavailable" || code === "execution_failed" }, audit: audit.audit, auditDigest: audit.auditDigest };
	}
}
