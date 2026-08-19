import type { ProviderEnv } from "../types.ts";
import { getProviderEnvValue } from "./provider-env.ts";

const DEFAULT_PROXY_PORTS: Record<string, number> = {
	ftp: 21,
	gopher: 70,
	http: 80,
	https: 443,
	ws: 80,
	wss: 443,
};

const providerProxyCache = new Map<string, string | null>();

function getProxyEnv(key: string, env?: ProviderEnv): string {
	const lowercaseKey = key.toLowerCase();
	const uppercaseKey = key.toUpperCase();
	return (
		env?.[lowercaseKey] ||
		env?.[uppercaseKey] ||
		getProviderEnvValue(lowercaseKey) ||
		getProviderEnvValue(uppercaseKey) ||
		""
	);
}

function parseProxyTargetUrl(targetUrl: string | URL): URL | undefined {
	if (targetUrl instanceof URL) {
		return targetUrl;
	}

	try {
		return new URL(targetUrl);
	} catch {
		return undefined;
	}
}

/** 归一化 provider id，供 RUNLEDGER_PROXY_<PROVIDER> 使用。 */
export function normalizeProviderProxyKey(providerId: string): string {
	return providerId.toUpperCase().replace(/[^A-Z0-9]/g, "_");
}

function isLoopbackHostname(hostname: string): boolean {
	const normalizedHostname = hostname.replace(/^\[|\]$/g, "").toLowerCase();
	return normalizedHostname === "localhost" || normalizedHostname === "::1" || /^127(?:\.\d{1,3}){3}$/u.test(normalizedHostname);
}

function shouldProxyHostname(hostname: string, port: number, env?: ProviderEnv): boolean {
	if (isLoopbackHostname(hostname)) {
		return false;
	}

	const noProxy = getProxyEnv("no_proxy", env).toLowerCase();
	if (!noProxy) {
		return true;
	}
	if (noProxy === "*") {
		return false;
	}

	return noProxy.split(/[,\s]/).every((proxy) => {
		if (!proxy) {
			return true;
		}

		const parsedProxy = proxy.match(/^(.+):(\d+)$/);
		let proxyHostname = parsedProxy ? parsedProxy[1]! : proxy;
		const proxyPort = parsedProxy ? Number.parseInt(parsedProxy[2]!, 10) : 0;
		if (proxyPort && proxyPort !== port) {
			return true;
		}

		proxyHostname = proxyHostname.replace(/^\[|\]$/g, "");
		if (!/^[.*]/.test(proxyHostname)) {
			return hostname !== proxyHostname;
		}

		if (proxyHostname.startsWith("*")) {
			proxyHostname = proxyHostname.slice(1);
		}
		return !hostname.endsWith(proxyHostname);
	});
}

function proxyProtocolForTarget(protocol: string): string {
	if (protocol === "https" || protocol === "wss") {
		return "https";
	}
	if (protocol === "http" || protocol === "ws") {
		return "http";
	}
	return protocol;
}

function proxyEnvironmentKeyForTarget(protocol: string): string {
	if (protocol === "https" || protocol === "wss") {
		return "https_proxy";
	}
	if (protocol === "http" || protocol === "ws") {
		return "http_proxy";
	}
	return `${protocol}_proxy`;
}

function getProxyForUrl(providerId: string | undefined, targetUrl: string | URL, env?: ProviderEnv): string {
	const parsedUrl = parseProxyTargetUrl(targetUrl);
	if (!parsedUrl?.protocol || !parsedUrl.host) {
		return "";
	}

	const protocol = parsedUrl.protocol.split(":", 1)[0]!;
	const hostname = parsedUrl.hostname.toLowerCase();
	const port = Number.parseInt(parsedUrl.port, 10) || DEFAULT_PROXY_PORTS[protocol] || 0;
	if (!shouldProxyHostname(hostname, port, env)) {
		return "";
	}

	const providerProxy = providerId ? getProxyEnv(`RUNLEDGER_PROXY_${normalizeProviderProxyKey(providerId)}`, env) : "";
	let proxy =
		providerProxy ||
		getProxyEnv("RUNLEDGER_PROXY", env) ||
		getProxyEnv(proxyEnvironmentKeyForTarget(protocol), env) ||
		getProxyEnv("all_proxy", env);
	if (proxy && !proxy.includes("://")) {
		proxy = `${proxyProtocolForTarget(protocol)}://${proxy}`;
	}
	return proxy;
}

export const UNSUPPORTED_PROXY_PROTOCOL_MESSAGE =
	"Unsupported proxy protocol. SOCKS and PAC proxy URLs are not supported; use an HTTP or HTTPS proxy URL.";

function validateProxyUrl(proxy: string): string {
	let proxyUrl: URL;
	try {
		proxyUrl = new URL(proxy);
	} catch {
		throw new Error("Invalid proxy URL");
	}

	if (proxyUrl.protocol !== "http:" && proxyUrl.protocol !== "https:") {
		throw new Error(`${UNSUPPORTED_PROXY_PROTOCOL_MESSAGE} Got ${proxyUrl.protocol}`);
	}

	return proxy;
}

/** 单次解析 provider 出站代理，不读取或写入缓存。 */
export function resolveProviderProxyUrl(providerId: string, targetUrl: string | URL, env?: ProviderEnv): string {
	const proxy = getProxyForUrl(providerId, targetUrl, env);
	return proxy ? validateProxyUrl(proxy) : "";
}

/** 按 provider 与归一化目标 URL 缓存进程生命周期内的代理解析结果。 */
export function getCachedProviderProxyUrl(
	providerId: string,
	targetUrl: string | URL,
	env?: ProviderEnv,
): URL | undefined {
	const parsedTargetUrl = parseProxyTargetUrl(targetUrl);
	if (!parsedTargetUrl) {
		return undefined;
	}

	const cacheKey = `${normalizeProviderProxyKey(providerId)}\u0000${parsedTargetUrl.toString()}`;
	const cachedProxy = providerProxyCache.get(cacheKey);
	if (cachedProxy !== undefined) {
		return cachedProxy === null ? undefined : new URL(cachedProxy);
	}

	const proxy = resolveProviderProxyUrl(providerId, parsedTargetUrl, env);
	providerProxyCache.set(cacheKey, proxy || null);
	return proxy ? new URL(proxy) : undefined;
}

export function resolveHttpProxyUrlForTarget(targetUrl: string | URL, env?: ProviderEnv): URL | undefined {
	const proxy = resolveProviderProxyUrl("", targetUrl, env);
	if (!proxy) {
		return undefined;
	}

	return new URL(proxy);
}
