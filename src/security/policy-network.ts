/** 受限网络访问面；实际传输只能通过 Host 注入的 broker port。 */

import type { NetworkPolicy, SecurityResult } from "./types.ts";

const NETWORK_METHODS = new Set(["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]);

export interface NetworkBrokerRequest {
	readonly url: string;
	readonly method: string;
	readonly headers: Readonly<Record<string, string>>;
	readonly body?: string | Buffer;
	readonly maxBytes: number;
}

export interface NetworkBrokerResponse {
	readonly status: number;
	readonly headers: Readonly<Record<string, string>>;
	readonly body: Buffer;
	readonly finalUrl: string;
}

export interface NetworkBrokerPort {
	request(request: NetworkBrokerRequest, signal?: AbortSignal): Promise<NetworkBrokerResponse>;
}

function failure(message: string, retryable = false): SecurityResult<never> {
	return { ok: false, error: { code: "network_denied", message, retryable } };
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validHeaders(value: unknown): value is Readonly<Record<string, string>> {
	return isRecord(value) && Object.values(value).every((entry) => typeof entry === "string");
}

function validPolicy(policy: NetworkPolicy): boolean {
	if (!isRecord(policy) || !Array.isArray(policy.allowedHosts)) return false;
	if (!policy.allowedHosts.every((host) => typeof host === "string" && host.length > 0 && !host.includes("/") && !host.includes("\0"))) return false;
	return policy.mode === "deny" || policy.mode === "allow" || policy.mode === "allowlist";
}

function normalizeHost(value: string): string {
	return value.toLowerCase().replace(/\.$/u, "");
}

function hostAllowed(host: string, policy: NetworkPolicy): boolean {
	if (!validPolicy(policy) || policy.mode === "deny") return false;
	if (policy.mode === "allow") return true;
	const normalizedHost = normalizeHost(host);
	return policy.allowedHosts.some((entry) => {
		const normalizedEntry = normalizeHost(entry);
		if (normalizedEntry === "*") return true;
		if (normalizedEntry.startsWith("*.")) {
			const suffix = normalizedEntry.slice(1);
			return normalizedHost.endsWith(suffix) && normalizedHost.length > suffix.length;
		}
		return normalizedHost === normalizedEntry;
	});
}

function isLoopback(host: string): boolean {
	return ["localhost", "127.0.0.1", "[::1]", "::1"].includes(normalizeHost(host));
}

function allowedUrl(value: string): SecurityResult<URL> {
	let parsed: URL;
	try {
		parsed = new URL(value);
	} catch {
		return failure("network URL is invalid");
	}
	if (parsed.username || parsed.password) return failure("network URL credentials are not allowed");
	if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLoopback(parsed.hostname))) {
		return failure("network URL must use HTTPS except loopback");
	}
	if (parsed.hostname.length === 0) return failure("network URL host is empty");
	return { ok: true, value: parsed };
}

function validResponse(value: NetworkBrokerResponse): boolean {
	return Number.isInteger(value.status) && value.status >= 100 && value.status <= 599 &&
		validHeaders(value.headers) && Buffer.isBuffer(value.body) && typeof value.finalUrl === "string";
}

export class PolicyNetworkClient {
	readonly #broker: NetworkBrokerPort;
	readonly #policy: NetworkPolicy;

	public constructor(broker: NetworkBrokerPort, policy: NetworkPolicy) {
		this.#broker = broker;
		this.#policy = policy;
	}

	public async request(request: NetworkBrokerRequest, signal?: AbortSignal): Promise<SecurityResult<NetworkBrokerResponse>> {
		if (!validPolicy(this.#policy)) return failure("network policy is unknown or malformed");
		if (!isRecord(request) || typeof request.url !== "string" || typeof request.method !== "string" || !validHeaders(request.headers)) {
			return failure("network request is malformed");
		}
		if (!Number.isSafeInteger(request.maxBytes) || request.maxBytes <= 0) return failure("network response bound is invalid");
		if (request.body !== undefined && typeof request.body !== "string" && !Buffer.isBuffer(request.body)) return failure("network request body is malformed");
		const method = request.method.trim().toUpperCase();
		if (!NETWORK_METHODS.has(method)) return failure("network method is unknown");
		const parsedResult = allowedUrl(request.url);
		if (!parsedResult.ok) return parsedResult;
		const parsed = parsedResult.value;
		if (!hostAllowed(parsed.hostname, this.#policy)) return failure("network host is denied by policy");

		let response: NetworkBrokerResponse;
		try {
			response = await this.#broker.request({ ...request, method }, signal);
		} catch {
			return failure("network broker is unavailable", true);
		}
		if (!validResponse(response)) return failure("network broker returned an invalid response");
		const finalUrlResult = allowedUrl(response.finalUrl);
		if (!finalUrlResult.ok) return finalUrlResult;
		const finalUrl = finalUrlResult.value;
		if (
			normalizeHost(finalUrl.hostname) !== normalizeHost(parsed.hostname) ||
			finalUrl.port !== parsed.port ||
			!hostAllowed(finalUrl.hostname, this.#policy)
		) return failure("cross-host or cross-port redirect is denied");
		if (response.body.byteLength > request.maxBytes) return failure("network response exceeds the trusted byte bound");
		return { ok: true, value: response };
	}

}
