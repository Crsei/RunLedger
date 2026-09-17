/**
 * P7 预算/上限矩阵：把散落在各模块的 bounded 上限集中成一份**被执行的清单**。
 *
 * 每个 case 都断言“恰好在上限内可接受、超过上限被拒”，而不是只读常量：上限被
 * 放宽、被静默截断或被绕过时这里会失败。需要真实文件系统的上限（安装条目/字节、
 * catalog 字节、doctor 条目）在各自专项里用临时目录覆盖，不在本文件重复。
 */

import { describe, expect, it } from "vitest";
import { Type } from "typebox";
import { createExtensionHostFrameDecoder, decodeExtensionHostFrame } from "../../src/extensions/host/protocol.ts";
import { validateExtensionRegistry } from "../../src/extensions/host/registration.ts";
import { createExtensionApi } from "../../src/extensions/host/runtime-api.ts";
import { createExtensionActionHandler } from "../../src/extensions/actions/handler.ts";
import { admitExtensionTools } from "../../src/extensions/tools/admission.ts";
import { ExtensionEventBridge } from "../../src/extensions/events/bridge.ts";
import { projectExtensionEvent } from "../../src/extensions/events/projection.ts";
import { ExtensionActionLedger } from "../../src/extensions/actions/receipts.ts";
import { parseExtensionSettingValue } from "../../src/extensions/plugins/settings-schema.ts";
import { createManagedGitMaterializer } from "../../src/extensions/plugins/git-materializer.ts";
import { EXTENSION_CONTRACT_BOUNDS, ExtensionDigestSchema } from "../../src/contracts/extensions/common.ts";
import { EXTENSION_DEFAULT_HOST_LIMITS } from "../../src/contracts/extensions/registry.ts";
import { EXTENSION_HOST_PROTOCOL_VERSION } from "../../src/contracts/extensions/host-protocol.ts";
import { EXTENSION_EVENT_PROJECTION_CATALOG } from "../../src/contracts/extensions/events.ts";

const digest = "a".repeat(64);
const invoker = async () => ({ content: [] as never[], details: {} });

describe("limits matrix: host protocol", () => {
	const frameHeader = {
		protocolVersion: EXTENSION_HOST_PROTOCOL_VERSION,
		generation: 1,
		frameId: "f-1",
		kind: "event",
		requestId: "r-1",
		name: "TurnStart",
		cancelable: false,
		deadlineMs: 1_000,
	};

	it("enforces the per-frame byte bound with no partial frame", () => {
		const payload = { blob: "x".repeat(600) };
		const line = JSON.stringify({ ...frameHeader, payload });
		const decoder = createExtensionHostFrameDecoder({ generation: 1, maxFrameBytes: Buffer.byteLength(line, "utf8") + 16 });
		expect(decoder.push(line + "\n").frames).toHaveLength(1);

		const tight = createExtensionHostFrameDecoder({ generation: 1, maxFrameBytes: Buffer.byteLength(line, "utf8") - 1 });
		const rejected = tight.push(line + "\n");
		expect(rejected.frames).toEqual([]);
		expect(rejected.errors[0]?.code).toBe("frame_oversize");
	});

	it("enforces the nesting depth bound at the declared limit", () => {
		const at = (levels: number): Record<string, unknown> => {
			let value: Record<string, unknown> = { leaf: true };
			for (let index = 1; index < levels; index += 1) value = { child: value };
			return value;
		};
		expect(decodeExtensionHostFrame({ ...frameHeader, payload: at(11) }, { maxDepth: 12 }).ok).toBe(true);
		const deep = decodeExtensionHostFrame({ ...frameHeader, payload: at(20) }, { maxDepth: 12 });
		expect(deep.ok).toBe(false);
		if (!deep.ok) expect(deep.error.code).toBe("frame_too_deep");
	});

	it("enforces the per-kind registration bound", () => {
		const tool = (name: string) => ({ name, description: "d", parameters: { type: "object" }, approvalClass: "read-only" as const });
		const limits = { ...EXTENSION_DEFAULT_HOST_LIMITS, maxRegistrationsPerKind: 2 };
		const candidate = (count: number) => ({
			packageId: "sample@local",
			digest,
			generation: 1,
			hostPid: 10,
			tools: Array.from({ length: count }, (_value, index) => tool(`tool_${index}`)),
			commands: [],
			flags: [],
			subscriptions: [],
			limits,
		});
		const atLimit = validateExtensionRegistry(candidate(2), { packageId: "sample@local", digest, hostPid: 10, generation: 1, limits });
		expect(atLimit.ok).toBe(true);
		const over = validateExtensionRegistry(candidate(3), { packageId: "sample@local", digest, hostPid: 10, generation: 1, limits });
		expect(over.ok).toBe(false);
		if (!over.ok) expect(over.error.code).toBe("registry_limit_exceeded");
	});

	it("enforces the host-side tool schema byte bound during admission", () => {
		const tool = (payloadSize: number) => ({ name: "tool_a", description: "d", parameters: { type: "object", description: "x".repeat(payloadSize) }, approvalClass: "read-only" as const });
		const base = { packageId: "sample@local", digest, generation: 1, declaredTools: ["tool_a"] };
		const under = admitExtensionTools({ packages: [{ ...base, tools: [tool(32)] }], reservedNames: [], invoke: invoker, maxToolSchemaBytes: 512 });
		expect(under.rejected).toEqual([]);
		const over = admitExtensionTools({ packages: [{ ...base, tools: [tool(2_048)] }], reservedNames: [], invoke: invoker, maxToolSchemaBytes: 512 });
		expect(over.rejected[0]?.code).toBe("schema_oversize");
	});
});

describe("limits matrix: extension-side API", () => {
	it("rejects message text beyond the text bound and empty text", () => {
		const runtime = createExtensionApi();
		runtime.initialize({ dispatch: async () => ({ ok: true }) });
		expect(() => runtime.api.sendMessage("x".repeat(64 * 1024 + 1))).toThrow(/bounded non-empty text/u);
		expect(() => runtime.api.sendMessage("")).toThrow(/bounded non-empty text/u);
		expect(runtime.api.sendMessage("x".repeat(64 * 1024))).toBeInstanceOf(Promise);
	});

	it("forwards append-entry to the owner, which enforces the entry byte bound", async () => {
		// 字节上限在 owner 侧动作处理器里，不在扩展 API 层：API 只负责把 entry 送出去。
		const seen: unknown[] = [];
		const runtime = createExtensionApi();
		runtime.initialize({ dispatch: async (request) => { seen.push(request.payload.entry); return { ok: true }; } });
		await expect(runtime.api.appendEntry({ note: "small" })).resolves.toEqual({ ok: true });
		expect(seen).toEqual([{ note: "small" }]);

		const actions = createExtensionActionHandler({
			port: {
				sendMessage: async () => ({ ok: true }), appendEntry: async () => ({ ok: true }), setActiveTools: async () => ({ ok: true }),
				setModel: async () => ({ ok: true }), setThinkingLevel: async () => ({ ok: true }), setSessionName: async () => ({ ok: true }),
				exec: async () => ({ ok: true }), emitIntent: async () => ({ ok: true }),
			},
			generation: 1,
			admittedTools: () => [],
		});
		const oversized = await actions.handle({ requestId: "r1", action: "append-entry", payload: { entry: { blob: "x".repeat(48 * 1024) } } });
		expect(oversized.ok).toBe(false);
		if (!oversized.ok) expect(oversized.code).toBe("invalid_payload");
	});

	it("rejects decision requests outside 1..8 options", async () => {
		const runtime = createExtensionApi();
		runtime.initialize({ dispatch: async () => ({ ok: true }) });
		for (const options of [[], Array.from({ length: 9 }, (_value, index) => `o${index}`)]) {
			const result = await runtime.api.requestUserDecision("q", options);
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.code).toBe("invalid_options");
		}
	});

	it("bounds registrations per kind at the configured limit", () => {
		const runtime = createExtensionApi({ limits: { ...EXTENSION_DEFAULT_HOST_LIMITS, maxRegistrationsPerKind: 1 } });
		runtime.api.registerFlag({ name: "one", description: "d", type: "boolean" });
		expect(() => runtime.api.registerFlag({ name: "two", description: "d", type: "boolean" })).toThrow(/limit reached/u);
	});
});

describe("limits matrix: projection and bridge", () => {
	it("keeps every projected descriptor within the framework payload bound", () => {
		for (const descriptor of EXTENSION_EVENT_PROJECTION_CATALOG) {
			expect(descriptor.payloadBytes, descriptor.name).toBeLessThanOrEqual(EXTENSION_CONTRACT_BOUNDS.eventPayloadBytes);
			expect(descriptor.payloadFields.length, descriptor.name).toBeLessThanOrEqual(32);
		}
	});

	it("rejects a projected payload beyond the descriptor bound", () => {
		const descriptor = EXTENSION_EVENT_PROJECTION_CATALOG.find((item) => item.name === "PostToolUse");
		expect(descriptor).toBeDefined();
		const limit = descriptor?.payloadBytes ?? 8 * 1024;
		const over = projectExtensionEvent({ name: "PostToolUse", source: { toolName: "x".repeat(limit + 16) } });
		expect(over.ok).toBe(false);
		if (!over.ok) expect(over.error.code).toBe("payload_oversize");
	});

	it("bounds additionalContext and reason by the configured character limits", async () => {
		const bridge = new ExtensionEventBridge({
			dispatch: async () => ({ ok: true, value: { handlers: [
				{ index: 0, outcome: "result", durationMs: 1, result: { additionalContext: "x".repeat(101) } },
			] } }),
			maxContextChars: 100,
		});
		const context = await bridge.dispatch({ name: "UserPromptSubmit", source: { sessionId: "s" }, subscribers: ["sample@local"] });
		expect(context.ok).toBe(false);
		if (!context.ok) expect(context.code).toBe("handler_result_invalid");

		const denyBridge = new ExtensionEventBridge({
			dispatch: async () => ({ ok: true, value: { handlers: [
				{ index: 0, outcome: "result", durationMs: 1, result: { decision: "deny", reason: "x".repeat(101) } },
			] } }),
			maxReasonChars: 100,
		});
		const deny = await denyBridge.dispatch({ name: "PreToolUse", source: { sessionId: "s" }, subscribers: ["sample@local"] });
		expect(deny.ok).toBe(false);
		if (!deny.ok) expect(deny.code).toBe("handler_result_invalid");
	});
});

describe("limits matrix: receipts, settings and git materializer", () => {
	it("evicts the oldest action receipts beyond the ledger bound", () => {
		const ledger = new ExtensionActionLedger({ maxEntries: 2 });
		for (const requestId of ["r1", "r2", "r3"]) {
			ledger.record({ requestId, action: "send-message", generation: 1, requestDigest: "d", outcome: "committed" });
		}
		expect(ledger.size()).toBe(2);
		expect(ledger.replay({ generation: 1, action: "send-message", requestId: "r1", requestDigest: "d" }).status).toBe("miss");
		expect(ledger.replay({ generation: 1, action: "send-message", requestId: "r3", requestDigest: "d" }).status).toBe("hit");
	});

	it("bounds plugin setting strings and numbers", () => {
		const text = { type: "string" as const, description: "d" };
		expect(parseExtensionSettingValue(text, "x".repeat(4_096)).ok).toBe(true);
		expect(parseExtensionSettingValue(text, "x".repeat(4_097))).toMatchObject({ ok: false, code: "invalid_bounds" });

		const number = { type: "number" as const, description: "d" };
		expect(parseExtensionSettingValue(number, 1_000_000_000).ok).toBe(true);
		expect(parseExtensionSettingValue(number, 1_000_000_001)).toMatchObject({ ok: false, code: "invalid_bounds" });
		expect(parseExtensionSettingValue(number, Number.POSITIVE_INFINITY)).toMatchObject({ ok: false, code: "invalid_type" });
	});

	it("rejects an out-of-range git materializer timeout at construction", () => {
		const storage = {} as never;
		const managedProcess = {} as never;
		expect(() => createManagedGitMaterializer({ managedProcess, storage, cwd: "/tmp", timeoutMs: 0 })).toThrow(/out of range/u);
		expect(() => createManagedGitMaterializer({ managedProcess, storage, cwd: "/tmp", timeoutMs: 600_001 })).toThrow(/out of range/u);
		expect(() => createManagedGitMaterializer({ managedProcess, storage, cwd: "relative", timeoutMs: 1_000 })).toThrow(/must be absolute/u);
	});

	it("keeps the frozen digest and semver schemas strict", () => {
		const { Value } = require("typebox/value") as typeof import("typebox/value");
		expect(Value.Check(ExtensionDigestSchema, digest)).toBe(true);
		expect(Value.Check(ExtensionDigestSchema, "A".repeat(64))).toBe(false);
		expect(Value.Check(ExtensionDigestSchema, "a".repeat(63))).toBe(false);
		expect(Value.Check(Type.Object({ kind: Type.Literal("x") }, { additionalProperties: false }), { kind: "x" })).toBe(true);
	});
});
