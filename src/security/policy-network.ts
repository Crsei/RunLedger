/** Host policy-aware network client；不直接调用 global fetch。 */

import type { NetworkPolicy, SecurityResult } from "./types.ts";

export interface NetworkBrokerRequest {
	url: string;
	method: string;
	headers: Readonly<Record<string, string>>;
	body?: string | Buffer;
	maxBytes: number;
}

export interface NetworkBrokerResponse {
	status: number;
	headers: Readonly<Record<string, string>>;
	body: Buffer;
	finalUrl: string;
}

export interface NetworkBrokerPort {
	request(request: NetworkBrokerRequest, signal?: AbortSignal): Promise<NetworkBrokerResponse>;
}

function failure(message: string): SecurityResult<never> {
	return { ok: false, error: { code: "network_denied", message, retryable: false } };
}

function hostAllowed(host: string, policy: NetworkPolicy): boolean {
	if (policy.mode === "allow") return true;
	if (policy.mode === "deny") return false;
	return policy.allowedHosts.some((entry) => entry === host || (entry.startsWith("*.") && host.endsWith(entry.slice(1))));
}

export class PolicyNetworkClient {
	readonly #broker: NetworkBrokerPort;
	readonly #policy: NetworkPolicy;

	public constructor(broker: NetworkBrokerPort, policy: NetworkPolicy) {
		this.#broker = broker;
		this.#policy = policy;
	}

	public async request(request: NetworkBrokerRequest, signal?: AbortSignal): Promise<SecurityResult<NetworkBrokerResponse>> {
		let parsed: URL;
		try {
			parsed = new URL(request.url);
		} catch {
			return failure("network URL is invalid");
		}
		const localHttp = parsed.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
		if (parsed.protocol !== "https:" && !localHttp) return failure("network URL must use HTTPS except loopback");
		if (!hostAllowed(parsed.hostname, this.#policy)) return failure("network host is denied by policy");
		if (!Number.isSafeInteger(request.maxBytes) || request.maxBytes <= 0) return failure("network response bound is invalid");
		let response: NetworkBrokerResponse;
		try {
			response = await this.#broker.request(request, signal);
		} catch {
			return { ok: false, error: { code: "network_denied", message: "network broker is unavailable", retryable: true } };
		}
		let finalUrl: URL;
		try {
			finalUrl = new URL(response.finalUrl);
		} catch {
			return failure("network broker returned an invalid final URL");
		}
		if (finalUrl.hostname !== parsed.hostname || !hostAllowed(finalUrl.hostname, this.#policy)) {
			return failure("cross-host redirect is denied");
		}
		if (response.body.byteLength > request.maxBytes) return failure("network response exceeds the trusted byte bound");
		return { ok: true, value: response };
	}
}
