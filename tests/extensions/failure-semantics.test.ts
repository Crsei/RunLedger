/**
 * P7 失败语义矩阵：把已交付各层的失败码固定成**稳定契约**。
 *
 * 这里的价值不是重新实现功能测试（分发安装/卸载、marketplace 管理、真实子进程
 * host 的失败路径分别在 `distribution.test.ts`、`marketplace-manager.test.ts`、
 * `host-process.test.ts` 里已覆盖），而是把每条失败路径的 **code 字符串**集中断言
 * 一次：改名或静默降级都会在这里失败，而不是等到用户看到行为变化。
 */

import { describe, expect, it } from "vitest";
import { projectExtensionEvent } from "../../src/extensions/events/projection.ts";
import { ExtensionEventBridge } from "../../src/extensions/events/bridge.ts";
import type { ExtensionEventOutcome } from "../../src/extensions/host/client.ts";
import { admitExtensionTools } from "../../src/extensions/tools/admission.ts";
import type { ExtensionToolPackage } from "../../src/extensions/tools/admission.ts";
import { decodeExtensionHostFrame, createExtensionHostFrameDecoder } from "../../src/extensions/host/protocol.ts";
import { resolveExtensionSource } from "../../src/extensions/plugins/marketplace/source-resolver.ts";
import { resolveExtensionHostActivation } from "../../src/extensions/plugins/activation.ts";
import { createExtensionActionHandler } from "../../src/extensions/actions/handler.ts";
import type { ExtensionActionActorPort } from "../../src/extensions/actions/handler.ts";
import { EXTENSION_HOST_PROTOCOL_VERSION } from "../../src/contracts/extensions/host-protocol.ts";
import { EXTENSION_CONTRACT_BOUNDS } from "../../src/contracts/extensions/common.ts";

const digest = "a".repeat(64);

describe("failure semantics: extension event projection", () => {
	it("rejects events outside the projected namespace and oversize payloads", () => {
		const notProjected = projectExtensionEvent({ name: "ToolCall", source: {} });
		expect(notProjected.ok).toBe(false);
		if (!notProjected.ok) expect(notProjected.error.code).toBe("event_not_projected");

		const oversize = projectExtensionEvent({
			name: "PreToolUse",
			source: { argsJson: "x".repeat(EXTENSION_CONTRACT_BOUNDS.eventPayloadBytes) },
			maxPayloadBytes: 1_024,
		});
		expect(oversize.ok).toBe(false);
		if (!oversize.ok) expect(oversize.error.code).toBe("payload_oversize");
	});
});

describe("failure semantics: extension event bridge", () => {
	function bridge(outcome: ExtensionEventOutcome) {
		return new ExtensionEventBridge({ dispatch: async () => outcome });
	}
	const subscribers = ["sample@local"];

	it("reports not-projected before touching the host", async () => {
		const result = await bridge({ ok: true, value: null }).dispatch({ name: "ToolCall", source: {}, subscribers });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.code).toBe("event_not_projected");
	});

	it("maps host transport failures to explicit codes", async () => {
		const cases: ReadonlyArray<readonly [string, string]> = [
			["host_unavailable", "host_unavailable"],
			["host_event_aborted", "aborted"],
			["host_event_timeout", "host_unavailable"],
			["event_payload_oversize", "payload_oversize"],
		];
		for (const [hostCode, expected] of cases) {
			const result = await bridge({ ok: false, code: hostCode, message: hostCode }).dispatch({ name: "TurnStart", source: { sessionId: "s" }, subscribers });
			expect(result.ok, hostCode).toBe(false);
			if (!result.ok) expect(result.code, hostCode).toBe(expected);
		}
	});

	it("fails closed on malformed handler results instead of degrading to allow", async () => {
		const malformed: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
			["PreToolUse", { decision: "maybe" }],
			["PreToolUse", { decision: "allow", sandbox: "off" }],
			["SessionBeforeStop", { decision: "allow", updatedInput: { a: 1 } }],
			["UserPromptSubmit", { additionalContext: "" }],
		];
		for (const [name, result] of malformed) {
			const outcome = await bridge({ ok: true, value: { handlers: [{ index: 0, outcome: "result", durationMs: 1, result }] } })
				.dispatch({ name, source: { sessionId: "s" }, subscribers });
			expect(outcome.ok, name + " " + JSON.stringify(result)).toBe(false);
			if (!outcome.ok) expect(outcome.code, name).toBe("handler_result_invalid");
		}
	});

	it("rejects oversize rewrites and replacements", async () => {
		const oversize = "x".repeat(EXTENSION_CONTRACT_BOUNDS.eventPayloadBytes + 16);
		const cases: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
			["PreToolUse", { decision: "allow", updatedInput: { blob: oversize } }],
			["PostToolUse", { replacement: { blob: oversize } }],
		];
		for (const [name, result] of cases) {
			const outcome = await bridge({ ok: true, value: { handlers: [{ index: 0, outcome: "result", durationMs: 1, result }] } })
				.dispatch({ name, source: { sessionId: "s" }, subscribers });
			expect(outcome.ok, name).toBe(false);
			if (!outcome.ok) expect(outcome.code, name).toBe("handler_result_invalid");
		}
	});

	it("keeps handler timeouts and errors as diagnostics, not dispatch failures", async () => {
		const outcome = await bridge({
			ok: true,
			value: { handlers: [
				{ index: 0, outcome: "timeout", durationMs: 30, result: null },
				{ index: 1, outcome: "error", durationMs: 1, result: null },
			] },
		}).dispatch({ name: "PreToolUse", source: { sessionId: "s" }, subscribers });
		expect(outcome.ok).toBe(true);
		if (outcome.ok) {
			expect(outcome.result.decision).toBe("allow");
			expect(outcome.result.diagnostics.map((diagnostic) => diagnostic.code).sort()).toEqual([
				"extensions.event_handler_failed",
				"extensions.event_handler_timeout",
			]);
		}
	});
});

describe("failure semantics: tool admission", () => {
	const tool = (name: string, parameters: Record<string, unknown> = { type: "object" }) =>
		({ name, description: "d", parameters, approvalClass: "read-only" as const });
	const invoker = async () => ({ content: [] as never[], details: {} });

	it("reports each registration rejection with its own code", () => {
		const cases: ReadonlyArray<readonly [string, Partial<ExtensionToolPackage>]> = [
			["capability_not_declared", { tools: [tool("tool_a")] }],
			["schema_not_object", { declaredTools: ["tool_a"], tools: [tool("tool_a", { type: "array" })] }],
			["schema_keyword_forbidden", { declaredTools: ["tool_a"], tools: [tool("tool_a", { type: "object", $ref: "https://x/y" })] }],
		];
		for (const [expected, pkg] of cases) {
			const result = admitExtensionTools({
				packages: [{ packageId: "sample@local", digest, generation: 1, declaredTools: [], tools: [], ...pkg }],
				reservedNames: [],
				invoke: invoker,
			});
			expect(result.admitted, expected).toEqual([]);
			expect(result.rejected[0]?.code, expected).toBe(expected);
		}
	});

	it("refuses stdlib and base tool names before spending a claim", () => {
		const reserved = admitExtensionTools({
			packages: [{ packageId: "sample@local", digest, generation: 1, declaredTools: ["read"], tools: [tool("read")] }],
			reservedNames: ["read", "bash"],
			invoke: invoker,
		});
		expect(reserved.admitted).toEqual([]);
		expect(reserved.rejected[0]?.code).toBe("runtime_name_reserved");
	});

	it("resolves cross-extension conflicts deterministically and reports the loser", () => {
		const conflict = admitExtensionTools({
			packages: [
				{ packageId: "alpha@local", digest, generation: 1, declaredTools: ["tool_a"], tools: [tool("tool_a")] },
				{ packageId: "beta@local", digest, generation: 1, declaredTools: ["tool_a"], tools: [tool("tool_a")] },
			],
			reservedNames: [],
			invoke: invoker,
		});
		expect(conflict.admitted).toHaveLength(1);
		expect(conflict.rejected[0]?.code).toBe("runtime_name_conflict");
	});

	it("reports schema byte and depth limits as oversize", () => {
		let nested: Record<string, unknown> = { type: "string" };
		for (let index = 0; index < 12; index += 1) nested = { type: "object", properties: { child: nested } };
		const deep = admitExtensionTools({
			packages: [{ packageId: "sample@local", digest, generation: 1, declaredTools: ["tool_a"], tools: [tool("tool_a", nested)] }],
			reservedNames: [],
			invoke: invoker,
		});
		expect(deep.rejected[0]?.code).toBe("schema_oversize");

		const wide = admitExtensionTools({
			packages: [{ packageId: "sample@local", digest, generation: 1, declaredTools: ["tool_a"], tools: [tool("tool_a", { type: "object", blob: "x".repeat(2_048) })] }],
			reservedNames: [],
			invoke: invoker,
			maxToolSchemaBytes: 256,
		});
		expect(wide.rejected[0]?.code).toBe("schema_oversize");
	});
});

describe("failure semantics: extension host protocol", () => {
	const frame = {
		protocolVersion: EXTENSION_HOST_PROTOCOL_VERSION,
		generation: 3,
		frameId: "f-1",
		kind: "event",
		requestId: "r-1",
		name: "PreToolUse",
		cancelable: true,
		payload: {},
		deadlineMs: 1_000,
	};

	it("separates version, generation, kind, schema and shape failures", () => {
		const cases: ReadonlyArray<readonly [unknown, string, Record<string, unknown>?]> = [
			[{ ...frame, protocolVersion: 2 }, "frame_version_mismatch"],
			[frame, "frame_generation_mismatch", { generation: 9 }],
			[{ ...frame, kind: "intent" }, "frame_kind_unknown"],
			[{ ...frame, requestId: "bad id" }, "frame_schema_invalid"],
			["nope", "frame_not_object"],
		];
		for (const [value, expected, options] of cases) {
			const decoded = decodeExtensionHostFrame(value, options ?? {});
			expect(decoded.ok, expected).toBe(false);
			if (!decoded.ok) expect(decoded.error.code, expected).toBe(expected);
		}
	});

	it("rejects deep nesting and reports invalid JSON and oversize lines", () => {
		let nested: Record<string, unknown> = { leaf: true };
		for (let index = 0; index < 40; index += 1) nested = { child: nested };
		const deep = decodeExtensionHostFrame({ ...frame, payload: nested });
		expect(deep.ok).toBe(false);
		if (!deep.ok) expect(deep.error.code).toBe("frame_too_deep");

		const decoder = createExtensionHostFrameDecoder({ generation: 3, maxFrameBytes: 256 });
		const decoded = decoder.push("{\"broken\":\n{\"kind\":\"event\",\"padding\":\"" + "y".repeat(512) + "\"}\n");
		expect(decoded.errors.map((error) => error.code)).toEqual(["frame_invalid_json", "frame_oversize"]);
	});
});

describe("failure semantics: source resolution and activation gates", () => {
	it("rejects npm sources, bare relative paths and escaping paths", () => {
		const npm = resolveExtensionSource({ source: "npm", package: "left-pad" }, "/tmp");
		expect(npm.ok).toBe(false);
		if (!npm.ok) expect(npm.code).toBe("source_unsupported");

		const bare = resolveExtensionSource("plugins/a", "/tmp");
		expect(bare.ok).toBe(false);
		if (!bare.ok) expect(bare.code).toBe("source_invalid");

		const escape = resolveExtensionSource("./../../etc", "/tmp");
		expect(escape.ok).toBe(false);
		if (!escape.ok) expect(escape.code).toBe("source_escapes_root");

		const subdir = resolveExtensionSource({ source: "git-subdir", url: "https://x/y.git", path: "../out" }, "/tmp");
		expect(subdir.ok).toBe(false);
		if (!subdir.ok) expect(subdir.code).toBe("source_invalid");
	});

	it("gates host activation on enabled, trust, digest, entrypoints and host state", () => {
		const base = { enabled: true, digest: "a".repeat(64), trustedDigest: "a".repeat(64), entrypoints: ["./src/index.ts"], hostStatus: "idle" as const };
		expect(resolveExtensionHostActivation(base)).toEqual({ ok: true });
		const cases: ReadonlyArray<readonly [Parameters<typeof resolveExtensionHostActivation>[0], string]> = [
			[{ ...base, enabled: false }, "disabled"],
			[{ ...base, trustedDigest: undefined }, "untrusted"],
			[{ ...base, trustedDigest: "b".repeat(64) }, "digest_stale"],
			[{ ...base, entrypoints: [] }, "no_entrypoints"],
			[{ ...base, hostStatus: "failed" }, "host_failed"],
		];
		for (const [input, expected] of cases) {
			const gate = resolveExtensionHostActivation(input);
			expect(gate.ok, expected).toBe(false);
			if (!gate.ok) expect(gate.code, expected).toBe(expected);
		}
	});
});

describe("failure semantics: runtime actions", () => {
	function actor(overrides: Partial<ExtensionActionActorPort> = {}): ExtensionActionActorPort {
		return {
			sendMessage: async () => ({ ok: true }),
			appendEntry: async () => ({ ok: true }),
			setActiveTools: async () => ({ ok: true }),
			setModel: async () => ({ ok: true }),
			setThinkingLevel: async () => ({ ok: true }),
			setSessionName: async () => ({ ok: true }),
			exec: async () => ({ ok: true }),
			emitIntent: async () => ({ ok: true }),
			...overrides,
		};
	}
	function handler(overrides: Partial<ExtensionActionActorPort> = {}) {
		return createExtensionActionHandler({ port: actor(overrides), generation: 1, admittedTools: () => ["tool_a"] });
	}

	it("rejects malformed payloads, unknown actions and invalid intents", async () => {
		const cases: ReadonlyArray<readonly [Record<string, unknown>, string]> = [
			[{ requestId: "r1", action: "send-message", payload: { text: "" } }, "invalid_payload"],
			[{ requestId: "r2", action: "set-model", payload: { providerId: "x" } }, "invalid_payload"],
			[{ requestId: "r3", action: "set-thinking-level", payload: { level: "warp" } }, "invalid_payload"],
			[{ requestId: "r4", action: "set-service-tier", payload: {} }, "unsupported_action"],
			[{ requestId: "r5", action: "intent", payload: {} }, "invalid_intent"],
			[{ requestId: "r6", action: "set-active-tools", payload: { names: ["ghost"] } }, "unknown_tool"],
		];
		for (const [request, expected] of cases) {
			const result = await handler().handle(request as never);
			expect(result.ok, expected).toBe(false);
			if (!result.ok) expect(result.code, expected).toBe(expected);
		}
	});

	it("reports same-id different-body as a conflict and a throwing port as uncertain", async () => {
		const actions = handler();
		await actions.handle({ requestId: "r1", action: "send-message", payload: { text: "hello" } });
		const conflict = await actions.handle({ requestId: "r1", action: "send-message", payload: { text: "goodbye" } });
		expect(conflict.ok).toBe(false);
		if (!conflict.ok) expect(conflict.code).toBe("request_conflict");

		let calls = 0;
		const throwing = handler({ setModel: async () => { calls += 1; throw new Error("lookup failed at /home/user/.runledger/secret"); } });
		const uncertain = await throwing.handle({ requestId: "r2", action: "set-model", payload: { providerId: "x", modelId: "y" } });
		expect(uncertain.ok).toBe(false);
		if (!uncertain.ok) {
			expect(uncertain.code).toBe("uncertain_outcome");
			expect(JSON.stringify(uncertain)).not.toContain("/home/user");
		}
		// 不确定即不重试。
		await throwing.handle({ requestId: "r2", action: "set-model", payload: { providerId: "x", modelId: "y" } });
		expect(calls).toBe(1);
	});
});
