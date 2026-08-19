import { anthropicMessagesApi } from "../api/anthropic-messages.lazy.ts";
import { lazyStream } from "../api/lazy.ts";
import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import type { ApiKeyAuth } from "../auth/types.ts";
import { createProvider, type Provider, type RefreshModelsContext } from "../models.ts";
import type {
	AnthropicMessagesCompat,
	Api,
	Context,
	Model,
	OpenAICompletionsCompat,
	ProviderEnv,
	ProviderHeaders,
	ProviderStreams,
	SimpleStreamOptions,
	StreamOptions,
} from "../types.ts";
import { fetchWithProviderProxy } from "../utils/fetch-provider-proxy.ts";
import {
	detectWireForModel,
	normalizeProxyBaseUrl,
	parseProxyProviderConfig,
	PROXY_WIRE_ORDER,
	proxyWireBaseUrl,
	proxyWireRequestUrl,
	ProxyWireCache,
	resolveProxyApiKey,
	type ProxyProviderConfig,
	type ProxyWire,
	type ProxyWireCandidates,
	type ProxyWireProbe as ProxyWireProbeRecord,
} from "./proxy-discovery.ts";

export interface ProxyWireProbeInput {
	readonly providerId: string;
	readonly model: Model<ProxyWire>;
	readonly wire: ProxyWire;
	readonly apiKey?: string;
	readonly headers?: ProviderHeaders;
	readonly env?: ProviderEnv;
	readonly timeoutMs: number;
	readonly signal?: AbortSignal;
}

export type ProxyWireProbe = (input: ProxyWireProbeInput) => Promise<ProxyWireProbeRecord>;

export interface ProxyProviderOptions {
	readonly id: string;
	readonly name?: string;
	readonly config: unknown;
	readonly models?: readonly Model<ProxyWire>[];
	readonly fetch?: typeof fetch;
	readonly probe?: ProxyWireProbe;
	readonly transports?: Partial<Record<ProxyWire, ProviderStreams>>;
	readonly wireCache?: ProxyWireCache;
}

type ProxyWireProbeResult = ProxyWireProbeRecord;
type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isHeaderKey(headers: ProviderHeaders | undefined, name: string): boolean {
	if (!headers) return false;
	const expected = name.toLowerCase();
	return Object.keys(headers).some((key) => key.toLowerCase() === expected);
}

function mergeHeaders(...sources: (ProviderHeaders | undefined)[]): ProviderHeaders {
	const merged: ProviderHeaders = {};
	for (const source of sources) {
		if (source) Object.assign(merged, source);
	}
	return merged;
}

function materializeHeaders(headers: ProviderHeaders): Record<string, string> {
	return Object.fromEntries(Object.entries(headers).filter((entry): entry is [string, string] => entry[1] !== null));
}

function configuredApiKeyEnvName(value: string): string | undefined {
	const explicit = value.match(/^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/u) ?? value.match(/^\$([A-Za-z_][A-Za-z0-9_]*)$/u);
	return explicit?.[1] ?? (/^[A-Z_][A-Z0-9_]*$/u.test(value) ? value : undefined);
}

function hasUsableAuthHeader(headers: ProviderHeaders | undefined): boolean {
	if (!headers) return false;
	return Object.entries(headers).some(
		([name, value]) =>
			(name.toLowerCase() === "authorization" || name.toLowerCase() === "x-api-key") &&
			typeof value === "string" &&
			value.trim().length > 0,
	);
}

function makeAuth(config: ProxyProviderConfig, providerName: string): ApiKeyAuth {
	return {
		name: `${providerName} API key`,
		login: async (interaction) => {
			const key = await interaction.prompt({ type: "secret", message: `Enter ${providerName} API key` });
			return { type: "api_key", key };
		},
		resolve: async ({ ctx, credential }) => {
			const headers = config.headers;
			if (credential?.key) {
				return {
					auth: { apiKey: credential.key, ...(headers ? { headers } : {}) },
					source: "stored credential",
				};
			}

			if (config.apiKey) {
				const envName = configuredApiKeyEnvName(config.apiKey);
				const envValue = envName ? await ctx.env(envName) : undefined;
				const apiKey = resolveProxyApiKey(config.apiKey, envName ? { [envName]: envValue } : {});
				if (apiKey) {
					return {
						auth: { apiKey, ...(headers ? { headers } : {}) },
						source: envName ?? "configured proxy key",
					};
				}
			}

			if (hasUsableAuthHeader(headers)) return { auth: { headers }, source: "configured headers" };
			return undefined;
		},
	};
}

function positiveNumber(value: unknown, fallback: number): number {
	const numeric = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
	return Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric) : fallback;
}

function mapCatalogModel(
	providerId: string,
	baseUrl: string,
	entry: JsonRecord,
	staticModels: readonly Model<ProxyWire>[],
): Model<ProxyWire> | undefined {
	const id = typeof entry.id === "string" ? entry.id.trim() : "";
	if (!id) return undefined;
	const reference = staticModels.find((candidate) => candidate.id === id);
	const name = typeof entry.name === "string" && entry.name.trim() ? entry.name.trim() : (reference?.name ?? id);
	const contextWindow = positiveNumber(entry.context_window, reference?.contextWindow ?? 4096);
	const maxTokens = positiveNumber(entry.max_tokens, reference?.maxTokens ?? 4096);
	return {
		...(reference ?? {
			id,
			name: id,
			api: "openai-completions" as const,
			provider: providerId,
			baseUrl,
			reasoning: false,
			input: ["text"] as ("text" | "image")[],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 4096,
			maxTokens: 4096,
		}),
		id,
		name,
		api: "openai-completions",
		provider: providerId,
		baseUrl,
		contextWindow,
		maxTokens,
	};
}

function truncateBody(body: string): string {
	const trimmed = body.trim();
	return trimmed.length > 512 ? `${trimmed.slice(0, 512)}…` : trimmed;
}

function requestWithOptionalProviderProxy(
	fetchImpl: typeof fetch | undefined,
	providerId: string,
	input: string,
	init: RequestInit,
	env: ProviderEnv | undefined,
): ReturnType<typeof fetch> {
	return fetchImpl ? fetchImpl(input, init) : fetchWithProviderProxy(providerId, input, init, env);
}

async function fetchCatalog(
	context: RefreshModelsContext,
	providerId: string,
	config: ProxyProviderConfig,
	staticModels: readonly Model<ProxyWire>[],
	fetchImpl: typeof fetch | undefined,
): Promise<readonly Model<ProxyWire>[]> {
	const key = context.credential?.type === "api_key" ? context.credential.key : undefined;
	const headers = mergeHeaders(config.headers);
	if (key && !isHeaderKey(headers, "authorization")) headers.Authorization = `Bearer ${key}`;
	if (!isHeaderKey(headers, "accept")) headers.Accept = "application/json";
	const response = await requestWithOptionalProviderProxy(
		fetchImpl,
		providerId,
		`${config.baseUrl}/models`,
		{ method: "GET", headers: materializeHeaders(headers), signal: context.signal },
		context.credential?.type === "api_key" ? context.credential.env : undefined,
	);
	if (!response.ok) throw new Error(`Could not load proxy models: ${response.status}: ${truncateBody(await response.text())}`);

	const payload: unknown = await response.json();
	if (!isRecord(payload) || !Array.isArray(payload.data)) throw new Error("Invalid proxy model catalog response");
	const models = new Map<string, Model<ProxyWire>>();
	for (const entry of payload.data) {
		if (!isRecord(entry)) continue;
		const mapped = mapCatalogModel(providerId, config.baseUrl, entry, staticModels);
		if (mapped && !models.has(mapped.id)) models.set(mapped.id, mapped);
	}
	if (models.size === 0) throw new Error("Proxy returned an empty model catalog");
	return [...models.values()];
}

interface RequestSignal {
	signal: AbortSignal;
	cleanup: () => void;
}

function requestSignal(signal: AbortSignal | undefined, timeoutMs: number): RequestSignal {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(new Error("proxy probe timeout")), timeoutMs);
	const onAbort = () => controller.abort(signal?.reason);
	if (signal?.aborted) onAbort();
	else signal?.addEventListener("abort", onAbort, { once: true });
	return {
		signal: controller.signal,
		cleanup: () => {
			clearTimeout(timeout);
			signal?.removeEventListener("abort", onAbort);
		},
	};
}

function probeHeaders(
	config: ProxyProviderConfig,
	wire: ProxyWire,
	apiKey: string | undefined,
	headers: ProviderHeaders | undefined,
): Record<string, string> {
	const merged = mergeHeaders(config.headers, headers);
	if (!isHeaderKey(merged, "content-type")) merged["content-type"] = "application/json";
	if (!isHeaderKey(merged, "accept")) merged.Accept = "application/json";
	if (apiKey) {
		const authName = wire === "anthropic-messages" && !config.authHeader ? "x-api-key" : "authorization";
		if (!isHeaderKey(merged, authName)) {
			merged[authName] = authName === "authorization" ? `Bearer ${apiKey}` : apiKey;
		}
	}
	return materializeHeaders(merged);
}

function probeBody(modelId: string, wire: ProxyWire): string {
	return JSON.stringify(
		wire === "anthropic-messages"
			? { model: modelId, max_tokens: 1, stream: false, messages: [{ role: "user", content: "ping" }] }
			: { model: modelId, max_tokens: 1, stream: false, messages: [{ role: "user", content: "ping" }] },
	);
}

async function defaultProbe(
	input: ProxyWireProbeInput,
	config: ProxyProviderConfig,
	fetchImpl: typeof fetch | undefined,
): Promise<ProxyWireProbeResult> {
	const request = requestSignal(input.signal, input.timeoutMs);
	try {
		const response = await requestWithOptionalProviderProxy(
			fetchImpl,
			input.providerId,
			proxyWireRequestUrl(config.baseUrl, input.wire),
			{
				method: "POST",
				headers: probeHeaders(config, input.wire, input.apiKey, input.headers),
				body: probeBody(input.model.id, input.wire),
				signal: request.signal,
			},
			input.env,
		);
		await response.arrayBuffer();
		return response.ok
			? { accepted: true, status: response.status }
			: { accepted: false, status: response.status, reason: "status_rejected" };
	} catch {
		return { accepted: false, reason: "request_failed" };
	} finally {
		request.cleanup();
	}
}

function routeModel(model: Model<ProxyWire>, wire: ProxyWire, config: ProxyProviderConfig): Model<ProxyWire> {
	if (wire === "anthropic-messages") {
		const compat: AnthropicMessagesCompat = {
			...(model.compat as AnthropicMessagesCompat | undefined),
			authHeader: config.authHeader,
		};
		return {
			...model,
			api: wire,
			baseUrl: proxyWireBaseUrl(config.baseUrl, wire),
			compat,
		};
	}

	const compat: OpenAICompletionsCompat = {
		...(model.compat as OpenAICompletionsCompat | undefined),
		...(config.disableStrictTools ? { supportsStrictMode: false } : {}),
	};
	return {
		...model,
		api: wire,
		baseUrl: proxyWireBaseUrl(config.baseUrl, wire),
		compat,
	};
}

export function createProxyProvider(options: ProxyProviderOptions): Provider<ProxyWire> {
	const config = parseProxyProviderConfig(options.config);
	const providerName = options.name ?? options.id;
	const staticModels = (options.models ?? []).map((entry) => ({
		...entry,
		provider: options.id,
		baseUrl: entry.baseUrl || config.baseUrl,
	}));
	const transports: Record<ProxyWire, ProviderStreams> = {
		"anthropic-messages": options.transports?.["anthropic-messages"] ?? anthropicMessagesApi(),
		"openai-completions": options.transports?.["openai-completions"] ?? openAICompletionsApi(),
	};
	const wireCache = options.wireCache ?? new ProxyWireCache();
	const probe: ProxyWireProbe = options.probe ?? ((input: ProxyWireProbeInput) => defaultProbe(input, config, options.fetch));
	const auth = makeAuth(config, providerName);
	const provider = createProvider<ProxyWire>({
		id: options.id,
		name: providerName,
		baseUrl: config.baseUrl,
		auth: { apiKey: auth },
		models: staticModels,
		fetchModels: (context) => fetchCatalog(context, options.id, config, staticModels, options.fetch),
		api: transports,
	});

	const resolveWire = async (model: Model<ProxyWire>, optionsArg: StreamOptions | undefined): Promise<ProxyWire> => {
		const cached = wireCache.get(options.id, model.id);
		if (cached?.state === "success") return cached.wire;
		if (cached?.state === "failure") throw new Error(`Proxy wire detection failed for ${options.id}/${model.id}`);
		optionsArg?.signal?.throwIfAborted();

		const candidates: ProxyWireCandidates = {};
		for (const wire of PROXY_WIRE_ORDER) {
			try {
				candidates[wire] = await probe({
					providerId: options.id,
					model,
					wire,
					apiKey: optionsArg?.apiKey,
					headers: mergeHeaders(config.headers, optionsArg?.headers),
					env: optionsArg?.env,
					timeoutMs: config.discovery.timeoutMs,
					signal: optionsArg?.signal,
				});
			} catch {
				optionsArg?.signal?.throwIfAborted();
				candidates[wire] = { accepted: false, reason: "probe_failed" };
			}
			optionsArg?.signal?.throwIfAborted();
			if (candidates[wire]?.accepted) break;
		}

		const detection = detectWireForModel(model.id, candidates);
		wireCache.remember(options.id, model.id, detection);
		if (!detection.ok) throw new Error(`Proxy wire detection failed for ${options.id}/${model.id}`);
		return detection.wire;
	};

	return {
		...provider,
		stream: (model, context, optionsArg) =>
			lazyStream(model, async () => {
				const wire = await resolveWire(model, optionsArg);
				return transports[wire].stream(routeModel(model, wire, config), context, optionsArg);
			}),
		streamSimple: (model, context, optionsArg?: SimpleStreamOptions) =>
			lazyStream(model, async () => {
				const wire = await resolveWire(model, optionsArg);
				return transports[wire].streamSimple(routeModel(model, wire, config), context, optionsArg);
			}),
	};
}

export { normalizeProxyBaseUrl };
