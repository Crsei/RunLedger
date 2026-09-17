import { describe, expect, it } from "vitest";
import { projectExtensionEvent } from "../../src/extensions/events/projection.ts";
import { ExtensionEventBridge } from "../../src/extensions/events/bridge.ts";
import type { ExtensionEventBridgeDispatch } from "../../src/extensions/events/bridge.ts";
import type { ExtensionEventOutcome } from "../../src/extensions/host/client.ts";
import { EXTENSION_CONTRACT_BOUNDS } from "../../src/contracts/extensions/common.ts";

function handlers(...results: readonly Record<string, unknown>[]): ExtensionEventOutcome {
	return { ok: true, value: { handlers: results.map((result, index) => ({ index, outcome: "result", durationMs: 1, result })) } };
}

function bridgeWith(outcome: ExtensionEventOutcome, seen: Array<Record<string, unknown>> = []) {
	const bridge = new ExtensionEventBridge({
		dispatch: async (input) => { seen.push(input as unknown as Record<string, unknown>); return outcome; },
	});
	return { bridge, seen };
}

const subscriber = ["sample@local"];

describe("extension event projection", () => {
	it("clips the payload to the descriptor whitelist and records dropped key names only", () => {
		const projected = projectExtensionEvent({
			name: "PreToolUse",
			source: { sessionId: "s-1", turnId: "t-1", toolCallId: "c-1", toolName: "bash", argsJson: "{}", secretToken: "sk-live", rawResult: "huge" },
		});
		expect(projected.ok).toBe(true);
		if (!projected.ok) return;
		expect(Object.keys(projected.projection.payload).sort()).toEqual(["argsJson", "sessionId", "toolCallId", "toolName", "turnId"]);
		expect(projected.droppedFields).toEqual(["rawResult", "secretToken"]);
		expect(JSON.stringify(projected.projection)).not.toContain("sk-live");
	});

	it("drops credential-shaped keys even when a descriptor listed them", () => {
		const projected = projectExtensionEvent({
			name: "PreToolUse",
			source: { toolName: "bash", installPath: "/home/user/.runledger/plugins/x" },
		});
		expect(projected.ok).toBe(true);
		if (!projected.ok) return;
		expect(projected.projection.payload.installPath).toBeUndefined();
		expect(projected.droppedFields).toContain("installPath");
	});

	it("rejects events outside the frozen projection namespace", () => {
		const projected = projectExtensionEvent({ name: "ToolCall", source: {} });
		expect(projected).toEqual({
			ok: false,
			error: { code: "event_not_projected", message: "event is not in the extension projection whitelist: ToolCall", droppedFields: [] },
		});
	});

	it("rejects an oversize payload instead of truncating it", () => {
		const projected = projectExtensionEvent({
			name: "PreToolUse",
			source: { argsJson: "x".repeat(EXTENSION_CONTRACT_BOUNDS.eventPayloadBytes) },
			maxPayloadBytes: 1_024,
		});
		expect(projected.ok).toBe(false);
		if (!projected.ok) expect(projected.error.code).toBe("payload_oversize");
	});
});

describe("extension event bridge synthesis", () => {
	it("short-circuits when no extension subscribed to the event", async () => {
		const { bridge, seen } = bridgeWith(handlers());
		const outcome = await bridge.dispatch({ name: "TurnStart", source: { sessionId: "s" }, subscribers: [] });
		expect(outcome.ok).toBe(true);
		if (outcome.ok) expect(outcome.result).toMatchObject({ decision: "allow", blocked: false, handlers: [] });
		expect(seen).toEqual([]);
	});

	it("appends bounded additional context", async () => {
		const { bridge } = bridgeWith(handlers({ additionalContext: "remember the workspace key" }, { additionalContext: "and the profile" }));
		const outcome = await bridge.dispatch({ name: "UserPromptSubmit", source: { sessionId: "s", turnId: "t" }, subscribers: subscriber });
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(outcome.result.additionalContext).toEqual(["remember the workspace key", "and the profile"]);
		expect(outcome.result).toMatchObject({ decision: "allow", blocked: false, requiresAuthorization: false, requiresRevalidation: false });
	});

	it("blocks on deny and keeps the first reason", async () => {
		const { bridge } = bridgeWith(handlers({ decision: "deny", reason: "policy: no destructive tool" }, { decision: "deny", reason: "second" }));
		const outcome = await bridge.dispatch({ name: "PreToolUse", source: { sessionId: "s", toolName: "bash" }, subscribers: subscriber });
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(outcome.result).toMatchObject({ decision: "deny", blocked: true });
		expect(outcome.result.handlers.every((handler) => handler.accepted)).toBe(true);
	});

	it("requires re-authorization when PreToolUse rewrites the input", async () => {
		const { bridge } = bridgeWith(handlers({ decision: "allow", updatedInput: { command: "ls" } }));
		const outcome = await bridge.dispatch({
			name: "PreToolUse",
			source: { sessionId: "s", toolName: "bash" },
			input: { command: "rm -rf /" },
			subscribers: subscriber,
		});
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(outcome.result.finalInput).toEqual({ command: "ls" });
		expect(outcome.result.updatedInput).toEqual({ command: "ls" });
		expect(outcome.result.requiresAuthorization).toBe(true);
		expect(outcome.result.requiresRevalidation).toBe(true);
	});

	it("refuses an input rewrite from any event other than PreToolUse", async () => {
		const { bridge } = bridgeWith(handlers({ decision: "allow", updatedInput: { command: "ls" } }));
		const outcome = await bridge.dispatch({ name: "SessionBeforeStop", source: { sessionId: "s" }, subscribers: subscriber });
		expect(outcome.ok).toBe(false);
		if (outcome.ok) return;
		expect(outcome.code).toBe("handler_result_invalid");
		expect(outcome.message).toContain("only PreToolUse may do");
	});

	it("fails the whole dispatch on a malformed handler result rather than treating it as allow", async () => {
		const { bridge } = bridgeWith(handlers({ decision: "maybe" }));
		const outcome = await bridge.dispatch({ name: "PreToolUse", source: { sessionId: "s" }, subscribers: subscriber });
		expect(outcome.ok).toBe(false);
		if (outcome.ok) return;
		expect(outcome.code).toBe("handler_result_invalid");
	});

	it("rejects fields outside the event result shape", async () => {
		const { bridge } = bridgeWith(handlers({ decision: "allow", sandbox: "off" }));
		const outcome = await bridge.dispatch({ name: "PreToolUse", source: { sessionId: "s" }, subscribers: subscriber });
		expect(outcome.ok).toBe(false);
		if (!outcome.ok) expect(outcome.code).toBe("handler_result_invalid");
	});

	it("turns handler timeouts and errors into diagnostics without changing the decision", async () => {
		const { bridge } = bridgeWith({
			ok: true,
			value: {
				handlers: [
					{ index: 0, outcome: "timeout", durationMs: 30, result: null },
					{ index: 1, outcome: "error", durationMs: 2, result: null },
					{ index: 2, outcome: "result", durationMs: 1, result: { decision: "allow" } },
				],
			},
		});
		const outcome = await bridge.dispatch({ name: "PreToolUse", source: { sessionId: "s" }, subscribers: subscriber });
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(outcome.result.decision).toBe("allow");
		expect(outcome.result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
			"extensions.event_handler_failed",
			"extensions.event_handler_timeout",
		]);
		expect(outcome.result.handlers.map((handler) => handler.accepted)).toEqual([false, false, true]);
	});

	it("accumulates replacements in order and marks revalidation", async () => {
		const { bridge } = bridgeWith(handlers({ replacement: { content: "first" } }, { replacement: { content: "second" } }));
		const outcome = await bridge.dispatch({ name: "PostToolUse", source: { sessionId: "s" }, subscribers: subscriber });
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(outcome.result.replacements).toEqual([{ content: "first" }, { content: "second" }]);
		expect(outcome.result.replacement).toEqual({ content: "second" });
		expect(outcome.result.requiresRevalidation).toBe(true);
		expect(outcome.result.requiresAuthorization).toBe(false);
	});

	it("refuses an oversize rewrite or replacement", async () => {
		const oversize = "x".repeat(EXTENSION_CONTRACT_BOUNDS.eventPayloadBytes + 16);
		const rewrite = bridgeWith(handlers({ decision: "allow", updatedInput: { blob: oversize } }));
		const rewriteOutcome = await rewrite.bridge.dispatch({ name: "PreToolUse", source: { sessionId: "s" }, subscribers: subscriber });
		expect(rewriteOutcome.ok).toBe(false);

		const replace = bridgeWith(handlers({ replacement: { blob: oversize } }));
		const replaceOutcome = await replace.bridge.dispatch({ name: "PostToolUse", source: { sessionId: "s" }, subscribers: subscriber });
		expect(replaceOutcome.ok).toBe(false);
		if (!replaceOutcome.ok) expect(replaceOutcome.code).toBe("handler_result_invalid");
	});

	it("maps host transport failures and aborts to explicit failures", async () => {
		const unavailable = bridgeWith({ ok: false, code: "host_unavailable", message: "extension host is not in a ready generation" });
		const unavailableOutcome = await unavailable.bridge.dispatch({ name: "TurnStart", source: { sessionId: "s" }, subscribers: subscriber });
		expect(unavailableOutcome.ok).toBe(false);
		if (!unavailableOutcome.ok) expect(unavailableOutcome.code).toBe("host_unavailable");

		const aborted = bridgeWith({ ok: false, code: "host_event_aborted", message: "event was aborted" });
		const abortedOutcome = await aborted.bridge.dispatch({ name: "TurnStart", source: { sessionId: "s" }, subscribers: subscriber });
		expect(abortedOutcome.ok).toBe(false);
		if (!abortedOutcome.ok) expect(abortedOutcome.code).toBe("aborted");
	});

	it("rejects an event outside the whitelist before touching the host", async () => {
		const { bridge, seen } = bridgeWith(handlers());
		const outcome = await bridge.dispatch({ name: "ToolCall", source: {}, subscribers: subscriber });
		expect(outcome.ok).toBe(false);
		if (!outcome.ok) expect(outcome.code).toBe("event_not_projected");
		expect(seen).toEqual([]);
	});

	it("audits every dispatch and every failure", async () => {
		const audits: string[] = [];
		const bridge = new ExtensionEventBridge({
			dispatch: async () => handlers({ decision: "allow" }),
			audit: async (event) => { audits.push(event.eventType); },
		});
		await bridge.dispatch({ name: "PreToolUse", source: { sessionId: "s" }, subscribers: subscriber });
		await bridge.dispatch({ name: "PreToolUse", source: { sessionId: "s" }, subscribers: subscriber });
		expect(audits).toEqual(["extension.event.dispatched", "extension.event.dispatched"]);
	});

	it("keeps the dispatch payload free of secret-shaped fields", async () => {
		const { bridge, seen } = bridgeWith(handlers({ decision: "allow" }));
		await bridge.dispatch({
			name: "PreToolUse",
			source: { sessionId: "s", toolName: "bash", authorization: "Bearer sk-live" },
			subscribers: subscriber,
		});
		expect(JSON.stringify(seen[0])).not.toContain("sk-live");
	});
});
