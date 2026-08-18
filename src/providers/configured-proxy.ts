import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { MutableModels, Provider } from "../models.ts";
import { createProxyProvider } from "./proxy-provider.ts";
import { parseProxyProviderConfig, type ProxyWire } from "./proxy-discovery.ts";

interface JsonRecord {
	readonly [key: string]: unknown;
}

export interface LoadConfiguredProxyProvidersOptions {
	readonly path: string;
}

type ConfiguredProxyProvider = Provider<ProxyWire>;

function isRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingFile(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function providerName(value: unknown, id: string): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new Error(`Configured proxy provider ${id} name must be a non-empty string`);
	}
	return value.trim();
}

async function readModelsConfig(path: string): Promise<unknown | undefined> {
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch (error) {
		if (isMissingFile(error)) return undefined;
		throw new Error(`Could not read configured proxy providers from ${path}`, { cause: error });
	}

	try {
		return JSON.parse(text) as unknown;
	} catch (error) {
		throw new Error(`Configured proxy provider file is invalid JSON: ${path}`, { cause: error });
	}
}

/** Load the canonical user-level models.json proxy providers. */
export async function loadConfiguredProxyProviders(
	options: LoadConfiguredProxyProvidersOptions,
): Promise<readonly ConfiguredProxyProvider[]> {
	const parsed = await readModelsConfig(options.path);
	if (parsed === undefined) return [];
	if (!isRecord(parsed) || !isRecord(parsed.providers)) {
		throw new Error("Configured proxy provider file must contain a providers object");
	}

	const providers: ConfiguredProxyProvider[] = [];
	for (const [id, rawConfig] of Object.entries(parsed.providers)) {
		if (id.trim().length === 0) throw new Error("Configured proxy provider id must be non-empty");
		if (!isRecord(rawConfig)) throw new Error(`Configured proxy provider ${id} must be an object`);
		const config = parseProxyProviderConfig(rawConfig);
		const name = providerName(rawConfig.name, id);
		providers.push(
			createProxyProvider({
				id,
				...(name === undefined ? {} : { name }),
				config,
			}),
		);
	}

	return providers;
}

/** Register configured providers atomically; configured IDs never replace built-ins. */
export function registerConfiguredProxyProviders(
	models: MutableModels,
	providers: readonly ConfiguredProxyProvider[],
): void {
	const ids = new Set<string>();
	for (const provider of providers) {
		if (ids.has(provider.id) || models.getProvider(provider.id) !== undefined) {
			throw new Error(`Configured proxy provider conflict: ${provider.id}`);
		}
		ids.add(provider.id);
	}
	for (const provider of providers) models.setProvider(provider);
}

/** Load and register the canonical user-level models.json file. */
export async function registerConfiguredProxyProvidersFromHome(models: MutableModels, home: string): Promise<void> {
	const providers = await loadConfiguredProxyProviders({ path: join(home, "models.json") });
	registerConfiguredProxyProviders(models, providers);
}
