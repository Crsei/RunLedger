/**
 * A2:ask reverse-request 的 TUI 分派。
 *
 * 覆盖单问、多选(勾选 → 提交)、取消、载荷非法与并发拒绝;断言问题文本与
 * 勾选标记真的出现在 overlay 渲染结果里,而不是只返回了正确的 body。
 */

import { describe, expect, it } from "vitest";
import { InteractiveMode } from "../../src/tui/interactive-mode.ts";
import { SESSION_PROTOCOL_VERSION, type SessionFrameEnvelope } from "../../src/runtime/session-server/protocol.ts";
import { encodeAskRequest, type AskQuestion } from "../../src/runtime/session-runtime/ask-reverse-request.ts";
import { ContractController, ContractTerminal, settleFrames } from "./fixtures/contract-integration.ts";

const QUESTIONS: readonly AskQuestion[] = [{
	id: "scope",
	question: "这个改动要覆盖哪些范围?",
	header: "Scope",
	options: [{ label: "runtime" }, { label: "tui", description: "只改呈现层" }],
}];

const MULTI_QUESTIONS: readonly AskQuestion[] = [{ ...QUESTIONS[0]!, multi: true }];

function askFrame(body: Record<string, unknown>): SessionFrameEnvelope {
	return { frameId: "ask-1", kind: "reverse_request", protocolVersion: SESSION_PROTOCOL_VERSION, body: { kind: "ask_prompt", body } };
}

interface OverlayProbe {
	handleInput?(data: string): void;
	render(width: number): string[];
}

/** InteractiveMode 的 overlay 句柄不是公开 API;命名 cast + 理由:测试必须驱动真实 modal 的按键输入。 */
interface OverlayHost {
	readonly ui?: { readonly overlay?: OverlayProbe };
}

function overlayOf(mode: InteractiveMode): OverlayProbe | undefined {
	const host = mode as unknown as OverlayHost;
	return host.ui?.overlay;
}

function modeWithAsk(): InteractiveMode {
	return new InteractiveMode({ controller: new ContractController(), terminal: new ContractTerminal() });
}

describe("ask reverse-request dispatch", () => {
	it("renders the question with its header and returns the picked label", async () => {
		const mode = modeWithAsk();
		const pending = mode.handleSessionReverseRequest(askFrame(encodeAskRequest(QUESTIONS)), new AbortController().signal);
		await settleFrames();
		const overlay = overlayOf(mode);
		expect(overlay).toBeDefined();
		const rendered = overlay?.render(80).join("\n") ?? "";
		expect(rendered).toContain("Scope: 这个改动要覆盖哪些范围?");
		expect(rendered).toContain("runtime");
		overlay?.handleInput?.("\r");
		await expect(pending).resolves.toEqual({ ok: true, answers: { scope: ["runtime"] } });
	});

	it("toggles checkboxes for a multi question and submits in option order", async () => {
		const mode = modeWithAsk();
		const pending = mode.handleSessionReverseRequest(askFrame(encodeAskRequest(MULTI_QUESTIONS)), new AbortController().signal);
		await settleFrames();
		overlayOf(mode)?.handleInput?.("\r");
		await settleFrames();
		expect(overlayOf(mode)?.render(80).join("\n")).toContain("[x] runtime");
		// 光标停在刚切换的行;下移一格勾选第二个选项。
		overlayOf(mode)?.handleInput?.("\x1b[B");
		overlayOf(mode)?.handleInput?.("\r");
		await settleFrames();
		expect(overlayOf(mode)?.render(80).join("\n")).toContain("[x] tui");
		// 再下移到「提交所选」并确认。
		overlayOf(mode)?.handleInput?.("\x1b[B");
		overlayOf(mode)?.handleInput?.("\r");
		await expect(pending).resolves.toEqual({ ok: true, answers: { scope: ["runtime", "tui"] } });
	});

	it("aborts the whole ask when the user cancels a question", async () => {
		const mode = modeWithAsk();
		const pending = mode.handleSessionReverseRequest(askFrame(encodeAskRequest(QUESTIONS)), new AbortController().signal);
		await settleFrames();
		overlayOf(mode)?.handleInput?.("\x1b");
		await expect(pending).resolves.toEqual({ ok: false, code: "aborted" });
	});

	it("rejects an invalid payload without opening an overlay", async () => {
		const mode = modeWithAsk();
		const body = await mode.handleSessionReverseRequest(askFrame({ questions: [] }), new AbortController().signal);
		expect(body).toEqual({ ok: false, code: "reverse_request_invalid" });
		expect(overlayOf(mode)).toBeUndefined();
	});

	it("refuses a second ask while one is active", async () => {
		const mode = modeWithAsk();
		const first = mode.handleSessionReverseRequest(askFrame(encodeAskRequest(QUESTIONS)), new AbortController().signal);
		await settleFrames();
		const second = await mode.handleSessionReverseRequest(
			{ ...askFrame(encodeAskRequest(QUESTIONS)), frameId: "ask-2" },
			new AbortController().signal,
		);
		expect(second).toEqual({ ok: false, code: "ask_busy" });
		overlayOf(mode)?.handleInput?.("\r");
		await expect(first).resolves.toEqual({ ok: true, answers: { scope: ["runtime"] } });
	});

	it("fails the ask when the reverse request is aborted while the modal is open", async () => {
		const mode = modeWithAsk();
		const abort = new AbortController();
		const pending = mode.handleSessionReverseRequest(askFrame(encodeAskRequest(QUESTIONS)), abort.signal);
		await settleFrames();
		abort.abort();
		await expect(pending).resolves.toEqual({ ok: false, code: "aborted" });
	});
});
