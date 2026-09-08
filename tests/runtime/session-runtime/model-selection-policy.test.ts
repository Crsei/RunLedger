import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createEmbeddedSessionRuntime } from "../../../src/cli/embedded-session-runtime.ts";
import { createModels, createProvider } from "../../../src/models.ts";
import { buildRunledgerLayout } from "../../../src/runtime/contracts/storage-layout.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/ids.ts";
import { openSessionDatabase } from "../../../src/storage/session-store/database.ts";
import { installSessionStoreSchema } from "../../../src/storage/session-store/schema.ts";
import { OwnerStore } from "../../../src/storage/session-store/owner-store.ts";
import { SessionStore } from "../../../src/storage/session-store/session-store.ts";
import { standardHarnessProfileRef } from "../../../src/runtime/harness-profiles/index.ts";
import type { Api, AssistantMessageEventStream, Model } from "../../../src/types.ts";

function model(id: string): Model<Api> {
	return {
		id,
		name: id,
		api: "mock",
		provider: "fixture",
		baseUrl: "http://localhost",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8_192,
		maxTokens: 1_024,
	};
}

function fixtureModels() {
	const models = createModels();
	const unverified = model("unverified");
	const verified = model("verified");
	const unavailableStream = (): AssistantMessageEventStream => {
		throw new Error("model stream is outside this selection-only test");
	};
	models.setProvider(createProvider({
		id: "fixture",
		name: "Fixture",
		auth: {
			apiKey: {
				name: "Fixture API key",
				check: async () => ({ source: "fixture", type: "api_key" }),
				resolve: async () => ({ auth: { apiKey: "fixture" }, source: "fixture" }),
			},
		},
		models: [unverified, verified],
		api: { stream: unavailableStream, streamSimple: unavailableStream },
	}));
	return { models, unverified, verified };
}

describe("SessionRuntime model selection policy", () => {
	it.each([false, true])("enforces configured model admission in the embedded Session domain (allowed=%s)", async (allowed) => {
		const root = await mkdtemp(join(tmpdir(), "runledger-session-model-policy-"));
		const home = join(root, "home");
		await mkdir(home, { recursive: true, mode: 0o700 });
		const layout = buildRunledgerLayout(home, "posix");
		const db = openSessionDatabase(layout.database);
		installSessionStoreSchema(db);
		const store = new SessionStore(db);
		const ownerStore = new OwnerStore(db);
		const sessionId = createRuntimeId("session", "model-policy");
		store.createSession({
			sessionId,
			workspaceId: createRuntimeId("workspace", "model-policy"),
			repositoryId: createRuntimeId("repository", "model-policy"),
			settingsDigest: "d".repeat(64),
			harnessProfile: standardHarnessProfileRef(),
		});
		const { models, unverified, verified } = fixtureModels();
		let embedded: Awaited<ReturnType<typeof createEmbeddedSessionRuntime>> | undefined;
		try {
			const creation = createEmbeddedSessionRuntime({
				sessionId,
				store,
				ownerStore,
				domain: {
					cwd: root,
					layout,
					settings: { provider: verified.provider, model: allowed ? verified.id : unverified.id },
					models,
					isModelSelectable: (candidate) => candidate.id === verified.id,
					securitySources: [{
						source: "cli",
						read: async () => ({ status: "available", text: JSON.stringify({ profile: "danger-full-access" }) }),
					}],
				},
			});
			// 即使断言失败，也由 finally 关闭意外创建成功的运行时。
			const initialized = creation.then((runtime) => { embedded = runtime; return runtime; });
			if (!allowed) {
				await expect(initialized).rejects.toThrow("Model selection is unavailable: fixture/unverified. No substitute model was selected.");
				return;
			}
			const runtime = await initialized;
			const snapshot = await runtime.handle.transport.request({
				frameId: "query_model_policy_snapshot",
				kind: "query_request",
				protocolVersion: 3,
				body: { queryId: "query_model_policy_snapshot", kind: "snapshot", body: {} },
			});
			expect(snapshot.body).toMatchObject({
				selection: { provider: verified.provider, model: verified },
			});
		} finally {
			await embedded?.handle.close().catch(() => undefined);
			await embedded?.runtime?.shutdownAfterLastAttachment("paused");
			db.close();
			await rm(root, { recursive: true, force: true });
		}
	});
});
