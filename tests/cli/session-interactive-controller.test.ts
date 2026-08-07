/**
 * R7:SessionInteractiveController 命令错误透传。
 *
 * 生产里未选 model 时 controller.prompt 抛 "No model selected...",
 * session runtime 包装为 { code: "domain_prompt_failed", detail }。
 * 客户端 command() 必须把 detail 拼进错误信息,否则 TUI 只显示
 * "domain_prompt_failed",用户无法知道真正原因。
 */

import { describe, expect, it } from "vitest";
import type { OwnedSessionHandle } from "../../src/cli/session-client.ts";
import {
	SessionInteractiveController,
	type SessionInteractiveSnapshot,
} from "../../src/cli/session-interactive-controller.ts";
import type { SessionFrameEnvelope } from "../../src/runtime/session-server/protocol.ts";
import type { SessionClientTransport } from "../../src/runtime/session-server/client-transport.ts";

function failingTransport(detail: string | undefined): SessionClientTransport {
	const request = async (_frame: SessionFrameEnvelope): Promise<SessionFrameEnvelope> => ({
		kind: "command_result",
		protocolVersion: 1,
		frameId: "result_1",
		body: { ok: false, code: "domain_prompt_failed", ...(detail === undefined ? {} : { detail }) },
	});
	const onEvent = (): (() => void) => () => undefined;
	return { request, onEvent } as unknown as SessionClientTransport;
}

function controller(detail: string | undefined): SessionInteractiveController {
	const handle = { transport: failingTransport(detail) } as unknown as OwnedSessionHandle;
	const snapshot: SessionInteractiveSnapshot = {
		sessionId: "session_fixture",
		messages: [],
		warnings: [],
		auditEntries: [],
		selection: { thinkingLevel: "off" },
		toolCount: 0,
		eventCursor: 0,
		driverRevision: 0,
	};
	return new SessionInteractiveController(handle, snapshot);
}

describe("SessionInteractiveController command error surfacing", () => {
	it("无 detail 时抛出 code", async () => {
		await expect(controller(undefined).prompt("hi")).rejects.toThrow("domain_prompt_failed");
	});

	it("有 detail 时把 detail 拼进错误信息", async () => {
		await expect(controller("No model selected. Use /provider or /model.").prompt("hi")).rejects.toThrow(
			"domain_prompt_failed: No model selected. Use /provider or /model.",
		);
	});
});
