/**
 * A2:`ask` 工具与 ask reverse-request 端口。
 *
 * 重点钉死两条风险:
 *   - headless(无 reverseRequestHandler)必须**立即** typed 失败,绝不轮询重试;
 *   - 无 port / 无 UI 一律 fail closed,不允许静默降级成「已问过」。
 */

import { describe, expect, it, vi } from "vitest";
import { Value } from "typebox/value";
import { SESSION_PROTOCOL_VERSION, type SessionFrameEnvelope } from "../../../src/runtime/session-server/protocol.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/ids.ts";
import { evaluatePlanModeCapabilities } from "../../../src/runtime/modes/plan/policy.ts";
import {
	ASK_LIMITS,
	AskRequestError,
	createReverseRequestAskPort,
	decodeAskAnswers,
	decodeAskRequest,
	encodeAskRequest,
	type AskPort,
} from "../../../src/runtime/session-runtime/ask-reverse-request.ts";
import type { ReverseRequestSender } from "../../../src/runtime/session-runtime/credential-reverse-request.ts";
import { askSchema, createAskTool } from "../../../src/runtime/tools/ask.ts";
import { createStdlibTools } from "../../../src/runtime/tools/index.ts";

const CONNECTION_ID = createRuntimeId("connection", "driver-1");

/** 工具参数按 schema 形状写成可变字面量(Static<typeof askSchema> 不接受 readonly 数组)。 */
const QUESTIONS = [{
	id: "scope",
	question: "这个改动要覆盖哪些范围?",
	header: "Scope",
	options: [{ label: "runtime" }, { label: "tui", description: "只改呈现层" }],
}];

function question(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return { id: "q1", question: "选哪个?", options: [{ label: "a" }], ...overrides };
}

function envelope(body: Record<string, unknown>): SessionFrameEnvelope {
	return { frameId: "reverse_response_1", kind: "reverse_response", protocolVersion: SESSION_PROTOCOL_VERSION, body };
}

/** 回放客户端行为的假 transport;每次 requestToConnection 调用都会记录。 */
function fakeTransport(response: Record<string, unknown>): ReverseRequestSender & { readonly calls: number } {
	const sender = {
		calls: 0,
		async requestToConnection(): Promise<SessionFrameEnvelope> {
			sender.calls += 1;
			return envelope(response);
		},
	};
	return sender;
}

describe("ask tool schema", () => {
	it("accepts the declared shape and rejects out-of-bounds questions/options", () => {
		expect(Value.Check(askSchema, { questions: [question({ header: "Scope", multi: true })] })).toBe(true);
		expect(Value.Check(askSchema, { questions: [] })).toBe(false);
		expect(Value.Check(askSchema, {
			questions: Array.from({ length: ASK_LIMITS.maxQuestions + 1 }, (_value, index) => question({ id: `q${index}` })),
		})).toBe(false);
		expect(Value.Check(askSchema, { questions: [question({ options: [] })] })).toBe(false);
		expect(Value.Check(askSchema, {
			questions: [question({ options: Array.from({ length: ASK_LIMITS.maxOptions + 1 }, (_value, index) => ({ label: `o${index}` })) })],
		})).toBe(false);
		expect(Value.Check(askSchema, { questions: [question({ id: "a".repeat(ASK_LIMITS.maxIdChars + 1) })] })).toBe(false);
		expect(Value.Check(askSchema, { questions: [question({ options: [{ label: "a".repeat(ASK_LIMITS.maxLabelChars + 1) }] })] })).toBe(false);
		// additionalProperties:false:未声明字段不允许悄悄改变提问语义。
		expect(Value.Check(askSchema, { questions: [question({ recommended: true })] })).toBe(false);
	});
});

describe("ask tool", () => {
	it("returns the picked labels as details plus a readable summary", async () => {
		const port: AskPort = { ask: vi.fn(async () => ({ scope: ["tui", "runtime"] })) };
		const tool = createAskTool(port);
		const result = await tool.execute("tool-ask", { questions: [...QUESTIONS] });
		expect(port.ask).toHaveBeenCalledTimes(1);
		expect(result.details).toEqual({ answers: { scope: ["tui", "runtime"] } });
		expect(result.content).toEqual([{ type: "text", text: "问：这个改动要覆盖哪些范围?\n答：tui, runtime" }]);
	});

	it("marks an empty multi-select answer instead of returning blank text", async () => {
		const tool = createAskTool({ ask: async () => ({ scope: [] }) });
		const result = await tool.execute("tool-ask", { questions: [...QUESTIONS] });
		expect(result.content).toEqual([{ type: "text", text: "问：这个改动要覆盖哪些范围?\n答：(未选择)" }]);
	});

	it("fails closed when no ask port is injected", async () => {
		const tool = createAskTool();
		await expect(tool.execute("tool-ask", { questions: [...QUESTIONS] })).rejects.toThrow(/ask port 未注入/u);
	});

	it("registers ask only when the port is injected, with a Plan Mode-safe claim", () => {
		const path = process.cwd();
		expect(createStdlibTools(path).has("ask")).toBe(false);
		const registry = createStdlibTools(path, { askPort: { ask: async () => ({}) } });
		const tool = registry.get("ask");
		expect(tool).toBeDefined();
		expect(tool?.isReadOnly?.()).toBe(true);
		// claim 的消费者是 Plan Mode:缺 claim 会被当成 unknown effect 一律 deny。
		expect(evaluatePlanModeCapabilities({ state: undefined, claims: tool?.capabilityClaims ?? [], enforceReadonly: true }))
			.toMatchObject({ decision: "allow" });
	});
});

describe("ask reverse-request port", () => {
	it("maps forward answers and normalizes multi-select to option order", () => {
		const answers = decodeAskAnswers({ scope: ["tui", "runtime"] }, QUESTIONS);
		expect(answers).toEqual({ scope: ["runtime", "tui"] });
		expect(decodeAskAnswers({ scope: ["ghost"] }, QUESTIONS)).toBeUndefined();
		expect(decodeAskAnswers({ unknown: ["runtime"] }, QUESTIONS)).toBeUndefined();
		expect(decodeAskAnswers({}, QUESTIONS)).toBeUndefined();
	});

	it("round-trips the wire payload through decode", () => {
		expect(decodeAskRequest(encodeAskRequest(QUESTIONS))).toEqual(QUESTIONS);
		expect(decodeAskRequest({ questions: [] })).toBeUndefined();
		// 标签就是答案身份:同问题内重复标签无法回传到具体选项。
		expect(decodeAskRequest({ questions: [{ id: "q1", question: "?", options: [{ label: "a" }, { label: "a" }] }] })).toBeUndefined();
		expect(decodeAskRequest({ questions: [{ id: "q1", question: "?", options: [{ label: "a" }] }, { id: "q1", question: "?", options: [{ label: "b" }] }] })).toBeUndefined();
	});

	it("fails typed and immediately when the client has no reverse-request handler", async () => {
		// fake timers:任何 25–250ms 轮询重试都会让这个 promise 永不结算 → 测试超时。
		vi.useFakeTimers();
		try {
			const sender = fakeTransport({ ok: false, code: "reverse_request_unhandled" });
			const port = createReverseRequestAskPort({ sender, connectionId: CONNECTION_ID });
			await expect(port.ask(QUESTIONS)).rejects.toMatchObject({ name: "AskRequestError", code: "unhandled" });
			expect(sender.calls).toBe(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it("fails typed when the user cancels", async () => {
		const sender = fakeTransport({ ok: false, code: "aborted" });
		const port = createReverseRequestAskPort({ sender, connectionId: CONNECTION_ID });
		await expect(port.ask(QUESTIONS)).rejects.toMatchObject({ code: "cancelled" });
		expect(sender.calls).toBe(1);
	});

	it("never invents answers when the response is missing or mismatched", async () => {
		const missing = createReverseRequestAskPort({ sender: fakeTransport({ ok: true }), connectionId: CONNECTION_ID });
		await expect(missing.ask(QUESTIONS)).rejects.toMatchObject({ code: "invalid_response" });
		const mismatched = createReverseRequestAskPort({ sender: fakeTransport({ ok: true, answers: { scope: ["nope"] } }), connectionId: CONNECTION_ID });
		await expect(mismatched.ask(QUESTIONS)).rejects.toMatchObject({ code: "invalid_response" });
	});

	it("reports an unattached driver instead of waiting for a UI", async () => {
		const sender = fakeTransport({ ok: true, answers: {} });
		const port = createReverseRequestAskPort({ sender, connectionId: () => undefined });
		await expect(port.ask(QUESTIONS)).rejects.toMatchObject({ code: "unavailable" });
		expect(sender.calls).toBe(0);
	});

	it("maps transport timeouts and delivery failures to distinct codes", async () => {
		const timedOut: ReverseRequestSender = { requestToConnection: async () => { throw new Error("reverse request timed out"); } };
		const port = createReverseRequestAskPort({ sender: timedOut, connectionId: CONNECTION_ID });
		const error = await port.ask(QUESTIONS).catch((cause: unknown) => cause);
		expect(error).toBeInstanceOf(AskRequestError);
		expect(error).toMatchObject({ code: "timeout" });

		const aborted = new AbortController();
		aborted.abort();
		const port2 = createReverseRequestAskPort({
			sender: { requestToConnection: async () => { throw new Error("reverse request aborted"); } },
			connectionId: CONNECTION_ID,
		});
		await expect(port2.ask(QUESTIONS, aborted.signal)).rejects.toMatchObject({ code: "cancelled" });
	});
});
