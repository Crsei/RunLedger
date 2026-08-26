import { AsyncLocalStorage } from "node:async_hooks";
import { createProxyFetchForUrl } from "./proxy-agent.ts";
import {
	meteredProviderFetch,
	runWithLocalTelemetry,
	type LocalTelemetryContext,
} from "../runtime/telemetry/local/provider.ts";

interface ProviderFetchScope {
	readonly fetch: typeof globalThis.fetch;
}

const providerFetchScopes = new AsyncLocalStorage<ProviderFetchScope>();
let fallbackFetch = globalThis.fetch;

const routedFetch: typeof globalThis.fetch = (input, init) => {
	const scope = providerFetchScopes.getStore();
	return meteredProviderFetch(scope?.fetch ?? fallbackFetch, input, init);
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

/**
 * 安装一次 provider fetch router，并把 local telemetry scope 置于 action
 * 的整个 async 生命周期内。SDK 在首次迭代 stream 时才发出的 fetch 也会
 * 继承同一 correlation。
 */
export function runWithProviderTelemetry<T>(context: LocalTelemetryContext, action: () => Promise<T>): Promise<T> {
	installProviderFetchRouter();
	return runWithLocalTelemetry(context, action);
}
