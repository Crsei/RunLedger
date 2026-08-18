import type { ProviderEnv } from "../types.ts";
import { getCachedProviderProxyUrl } from "./node-http-proxy.ts";
import { createProxyFetchForUrl } from "./proxy-agent.ts";

type FetchInput = Parameters<typeof globalThis.fetch>[0];
type FetchInit = Parameters<typeof globalThis.fetch>[1];

function resolveTargetUrl(input: FetchInput): string | URL {
	if (typeof input === "string" || input instanceof URL) {
		return input;
	}
	return input.url;
}

/** 为裸 fetch 请求按 provider 注入代理，未命中代理时保留原生 fetch 语义。 */
export function fetchWithProviderProxy(
	providerId: string,
	input: FetchInput,
	init?: FetchInit,
	env?: ProviderEnv,
): ReturnType<typeof globalThis.fetch> {
	const targetUrl = resolveTargetUrl(input);
	const proxyUrl = getCachedProviderProxyUrl(providerId, targetUrl, env);
	if (!proxyUrl) {
		return globalThis.fetch(input, init);
	}

	return createProxyFetchForUrl(targetUrl, proxyUrl)(input, init);
}
