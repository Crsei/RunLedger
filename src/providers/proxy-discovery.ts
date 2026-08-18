import type { ProviderHeaders } from "../types.ts";

export const PROXY_WIRE_ORDER = ["anthropic-messages", "openai-completions"] as const;
export type ProxyWire = (typeof PROXY_WIRE_ORDER)[number];

export interface ProxyDiscoveryConfig {
	readonly type: "proxy";
	readonly timeoutMs: number;
}

export interface ProxyProviderConfig {
	readonly baseUrl: string;
	readonly apiKey?: string;
	readonly authHeader: boolean;
	readonly disableStrictTools: boolean;
	readonly headers?: ProviderHeaders;
	readonly discovery: ProxyDiscoveryConfig;
}

export interface ProxyWireProbe {
	accepted: boolean;
	status?: number;
	reason?: string;
}

export type ProxyWireCandidates = Partial<Record<ProxyWire, ProxyWireProbe>>;

export interface ProxyWireAttempt extends ProxyWireProbe {
	wire: ProxyWire;
}

export type ProxyWireDetection =
	| {
			ok: true;
			modelId: string;
			wire: ProxyWire;
			attempts: readonly ProxyWireAttempt[];
	  }
	| {
			ok: false;
			modelId: string;
			reason: "wire_detection_failed";
			attempts: readonly ProxyWireAttempt[];
	  };

export type ProxyWireCacheEntry =
	| {
			state: "success";
			wire: ProxyWire;
			lastKnownGood: ProxyWire;
			attempts: readonly ProxyWireAttempt[];
			checkedAt: number;
			expiresAt: number;
	  }
	| {
			state: "failure";
			reason: "wire_detection_failed";
			lastKnownGood?: ProxyWire;
			attempts: readonly ProxyWireAttempt[];
			checkedAt: number;
			expiresAt: number;
	  };

export const DEFAULT_PROXY_WIRE_SUCCESS_TTL_MS = 5 * 60 * 1000;
export const DEFAULT_PROXY_WIRE_FAILURE_TTL_MS = 10 * 1000;

export interface ProxyWireCacheOptions {
	readonly successTtlMs?: number;
	readonly failureTtlMs?: number;
	readonly now?: () => number;
}

interface RawRecord {
	[key: string]: unknown;
}

function isRecord(value: unknown): value is RawRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, field: string): string {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new Error(`Proxy provider ${field} must be a non-empty string`);
	}
	return value.trim();
}

function requireBoolean(value: unknown, field: string): boolean {
	if (typeof value !== "boolean") throw new Error(`Proxy provider ${field} must be a boolean`);
	return value;
}

function parsePositiveInteger(value: unknown, field: string, fallback: number): number {
	if (value === undefined) return fallback;
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
		throw new Error(`Proxy provider ${field} must be a positive finite number`);
	}
	const integer = Math.floor(value);
	if (integer < 1) throw new Error(`Proxy provider ${field} must be at least 1`);
	return integer;
}

function parseHeaders(value: unknown): ProviderHeaders | undefined {
	if (value === undefined) return undefined;
	if (!isRecord(value)) throw new Error("Proxy provider headers must be an object");

	const headers: ProviderHeaders = {};
	for (const [name, headerValue] of Object.entries(value)) {
		if (typeof headerValue !== "string" && headerValue !== null) {
			throw new Error(`Proxy provider header ${name} must be a string or null`);
		}
		headers[name] = headerValue;
	}
	return headers;
}

function removeTrailingSlash(value: string): string {
	return value.replace(/\/+$/u, "");
}

function stripVersionPath(value: string): string {
	const url = new URL(value);
	url.pathname = url.pathname.replace(/\/v1$/u, "") || "/";
	return removeTrailingSlash(url.toString());
}

/** Normalize a configured proxy endpoint to the OpenAI-compatible /v1 base. */
export function normalizeProxyBaseUrl(value: string): string {
	const input = requireString(value, "baseUrl");
	let url: URL;
	try {
		url = new URL(input);
	} catch (error) {
		throw new Error(`Proxy provider baseUrl must be an absolute HTTP(S) URL`, { cause: error });
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error("Proxy provider baseUrl must use http or https");
	}
	if (url.username || url.password) throw new Error("Proxy provider baseUrl must not contain credentials");
	if (url.search) throw new Error("Proxy provider baseUrl must not contain a query");
	if (url.hash) throw new Error("Proxy provider baseUrl must not contain a fragment");

	const pathname = removeTrailingSlash(url.pathname);
	url.pathname = pathname === "" ? "/v1" : pathname.endsWith("/v1") ? pathname : `${pathname}/v1`;
	return removeTrailingSlash(url.toString());
}

/** Return the baseURL value expected by the selected SDK. */
export function proxyWireBaseUrl(value: string, wire: ProxyWire): string {
	const baseUrl = normalizeProxyBaseUrl(value);
	return wire === "anthropic-messages" ? stripVersionPath(baseUrl) : baseUrl;
}

/** Return the concrete request URL for a proxy wire probe or fixture. */
export function proxyWireRequestUrl(value: string, wire: ProxyWire): string {
	const baseUrl = normalizeProxyBaseUrl(value);
	return wire === "anthropic-messages"
		? `${stripVersionPath(baseUrl)}/v1/messages`
		: `${baseUrl}/chat/completions`;
}

/** Resolve either a literal key or a conventional environment-variable reference. */
export function resolveProxyApiKey(
	value: string | undefined,
	env: Readonly<Record<string, string | undefined>> = process.env,
): string | undefined {
	if (value === undefined) return undefined;
	const input = value.trim();
	if (input.length === 0) return undefined;

	const explicitReference = input.match(/^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/u) ?? input.match(/^\$([A-Za-z_][A-Za-z0-9_]*)$/u);
	const envName = explicitReference?.[1] ?? (/^[A-Z_][A-Z0-9_]*$/u.test(input) ? input : undefined);
	if (envName) return env[envName]?.trim() || undefined;
	return input;
}

/** Parse the provider-side proxy contract without performing network I/O. */
export function parseProxyProviderConfig(value: unknown): ProxyProviderConfig {
	if (!isRecord(value)) throw new Error("Proxy provider configuration must be an object");

	const discovery = value.discovery;
	if (!isRecord(discovery) || discovery.type !== "proxy") {
		throw new Error('Proxy provider discovery.type must be "proxy"');
	}

	const apiKey = value.apiKey === undefined ? undefined : requireString(value.apiKey, "apiKey");
	const authHeader = value.authHeader === undefined ? false : requireBoolean(value.authHeader, "authHeader");
	const disableStrictTools =
		value.disableStrictTools === undefined ? false : requireBoolean(value.disableStrictTools, "disableStrictTools");
	const headers = parseHeaders(value.headers);

	return {
		baseUrl: normalizeProxyBaseUrl(requireString(value.baseUrl, "baseUrl")),
		...(apiKey === undefined ? {} : { apiKey }),
		authHeader,
		disableStrictTools,
		...(headers ? { headers } : {}),
		discovery: {
			type: "proxy",
			timeoutMs: parsePositiveInteger(discovery.timeoutMs, "discovery.timeoutMs", 5000),
		},
	};
}

/** Apply the frozen A-order probe rule: Anthropic first, then OpenAI. */
export function detectWireForModel(modelId: string, candidates: ProxyWireCandidates): ProxyWireDetection {
	const normalizedModelId = requireString(modelId, "modelId");
	const attempts: ProxyWireAttempt[] = [];

	for (const wire of PROXY_WIRE_ORDER) {
		const probe = candidates[wire] ?? { accepted: false, reason: "not_probed" };
		const attempt = { wire, ...probe };
		attempts.push(attempt);
		if (probe.accepted) {
			return {
				ok: true,
				modelId: normalizedModelId,
				wire,
				attempts,
			};
		}
	}

	return {
		ok: false,
		modelId: normalizedModelId,
		reason: "wire_detection_failed",
		attempts,
	};
}

function cacheKey(providerId: string, modelId: string): string {
	return `${requireString(providerId, "providerId")}\u0000${requireString(modelId, "modelId")}`;
}

function cloneAttempts(attempts: readonly ProxyWireAttempt[]): readonly ProxyWireAttempt[] {
	return attempts.map((attempt) => ({ ...attempt }));
}

/** In-memory provider/model wire cache with short-lived failures and retained good state. */
export class ProxyWireCache {
	private readonly entries = new Map<string, ProxyWireCacheEntry>();
	private readonly successTtlMs: number;
	private readonly failureTtlMs: number;
	private readonly now: () => number;

	constructor(options: ProxyWireCacheOptions = {}) {
		this.successTtlMs = options.successTtlMs ?? DEFAULT_PROXY_WIRE_SUCCESS_TTL_MS;
		this.failureTtlMs = options.failureTtlMs ?? DEFAULT_PROXY_WIRE_FAILURE_TTL_MS;
		this.now = options.now ?? Date.now;
		if (!Number.isFinite(this.successTtlMs) || this.successTtlMs <= 0) {
			throw new Error("Proxy wire success TTL must be positive");
		}
		if (!Number.isFinite(this.failureTtlMs) || this.failureTtlMs <= 0) {
			throw new Error("Proxy wire failure TTL must be positive");
		}
	}

	remember(providerId: string, modelId: string, detection: ProxyWireDetection): void {
		const key = cacheKey(providerId, modelId);
		const checkedAt = this.now();
		const previous = this.entries.get(key);
		const lastKnownGood = detection.ok
			? detection.wire
			: previous?.state === "success"
				? previous.wire
				: previous?.lastKnownGood;

		if (detection.ok) {
			this.entries.set(key, {
				state: "success",
				wire: detection.wire,
				lastKnownGood: detection.wire,
				attempts: cloneAttempts(detection.attempts),
				checkedAt,
				expiresAt: checkedAt + this.successTtlMs,
			});
			return;
		}

		this.entries.set(key, {
			state: "failure",
			reason: detection.reason,
			...(lastKnownGood ? { lastKnownGood } : {}),
			attempts: cloneAttempts(detection.attempts),
			checkedAt,
			expiresAt: checkedAt + this.failureTtlMs,
		});
	}

	get(providerId: string, modelId: string): ProxyWireCacheEntry | undefined {
		const entry = this.entries.get(cacheKey(providerId, modelId));
		if (!entry || this.now() >= entry.expiresAt) return undefined;
		return {
			...entry,
			attempts: cloneAttempts(entry.attempts),
		};
	}

	getLastKnownGood(providerId: string, modelId: string): ProxyWire | undefined {
		const entry = this.entries.get(cacheKey(providerId, modelId));
		return entry?.state === "success" ? entry.wire : entry?.lastKnownGood;
	}
}
