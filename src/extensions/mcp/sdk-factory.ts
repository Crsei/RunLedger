/**
 * Official MCP SDK transport adapter.
 *
 * The extension manager consumes only McpTransportClient.  This adapter owns
 * the SDK Client/Transport pair and exposes bounded tool DTOs; production Host
 * composition may replace the stdio transport constructor with a managed
 * process transport without changing the extension contract.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport, type StdioServerParameters } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { isAbsolute } from "node:path";
import type { PolicyNetworkClient } from "../../security/policy-network.ts";
import type { ExecutionHandleRef } from "../../runtime/process/types.ts";
import type { OutputCursor } from "../../runtime/process/output.ts";
import type { ProcessToolClient } from "../../runtime/tools/process-tool-support.ts";
import type { ManagedBackgroundBashOperations } from "../../runtime/tools/bash.ts";
import type {
	McpClientFactory,
	McpRawContent,
	McpRawToolResult,
	McpServerConfig,
	McpToolDefinition,
	McpTransportClient,
} from "./types.ts";

export interface SdkMcpClientFactoryOptions {
	readonly clientName?: string;
	readonly clientVersion?: string;
	readonly stdioTransport?: (config: McpServerConfig, signal?: AbortSignal) => Promise<Transport> | Transport;
	/** Host-owned process facade used for production stdio MCP servers. */
	readonly managedProcess?: ProcessToolClient & Pick<ManagedBackgroundBashOperations, "start">;
	/** Absolute execution root supplied by the Host when stdio config omits cwd. */
	readonly managedProcessCwd?: string;
	readonly httpFetch?: FetchLike;
}

/** Adapts the Host/Gateway network port to the SDK FetchLike contract. */
export function createMcpGatewayFetch(network: PolicyNetworkClient, maxBytes = 2 * 1024 * 1024): FetchLike {
	return async (input, init = {}) => {
		const url = typeof input === "string" ? input : input.toString();
		const headers = Object.fromEntries(new Headers(init.headers).entries());
		let body: string | Buffer | undefined;
		if (typeof init.body === "string") body = init.body;
		else if (init.body !== undefined) body = Buffer.from(await new Response(init.body).arrayBuffer());
		const result = await network.request({
			url,
			method: init.method ?? "GET",
			headers,
			...(body === undefined ? {} : { body }),
			maxBytes,
		}, init.signal ?? undefined);
		if (!result.ok) throw new Error(result.error.message);
		return new Response(new Uint8Array(result.value.body), { status: result.value.status, headers: result.value.headers });
	};
}

const RESERVED_ENVIRONMENT_KEYS = new Set([
	"BASH_ENV",
	"ENV",
	"LD_LIBRARY_PATH",
	"LD_PRELOAD",
	"NODE_OPTIONS",
	"RUNLEDGER_HOOK_EVENT",
	"RUNLEDGER_HOOK_ID",
	"RUNLEDGER_SESSION_ID",
	"RUNLEDGER_HOST_HOME",
	"RUNLEDGER_HOST_SCOPE",
	"RUNLEDGER_HOST_CWD",
	]);

function filteredEnvironment(explicit: Readonly<Record<string, string>> | undefined): Record<string, string> {
	const result: Record<string, string> = {};
	for (const [key, value] of Object.entries(getDefaultEnvironment())) {
		if (!RESERVED_ENVIRONMENT_KEYS.has(key) && !key.startsWith("RUNLEDGER_")) result[key] = value;
	}
	for (const [key, value] of Object.entries(explicit ?? {})) {
		if (/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) && !RESERVED_ENVIRONMENT_KEYS.has(key) && !key.startsWith("RUNLEDGER_")) result[key] = value;
	}
	return result;
}

function shellQuote(value: string): string {
	return value.length === 0 ? "''" : `'${value.replaceAll("'", "'\\''")}'`;
}

function managedStdioCommand(config: McpServerConfig): string {
	if (config.stdio === undefined || config.stdio.command.length === 0) throw new Error("MCP stdio command is missing");
	const environment = Object.entries(config.stdio.env ?? {})
		.filter(([key]) => /^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) && !RESERVED_ENVIRONMENT_KEYS.has(key) && !key.startsWith("RUNLEDGER_"))
		.sort(([left], [right]) => left.localeCompare(right));
	const assignments = environment.map(([key, value]) => `${key}=${shellQuote(value)}`);
	return [...assignments, shellQuote(config.stdio.command), ...(config.stdio.args ?? []).map(shellQuote)].join(" ");
}

function sameCursor(left: OutputCursor, right: OutputCursor): boolean {
	return left.sequence === right.sequence && left.byteOffset === right.byteOffset;
}

interface ManagedMcpProcessPort extends ProcessToolClient {
	start(input: Parameters<ManagedBackgroundBashOperations["start"]>[0]): ReturnType<ManagedBackgroundBashOperations["start"]>;
}

/**
 * JSONL MCP transport backed by the Host process facade.
 *
 * MCP's stdio wire is line-delimited JSON. This adapter deliberately keeps
 * only a safe execution handle and output cursor; it never sees a PID, pipe,
 * PTY handle, spool path, or child-process object.
 */
class HostManagedMcpTransport implements Transport {
	private readonly processPort: ManagedMcpProcessPort;
	private readonly config: McpServerConfig;
	private readonly executionCwd: string | undefined;
	private readonly signal: AbortSignal | undefined;
	private handle: ExecutionHandleRef | undefined;
	private cursor: OutputCursor = { sequence: 0, byteOffset: 0 };
	private pendingText = "";
	private pumpPromise: Promise<void> | undefined;
	private abortListener: (() => void) | undefined;
	private started = false;
	private closed = false;
	private closeNotified = false;

	public onclose?: () => void;
	public onerror?: (error: Error) => void;
	public onmessage?: <T extends JSONRPCMessage>(message: T) => void;

	public constructor(processPort: ManagedMcpProcessPort, config: McpServerConfig, executionCwd?: string, signal?: AbortSignal) {
		this.processPort = processPort;
		this.config = config;
		this.executionCwd = executionCwd;
		this.signal = signal;
	}

	public async start(): Promise<void> {
		if (this.started) return;
		if (this.closed) throw new Error("MCP managed transport is closed");
		if (this.signal?.aborted) throw new Error("MCP managed transport was aborted");
		const stdio = this.config.stdio;
		if (stdio === undefined) throw new Error("MCP stdio configuration is missing");
		const cwd = stdio.cwd ?? this.executionCwd;
		if (cwd === undefined || !isAbsolute(cwd)) throw new Error("MCP managed stdio cwd must be an absolute Host path");
		const started = await this.processPort.start({
			command: managedStdioCommand(this.config),
			cwd,
			timeoutMs: this.config.startupTimeoutMs,
			...(this.signal === undefined ? {} : { signal: this.signal }),
		});
		if (!started.ok) throw new Error(`MCP managed process start failed: ${started.code}`);
		this.handle = started.handle;
		this.started = true;
		if (this.signal !== undefined) {
			this.abortListener = () => { void this.close(); };
			this.signal.addEventListener("abort", this.abortListener, { once: true });
		}
		this.pumpPromise = this.pumpOutput();
	}

	public async send(message: JSONRPCMessage): Promise<void> {
		if (!this.started || this.closed || this.handle === undefined) throw new Error("MCP managed transport is not ready");
		let line: string;
		try {
			line = JSON.stringify(message);
		} catch {
			throw new Error("MCP JSON-RPC message is not serializable");
		}
		const written = await this.processPort.write(this.handle, "driver", `${line}\n`);
		if (!written.ok) throw new Error(`MCP managed transport write failed: ${written.code}`);
	}

	public async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		if (this.signal !== undefined && this.abortListener !== undefined) this.signal.removeEventListener("abort", this.abortListener);
		const handle = this.handle;
		if (handle !== undefined) {
			await this.stopAndReap(handle);
		}
		await this.pumpPromise?.catch(() => undefined);
		this.notifyClose();
	}

	private async stopAndReap(handle: ExecutionHandleRef): Promise<void> {
		await this.processPort.stop(handle, "driver", "SIGTERM").catch(() => undefined);
		const first = await this.processPort.processWait(handle, 1_000, "driver").catch(() => undefined);
		if (first?.ok === true && (first.outcome === "terminal" || first.outcome === "uncertain")) return;
		await this.processPort.stop(handle, "driver", "SIGKILL").catch(() => undefined);
		await this.processPort.processWait(handle, 1_000, "driver").catch(() => undefined);
	}

	private async pumpOutput(): Promise<void> {
		try {
			while (!this.closed && this.handle !== undefined) {
				const before = this.cursor;
				const output = await this.processPort.processOutput(this.handle, this.cursor, 64 * 1024);
				if (!output.ok) throw new Error(`MCP managed transport output failed: ${output.code}`);
				this.cursor = output.page.nextCursor;
				if (output.page.text.length > 0) this.consumeText(output.page.text);
				if (this.closed) break;
				if (output.page.truncated && !sameCursor(before, output.page.nextCursor)) continue;
				const waited = await this.processPort.processWait(this.handle, 500, "driver");
				if (!waited.ok) throw new Error(`MCP managed transport wait failed: ${waited.code}`);
				if (waited.outcome === "terminal" || waited.outcome === "uncertain") {
					const trailing = await this.processPort.processOutput(this.handle, this.cursor, 64 * 1024);
					if (trailing.ok) {
						this.cursor = trailing.page.nextCursor;
						if (trailing.page.text.length > 0) this.consumeText(trailing.page.text);
					}
					if (this.pendingText.trim().length > 0) throw new Error("MCP managed transport ended with an incomplete JSONL message");
					break;
				}
			}
		} catch (error) {
			if (!this.closed) {
				this.reportError(error instanceof Error ? error : new Error("MCP managed transport failed"));
				this.closed = true;
			}
		} finally {
			this.notifyClose();
		}
	}

	private consumeText(text: string): void {
		this.pendingText += text;
		while (true) {
			const newline = this.pendingText.indexOf("\n");
			if (newline < 0) return;
			const line = this.pendingText.slice(0, newline).replace(/\r$/u, "");
			this.pendingText = this.pendingText.slice(newline + 1);
			if (line.length === 0) continue;
			let value: unknown;
			try {
				value = JSON.parse(line) as unknown;
			} catch {
				throw new Error("MCP managed transport received invalid JSONL");
			}
			if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("MCP managed transport received a non-object JSON-RPC message");
			this.onmessage?.(value as JSONRPCMessage);
		}
	}

	private reportError(error: Error): void {
		this.onerror?.(error);
	}

	private notifyClose(): void {
		if (this.closeNotified) return;
		this.closeNotified = true;
		this.onclose?.();
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rawContent(value: unknown): McpRawContent {
	if (!isRecord(value) || typeof value.type !== "string") return { type: "text", text: JSON.stringify(value) ?? "null" };
	if (value.type === "text" && typeof value.text === "string") return { type: "text", text: value.text };
	if (value.type === "image" && typeof value.data === "string" && typeof value.mimeType === "string") return { type: "image", data: value.data, mimeType: value.mimeType };
	if (value.type === "resource" && isRecord(value.resource) && typeof value.resource.uri === "string") {
		return {
			type: "resource",
			uri: value.resource.uri,
			...(typeof value.resource.mimeType === "string" ? { mimeType: value.resource.mimeType } : {}),
			...(typeof value.resource.text === "string" ? { text: value.resource.text } : {}),
		};
	}
	return { type: value.type, ...value };
}

function toolDefinition(value: { readonly name: string; readonly description?: string; readonly inputSchema?: unknown; readonly annotations?: { readonly readOnlyHint?: boolean; readonly destructiveHint?: boolean; readonly idempotentHint?: boolean } }): McpToolDefinition {
	return {
		name: value.name,
		...(value.description === undefined ? {} : { description: value.description }),
		inputSchema: value.inputSchema ?? { type: "object" },
		...(value.annotations === undefined ? {} : {
			annotations: {
				...(value.annotations.readOnlyHint === undefined ? {} : { readOnly: value.annotations.readOnlyHint }),
				...(value.annotations.destructiveHint === undefined ? {} : { destructive: value.annotations.destructiveHint }),
				...(value.annotations.idempotentHint === undefined ? {} : { concurrencySafe: value.annotations.idempotentHint }),
			},
		}),
	};
}

class SdkMcpTransportClient implements McpTransportClient {
	readonly #client: Client;
	readonly #transport: Transport;
	#closed = false;

	public constructor(client: Client, transport: Transport) {
		this.#client = client;
		this.#transport = transport;
	}

	public async listTools(signal?: AbortSignal): Promise<readonly McpToolDefinition[]> {
		const result = await this.#client.listTools({}, { signal });
		return result.tools.map((tool) => toolDefinition(tool));
	}

	public async callTool(toolName: string, input: unknown, signal?: AbortSignal): Promise<McpRawToolResult> {
		const argumentsValue = isRecord(input) ? input : { value: input };
		const result = await this.#client.callTool({ name: toolName, arguments: argumentsValue }, undefined, { signal });
		return {
			isError: result.isError === true,
			content: Array.isArray(result.content) ? result.content.map((item) => rawContent(item)) : [],
		};
	}

	public async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		await this.#client.close().catch(async () => { await this.#transport.close().catch(() => undefined); });
	}
}

function defaultStdioTransport(config: McpServerConfig): Transport {
	if (!config.stdio || config.stdio.command.length === 0) throw new Error("MCP stdio command is missing");
	const parameters: StdioServerParameters = {
		command: config.stdio.command,
		args: [...(config.stdio.args ?? [])],
		env: filteredEnvironment(config.stdio.env),
		stderr: "pipe",
		...(config.stdio.cwd === undefined ? {} : { cwd: config.stdio.cwd }),
	};
	return new StdioClientTransport(parameters);
}

function defaultHttpTransport(config: McpServerConfig, fetchImplementation?: FetchLike): Transport {
	if (config.url === undefined) throw new Error("MCP Streamable HTTP URL is missing");
	const url = new URL(config.url);
	return new StreamableHTTPClientTransport(url, {
		...(fetchImplementation === undefined ? {} : { fetch: fetchImplementation }),
		...(config.headers === undefined ? {} : { requestInit: { headers: config.headers } }),
	});
}

export function createSdkMcpClientFactory(options: SdkMcpClientFactoryOptions = {}): McpClientFactory {
	const clientInfo = {
		name: options.clientName ?? "runledger-runtime-host",
		version: options.clientVersion ?? "0.0.1",
	};
	return {
		connect: async (config, signal) => {
			const transport = config.transport === "stdio"
				? options.managedProcess === undefined
					? await (options.stdioTransport?.(config, signal) ?? defaultStdioTransport(config))
					: new HostManagedMcpTransport(options.managedProcess, config, options.managedProcessCwd, signal)
				: defaultHttpTransport(config, options.httpFetch);
			const client = new Client(clientInfo, { capabilities: {} });
			try {
				await client.connect(transport, { signal });
				return new SdkMcpTransportClient(client, transport);
			} catch (error) {
				await transport.close().catch(() => undefined);
				throw error;
			}
		},
	};
}
