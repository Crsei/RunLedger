/**
 * 模型列表触发的 catalog 刷新:
 * - `Models.refresh({ providers })` 必须真的限定 provider(此前只写进文档、未实现);
 * - controller.refreshModels 只刷新有 fetchModels 的 provider,TTL 内不重复请求,
 *   失败保持 last-known-good 且不向调用方抛错。
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderAuth } from "../../src/auth/types.ts";
import { createModels, createProvider } from "../../src/models.ts";
import { buildRunledgerLayout } from "../../src/runtime/contracts/storage-layout.ts";
import { InteractiveSessionController } from "../../src/runtime/interactive-session-controller.ts";
import { MemoryLedger } from "../../src/runtime/ledger/memory-ledger.ts";
import type { SessionReplay } from "../../src/storage/session-codec.ts";
import type { Api, AssistantMessageEventStream, Model } from "../../src/types.ts";

const cleanup: string[] = [];

afterEach(async () => {
	await Promise.all(cleanup.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "runledger-catalog-refresh-"));
	cleanup.push(dir);
	return dir;
}

function model(provider: string, id: string): Model<Api> {
	return {
		id,
		name: `${provider} ${id}`,
		api: "mock",
		provider,
		baseUrl: "http://localhost",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 1024,
	};
}

/** 环境凭据式 auth:refresh 无需先 login 即可解析出 credential。 */
function envAuth(): ProviderAuth {
	return {
		apiKey: {
			name: "Fixture API key",
			login: async () => ({ type: "api_key", key: "fixture-key" }),
			resolve: async () => ({ auth: { apiKey: "fixture-key" }, source: "FIXTURE_API_KEY" }),
		},
	};
}

function stopStream(): AssistantMessageEventStream {
	throw new Error("streaming is not expected in catalog refresh tests");
}

function dynamicProvider(options: {
	id: string;
	fetchModels: () => Promise<readonly Model<Api>[]>;
}): ReturnType<typeof createProvider> {
	return createProvider({
		id: options.id,
		name: options.id,
		auth: envAuth(),
		models: [model(options.id, "baseline")],
		fetchModels: options.fetchModels,
		api: { stream: () => stopStream(), streamSimple: () => stopStream() },
	});
}

const EMPTY_REPLAY: SessionReplay = { messages: [], config: {}, auditEntries: [], warnings: [] };

async function controllerFor(models: ReturnType<typeof createModels>): Promise<InteractiveSessionController> {
	const cwd = await tempDir();
	return InteractiveSessionController.create({
		cwd,
		layout: buildRunledgerLayout(join(cwd, "home"), "posix"),
		systemPrompt: "test",
		models,
		settings: {},
		replay: EMPTY_REPLAY,
		ledger: new MemoryLedger(),
		tools: [],
	});
}

describe("Models.refresh provider selection", () => {
	it("refreshes only the requested providers", async () => {
		const p1 = vi.fn(async () => [model("p1", "fresh-1")]);
		const p2 = vi.fn(async () => [model("p2", "fresh-2")]);
		const models = createModels();
		models.setProvider(dynamicProvider({ id: "p1", fetchModels: p1 }));
		models.setProvider(dynamicProvider({ id: "p2", fetchModels: p2 }));

		await models.refresh({ providers: ["p1"] });

		expect(p1).toHaveBeenCalledTimes(1);
		expect(p2).not.toHaveBeenCalled();
		expect(models.getModels("p1").map((entry) => entry.id)).toContain("fresh-1");
		expect(models.getModels("p2").map((entry) => entry.id)).toEqual(["baseline"]);
	});

	it("ignores unknown and static providers", async () => {
		const models = createModels();
		const staticProvider = createProvider({
			id: "static",
			name: "static",
			auth: envAuth(),
			models: [model("static", "only")],
			api: { stream: () => stopStream(), streamSimple: () => stopStream() },
		});
		models.setProvider(staticProvider);
		await expect(models.refresh({ providers: ["static", "missing"] })).resolves.toMatchObject({ aborted: false });
	});
});

describe("InteractiveSessionController.refreshModels", () => {
	it("refreshes dynamic providers and skips static ones", async () => {
		const fetchModels = vi.fn(async () => [model("p1", "fresh-1")]);
		const models = createModels();
		models.setProvider(dynamicProvider({ id: "p1", fetchModels }));
		models.setProvider(createProvider({
			id: "static",
			name: "static",
			auth: envAuth(),
			models: [model("static", "only")],
			api: { stream: () => stopStream(), streamSimple: () => stopStream() },
		}));
		const controller = await controllerFor(models);
		try {
			await controller.refreshModels();
			expect(fetchModels).toHaveBeenCalledTimes(1);
			expect(models.getModels("p1").map((entry) => entry.id)).toContain("fresh-1");
		} finally {
			controller.dispose();
		}
	});

	it("throttles repeated refreshes inside the TTL", async () => {
		const fetchModels = vi.fn(async () => [model("p1", "fresh-1")]);
		const models = createModels();
		models.setProvider(dynamicProvider({ id: "p1", fetchModels }));
		const controller = await controllerFor(models);
		try {
			await controller.refreshModels("p1");
			await controller.refreshModels("p1");
			await controller.refreshModels();
			expect(fetchModels).toHaveBeenCalledTimes(1);
		} finally {
			controller.dispose();
		}
	});

	it("keeps the last known-good catalog and does not throw when discovery fails", async () => {
		const fetchModels = vi.fn(async () => {
			throw new Error("discovery unavailable");
		});
		const models = createModels();
		models.setProvider(dynamicProvider({ id: "p1", fetchModels }));
		const controller = await controllerFor(models);
		try {
			await expect(controller.refreshModels("p1")).resolves.toBeUndefined();
			expect(fetchModels).toHaveBeenCalledTimes(1);
			const available = await controller.getAvailableModels("p1");
			expect(available.map((entry) => entry.id)).toEqual(["baseline"]);
		} finally {
			controller.dispose();
		}
	});
});
