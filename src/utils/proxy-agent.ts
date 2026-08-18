import { Readable } from "node:stream";
import { HttpProxyAgent } from "http-proxy-agent";
import { HttpsProxyAgent } from "https-proxy-agent";
import nodeFetch, {
	type Request as NodeFetchRequest,
	type RequestInit as NodeFetchRequestInit,
	type Response as NodeFetchResponse,
} from "node-fetch";

export interface BunProxyAgent {
	proxy: string;
}

export type NodeProxyAgent = HttpProxyAgent<string> | HttpsProxyAgent<string>;
export type ProxyAgent = NodeProxyAgent | BunProxyAgent;

export interface ProxyFetchOptions {
	/** Use the direct node-fetch bridge even when global fetch is test-wrapped or routed. */
	readonly forceNodeFetch?: boolean;
	/** Use this already-captured fetch implementation instead of looking up global fetch later. */
	readonly baseFetch?: typeof globalThis.fetch;
}

type NodeFetchFunction = (
	input: string | URL | NodeFetchRequest,
	init?: NodeFetchRequestInit,
) => Promise<NodeFetchResponse>;

const nodeFetchFunction = nodeFetch as unknown as NodeFetchFunction;
const originalGlobalFetch = globalThis.fetch;

function toWebResponse(response: NodeFetchResponse): Response {
	const body = response.body
		? (Readable.toWeb(response.body as unknown as Readable) as unknown as ReadableStream<Uint8Array>)
		: null;
	return new Response(body, {
		status: response.status,
		statusText: response.statusText,
		headers: Object.fromEntries(response.headers.entries()),
	});
}

function hasCustomFetchImplementation(): boolean {
	const currentFetch = globalThis.fetch as typeof globalThis.fetch & { mock?: unknown };
	return currentFetch !== originalGlobalFetch || currentFetch.mock !== undefined;
}

function isBunRuntime(): boolean {
	return Boolean(process.versions.bun);
}

function parseTargetUrl(targetUrl: string | URL): URL {
	return targetUrl instanceof URL ? targetUrl : new URL(targetUrl);
}

function isBunProxyAgent(agent: ProxyAgent): agent is BunProxyAgent {
	return "proxy" in agent && typeof agent.proxy === "string";
}

/**
 * 创建与目标协议匹配的出站代理 transport。
 * Bun 的 fetch 直接接受 proxy 选项，Node 则使用 node-fetch 的 agent 扩展。
 */
export function createProxyAgentForUrl(targetUrl: string | URL, proxyUrl: string | URL): ProxyAgent {
	const target = parseTargetUrl(targetUrl);
	const proxy = proxyUrl.toString();

	if (isBunRuntime()) {
		return { proxy };
	}

	switch (target.protocol) {
		case "http:":
		case "ws:":
			return new HttpProxyAgent(proxy);
		case "https:":
		case "wss:":
			return new HttpsProxyAgent(proxy);
		default:
			throw new Error(`Unsupported target protocol for proxy agent: ${target.protocol}`);
	}
}

function isRequestInput(input: Parameters<typeof globalThis.fetch>[0]): input is Request {
	return typeof Request !== "undefined" && input instanceof Request;
}

async function buildNodeFetchArguments(
	input: Parameters<typeof globalThis.fetch>[0],
	init: Parameters<typeof globalThis.fetch>[1],
	agent: NodeProxyAgent,
): Promise<{ input: string | URL; init: NodeFetchRequestInit }> {
	if (!isRequestInput(input)) {
		return {
			input,
			init: {
				...(init as unknown as NodeFetchRequestInit | undefined),
				agent,
			},
		};
	}

	const body =
		init?.body ??
		(input.method !== "GET" && input.method !== "HEAD" && input.body
			? Buffer.from(await input.clone().arrayBuffer())
			: undefined);
	const nodeInit: NodeFetchRequestInit = {
		...(init as unknown as NodeFetchRequestInit | undefined),
		method: init?.method ?? input.method,
		headers: (init?.headers ?? Object.fromEntries(input.headers.entries())) as unknown as NodeFetchRequestInit["headers"],
		agent,
		signal: (init?.signal ?? input.signal) as unknown as NodeFetchRequestInit["signal"],
		...(body !== undefined ? { body: body as NodeFetchRequestInit["body"] } : {}),
	};

	return { input: input.url, init: nodeInit };
}

/**
 * 为支持自定义 fetch 的 SDK 创建 provider-scoped fetch。
 * 没有该适配器时不能把 Node http.Agent 直接塞进 undici fetch。
 */
export function createProxyFetchForUrl(
	targetUrl: string | URL,
	proxyUrl: string | URL,
	options: ProxyFetchOptions = {},
): typeof globalThis.fetch {
	const agent = createProxyAgentForUrl(targetUrl, proxyUrl);
	const baseFetch = options.baseFetch ?? globalThis.fetch;

	if (isBunProxyAgent(agent)) {
		return (input, init) =>
			baseFetch(input, {
				...init,
				proxy: agent.proxy,
			} as RequestInit & { proxy: string });
	}

	// SDK consumers and tests may deliberately replace global fetch. Preserve that
	// transport while still exposing the Node agent extension it can understand.
	if (!options.forceNodeFetch && hasCustomFetchImplementation()) {
		return (input, init) =>
			baseFetch(input, {
				...init,
				agent,
			} as RequestInit & { agent: NodeProxyAgent });
	}

	return async (input, init) => {
		const argumentsForNodeFetch = await buildNodeFetchArguments(input, init, agent);
		const response = await nodeFetchFunction(argumentsForNodeFetch.input, argumentsForNodeFetch.init);
		return toWebResponse(response);
	};
}
