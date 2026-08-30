#!/usr/bin/env node

/**
 * S9 拆分后:model generator 主入口 —— 只保留 CLI 参数解析、
 * source orchestration 与最终退出码;实现位于 `model-generation/`:
 *
 * - options.ts              参数解析;
 * - models-dev-source.ts    models.dev 归一化 + 网络 loader;
 * - remote-catalog-sources.ts  NVIDIA NIM / OpenRouter / AI Gateway;
 * - compat-metadata.ts      provider compat 元数据;
 * - thinking-metadata.ts    thinking level 元数据;
 * - provider-normalization.ts  全量 catalog 归一化与去重;
 * - emit-provider-data.ts   src/providers/*.models.ts + data/*.json;
 * - emit-model-types.ts     src/models.generated.ts + JSON 目录 dump。
 *
 * 冻结快照模式不得访问网络;fetch 只在 main 入口触发。
 */

import { readFile } from "node:fs/promises";
import { dirname, join } from "path";
import { fileURLToPath, pathToFileURL } from "url";
import type { Api, Model } from "../src/types.ts";
import { readGeneratorOptions, type GeneratorOptions } from "./model-generation/options.ts";
import { loadModelsDevData } from "./model-generation/models-dev-source.ts";
import { fetchOpenRouterModels, fetchAiGatewayModels } from "./model-generation/remote-catalog-sources.ts";
import { normalizeProviderCatalogs } from "./model-generation/provider-normalization.ts";
import { emitProviderData } from "./model-generation/emit-provider-data.ts";
import { emitModelTypes } from "./model-generation/emit-model-types.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const defaultPackageRoot = join(__dirname, "..");

export interface FrozenModelSources {
	readonly modelsDev: readonly Model<Api>[];
	readonly openRouter: readonly Model<Api>[];
	readonly aiGateway: readonly Model<Api>[];
}

export interface ModelGeneratorDependencies {
	readonly packageRoot?: string;
	readonly log?: (message: string) => void;
	readonly loadRemoteSources?: (strict: boolean) => Promise<FrozenModelSources>;
	readonly loadFrozenSources?: (path: string) => Promise<FrozenModelSources>;
}

export interface ModelGeneratorResult {
	readonly source: GeneratorOptions["source"];
	readonly sourceModelCount: number;
	readonly providerCount: number;
}

export async function generateModels(
	generatorOptions: GeneratorOptions,
	dependencies: ModelGeneratorDependencies = {},
): Promise<ModelGeneratorResult> {
	const packageRoot = dependencies.packageRoot ?? defaultPackageRoot;
	const log = dependencies.log ?? console.log;
	const sources = generatorOptions.source === "frozen"
		? await (dependencies.loadFrozenSources ?? readFrozenSources)(generatorOptions.frozenInput!)
		: await (dependencies.loadRemoteSources ?? loadRemoteSources)(generatorOptions.strict);
	const modelsDevModels = [...sources.modelsDev];
	const openRouterModels = [...sources.openRouter];
	const aiGatewayModels = [...sources.aiGateway];

	// Combine models (models.dev has priority);归一化与去重在 provider-normalization 内完成
	const allModels = [...modelsDevModels, ...openRouterModels, ...aiGatewayModels];
	const providers = normalizeProviderCatalogs(allModels);

	if (!generatorOptions.jsonOnly) {
		emitProviderData(providers, { packageRoot, pretty: generatorOptions.pretty });
	}
	if (!generatorOptions.jsonOnly || generatorOptions.jsonOutputDir) {
		emitModelTypes(providers, {
			packageRoot,
			pretty: generatorOptions.pretty,
			jsonOutputDir: generatorOptions.jsonOutputDir,
			writeTypes: !generatorOptions.jsonOnly,
		});
	}

	// Print statistics
	const totalModels = allModels.length;
	const reasoningModels = allModels.filter(m => m.reasoning).length;

	log(`\nModel Statistics:`);
	log(`  Total tool-capable models: ${totalModels}`);
	log(`  Reasoning-capable models: ${reasoningModels}`);

	for (const [provider, models] of Object.entries(providers)) {
		log(`  ${provider}: ${Object.keys(models).length} models`);
	}
	return { source: generatorOptions.source, sourceModelCount: totalModels, providerCount: Object.keys(providers).length };
}

async function loadRemoteSources(strict: boolean): Promise<FrozenModelSources> {
	const [modelsDev, openRouter, aiGateway] = await Promise.all([
		loadModelsDevData(strict),
		fetchOpenRouterModels(strict),
		fetchAiGatewayModels(strict),
	]);
	return { modelsDev, openRouter, aiGateway };
}

async function readFrozenSources(path: string): Promise<FrozenModelSources> {
	const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<FrozenModelSources>;
	if (!Array.isArray(parsed.modelsDev) || !Array.isArray(parsed.openRouter) || !Array.isArray(parsed.aiGateway)) {
		throw new Error("frozen model source must contain modelsDev, openRouter, and aiGateway arrays");
	}
	return { modelsDev: parsed.modelsDev, openRouter: parsed.openRouter, aiGateway: parsed.aiGateway };
}

// Run the generator only when executed directly;import 时无副作用
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const generatorOptions = readGeneratorOptions(process.argv.slice(2));
	generateModels(generatorOptions).catch((error) => {
		console.error(error);
		process.exitCode = 1;
	});
}
