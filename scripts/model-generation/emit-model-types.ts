/**
 * S9 拆分:emit model types —— src/models.generated.ts 聚合器与可选 JSON 目录 dump。
 */

import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import type { Model } from "../../src/types.ts";
import { buildSortedJsonProviders, GENERATED_HEADER } from "./emit-provider-data.ts";

function writeJson(path: string, value: unknown, pretty: boolean): void {
	writeFileSync(path, `${JSON.stringify(value, null, pretty ? 2 : undefined)}\n`);
}

/** 写 src/models.generated.ts;jsonOutputDir 提供时同时写完整 JSON 目录 dump。 */
export function emitModelTypes(
	providers: Record<string, Record<string, Model<any>>>,
	options: { packageRoot: string; pretty: boolean; jsonOutputDir: string | undefined; writeTypes?: boolean },
): void {
	const { packageRoot, pretty, jsonOutputDir, writeTypes = true } = options;
	const catalogConstName = (providerId: string) =>
		`${providerId.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_MODELS`;
	const sortedProviderIds = Object.keys(providers).sort();
	const jsonProviders = buildSortedJsonProviders(providers);

	if (writeTypes) {
		let output = GENERATED_HEADER;
		for (const providerId of sortedProviderIds) {
			output += `import { ${catalogConstName(providerId)} } from "./providers/${providerId}.models.ts";\n`;
		}
		output += `\nexport const MODELS: {\n`;
		for (const providerId of sortedProviderIds) {
			output += `\treadonly ${JSON.stringify(providerId)}: typeof ${catalogConstName(providerId)};\n`;
		}
		output += `} = {\n`;
		for (const providerId of sortedProviderIds) {
			output += `\t${JSON.stringify(providerId)}: ${catalogConstName(providerId)},\n`;
		}
		output += `};\n`;
		writeFileSync(join(packageRoot, "src/models.generated.ts"), output);
		console.log("Generated src/models.generated.ts");
	}

	if (jsonOutputDir) {
		const providerOutputDir = join(jsonOutputDir, "providers");
		rmSync(jsonOutputDir, { recursive: true, force: true });
		mkdirSync(providerOutputDir, { recursive: true });
		writeJson(join(jsonOutputDir, "models.json"), jsonProviders, pretty);
		writeJson(join(jsonOutputDir, "providers.json"), sortedProviderIds, pretty);
		for (const providerId of sortedProviderIds) {
			writeJson(join(providerOutputDir, `${providerId}.json`), jsonProviders[providerId], pretty);
		}
		console.log(`Generated JSON model catalog under ${jsonOutputDir}`);
	}
}
