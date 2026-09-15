import { stream as responsesStream, streamSimple as responsesStreamSimple } from "../../../src/api/openai-responses.ts";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { FileArtifactStore } from "../../../src/runtime/trace/artifact-store.ts";
import { stream, streamSimple } from "../../../src/api/openai-completions.ts";
import { createModels, createProvider } from "../../../src/models.ts";
import { createEmbeddedSessionRuntime } from "../../../src/cli/embedded-session-runtime.ts";
import { claimDriver, fetchDomainSnapshot } from "../../../src/cli/main.ts";
import { SessionInteractiveController } from "../../../src/cli/session-interactive-controller.ts";
import { buildRunledgerLayout } from "../../../src/runtime/contracts/storage-layout.ts";
import { standardHarnessProfileRef } from "../../../src/runtime/harness-profiles/index.ts";
import { createCatalogModelRouter } from "../../../src/runtime/model-routing/catalog-router.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/ids.ts";
import { openSessionDatabase } from "../../../src/storage/session-store/database.ts";
import { OwnerStore } from "../../../src/storage/session-store/owner-store.ts";
import { installSessionStoreSchema } from "../../../src/storage/session-store/schema.ts";
import { SessionStore } from "../../../src/storage/session-store/session-store.ts";
import { saveProjectSettings } from "../../../src/storage/settings-manager.ts";
import type { Model } from "../../../src/types.ts";

async function fixture(native = false) {
	const root = mkdtempSync(join(tmpdir(), "runledger-compact-"));
	const home = join(root, "home"); mkdirSync(home, { mode: 0o700 });
	const requests: Record<string, unknown>[] = [];
	let rejectSummary = false;
	let rejectNormal = 0;
	let summaryGate: Promise<void> | undefined;
	let releaseSummary: (() => void) | undefined;
	const server = createServer(async (req, res) => {
		let raw = ""; for await (const chunk of req) raw += String(chunk);
		const request = JSON.parse(raw) as Record<string, unknown>; requests.push(request);
		const summarizing = JSON.stringify((request.messages as unknown[] | undefined)?.[0] ?? {}).includes("Summarize the supplied historical conversation");
		if (native) {
			if (req.url?.endsWith("/compact")) {
				res.writeHead(200, { "content-type": "application/json" });
				res.end(JSON.stringify({ id: "cmp_fixture", object: "response.compaction", created_at: 1,
					output: [...(request.input as Record<string, unknown>[]).filter((item) => item.role === "user"), { type: "compaction", id: "cmp_item", encrypted_content: "opaque-native-sentinel" }],
					usage: { input_tokens: 400, output_tokens: 100, total_tokens: 500, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } })); return;
			}
			const item = { type: "message", id: `msg_${requests.length}`, role: "assistant", status: "completed", content: [{ type: "output_text", text: `native-long-${requests.length} ${"evidence ".repeat(1200)}`, annotations: [] }] };
			res.writeHead(200, { "content-type": "text/event-stream" });
			res.end([{ type: "response.output_item.done", output_index: 0, item }, { type: "response.completed", response: { id: "response_fixture", status: "completed", output: [item], usage: { input_tokens: 100, output_tokens: 100, total_tokens: 200 } } }].map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("")); return;
		}
		if (summarizing && summaryGate !== undefined) await summaryGate;
		if (summarizing && rejectSummary) { res.writeHead(400, { "content-type": "application/json" }); res.end(JSON.stringify({ error: { message: "fixture rejects summary", type: "invalid_request_error" } })); return; }
		if (!summarizing && rejectNormal > 0) { rejectNormal -= 1; res.writeHead(400, { "content-type": "application/json" }); res.end(JSON.stringify({ error: { message: "maximum context length is 100000 tokens", type: "invalid_request_error" } })); return; }
		const content = summarizing ? "Goal and constraints: keep release scope. Decisions and completed work: compact-sentinel. Files and tool outcomes: none. Unresolved tasks: continue release. Verification evidence: none. Source references: original conversation." : "Turn finished.";
		res.writeHead(200, { "content-type": "text/event-stream" });
		res.end(`data: ${JSON.stringify({ id: "compact-test", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address(); if (address === null || typeof address === "string") throw new Error("listener missing");
	const model: Model<"openai-completions" | "openai-responses"> = { id: "fixture", name: "Fixture", provider: native ? "openai" : "fixture", api: native ? "openai-responses" : "openai-completions", baseUrl: `http://127.0.0.1:${address.port}/v1`, reasoning: false, input: ["text"], contextWindow: 100_000, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
	const models = createModels(); models.setProvider(createProvider({ id: model.provider, models: [model, { ...model, id: "other" }],
		auth: { apiKey: { name: "Fixture", check: async () => ({ type: "api_key", source: "fixture" }), resolve: async () => ({ auth: { apiKey: "fixture-only" }, source: "fixture" }) } }, api: { "openai-completions": { stream, streamSimple }, "openai-responses": { stream: responsesStream, streamSimple: responsesStreamSimple } },
	}));
	const layout = buildRunledgerLayout(home, "posix"); const db = openSessionDatabase(layout.database); installSessionStoreSchema(db);
	const store = new SessionStore(db); const ownerStore = new OwnerStore(db);
	const sessionId = createRuntimeId("session", "compact-production");
	store.createSession({ sessionId, workspaceId: createRuntimeId("workspace", "compact"), repositoryId: createRuntimeId("repository", "compact"), settingsDigest: "d".repeat(64), harnessProfile: standardHarnessProfileRef() });
	const settings = { autoTitle: false, provider: model.provider, model: "fixture", recording: { mode: "off" as const } };
	await saveProjectSettings({ layout }, settings);
	let embedded: Awaited<ReturnType<typeof createEmbeddedSessionRuntime>> | undefined;
	let client: SessionInteractiveController | undefined;
	const stop = async () => { client?.dispose(); await embedded?.handle.close(); await embedded?.runtime?.shutdownAfterLastAttachment("paused"); client = undefined; embedded = undefined; };
	const start = async (targetSessionId = sessionId) => {
		embedded = await createEmbeddedSessionRuntime({ sessionId: targetSessionId, store, ownerStore, domain: {
			cwd: root, layout, models, settings, modelRequestRouter: createCatalogModelRouter(models),
			securitySources: [{ source: "cli", read: async () => ({ status: "available", text: JSON.stringify({ profile: "danger-full-access", approvalPolicy: "never" }) }) }],
		} });
		client = new SessionInteractiveController(embedded.handle, await fetchDomainSnapshot(embedded));
		await claimDriver(embedded, client); await client.resumeEvents();
		return client;
	};
	return { root, model, layout, store, rejectReceipt: () => db.execSync("CREATE TEMP TRIGGER reject_compact_receipt BEFORE INSERT ON command_attempt_receipts WHEN NEW.outcome = 'committed' AND NEW.command_id LIKE 'command_compact-%' BEGIN SELECT RAISE(ABORT, 'fixture receipt failure'); END"), hold: () => { summaryGate = new Promise<void>((resolve) => { releaseSummary = resolve; }); }, release: () => releaseSummary?.(), sessionId, requests, start, stop, overflow: (count: number) => { rejectNormal = count; }, configure: (threshold: number) => saveProjectSettings({ layout }, { ...settings, compaction: { auto: true, threshold } }), reject: () => { rejectSummary = true; },
		close: async () => { releaseSummary?.(); await stop(); db.close(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); rmSync(root, { recursive: true, force: true }); },
	};
}

describe("manual compact through the production Session Owner", () => {
	it("commits a real HTTP summary, preserves raw messages and restores the same projection", async () => {
		const f = await fixture();
		try {
			let client = await f.start();
			for (let index = 0; index < 4; index += 1) { await client.prompt(`turn-${index} ${"release-detail ".repeat(150)}`); await client.waitForIdle(); }
			const originals = f.store.replaySessionEvents(f.sessionId).filter((event) => event.eventType === "ledger.message");
			expect(client.supports("compact.run")).toBe(true);
			const context = { correlationId: "compact-request", effectId: "compact-effect", expectedRevision: 0 };
			const compacted = await client.commandSessionDomain("compact.run", {}, context);
			expect(compacted, JSON.stringify(compacted)).toMatchObject({ ok: true, domainRevision: 1 });
			const summaryRequest = f.requests.at(-1)!;
			expect(summaryRequest.tools ?? []).toEqual([]);
			expect(JSON.stringify(summaryRequest.messages)).toContain("turn-0");
			expect(JSON.stringify(summaryRequest.messages)).not.toContain("turn-3");
			const count = f.requests.length;
			expect(await client.commandSessionDomain("compact.run", {}, context)).toEqual(compacted);
			expect(f.requests).toHaveLength(count);
			expect(f.store.replaySessionEvents(f.sessionId).filter((event) => event.eventType === "ledger.message")).toEqual(originals);
			expect(f.store.listAllAttemptReceipts(f.sessionId).filter((receipt) => receipt.commandId.includes("compact-")).at(-1)?.outcome).toBe("committed");
			await f.stop(); client = await f.start();
			await client.prompt("continue-after-resume"); await client.waitForIdle();
			const wire = JSON.stringify(f.requests.at(-1)!.messages);
			expect(wire).toContain("compact-sentinel"); expect(wire).toContain("turn-3"); expect(wire).not.toContain("turn-0");
			expect(wire).toContain("continue-after-resume");
		} finally { await f.close(); }
	}, 60_000);

	it("records a failed attempt while leaving the original request projection intact", async () => {
		const f = await fixture();
		try {
			const client = await f.start();
			for (let index = 0; index < 2; index += 1) { await client.prompt(`original-${index} ${"detail ".repeat(100)}`); await client.waitForIdle(); }
			f.reject();
			expect(await client.commandSessionDomain("compact.run", { strategy: "hierarchical" }, { correlationId: "failed", effectId: "failed", expectedRevision: 0 })).toMatchObject({ ok: false });
			expect(f.store.replaySessionEvents(f.sessionId).filter((event) => event.eventType.startsWith("compaction.")).map((event) => event.eventType)).toEqual(["compaction.started", "compaction.failed"]);
			await client.prompt("continue-original"); await client.waitForIdle();
			expect(JSON.stringify(f.requests.at(-1)!.messages)).toContain("original-0");
			expect(JSON.stringify(f.requests.at(-1)!.messages)).not.toContain("Historical conversation summary");
		} finally { await f.close(); }
	}, 60_000);
	it.each(["intent", "artifact", "before-commit", "after-commit"] as const)("restores an atomic projection after %s failure", async (phase) => {
		const f = await fixture();
		try {
			let client = await f.start();
			for (let index = 0; index < 3; index += 1) { await client.prompt(`fault-original-${index} ${"detail ".repeat(200)}`); await client.waitForIdle(); }
			if (phase === "intent") {
				const append = f.store.appendEvent.bind(f.store);
				vi.spyOn(f.store, "appendEvent").mockImplementationOnce((...args) => { append(...args); throw new Error("fixture intent boundary failure"); });
			} else if (phase === "artifact") vi.spyOn(FileArtifactStore.prototype, "putDurable").mockRejectedValueOnce(new Error("fixture disk failure"));
			else {
				const append = f.store.appendEventAndSettleAttempt.bind(f.store);
				vi.spyOn(f.store, "appendEventAndSettleAttempt").mockImplementationOnce((...args) => {
					if (phase === "after-commit") append(...args);
					throw new Error("fixture transaction boundary failure");
				});
			}
			const result = await client.commandSessionDomain("compact.run", {}, { correlationId: phase, effectId: phase, expectedRevision: 0 });
			expect(result.ok).toBe(phase === "after-commit");
			vi.restoreAllMocks();
			const calls = f.requests.length;
			await f.stop(); client = await f.start();
			expect(f.requests).toHaveLength(calls);
			await client.prompt("continue-fault"); await client.waitForIdle();
			const wire = JSON.stringify(f.requests.at(-1)!.messages);
			expect(wire.includes("compact-sentinel")).toBe(phase === "after-commit");
			expect(wire.includes("fault-original-0")).toBe(phase !== "after-commit");
		} finally { vi.restoreAllMocks(); await f.close(); }
	}, 60_000);

	it("uses hierarchical via the same owner and chains a second compact", async () => {
		const f = await fixture();
		try {
			const client = await f.start();
			for (let index = 0; index < 3; index += 1) { await client.prompt(`chain-${index} ${"detail ".repeat(200)}`); await client.waitForIdle(); }
			expect(await client.commandSessionDomain("compact.run", { strategy: "hierarchical" }, { correlationId: "chain-first", effectId: "first", expectedRevision: 0 })).toMatchObject({ ok: true, domainRevision: 1 });
			await client.prompt(`chain-new ${"detail ".repeat(200)}`); await client.waitForIdle();
			expect(await client.commandSessionDomain("compact.run", {}, { correlationId: "chain-second", effectId: "second", expectedRevision: 1 })).toMatchObject({ ok: true, domainRevision: 2 });
			const records = f.store.replaySessionEvents(f.sessionId).filter((event) => event.eventType === "compaction.completed").map((event) => JSON.parse(event.payloadJson));
			expect(records[1].previousId).toBe(records[0].checkpoint.compactionId);
			expect(records[1].count).toBeGreaterThan(records[0].count);
			await client.prompt("continue-chain"); await client.waitForIdle();
			expect(JSON.stringify(f.requests.at(-1)!.messages)).toContain("chain-new");
		} finally { await f.close(); }
	}, 60_000);

	it("automatically compacts before omission", async () => {
		const f = await fixture();
		try {
			const client = await f.start();
			for (let index = 0; index < 3; index += 1) { await client.prompt(`auto-${index} ${"detail ".repeat(2200)}`); await client.waitForIdle(); }
			await f.configure(0.1);
			await client.prompt("auto-trigger"); await client.waitForIdle();
			const completed = f.store.replaySessionEvents(f.sessionId).filter((event) => event.eventType === "compaction.completed");
			expect(completed, JSON.stringify(f.store.replaySessionEvents(f.sessionId).filter((event) => event.eventType.startsWith("compaction.")).map((event) => JSON.parse(event.payloadJson)))).toHaveLength(1);
			expect(JSON.parse(completed[0]!.payloadJson).checkpoint.reason).toBe("auto");
			expect(JSON.stringify(f.requests.at(-1)!.messages)).toContain("compact-sentinel");
		} finally { await f.close(); }
	}, 60_000);

	it.each([1, 5])("retries overflow at most once (provider rejects %s requests)", async (rejections) => {
		const f = await fixture();
		try {
			const client = await f.start();
			for (let index = 0; index < 3; index += 1) { await client.prompt(`overflow-${index} ${"detail ".repeat(200)}`); await client.waitForIdle(); }
			await f.configure(0.95); f.overflow(rejections);
			const previous = f.requests.length;
			await client.prompt("overflow-trigger"); await client.waitForIdle();
			expect(f.requests.length - previous, JSON.stringify(f.store.replaySessionEvents(f.sessionId).filter((event) => event.eventType.startsWith("compaction.")).map((event) => JSON.parse(event.payloadJson)))).toBe(3);
			const completed = f.store.replaySessionEvents(f.sessionId).filter((event) => event.eventType === "compaction.completed");
			expect(completed, JSON.stringify(f.store.replaySessionEvents(f.sessionId).filter((event) => event.eventType.startsWith("compaction.")).map((event) => JSON.parse(event.payloadJson)))).toHaveLength(1);
			expect(JSON.parse(completed[0]!.payloadJson).checkpoint.reason).toBe("overflow");
		} finally { await f.close(); }
	}, 60_000);

	it("commits the full native Responses window, restores it and rejects incompatible model switches", async () => {
		const f = await fixture(true);
		try {
			let client = await f.start();
			for (let index = 0; index < 3; index += 1) { await client.prompt(`native-user-${index}`); await client.waitForIdle(); }
			const original = f.store.replaySessionEvents(f.sessionId).filter((event) => event.eventType === "ledger.message");
			const result = await client.commandSessionDomain("compact.run", { strategy: "openai-responses-native" }, { correlationId: "native", effectId: "native", expectedRevision: 0 });
			expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
			expect(f.requests.at(-1)!.tools).toBeUndefined();
			await expect(client.selectModel({ ...f.model, id: "other" })).rejects.toThrow();
			await client.selectModel(f.model);
			expect(f.store.replaySessionEvents(f.sessionId).filter((event) => event.eventType === "ledger.message")).toEqual(original);
			await f.stop(); client = await f.start();
			await client.prompt("native-after-resume"); await client.waitForIdle();
			const wire = f.requests.at(-1)!.input as Record<string, unknown>[];
			expect(wire.filter((item) => item.type === "compaction")).toEqual([{ type: "compaction", id: "cmp_item", encrypted_content: "opaque-native-sentinel" }]);
			expect(JSON.stringify(wire)).toContain("native-user-0");
			expect(JSON.stringify(wire)).not.toContain("native-long-1");
			expect(JSON.stringify(wire)).toContain("native-long-3");
			expect(JSON.stringify(wire)).toContain("native-after-resume");
		} finally { await f.close(); }
	}, 60_000);

	it.each([false, true])("inherits committed compact on fork and supports explicit raw fork (native=%s)", async (native) => {
		const f = await fixture(native);
		try {
			let client = await f.start();
			for (let index = 0; index < 3; index += 1) { await client.prompt(`fork-user-${index} ${native ? "" : "detail ".repeat(200)}`); await client.waitForIdle(); }
			const compacted = await client.commandSessionDomain("compact.run", { strategy: native ? "openai-responses-native" : "single-pass" }, { correlationId: "fork-compact", effectId: "fork-compact", expectedRevision: 0 });
			expect(compacted).toMatchObject({ ok: true });
			await f.stop();
			const inheritedId = createRuntimeId("session", "fork-inherited");
			const rawId = createRuntimeId("session", "fork-raw");
			f.store.forkSession({ sessionId: inheritedId, sourceSessionId: f.sessionId });
			f.store.forkSession({ sessionId: rawId, sourceSessionId: f.sessionId, inheritCompaction: false });
			expect(f.store.listAllAttemptReceipts(inheritedId)).toHaveLength(0);
			client = await f.start(inheritedId); await client.prompt("fork-continue"); await client.waitForIdle();
			expect(JSON.stringify(f.requests.at(-1)!)).toContain(native ? "opaque-native-sentinel" : "compact-sentinel");
			await f.stop(); client = await f.start(rawId); await client.selectModel({ ...f.model, id: "other" });
			await client.prompt("raw-continue"); await client.waitForIdle();
			const wire = JSON.stringify(f.requests.at(-1)!);
			expect(wire).not.toContain(native ? "opaque-native-sentinel" : "compact-sentinel");
			expect(wire).toContain(native ? "native-long-1" : "fork-user-0");
		} finally { await f.close(); }
	}, 60_000);

	it("cancels in-flight compact without publishing the late summary", async () => {
		const f = await fixture();
		try {
			const client = await f.start();
			for (let index = 0; index < 3; index += 1) { await client.prompt(`cancel-${index} ${"detail ".repeat(200)}`); await client.waitForIdle(); }
			f.hold(); const before = f.requests.length;
			const pending = client.commandSessionDomain("compact.run", {}, { correlationId: "cancel", effectId: "cancel", expectedRevision: 0 });
			await vi.waitFor(() => expect(f.requests.length).toBe(before + 1));
			await client.interrupt();
			expect(await pending).toMatchObject({ ok: false, code: "cancelled" });
			f.release();
			await client.prompt("after-cancel"); await client.waitForIdle();
			expect(f.store.replaySessionEvents(f.sessionId).some((event) => event.eventType === "compaction.completed")).toBe(false);
			expect(JSON.stringify(f.requests.at(-1)!.messages)).toContain("cancel-0");
		} finally { await f.close(); }
	}, 60_000);

	it("suppresses repeated automatic failure until settings change", async () => {
		const f = await fixture();
		try {
			const client = await f.start();
			for (let index = 0; index < 3; index += 1) { await client.prompt(`suppress-${index} ${"detail ".repeat(2200)}`); await client.waitForIdle(); }
			f.reject(); await f.configure(0.1);
			for (let index = 0; index < 2; index += 1) { await client.prompt(`suppressed-request-${index}`); await client.waitForIdle(); }
			const failures = () => f.store.replaySessionEvents(f.sessionId).filter((event) => event.eventType === "compaction.failed").length;
			expect(failures()).toBe(1);
			await f.configure(0.11); await client.prompt("changed-settings"); await client.waitForIdle();
			expect(failures()).toBe(2);
		} finally { await f.close(); }
	}, 60_000);

	it("rolls back the completed event when the receipt insert fails inside SQLite", async () => {
		const f = await fixture();
		try {
			const client = await f.start();
			for (let index = 0; index < 3; index += 1) { await client.prompt(`atomic-${index} ${"detail ".repeat(200)}`); await client.waitForIdle(); }
			f.rejectReceipt();
			expect(await client.commandSessionDomain("compact.run", {}, { correlationId: "receipt-fault", effectId: "receipt-fault", expectedRevision: 0 })).toMatchObject({ ok: false });
			expect(f.store.replaySessionEvents(f.sessionId).filter((event) => event.eventType.startsWith("compaction.")).map((event) => event.eventType)).toEqual(["compaction.started", "compaction.failed"]);
			expect(f.store.listAllAttemptReceipts(f.sessionId).filter((receipt) => receipt.commandId.startsWith("command_compact-")).map((receipt) => receipt.outcome)).toEqual(["started", "rejected"]);
			await client.prompt("after-atomic-fault"); await client.waitForIdle();
			expect(JSON.stringify(f.requests.at(-1)!.messages)).toContain("atomic-0");
		} finally { await f.close(); }
	}, 60_000);

	it("rewinds by forking a completed boundary on either side of a compact cut", async () => {
		const f = await fixture();
		try {
			let client = await f.start();
			for (let index = 0; index < 3; index += 1) { await client.prompt(`rewind-${index} ${"detail ".repeat(200)}`); await client.waitForIdle(); }
			expect(await client.commandSessionDomain("compact.run", {}, { correlationId: "rewind-first", effectId: "rewind-first", expectedRevision: 0 })).toMatchObject({ ok: true });
			await client.prompt(`rewind-3 ${"detail ".repeat(200)}`); await client.waitForIdle();
			const boundaries = f.store.replaySessionEvents(f.sessionId).filter((event) => event.eventType === "ledger.message" && JSON.parse(event.payloadJson).payload.message?.role === "assistant");
			await client.prompt(`rewind-future ${"detail ".repeat(200)}`); await client.waitForIdle();
			expect(await client.commandSessionDomain("compact.run", {}, { correlationId: "rewind-second", effectId: "rewind-second", expectedRevision: 1 })).toMatchObject({ ok: true });
			await f.stop();
			for (const [label, boundary, summarized] of [["before-cut", boundaries[0]!, false], ["after-cut", boundaries.at(-1)!, true]] as const) {
				const targetId = createRuntimeId("session", label);
				f.store.forkSession({ sessionId: targetId, sourceSessionId: f.sessionId, throughSequence: boundary.sequence });
				client = await f.start(targetId); await client.prompt("rewind-continue"); await client.waitForIdle();
				const wire = JSON.stringify(f.requests.at(-1)!.messages);
				expect(wire.includes("compact-sentinel")).toBe(summarized);
				expect(wire).not.toContain("rewind-future");
				expect(wire).toContain(summarized ? "rewind-3" : "rewind-0");
				await f.stop();
			}
			const userEvent = f.store.replaySessionEvents(f.sessionId).find((event) => event.eventType === "ledger.message" && JSON.parse(event.payloadJson).payload.message?.role === "user")!;
			expect(() => f.store.forkSession({ sessionId: createRuntimeId("session", "bad-boundary"), sourceSessionId: f.sessionId, throughSequence: userEvent.sequence })).toThrow("boundary");
			expect(f.store.getSession(createRuntimeId("session", "bad-boundary"))).toBeUndefined();
		} finally { await f.close(); }
	}, 60_000);

	it("fails restore on a corrupt committed artifact without calling the model again", async () => {
		const f = await fixture();
		try {
			const client = await f.start();
			for (let index = 0; index < 3; index += 1) { await client.prompt(`corrupt-${index} ${"detail ".repeat(200)}`); await client.waitForIdle(); }
			expect(await client.commandSessionDomain("compact.run", {}, { correlationId: "corrupt", effectId: "corrupt", expectedRevision: 0 })).toMatchObject({ ok: true });
			await f.stop();
			const record = JSON.parse(f.store.replaySessionEvents(f.sessionId).find((event) => event.eventType === "compaction.completed")!.payloadJson);
			writeFileSync(join(f.layout.artifacts, "sha256", record.artifact.digest.slice(0, 2), record.artifact.digest), "corrupt-fixture");
			const requests = f.requests.length;
			await expect(f.start()).rejects.toThrow("integrity");
			expect(f.requests).toHaveLength(requests);
		} finally { await f.close(); }
	}, 60_000);

});
