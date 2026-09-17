/**
 * MCP JSON-RPC 2.0 over HTTP。
 *
 * 来源：oh-my-pi `coding-agent/src/mcp/json-rpc.ts`（快照 `1c0303b1`）的已用面：
 * `callMCP` / `readMcpJsonRpcResponse` / `redactUrlForLog` 与 `JsonRpcResponse`。
 * exa、parallel、zai 三个 provider 的 keyless / MCP 路径依赖它。
 *
 * 与上游的差异：
 * - 传输由调用方注入（`fetch` 选项），不再默认全局 `fetch`；
 * - 上游经 `pi-utils` 的 `logger` / `readSseEvents`，此处用最小 SSE 解析替代，
 *   且不写日志（RunLedger 的 trace 由受治 recorder 负责，不在库层落盘）。
 */

export interface JsonRpcResponse {
	readonly jsonrpc: "2.0";
	readonly id: string | number;
	readonly result?: unknown;
	readonly error?: { readonly code: number; readonly message: string; readonly data?: unknown };
}

/** 单个 MCP HTTP 请求在调用方未提供 signal 时的硬上限。 */
const MCP_DEFAULT_TIMEOUT_MS = 60_000;

const SENSITIVE_QUERY_PARAM = /key|token|secret|auth/i;

/** 抹掉承载凭据的查询参数，避免错误信息回显密钥。 */
export function redactUrlForLog(url: string): string {
	try {
		const parsed = new URL(url);
		for (const name of parsed.searchParams.keys()) {
			if (SENSITIVE_QUERY_PARAM.test(name)) parsed.searchParams.set(name, "[redacted]");
		}
		return parsed.toString();
	} catch {
		return url.split("?")[0];
	}
}

function decodeJsonRpcResponse(message: unknown): JsonRpcResponse | null {
	if (typeof message !== "object" || message === null || Array.isArray(message)) {
		throw new SyntaxError("Malformed JSON-RPC message");
	}
	const record = message as Record<string, unknown>;
	if (record.jsonrpc !== "2.0") throw new SyntaxError("Malformed JSON-RPC message");

	const hasResult = Object.hasOwn(record, "result");
	const hasError = Object.hasOwn(record, "error");
	if ("method" in record) {
		if (
			typeof record.method !== "string" ||
			hasResult ||
			hasError ||
			("id" in record && typeof record.id !== "string" && typeof record.id !== "number")
		) {
			throw new SyntaxError("Malformed JSON-RPC request");
		}
		return null;
	}

	if (typeof record.id !== "string" && typeof record.id !== "number") {
		throw new SyntaxError("Malformed JSON-RPC response");
	}
	if (hasResult === hasError) throw new SyntaxError("Malformed JSON-RPC response");

	if (hasError) {
		const error = record.error;
		if (typeof error !== "object" || error === null || Array.isArray(error)) {
			throw new SyntaxError("Malformed JSON-RPC error response");
		}
		const detail = error as Record<string, unknown>;
		if (typeof detail.code !== "number" || typeof detail.message !== "string") {
			throw new SyntaxError("Malformed JSON-RPC error response");
		}
		return {
			jsonrpc: "2.0",
			id: record.id,
			error: {
				code: detail.code,
				message: detail.message,
				...(Object.hasOwn(detail, "data") ? { data: detail.data } : {}),
			},
		};
	}

	return { jsonrpc: "2.0", id: record.id, result: record.result };
}

/**
 * 从 JSON 或 SSE 响应里读出与请求 id 匹配的 JSON-RPC 响应。
 *
 * 通知、服务端请求与其他 id 的响应都不满足本次请求；格式错误一律失败。
 */
export async function readMcpJsonRpcResponse(
	response: Response,
	expectedId: string | number,
	signal?: AbortSignal,
): Promise<JsonRpcResponse> {
	let sawUnmatchedResponse = false;

	const selectMessage = (message: unknown): JsonRpcResponse | null => {
		const decoded = decodeJsonRpcResponse(message);
		if (!decoded) return null;
		if (decoded.id === expectedId) return decoded;
		sawUnmatchedResponse = true;
		return null;
	};
	const selectResponse = (payload: unknown): JsonRpcResponse | null => {
		if (!Array.isArray(payload)) return selectMessage(payload);
		for (const message of payload) {
			const matched = selectMessage(message);
			if (matched) return matched;
		}
		return null;
	};

	signal?.throwIfAborted();
	if (response.headers.get("Content-Type")?.toLowerCase().includes("text/event-stream")) {
		if (!response.body) throw new Error("MCP SSE response did not include a body");
		for await (const data of readSseData(response.body, signal)) {
			if (data === "" || data === "[DONE]") continue;
			const matched = selectResponse(JSON.parse(data) as unknown);
			if (matched) {
				signal?.throwIfAborted();
				return matched;
			}
		}
	} else {
		const matched = selectResponse(await response.json());
		if (matched) {
			signal?.throwIfAborted();
			return matched;
		}
	}
	signal?.throwIfAborted();

	if (sawUnmatchedResponse) throw new Error("MCP response ID did not match request ID");
	throw new Error("MCP response did not include a result or error");
}

/** 最小 SSE `data:` 行解析（上游 `pi-utils/stream.ts:readSseEvents` 的已用子集）。 */
async function* readSseData(stream: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<string> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	try {
		for (;;) {
			signal?.throwIfAborted();
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			let newline = buffer.indexOf("\n");
			while (newline !== -1) {
				const line = buffer.slice(0, newline).replace(/\r$/, "");
				buffer = buffer.slice(newline + 1);
				if (line.startsWith("data:")) yield line.slice(5).trimStart();
				newline = buffer.indexOf("\n");
			}
		}
		const tail = buffer.trim();
		if (tail.startsWith("data:")) yield tail.slice(5).trimStart();
	} finally {
		reader.releaseLock();
	}
}

/** 单次 MCP JSON-RPC HTTP 请求的控制项。 */
export interface CallMcpOptions {
	readonly signal?: AbortSignal;
	readonly fetch?: (input: string, init?: RequestInit) => Promise<Response>;
	readonly headers?: Record<string, string>;
	/** 非 2xx 响应的错误映射（body 已读取）。 */
	readonly onHttpError?: (response: Response, body: string) => Error;
	/** 解析失败/不匹配时的错误映射。 */
	readonly onParseError?: (error: unknown) => Error;
}

/** 以 JSON-RPC 2.0 over HTTP 调用 MCP server。 */
export async function callMCP(
	url: string,
	method: string,
	params?: Record<string, unknown>,
	options?: CallMcpOptions,
): Promise<JsonRpcResponse> {
	const body = {
		jsonrpc: "2.0",
		id: Math.random().toString(36).slice(2),
		method,
		params: params ?? {},
	};
	const signal = options?.signal ?? AbortSignal.timeout(MCP_DEFAULT_TIMEOUT_MS);

	const response = await (options?.fetch ?? fetch)(url, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Accept: "application/json, text/event-stream",
			...options?.headers,
		},
		body: JSON.stringify(body),
		signal,
	});

	if (!response.ok) {
		if (options?.onHttpError) throw options.onHttpError(response, await response.text());
		throw new Error(`MCP request failed: ${response.status} ${response.statusText}`);
	}

	try {
		return await readMcpJsonRpcResponse(response, body.id, signal);
	} catch (error) {
		throw options?.onParseError?.(error) ?? error;
	}
}
