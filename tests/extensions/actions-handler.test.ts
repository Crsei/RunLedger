import { describe, expect, it } from "vitest";
import { createExtensionActionHandler } from "../../src/extensions/actions/handler.ts";
import type { ExtensionActionActorPort } from "../../src/extensions/actions/handler.ts";
import { ExtensionActionLedger } from "../../src/extensions/actions/receipts.ts";
import type { ExtensionHostActionRequest } from "../../src/extensions/host/client.ts";
import type { ExtensionActionResult } from "../../src/extensions/host/runtime-api.ts";

function request(action: string, payload: Record<string, unknown> = {}, requestId = "action-1"): ExtensionHostActionRequest {
	return { requestId, action, payload };
}

interface Recorder {
	readonly calls: string[];
	readonly port: ExtensionActionActorPort;
}

function createRecorder(overrides: Partial<ExtensionActionActorPort> = {}): Recorder {
	const calls: string[] = [];
	const ok = async (name: string): Promise<ExtensionActionResult> => { calls.push(name); return { ok: true, value: { committed: true } }; };
	const port: ExtensionActionActorPort = {
		sendMessage: async (input) => { calls.push(`sendMessage:${input.text}`); return { ok: true }; },
		appendEntry: async () => ok("appendEntry"),
		setActiveTools: async (input) => { calls.push(`setActiveTools:${input.names.join(",")}`); return { ok: true }; },
		setModel: async (input) => { calls.push(`setModel:${input.providerId}/${input.modelId}`); return { ok: true }; },
		setThinkingLevel: async (input) => { calls.push(`setThinkingLevel:${input.level}`); return { ok: true }; },
		setSessionName: async (input) => { calls.push(`setSessionName:${input.name}`); return { ok: true }; },
		exec: async (input) => { calls.push(`exec:${input.command}`); return { ok: true }; },
		emitIntent: async (input) => { calls.push(`emitIntent:${input.intent.kind}`); return { ok: true }; },
		...overrides,
	};
	return { calls, port };
}

function handlerFor(recorder: Recorder, admittedTools: readonly string[] = ["fixture_echo"], audits: string[] = []) {
	return createExtensionActionHandler({
		port: recorder.port,
		generation: 3,
		admittedTools: () => admittedTools,
		audit: async (event) => { audits.push(event.eventType); },
	});
}

describe("extension runtime actions", () => {
	it("routes well-formed actions to the owner port and records a committed receipt", async () => {
		const recorder = createRecorder();
		const audits: string[] = [];
		const handler = handlerFor(recorder, ["read", "grep"], audits);
		await expect(handler.handle(request("set-active-tools", { names: ["read", "grep"] }))).resolves.toEqual({ ok: true });
		await expect(handler.handle(request("set-model", { providerId: "openai", modelId: "gpt" }, "action-2"))).resolves.toEqual({ ok: true });
		expect(recorder.calls).toEqual(["setActiveTools:read,grep", "setModel:openai/gpt"]);
		expect(audits).toEqual(["extension.action.committed", "extension.action.committed"]);
		expect(handler.ledger.size()).toBe(2);
	});

	it("rejects malformed payloads without touching the owner port", async () => {
		const recorder = createRecorder();
		const handler = handlerFor(recorder);
		const cases: Array<[string, Record<string, unknown>, string]> = [
			["send-message", { text: "" }, "invalid_payload"],
			["send-message", { text: "hi", extra: 1 }, "invalid_payload"],
			["append-entry", { entry: "not-an-object" }, "invalid_payload"],
			["set-model", { providerId: "openai" }, "invalid_payload"],
			["set-thinking-level", { level: "warp" }, "invalid_payload"],
			["set-session-name", { name: "x".repeat(300) }, "invalid_payload"],
			["exec", { command: "" }, "invalid_payload"],
			["set-service-tier", {}, "unsupported_action"],
		];
		for (const [action, payload, code] of cases) {
			const result = await handler.handle(request(action, payload, `req-${action}-${code}-${JSON.stringify(payload).length}`));
			expect(result.ok, `${action} ${code}`).toBe(false);
			if (!result.ok) expect(result.code).toBe(code);
		}
		expect(recorder.calls).toEqual([]);
	});

	it("keeps setActiveTools an owner decision and rejects unknown names", async () => {
		const recorder = createRecorder();
		const handler = handlerFor(recorder, ["read"]);
		const rejectedResult = await handler.handle(request("set-active-tools", { names: ["read", "ghost"] }));
		expect(rejectedResult.ok).toBe(false);
		if (!rejectedResult.ok) expect(rejectedResult.code).toBe("unknown_tool");
		expect(recorder.calls).toEqual([]);

		const accepted = await handler.handle(request("set-active-tools", { names: ["read"] }, "action-2"));
		expect(accepted.ok).toBe(true);
		expect(recorder.calls).toEqual(["setActiveTools:read"]);
	});

	it("replays the same request id without a second side effect", async () => {
		const recorder = createRecorder();
		const audits: string[] = [];
		const handler = handlerFor(recorder, ["fixture_echo"], audits);
		const first = await handler.handle(request("send-message", { text: "hello" }));
		const second = await handler.handle(request("send-message", { text: "hello" }));
		expect(first).toEqual(second);
		expect(recorder.calls).toEqual(["sendMessage:hello"]);
		expect(audits).toEqual(["extension.action.committed", "extension.action.replayed"]);
	});

	it("reports a conflict when one request id carries a different body", async () => {
		const recorder = createRecorder();
		const handler = handlerFor(recorder);
		await handler.handle(request("send-message", { text: "hello" }));
		const conflict = await handler.handle(request("send-message", { text: "goodbye" }));
		expect(conflict.ok).toBe(false);
		if (!conflict.ok) expect(conflict.code).toBe("request_conflict");
		expect(recorder.calls).toEqual(["sendMessage:hello"]);
	});

	it("marks an unknown outcome as uncertain and never replays the side effect", async () => {
		let calls = 0;
		const recorder = createRecorder({
			setModel: async () => { calls += 1; throw new Error("provider credential lookup failed with /home/user/.runledger/secret"); },
		});
		const handler = handlerFor(recorder);
		const first = await handler.handle(request("set-model", { providerId: "openai", modelId: "gpt" }));
		expect(first).toEqual({ ok: false, code: "uncertain_outcome", message: "extension action outcome is unknown" });
		const replay = await handler.handle(request("set-model", { providerId: "openai", modelId: "gpt" }));
		expect(replay).toEqual({ ok: false, code: "uncertain_outcome", message: "extension action outcome is unknown" });
		expect(calls).toBe(1);
		expect(JSON.stringify(first)).not.toContain("/home/user");
	});

	it("propagates a model failure as a rejection without inventing state", async () => {
		const recorder = createRecorder({
			setModel: async () => ({ ok: false, code: "model_unavailable", message: "no credentials for openai" }),
		});
		const handler = handlerFor(recorder);
		const result = await handler.handle(request("set-model", { providerId: "openai", modelId: "gpt" }));
		expect(result).toEqual({ ok: false, code: "model_unavailable", message: "no credentials for openai" });
		// 失败回执同样被记账，因此重放返回同一失败而不是再试一次。
		const replay = await handler.handle(request("set-model", { providerId: "openai", modelId: "gpt" }));
		expect(replay).toEqual(result);
	});

	it("treats intents as projections and validates them", async () => {
		const recorder = createRecorder();
		const handler = handlerFor(recorder);
		const missing = await handler.handle(request("intent", {}));
		expect(missing.ok).toBe(false);
		if (!missing.ok) expect(missing.code).toBe("invalid_intent");

		const emitted = await handler.handle({
			requestId: "action-intent",
			action: "intent",
			payload: {},
			intent: { kind: "status", level: "info", key: "phase", text: "running" },
		});
		expect(emitted.ok).toBe(true);
		expect(recorder.calls).toEqual(["emitIntent:status"]);
	});

	it("bounds the receipt ledger and evicts the oldest entries", async () => {
		const ledger = new ExtensionActionLedger({ maxEntries: 2 });
		expect(ledger.replay({ generation: 1, action: "a", requestId: "1", requestDigest: "d" }).status).toBe("miss");
		ledger.record({ requestId: "1", action: "a", generation: 1, requestDigest: "d", outcome: "committed" });
		ledger.record({ requestId: "2", action: "a", generation: 1, requestDigest: "d", outcome: "committed" });
		ledger.record({ requestId: "3", action: "a", generation: 1, requestDigest: "d", outcome: "committed" });
		expect(ledger.size()).toBe(2);
		expect(ledger.replay({ generation: 1, action: "a", requestId: "1", requestDigest: "d" }).status).toBe("miss");
		expect(ledger.replay({ generation: 1, action: "a", requestId: "3", requestDigest: "d" }).status).toBe("hit");
	});

	it("scopes receipts by generation so a new host cannot inherit old ids", async () => {
		const recorder = createRecorder();
		const ledger = new ExtensionActionLedger();
		const first = createExtensionActionHandler({ port: recorder.port, generation: 1, ledger, admittedTools: () => [] });
		await first.handle(request("send-message", { text: "hello" }));
		const second = createExtensionActionHandler({ port: recorder.port, generation: 2, ledger, admittedTools: () => [] });
		await second.handle(request("send-message", { text: "hello" }));
		expect(recorder.calls).toEqual(["sendMessage:hello", "sendMessage:hello"]);
	});
});
