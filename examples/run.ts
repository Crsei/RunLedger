/**
 * RunLedger CLI demo —— 验证 pi-ai 移植层接入正确。
 *
 * 用法：`npm run demo`
 *
 * 行为：
 *   1. 加载自动生成的模型 catalog (`src/models.generated.ts`)；
 *   2. 打印 provider 总数 与 model 总数；
 *   3. 抽样打印 anthropic / openai 两个 provider 下前 3 个模型 ID + context window + 价格；
 *   4. 演示 canonical home resolver；历史 paths helper 仅用于迁移 source 定位（不写盘）。
 *   5. 演示 mock LLM 端到端跑通 Agent 循环（含 echo 工具调用）;
 *   6. 若检测到 `asset/api-key.json` 与 deepseek provider 可用,演示真实调用
 *      deepseek-v4-pro(走现有 deepseek provider 的 openai-completions 协议)
 *      跑同样的 Agent 循环,verify 整个 pi-ai 接入与 toolUse 流在真实 LLM 上也通。
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { MODELS } from "../src/models.generated.ts";
import { getAgentDir } from "../src/storage/paths.ts";
import { echoTool } from "../src/runtime/tools/echo.ts";
import { mockStreamFn, mockModel } from "../src/runtime/providers/mock-stream.ts";
import { Agent } from "../src/runtime/agent.ts";
import type { AgentEvent } from "../src/runtime/types.ts";
import { MemoryLedger } from "../src/runtime/ledger/memory-ledger.ts";
import { DEEPSEEK_MODELS } from "../src/providers/deepseek.models.ts";
import { stream as openaiCompletionsStream } from "../src/api/openai-completions.ts";
import type { Model, Api, Context, AssistantMessageEventStream } from "../src/types.ts";
import type { StreamFn } from "../src/runtime/types.ts";

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

	console.log("=== 完成 catalog demo ===\n");

	console.log("=== demo 1:mock LLM 端到端 ===");
	await demoMockLoop();
	console.log();

	console.log("=== demo 2:真实 deepseek-v4-pro(若 asset/api-key.json 存在)===");
	await demoDeepseekLoop();
}

/**
 * Demo 1:用 mockStreamFn + echoTool 把 Agent 循环跑通,事件流落进 MemoryLedger。
 * 不依赖任何网络/密钥,可重复执行。
 */
async function demoMockLoop(): Promise<void> {
	const ledger = new MemoryLedger({ metadata: { demo: "mock" } });
	const agent = new Agent({
		initialState: {
			systemPrompt: "你是 mock assistant,必须通过 echo 工具回复。",
			model: mockModel,
			tools: [echoTool],
		},
		streamFn: mockStreamFn,
		ledger,
		toolExecution: "sequential",
	});

	const events: AgentEvent[] = [];
	agent.subscribe((ev) => events.push(ev));

	const final = await agent.prompt("hello");

	console.log(`  共 ${events.length} 个事件`);
	console.log(`  共 ${final.length} 条 message`);
	console.log(`  最后一条:role=${final[final.length - 1]!.role}`);
	const ledgerEntries = ledger.entries();
	console.log(`  ledger: ${ledgerEntries.length} 条,含 tool_call=${ledgerEntries.some((e) => e.type === "tool_call")},tool_result=${ledgerEntries.some((e) => e.type === "tool_result")}`);
}

/**
 * Demo 2:走现有 pi-ai deepseek provider(openai-completions 协议),
 * 用 asset/api-key.json 中 ANTHROPIC_AUTH_TOKEN 这串 key 调 deepseek-v4-pro,
 * 验证 pi-ai adapter 对 OpenAI tool_calls finish_reason 等映射与 agent-loop 端到端通。
 *
 * 已先验证 sk- token 兼容 deepseek 的 OpenAI 端点和 anthropic 端点。
 */
async function demoDeepseekLoop(): Promise<void> {
	const assetPath = resolve(process.cwd(), "asset/api-key.json");
	let asset: { env?: Record<string, string> };
	try {
		asset = JSON.parse(readFileSync(assetPath, "utf8"));
	} catch (e) {
		console.log(`  跳过:asset/api-key.json 不可读 (${(e as Error).message})`);
		return;
	}

	const apiKey = asset.env?.ANTHROPIC_AUTH_TOKEN;
	if (!apiKey) {
		console.log("  跳过:asset/api-key.json 中未找到 ANTHROPIC_AUTH_TOKEN");
		return;
	}

	const model = DEEPSEEK_MODELS["deepseek-v4-pro"];
	if (!model) {
		console.log("  跳过:DEEPSEEK_MODELS['deepseek-v4-pro'] 不存在(可能 generate-models 未执行)");
		return;
	}

	// 包装为 runtime StreamFn:把 ctx + options 转发给 pi-ai openai-completions stream
	const realStreamFn: StreamFn = (m, ctx, opts) => {
		if (m.provider !== "deepseek") {
			throw new Error(`realStreamFn 不可用于 provider=${m.provider}`);
		}
		const piCtx: Context = {
			systemPrompt: ctx.systemPrompt,
			messages: ctx.messages,
			tools: ctx.tools.map((t) => ({
				name: t.name,
				description: t.description,
				parameters: t.parameters,
			})),
		};
		return openaiCompletionsStream(
			m as Model<"openai-completions">,
			piCtx,
			{ ...opts, apiKey },
		) as AssistantMessageEventStream;
	};

	const ledger = new MemoryLedger({ metadata: { demo: "deepseek" } });
	const agent = new Agent({
		initialState: {
			systemPrompt: "你是 demo agent。请通过 echo 工具回显用户输入,然后给出最终回复。",
			// why any:DEEPSEEK_MODELS 的类型 key 表态很严,放开到 Model<Api> 即可。
			model: model as unknown as Model<Api>,
			tools: [echoTool],
		},
		streamFn: realStreamFn,
		ledger,
		toolExecution: "sequential",
	});

	const events: AgentEvent[] = [];
	agent.subscribe((ev) => {
		events.push(ev);
		// 打印部分关键事件,帮助人眼判断 agent-loop 进展
		if (ev.type === "turn_start" || ev.type === "turn_end") {
			console.log(`  ${ev.type} turn=${ev.turn}${ev.type === "turn_end" ? ` stopReason=${ev.stopReason}` : ""}`);
		} else if (ev.type === "message_end" && ev.role === "assistant") {
			console.log(`  message_end role=assistant stopReason=${ev.stopReason ?? "?"}`);
		} else if (ev.type === "tool_execution_start") {
			console.log(`  tool_start name=${ev.toolName} id=${ev.toolCallId}`);
		} else if (ev.type === "tool_execution_end") {
			console.log(`  tool_end   name=${ev.toolName} id=${ev.toolCallId} isError=${ev.isError === true}`);
		}
	});

	try {
		const final = await agent.prompt("请通过 echo 工具回显 'hi from deepseek'");
		const tail = final[final.length - 1];
		const tailText =
			tail && tail.role === "assistant"
				? tail.content.find((c) => c.type === "text")?.text ?? "<no text>"
				: "<no assistant tail>";
		console.log(`  最终 assistant 文本:${tailText}`);
		console.log(`  events=${events.length}, ledger=${ledger.entries().length}`);
	} catch (e) {
		console.log(`  调用失败:${(e as Error).message}`);
	}
}

await main();
