import { AsyncLocalStorage } from "node:async_hooks";
import { createProxyFetchForUrl } from "./proxy-agent.ts";

interface ProviderFetchScope {
	readonly fetch: typeof globalThis.fetch;
}

const providerFetchScopes = new AsyncLocalStorage<ProviderFetchScope>();
let fallbackFetch = globalThis.fetch;

const routedFetch: typeof globalThis.fetch = (input, init) => {
	const scope = providerFetchScopes.getStore();
	return scope ? scope.fetch(input, init) : fallbackFetch(input, init);
};

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
