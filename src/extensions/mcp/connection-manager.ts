/** 注入式 MCP connection manager；真实 transport/process 生命周期由 Host adapter 提供。 */

import { runtimeDigest } from "../../runtime/protocol/foundation.ts";
import { mcpRuntimeName } from "../identity.ts";
import type {
	McpAuthorizationRequest,
	McpAuthorizationResult,
	McpCallValue,
	McpClientFactory,
	McpDiagnostic,
	McpManagerError,
	McpManagerResult,
	McpNormalizedContent,
	McpRawContent,
	McpRawToolResult,
	McpServerConfig,
	McpServerSnapshot,
	McpServerState,
	McpToolDefinition,
	McpToolDescriptor,
	McpTransportClient,
} from "./types.ts";

export type {
	McpAuthorizationRequest,
	McpAuthorizationResult,
	McpCallValue,
	McpClientFactory,
	McpManagerResult,
	McpRawToolResult,
	McpServerConfig,
	McpServerSnapshot,
	McpToolDescriptor,
	McpTransportClient,
} from "./types.ts";

export interface McpConnectionManagerOptions {
	readonly factory: McpClientFactory;
	readonly authorize?: (request: McpAuthorizationRequest, signal?: AbortSignal) => Promise<McpAuthorizationResult>;
	readonly maxConcurrentStarts?: number;
}

interface Entry {
	readonly config: McpServerConfig;
	state: McpServerState;
	generation: number;
	client?: McpTransportClient;
	tools: McpToolDescriptor[];
	diagnostics: McpDiagnostic[];
}

class McpOperationError extends Error {
	readonly code: "timeout" | "aborted" | "failed";

	public constructor(code: McpOperationError["code"], message: string) {
		super(message);
		this.name = "McpOperationError";
		this.code = code;
	}
}

function failure<T>(code: McpManagerError["code"], message: string, retryable: boolean): McpManagerResult<T> {
	return { ok: false, error: { code, message, retryable } };
}

function validPositive(value: number): boolean {
	return Number.isSafeInteger(value) && value > 0;
}

function stableTools(tools: readonly McpToolDefinition[], config: McpServerConfig): McpManagerResult<McpToolDescriptor[]> {
	const enabled = config.enabledTools === undefined ? undefined : new Set(config.enabledTools);
	const disabled = new Set(config.disabledTools ?? []);
	const selected = tools
		.filter((tool) => tool.name.length > 0)
		.filter((tool) => enabled === undefined || enabled.has(tool.name))
		.filter((tool) => !disabled.has(tool.name))
		.slice()
		.sort((left, right) => left.name.localeCompare(right.name));
	const seenRuntimeNames = new Set<string>();
	const descriptors: McpToolDescriptor[] = [];
	for (const tool of selected) {
		const runtimeName = mcpRuntimeName(config.displayName, tool.name);
		if (seenRuntimeNames.has(runtimeName)) return failure("invalid_catalog", `MCP runtime name collision: ${runtimeName}`, false);
		seenRuntimeNames.add(runtimeName);
		descriptors.push({
			...tool,
			rawName: tool.name,
			runtimeName,
			isReadOnly: tool.annotations?.readOnly === true,
			isDestructive: tool.annotations?.destructive ?? true,
			isConcurrencySafe: tool.annotations?.concurrencySafe === true,
		});
	}
	return { ok: true, value: descriptors };
}

function abortError(signal: AbortSignal | undefined): McpOperationError | undefined {
	return signal?.aborted ? new McpOperationError("aborted", "MCP operation was aborted") : undefined;
}

async function withTimeout<T>(
	operation: (signal: AbortSignal) => Promise<T>,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<T> {
	if (!validPositive(timeoutMs)) throw new McpOperationError("failed", "MCP timeout must be a positive safe integer");
	const abortController = new AbortController();
	const onAbort = () => abortController.abort();
	if (signal?.aborted) throw new McpOperationError("aborted", "MCP operation was aborted");
	signal?.addEventListener("abort", onAbort, { once: true });
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const timed = new Promise<never>((_, reject) => {
			timer = setTimeout(() => {
				abortController.abort();
				reject(new McpOperationError("timeout", `MCP operation exceeded ${timeoutMs}ms`));
			}, timeoutMs);
		});
		return await Promise.race([operation(abortController.signal), timed]);
	} catch (error) {
		if (error instanceof McpOperationError) throw error;
		const aborted = abortError(signal);
		if (aborted) throw aborted;
		throw new McpOperationError("failed", error instanceof Error ? error.message : "MCP operation failed");
	} finally {
		if (timer !== undefined) clearTimeout(timer);
		signal?.removeEventListener("abort", onAbort);
	}
}

function byteSize(content: McpNormalizedContent): number {
	if (content.type === "text") return Buffer.byteLength(content.text, "utf8");
	if (content.type === "image") return Buffer.byteLength(content.data, "utf8") + Buffer.byteLength(content.mimeType, "utf8");
	return Buffer.byteLength(content.uri, "utf8") + Buffer.byteLength(content.mimeType ?? "", "utf8") + Buffer.byteLength(content.text ?? "", "utf8");
}

function truncateText(value: string, maxBytes: number): string {
	if (maxBytes <= 0) return "";
	if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
	let result = value;
	while (result.length > 0 && Buffer.byteLength(result, "utf8") > maxBytes) result = result.slice(0, Math.max(0, result.length - 1));
	return result;
}

function normalizeContent(raw: McpRawContent): McpNormalizedContent {
	if (raw.type === "text" && typeof raw.text === "string") return { type: "text", text: raw.text };
	if (raw.type === "image" && typeof raw.data === "string" && typeof raw.mimeType === "string") return { type: "image", data: raw.data, mimeType: raw.mimeType };
	if (raw.type === "resource" && typeof raw.uri === "string") {
		return {
			type: "resource",
			uri: raw.uri,
			...(typeof raw.mimeType === "string" ? { mimeType: raw.mimeType } : {}),
			...(typeof raw.text === "string" ? { text: raw.text } : {}),
		};
	}
	let serialized: string;
	try {
		serialized = JSON.stringify(raw) ?? "null";
	} catch {
		serialized = "[unserializable MCP content]";
	}
	return { type: "text", text: serialized };
}

function normalizeResult(result: McpRawToolResult, maxBytes: number): McpCallValue["content"] extends readonly McpNormalizedContent[] ? { content: McpNormalizedContent[]; originalBytes: number; truncated: boolean } : never {
	const normalized = result.content.map(normalizeContent);
	const originalBytes = normalized.reduce((total, content) => total + byteSize(content), 0);
	const output: McpNormalizedContent[] = [];
	let used = 0;
	let truncated = false;
	for (const content of normalized) {
		const size = byteSize(content);
		if (used + size <= maxBytes) {
			output.push(content);
			used += size;
			continue;
		}
		truncated = true;
		const remaining = maxBytes - used;
		if (remaining > 0 && content.type === "text") {
			const shortened = truncateText(content.text, remaining);
			if (shortened.length > 0) output.push({ type: "text", text: shortened });
		}
		break;
	}
	return { content: output, originalBytes, truncated: truncated || output.length < normalized.length };
}

export class McpConnectionManager {
	readonly #factory: McpClientFactory;
	readonly #authorize?: McpConnectionManagerOptions["authorize"];
	readonly #maxConcurrentStarts: number;
	readonly #entries = new Map<string, Entry>();
	#activeStarts = 0;
	#startQueue: Array<() => void> = [];

	public constructor(options: McpConnectionManagerOptions) {
		this.#factory = options.factory;
		this.#authorize = options.authorize;
		this.#maxConcurrentStarts = validPositive(options.maxConcurrentStarts ?? 4) ? options.maxConcurrentStarts ?? 4 : 4;
	}

	public snapshot(serverId: string): McpServerSnapshot | undefined {
		const entry = this.#entries.get(serverId);
		return entry === undefined ? undefined : this.#toSnapshot(entry);
	}

	public snapshots(): readonly McpServerSnapshot[] {
		return [...this.#entries.values()].sort((left, right) => left.config.serverId.localeCompare(right.config.serverId)).map((entry) => this.#toSnapshot(entry));
	}

	public async start(config: McpServerConfig, signal?: AbortSignal): Promise<McpManagerResult<McpServerSnapshot>> {
		if (config.serverId.length === 0 || config.displayName.length === 0 || !validPositive(config.startupTimeoutMs) || !validPositive(config.toolTimeoutMs)) {
			return failure("invalid_config", "MCP server config contains an empty identity or invalid timeout", false);
		}
		const existing = this.#entries.get(config.serverId);
		if (existing?.client !== undefined) await this.#closeEntry(existing);
		const entry: Entry = { config, state: config.enabled ? "starting" : "disabled", generation: (existing?.generation ?? 0) + 1, tools: [], diagnostics: [] };
		this.#entries.set(config.serverId, entry);
		if (!config.enabled) return { ok: true, value: this.#toSnapshot(entry) };
		if (!config.trusted) {
			entry.state = "blocked-untrusted";
			entry.diagnostics.push({ code: "mcp.untrusted", message: "MCP server trust is not current", severity: "warning" });
			return failure("blocked_untrusted", "MCP server is not trusted", false);
		}
		await this.#acquireStartSlot();
		try {
			const client = await withTimeout((childSignal) => this.#factory.connect(config, childSignal), config.startupTimeoutMs, signal);
			entry.client = client;
			const definitions = await withTimeout((childSignal) => client.listTools(childSignal), config.startupTimeoutMs, signal);
			const built = stableTools(definitions, config);
			if (!built.ok) {
				entry.state = "failed";
				entry.diagnostics.push({ code: "mcp.catalog_conflict", message: built.error.message, severity: "error" });
				await this.#closeEntry(entry);
				return built as McpManagerResult<McpServerSnapshot>;
			}
			entry.tools = built.value;
			entry.state = "ready";
			return { ok: true, value: this.#toSnapshot(entry) };
		} catch (error) {
			entry.state = error instanceof McpOperationError && error.code === "timeout" ? "failed" : "failed";
			const code = error instanceof McpOperationError && error.code === "timeout" ? "mcp.startup_timeout" : "mcp.startup_failed";
			const message = error instanceof Error ? error.message : "MCP server startup failed";
			entry.diagnostics.push({ code, message, severity: "error" });
			return failure("startup_failed", message, true);
		} finally {
			this.#releaseStartSlot();
		}
	}

	public async call(input: { readonly serverId: string; readonly toolName: string; readonly input: unknown }, signal?: AbortSignal): Promise<McpManagerResult<McpCallValue>> {
		const entry = this.#entries.get(input.serverId);
		if (entry === undefined || entry.state !== "ready" || entry.client === undefined) return failure("server_not_ready", "MCP server is not ready", true);
		const descriptor = entry.tools.find((tool) => tool.rawName === input.toolName);
		if (descriptor === undefined) return failure("tool_not_found", "MCP tool is not enabled or does not exist", false);
		if (this.#authorize !== undefined) {
			const decision = await this.#authorize({ serverId: input.serverId, toolName: input.toolName, input: input.input, descriptor }, signal);
			if (decision.decision === "deny") return failure("authorization_denied", decision.reason ?? "MCP tool call was denied", false);
		}
		const timeoutMs = entry.config.toolTimeouts?.[input.toolName] ?? entry.config.toolTimeoutMs;
		try {
			const raw = await withTimeout((childSignal) => entry.client!.callTool(input.toolName, input.input, childSignal), timeoutMs, signal);
			const normalized = normalizeResult(raw, entry.config.maxResultBytes ?? 2 * 1024 * 1024);
			return {
				ok: true,
				value: {
					serverId: input.serverId,
					toolName: input.toolName,
					outcome: raw.isError ? "error" : "ok",
					...normalized,
					contentDigest: runtimeDigest(normalized.content),
				},
			};
		} catch (error) {
			const timeout = error instanceof McpOperationError && error.code === "timeout";
			return failure(timeout ? "tool_timeout" : "tool_failed", error instanceof Error ? error.message : "MCP tool call failed", timeout);
		}
	}

	public async closeAll(): Promise<void> {
		for (const entry of this.#entries.values()) await this.#closeEntry(entry);
	}

	async #closeEntry(entry: Entry): Promise<void> {
		if (entry.client === undefined) {
			if (entry.state !== "disabled" && entry.state !== "blocked-untrusted") entry.state = "stopped";
			return;
		}
		entry.state = "stopping";
		const client = entry.client;
		entry.client = undefined;
		try {
			await client.close();
		} finally {
			entry.state = "stopped";
		}
	}

	async #acquireStartSlot(): Promise<void> {
		if (this.#activeStarts < this.#maxConcurrentStarts) {
			this.#activeStarts += 1;
			return;
		}
		await new Promise<void>((resolve) => this.#startQueue.push(resolve));
		this.#activeStarts += 1;
	}

	#releaseStartSlot(): void {
		this.#activeStarts -= 1;
		this.#startQueue.shift()?.();
	}

	#toSnapshot(entry: Entry): McpServerSnapshot {
		return {
			serverId: entry.config.serverId,
			displayName: entry.config.displayName,
			transport: entry.config.transport,
			required: entry.config.required,
			state: entry.state,
			generation: entry.generation,
			tools: [...entry.tools],
			diagnostics: [...entry.diagnostics],
		};
	}
}
