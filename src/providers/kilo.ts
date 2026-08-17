import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import type { ApiKeyAuth, ApiKeyCredential, AuthInteraction } from "../auth/types.ts";
import type { RefreshModelsContext } from "../models.ts";
import { createProvider, type Provider } from "../models.ts";
import type { Model } from "../types.ts";
import { KILO_MODELS } from "./kilo.models.ts";

const KILO_DEFAULT_BASE_URL = "https://api.kilo.ai/api/gateway";
const KILO_POLL_INTERVAL_MS = 5000;

export interface KiloProviderOptions {
	baseUrl?: string;
	fetch?: typeof fetch;
}

type JsonRecord = Record<string, unknown>;

function normalizeBaseUrl(value: string | undefined): string {
	const configured = value?.trim() || KILO_DEFAULT_BASE_URL;
	return configured.replace(/\/+$/u, "");
}

// The provider base URL is the OpenAI-compatible gateway path; the device
// authorization API lives on the same host without the /api/gateway suffix
// (see source packages/ai/src/registry/kilo.ts).
function deviceAuthBaseUrl(providerBaseUrl: string): string {
	return providerBaseUrl.endsWith("/api/gateway")
		? providerBaseUrl.slice(0, -"/api/gateway".length)
		: providerBaseUrl;
}

function positiveNumber(value: unknown, fallback: number): number {
	const numeric = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
	return Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric) : fallback;
}

function truncateBody(body: string): string {
	const trimmed = body.trim();
	return trimmed.length > 512 ? `${trimmed.slice(0, 512)}…` : trimmed;
}

function mapModel(
	entry: JsonRecord,
	baseUrl: string,
	staticModels: readonly Model<"openai-completions">[],
): Model<"openai-completions"> | undefined {
	const id = typeof entry.id === "string" ? entry.id.trim() : "";
	if (!id) return undefined;
	const reference = staticModels.find((model) => model.id === id);
	const name = typeof entry.name === "string" && entry.name.trim() ? entry.name.trim() : reference?.name ?? id;
	return {
		...(reference ?? {
			id,
			name: id,
			api: "openai-completions" as const,
			provider: "kilo" as const,
			baseUrl,
			reasoning: false,
			input: ["text"] as ("text" | "image")[],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 4096,
			maxTokens: 4096,
		}),
		id,
		name,
		provider: "kilo",
		contextWindow: positiveNumber(entry.context_length, reference?.contextWindow ?? 4096),
		maxTokens: positiveNumber(entry.max_completion_tokens, reference?.maxTokens ?? 4096),
	};
}

async function fetchModels(
	context: RefreshModelsContext,
	baseUrl: string,
	fetchImpl: typeof fetch,
	staticModels: readonly Model<"openai-completions">[],
): Promise<readonly Model<"openai-completions">[]> {
	const response = await fetchImpl(`${baseUrl}/models`, {
		method: "GET",
		headers: { Accept: "application/json" },
		signal: context.signal,
	});
	if (!response.ok) {
		throw new Error(`Could not load Kilo Gateway models: ${response.status}: ${truncateBody(await response.text())}`);
	}

	const payload: unknown = await response.json();
	if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
		throw new Error("Invalid Kilo Gateway model catalog response");
	}
	const data = (payload as { data?: unknown }).data;
	if (!Array.isArray(data)) throw new Error("Invalid Kilo Gateway model catalog response");

	const models = new Map<string, Model<"openai-completions">>();
	for (const rawEntry of data) {
		if (typeof rawEntry !== "object" || rawEntry === null || Array.isArray(rawEntry)) continue;
		const model = mapModel(rawEntry as JsonRecord, baseUrl, staticModels);
		if (model && !models.has(model.id)) models.set(model.id, model);
	}
	if (models.size === 0) throw new Error("Kilo Gateway returned an empty model catalog");
	return [...models.values()];
}

function abortableSleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new Error("Login cancelled"));
			return;
		}
		const onAbort = () => {
			clearTimeout(timeout);
			reject(new Error("Login cancelled"));
		};
		const timeout = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

// Ported verbatim from source packages/ai/src/registry/kilo.ts. The device
// flow posts a code request, surfaces the verification URL, then polls until
// the user approves (202 pending -> retry after 5s; 403 denied; 410 expired;
// 200 with {status:"approved", token} completes).
async function loginKiloDeviceAuth(
	providerBaseUrl: string,
	fetchImpl: typeof fetch,
	interaction: AuthInteraction,
): Promise<ApiKeyCredential> {
	const deviceBaseUrl = deviceAuthBaseUrl(providerBaseUrl);
	const initiateResponse = await fetchImpl(`${deviceBaseUrl}/api/device-auth/codes`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		signal: interaction.signal,
	});
	if (!initiateResponse.ok) {
		if (initiateResponse.status === 429) {
			throw new Error("Too many pending authorization requests. Please try again later.");
		}
		throw new Error(`Failed to initiate device authorization: ${initiateResponse.status}`);
	}

	const initiateData: unknown = await initiateResponse.json();
	if (typeof initiateData !== "object" || initiateData === null || Array.isArray(initiateData)) {
		throw new Error("Kilo device authorization response missing required fields");
	}
	const body = initiateData as { code?: unknown; verificationUrl?: unknown; expiresIn?: unknown };
	if (
		typeof body.code !== "string" ||
		body.code.length === 0 ||
		typeof body.verificationUrl !== "string" ||
		body.verificationUrl.length === 0 ||
		typeof body.expiresIn !== "number" ||
		!Number.isFinite(body.expiresIn) ||
		body.expiresIn <= 0
	) {
		throw new Error("Kilo device authorization response missing required fields");
	}
	const userCode = body.code;
	const verificationUrl = body.verificationUrl;
	const expiresInSeconds = body.expiresIn;

	interaction.notify({ type: "auth_url", url: verificationUrl, instructions: `Enter code: ${userCode}` });

	const deadline = Date.now() + expiresInSeconds * 1000;
	while (Date.now() < deadline) {
		if (interaction.signal?.aborted) throw new Error("Login cancelled");

		const pollResponse = await fetchImpl(
			`${deviceBaseUrl}/api/device-auth/codes/${encodeURIComponent(userCode)}`,
			{ signal: interaction.signal },
		);
		if (pollResponse.status === 202) {
			await abortableSleep(KILO_POLL_INTERVAL_MS, interaction.signal);
			continue;
		}
		if (pollResponse.status === 403) throw new Error("Authorization was denied");
		if (pollResponse.status === 410) throw new Error("Authorization code expired. Please try again.");
		if (!pollResponse.ok) {
			throw new Error(`Failed to poll device authorization: ${pollResponse.status}`);
		}

		const pollData: unknown = await pollResponse.json();
		if (typeof pollData !== "object" || pollData === null || Array.isArray(pollData)) {
			throw new Error(`Failed to poll device authorization: ${pollResponse.status}`);
		}
		const pollBody = pollData as { status?: unknown; token?: unknown; access?: unknown };
		const token = typeof pollBody.token === "string" ? pollBody.token : typeof pollBody.access === "string" ? pollBody.access : undefined;
		if (pollBody.status === "approved" && token) {
			return { type: "api_key", key: token };
		}
		if (pollBody.status === "denied") throw new Error("Authorization was denied");
		if (pollBody.status === "expired") throw new Error("Authorization code expired. Please try again.");

		await abortableSleep(KILO_POLL_INTERVAL_MS, interaction.signal);
	}

	throw new Error("Authentication timed out. Please try again.");
}

// Model listing is unauthenticated, but request auth fails closed: resolve
// returning undefined makes Models.getAuth() reject streams with
// "Provider is not configured" even though discovery works without a key.
const kiloAuth = (fetchImpl: typeof fetch, baseUrl: string): ApiKeyAuth => ({
	name: "Kilo Gateway API key",
	login: (interaction) => loginKiloDeviceAuth(baseUrl, fetchImpl, interaction),
	resolve: async ({ ctx, credential }) => {
		if (credential?.key) return { auth: { apiKey: credential.key }, source: "stored credential" };
		const value = await ctx.env("KILO_API_KEY");
		if (value) return { auth: { apiKey: value }, source: "KILO_API_KEY" };
		return undefined;
	},
});

export function kiloProvider(options: KiloProviderOptions = {}): Provider<"openai-completions"> {
	const baseUrl = normalizeBaseUrl(options.baseUrl);
	const fetchImpl = options.fetch ?? globalThis.fetch;
	const staticModels = Object.values(KILO_MODELS);
	return createProvider({
		id: "kilo",
		name: "Kilo Gateway",
		baseUrl,
		auth: { apiKey: kiloAuth(fetchImpl, baseUrl) },
		models: staticModels,
		fetchModels: (context) => fetchModels(context, baseUrl, fetchImpl, staticModels),
		api: openAICompletionsApi(),
	});
}
