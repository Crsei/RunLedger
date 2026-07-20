/**
 * RunLedger CLI demo —— 验证 pi-ai 移植层接入正确。
 *
 * 用法：`npm run demo`
 *
 * 行为：
 *   1. 加载自动生成的模型 catalog (`src/models.generated.ts`)；
 *   2. 打印 provider 总数 与 model 总数；
 *   3. 抽样打印 anthropic / openai 两个 provider 下前 3 个模型 ID + context window + 价格；
 *   4. 演示用 storage 层的 `paths.getAgentDir()` 解析 `~/.runledger/agent` 目录（不写盘）。
 *
 * 不依赖任何 OAuth / API key；不发起网络请求；可重复运行。
 *
 * TODO：等 agent-loop 填实后再加一段真实 stream 演示。
 */

import { MODELS } from "../src/models.generated.ts";
import { getAgentDir } from "../src/storage/paths.ts";

function formatCost(cost: { input?: number; output?: number; currency?: string } | undefined): string {
	if (cost === undefined) return "n/a";
	const input = cost.input ?? 0;
	const output = cost.output ?? 0;
	const currency = cost.currency ?? "USD";
	// 价格常以 USD / 1M token 计；显示时保留 4 位
	return `${currency} ${input.toFixed(4)} in / ${output.toFixed(4)} out per 1M`;
}

function printSample(providerId: string, limit = 3): void {
	const catalog = MODELS[providerId];
	if (catalog === undefined) {
		console.log(`  [${providerId}] 不存在`);
		return;
	}
	const entries = Object.entries(catalog).slice(0, limit);
	console.log(`  [${providerId}] 共 ${Object.keys(catalog).length} 个模型，前 ${limit} 个：`);
	for (const [id, model] of entries) {
		const ctx = model.contextWindow ?? 0;
		const cost = "cost" in model ? (model as { cost?: unknown }).cost : undefined;
		console.log(`    - ${id}  context=${ctx}  cost=${formatCost(cost as { input?: number; output?: number; currency?: string } | undefined)}`);
	}
}

async function main(): Promise<void> {
	const providerIds = Object.keys(MODELS);
	const totalModels = providerIds.reduce((sum, id) => sum + Object.keys(MODELS[id] ?? {}).length, 0);

	console.log("=== RunLedger pi-ai 移植层 demo ===");
	console.log(`  Providers: ${providerIds.length}`);
	console.log(`  Models:    ${totalModels}`);
	console.log(`  Agent 目录: ${getAgentDir()}`);
	console.log();

	console.log("样例 provider 1: anthropic");
	printSample("anthropic", 3);
	console.log();

	console.log("样例 provider 2: openai");
	printSample("openai", 3);
	console.log();

	console.log("样例 provider 3: google");
	printSample("google", 3);
	console.log();

	console.log("=== 完成 ===");
}

await main();
