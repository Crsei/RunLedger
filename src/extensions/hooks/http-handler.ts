/** M7 HTTP Hook：SSRF/DNS-rebinding/redirect 与敏感 payload 审批。 */

import { isIP } from "node:net";
import { canonicalDigest, canonicalJson } from "../../runtime/protocol/v3/canonical-json.ts";
import { DEFAULT_EXTENSION_LIMITS } from "../diagnostics.ts";
import type { HookEnvelope, HookOutput } from "./types.ts";

export interface HookDnsResolverPort {
	resolve(hostname: string, signal?: AbortSignal): Promise<readonly string[]>;
}

export interface HookHttpAuthorizationReceipt {
	receiptId: string;
	urlDigest: string;
	payloadDigest: string;
	expiresAt: string;
}

export interface HookHttpAuthorizationPort {
	authorize(input: { url: string; payloadDigest: string; containsSensitiveData: boolean }, signal?: AbortSignal): Promise<HookHttpAuthorizationReceipt | undefined>;
}

export interface HookHttpResponse {
	status: number;
	body: Uint8Array;
	finalUrl: string;
	connectedAddress: string;
}

export interface HookHttpClientPort {
	post(input: { url: string; headers: Readonly<Record<string, string>>; body: Uint8Array; maxBytes: number; authorizationReceipt: HookHttpAuthorizationReceipt }, signal?: AbortSignal): Promise<HookHttpResponse>;
}

function privateAddress(address: string): boolean {
	if (address === "::1" || address === "0:0:0:0:0:0:0:1" || address.startsWith("fc") || address.startsWith("fd") || address.startsWith("fe80:")) return true;
	const parts = address.split(".").map(Number);
	if (parts.length !== 4 || parts.some((value) => !Number.isInteger(value))) return false;
	const [a = 0, b = 0] = parts;
	return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

function sensitive(envelope: HookEnvelope): boolean {
	return /(token|password|secret|authorization|cookie|credential)/iu.test(canonicalJson(envelope.payload));
}

export type HttpHookResult =
	| { ok: true; output: HookOutput; status: number; responseDigest: string }
	| { ok: false; reason: string };

export class HttpHookHandler {
	readonly #dns: HookDnsResolverPort;
	readonly #authorization: HookHttpAuthorizationPort;
	readonly #client: HookHttpClientPort;

	public constructor(options: { dns: HookDnsResolverPort; authorization: HookHttpAuthorizationPort; client: HookHttpClientPort }) {
		this.#dns = options.dns;
		this.#authorization = options.authorization;
		this.#client = options.client;
	}

	public async invoke(urlValue: string, envelope: HookEnvelope, signal?: AbortSignal): Promise<HttpHookResult> {
		let url: URL;
		try {
			url = new URL(urlValue);
		} catch {
			return { ok: false, reason: "HTTP hook URL is invalid" };
		}
		if (url.protocol !== "https:") return { ok: false, reason: "HTTP hooks require HTTPS" };
		if (url.username || url.password || url.hostname.endsWith(".local") || url.hostname === "localhost") return { ok: false, reason: "HTTP hook target is not public" };
		const addresses = await this.#dns.resolve(url.hostname, signal);
		if (addresses.length === 0 || addresses.some((address) => isIP(address) === 0 || privateAddress(address))) return { ok: false, reason: "HTTP hook DNS result is unsafe" };
		const body = Buffer.from(canonicalJson(envelope));
		if (body.byteLength > DEFAULT_EXTENSION_LIMITS.maxHookInputBytes) return { ok: false, reason: "HTTP hook payload exceeds bound" };
		const payloadDigest = canonicalDigest(envelope);
		const receipt = await this.#authorization.authorize({ url: url.href, payloadDigest, containsSensitiveData: sensitive(envelope) }, signal);
		if (!receipt || receipt.urlDigest !== canonicalDigest(url.href) || receipt.payloadDigest !== payloadDigest || new Date(receipt.expiresAt).getTime() <= Date.now()) return { ok: false, reason: "HTTP hook authorization is missing or stale" };
		const response = await this.#client.post({ url: url.href, headers: { "content-type": "application/json" }, body, maxBytes: DEFAULT_EXTENSION_LIMITS.maxStdoutBytes, authorizationReceipt: receipt }, signal);
		let finalUrl: URL;
		try {
			finalUrl = new URL(response.finalUrl);
		} catch {
			return { ok: false, reason: "HTTP hook returned invalid final URL" };
		}
		if (finalUrl.origin !== url.origin) return { ok: false, reason: "HTTP hook cross-origin redirect is denied" };
		if (!addresses.includes(response.connectedAddress) || privateAddress(response.connectedAddress)) return { ok: false, reason: "HTTP hook DNS rebinding detected" };
		if (response.body.byteLength > DEFAULT_EXTENSION_LIMITS.maxStdoutBytes) return { ok: false, reason: "HTTP hook response exceeds bound" };
		let output: unknown;
		try {
			output = JSON.parse(Buffer.from(response.body).toString("utf8"));
		} catch {
			return { ok: false, reason: "HTTP hook response is invalid JSON" };
		}
		if (typeof output !== "object" || output === null || Array.isArray(output)) return { ok: false, reason: "HTTP hook response must be an object" };
		const record = output as Record<string, unknown>;
		if (record.decision !== "allow" && record.decision !== "deny") return { ok: false, reason: "HTTP hook response decision is invalid" };
		return { ok: true, status: response.status, responseDigest: canonicalDigest(output), output: { decision: record.decision, ...(typeof record.reason === "string" ? { reason: record.reason.slice(0, 2_048) } : {}), ...(record.updatedInput !== undefined ? { updatedInput: record.updatedInput } : {}), ...(typeof record.additionalContext === "string" ? { additionalContext: record.additionalContext.slice(0, 16_384) } : {}) } };
	}
}
