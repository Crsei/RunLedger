#!/usr/bin/env node
/**
 * 从 oh-my-pi 冻结快照提取 bundled catalog 子集,生成 RunLedger 生成器的
 * 可复现模型数据源(vendored snapshot)。
 *
 * 用法:
 *   node scripts/sources/extract-oh-my-pi-models.ts <oh-my-pi checkout 路径>
 *
 * 输出: scripts/sources/oh-my-pi-provider-models-17.2.15.json
 *   { "<providerId>": [<raw model entry>, ...] }
 *   条目保留来源字段(id/name/api/baseUrl/reasoning/input/cost/contextWindow/
 *   maxTokens/compat),由 scripts/generate-models.ts 在生成时归一化为目标 Model。
 *
 * 只提取本移植清单新增 provider 的条目;identity 映射(azure/xai-oauth/moonshot)
 * 由生成器侧重写,不在此处改写来源数据。
 */

import { readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const sourceRoot = process.argv[2];
if (!sourceRoot) {
	console.error("usage: node scripts/sources/extract-oh-my-pi-models.ts <oh-my-pi checkout>");
	process.exit(1);
}

/** 需要 vendored 的 provider 集合(见 02-oh-my-pi-provider-port-execution-checklist.md 矩阵)。 */
const VENDORED_PROVIDER_IDS = [
	// A 批次:已有 adapter 可复用
	"aimlapi",
	"baseten",
	"coreweave",
	"firepass",
	"gmi-cloud",
	"nanogpt",
	"novita",
	"qianfan",
	"synthetic",
	"venice",
	"zhipu-coding-plan",
	// B 批次:auth/区域/多协议
	"alibaba-coding-plan",
	"alibaba-token-plan",
	"bedrock-mantle",
	"kilo",
	"kimi-code",
	"meta",
	"minimax-code",
	"minimax-code-cn",
	"opencode-zen",
	"qwen-portal",
	"sakana",
	"umans",
	"wafer-serverless",
	"zenmux",
	// xai-oauth 条目并入已有 xai provider(identity 映射,见矩阵行)
	"xai-oauth",
] as const;

type JsonRecord = Record<string, unknown>;

interface BundledModelsFile {
	[providerId: string]: Record<string, JsonRecord>;
}

const modelsPath = join(sourceRoot, "packages/catalog/src/models.json");
const bundled = JSON.parse(readFileSync(modelsPath, "utf8")) as BundledModelsFile;

const output: Record<string, JsonRecord[]> = {};
for (const providerId of VENDORED_PROVIDER_IDS) {
	const entries = bundled[providerId];
	if (!entries) {
		console.error(`source bundled catalog has no entry for "${providerId}"`);
		process.exit(1);
	}
	output[providerId] = Object.keys(entries)
		.sort()
		.map((id) => entries[id]);
}

const outPath = join(__dirname, "oh-my-pi-provider-models-17.2.15.json");
writeFileSync(outPath, `${JSON.stringify(output, null, "\t")}\n`);
console.log(`wrote ${outPath}`);
for (const [id, entries] of Object.entries(output)) {
	console.log(`  ${id}: ${entries.length} entries`);
}
