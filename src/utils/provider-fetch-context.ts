import { AsyncLocalStorage } from "node:async_hooks";
import { createProxyFetchForUrl, type FetchFunction } from "./proxy-agent.ts";

interface ProviderFetchScope {
	readonly fetch: FetchFunction;
}

const providerFetchScopes = new AsyncLocalStorage<ProviderFetchScope>();
let fallbackFetch = globalThis.fetch;

// 只拦截调用，保留 Bun fetch.preconnect 等宿主函数成员。
const routedFetch = new Proxy(globalThis.fetch, {
	apply(_target, _receiver, args: Parameters<typeof globalThis.fetch>) {
		const scope = providerFetchScopes.getStore();
		return scope ? scope.fetch(...args) : fallbackFetch(...args);
	},
});

function installProviderFetchRouter(): void {
	if (globalThis.fetch === routedFetch) return;
	fallbackFetch = globalThis.fetch;
	globalThis.fetch = routedFetch;
}

/** Run an SDK request in an async-local provider proxy scope without mutating request-global proxy state. */
export function runWithProviderProxyFetch<T>(
	targetUrl: string | URL,
	proxyUrl: string | URL,
	action: () => Promise<T>,
): Promise<T> {
	installProviderFetchRouter();
	const proxyFetch = createProxyFetchForUrl(targetUrl, proxyUrl, {
		forceNodeFetch: true,
		baseFetch: fallbackFetch,
	});
	return providerFetchScopes.run({ fetch: proxyFetch }, action);
}
