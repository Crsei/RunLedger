import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEmbeddedSessionRuntime } from "../../../src/cli/embedded-session-runtime.ts";
import { createModels, createProvider } from "../../../src/models.ts";
import { buildRunledgerLayout } from "../../../src/runtime/contracts/storage-layout.ts";
import { mockModel } from "../../../src/runtime/providers/mock-stream.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/ids.ts";
import type { SessionDomainPort } from "../../../src/runtime/session-runtime/session-runtime.ts";
import { openSessionDatabase } from "../../../src/storage/session-store/database.ts";
import { OwnerStore } from "../../../src/storage/session-store/owner-store.ts";
import { installSessionStoreSchema } from "../../../src/storage/session-store/schema.ts";
import { SessionStore } from "../../../src/storage/session-store/session-store.ts";
import { SettingsResolver } from "../../../src/storage/settings-resolver.ts";
import type { Api, AssistantMessage, Context, Model } from "../../../src/types.ts";
import { createAssistantMessageEventStream } from "../../../src/utils/event-stream.ts";

const cleanup: string[] = [];

afterEach(() => {
	for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

function stopStream(model: Model<Api>, _context: Context) {
	const stream = createAssistantMessageEventStream();
	queueMicrotask(() => {
		const message: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "production reply" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			stopReason: "stop",
			timestamp: Date.now(),
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		};
		stream.push({ type: "start", partial: { ...message, content: [] } });
		stream.push({ type: "done", reason: "stop", message });
		stream.end(message);
	});
	return stream;
}

describe("production Session settings turn composition", () => {
	it("adopts next-turn settings, rebuilds tools, and invokes the Host compaction summarizer", async () => {
		const root = mkdtempSync(join(tmpdir(), "runledger-settings-turn-composition-"));
		cleanup.push(root);
		const layout = buildRunledgerLayout(join(root, "home"), "posix");
		mkdirSync(layout.home, { recursive: true, mode: 0o700 });
		const database = openSessionDatabase(layout.database);
		installSessionStoreSchema(database);
		const store = new SessionStore(database);
		const ownerStore = new OwnerStore(database);
		const sessionId = createRuntimeId("session", "settings-turn-composition");
		store.createSession({
			sessionId,
			workspaceId: createRuntimeId("workspace", "settings-turn-composition"),
			repositoryId: createRuntimeId("repository", "settings-turn-composition"),
			settingsDigest: "s".repeat(64),
		});
		const models = createModels();
		models.setProvider(createProvider({
			id: mockModel.provider,
			name: "Settings fixture",
			auth: {
				apiKey: {
					name: "fixture key",
					resolve: async () => ({ auth: { apiKey: "fixture-only" }, source: "fixture" }),
				},
			},
			models: [mockModel],
			api: { stream: stopStream, streamSimple: stopStream },
		}));
		const startupSettings = new SettingsResolver({
			user: { tools: { write: { enabled: true } }, compaction: { thresholdTokens: 1 } },
		}).effectiveRuntimeSnapshot();
		const turnSettings = new SettingsResolver({
			user: {
				retry: { maxRetries: 4 },
				tools: { write: { enabled: false } },
				compaction: { thresholdTokens: 1, retainRecentTurns: 1, minCompactedTurns: 1 },
			},
		}).effectiveRuntimeSnapshot();
		const runtimeSettingsForTurn = vi.fn(async () => turnSettings);
		const compactionSummarizer = vi.fn(() => "production compacted history");
		const compactionSummarizerFactory = vi.fn(() => compactionSummarizer);
		let embedded: Awaited<ReturnType<typeof createEmbeddedSessionRuntime>> | undefined;
		try {
			embedded = await createEmbeddedSessionRuntime({
				sessionId,
				store,
				ownerStore,
				domain: {
					cwd: root,
					layout,
					settings: { provider: mockModel.provider, model: mockModel.id },
					runtimeSettings: startupSettings,
					runtimeSettingsForTurn,
					compactionSummarizerFactory,
					models,
					securitySources: [{
						source: "cli",
						read: async () => ({ status: "available", text: JSON.stringify({ profile: "danger-full-access" }) }),
					}],
				},
			});
			const runtime = embedded.runtime;
			if (runtime === undefined) throw new Error("fixture did not claim the Session runtime");
			const domain = (runtime as unknown as { readonly domain?: SessionDomainPort }).domain;
			if (domain === undefined) throw new Error("production Session domain was not composed");
			const initialToolCount = domain.controller.toolCount;

			await domain.controller.prompt("first turn");
			await domain.controller.prompt("second turn");

			expect(runtimeSettingsForTurn).toHaveBeenCalledTimes(2);
			expect(compactionSummarizerFactory).toHaveBeenCalledTimes(2);
			expect(compactionSummarizer).toHaveBeenCalledTimes(1);
			expect(domain.controller.toolCount).toBe(initialToolCount - 1);
			expect(runtime.runtimeSettingsSnapshot()).toBe(turnSettings);
		} finally {
			await embedded?.handle.close().catch(() => undefined);
			await embedded?.runtime?.shutdownAfterLastAttachment("paused");
			database.close();
		}
	});
});
