import { describe, expect, it, vi } from "vitest";
import type { OwnedSessionHandle } from "../../src/cli/session-client.ts";
import { SessionInteractiveController } from "../../src/cli/session-interactive-controller.ts";
import { standardHarnessProfileRef } from "../../src/runtime/harness-profiles/index.ts";
import type { ConnectionId } from "../../src/runtime/protocol/ids.ts";
import type { SessionClientTransport } from "../../src/runtime/session-server/client-transport.ts";
import type { SessionFrameEnvelope } from "../../src/runtime/session-server/protocol.ts";
import type { SessionCommandRequest } from "../../src/runtime/session-server/runtime-server.ts";
import type { SessionCommandPort } from "../../src/runtime/session-runtime/command-routes.ts";
import { createConversationCommandRoutes } from "../../src/runtime/session-runtime/command-routes/conversation.ts";

describe("Session prompt and queue delivery", () => {
	it.each([
		{ active: false, behavior: undefined, expectedBehavior: undefined },
		{ active: false, behavior: "steer", expectedBehavior: undefined },
		{ active: false, behavior: "followUp", expectedBehavior: undefined },
		{ active: true, behavior: undefined, expectedBehavior: "steer" },
		{ active: true, behavior: "steer", expectedBehavior: "steer" },
		{ active: true, behavior: "followUp", expectedBehavior: "followUp" },
	] as const)("preserves the question through production routes (active=$active, behavior=$behavior)", async ({ active, behavior, expectedBehavior }) => {
		const prompt = vi.fn(async (_text: string, _behavior?: "steer" | "followUp"): Promise<void> => undefined);
		// 仅替换领域执行；请求正文仍由生产 conversation routes 解码。
		const routes = createConversationCommandRoutes({
			domain: { controller: { prompt } },
			state: () => "ready",
			barrier: { admitPrompt: () => ({ ok: true }) },
			invalidateIdleRecap: () => undefined,
			emit: () => undefined,
		} as unknown as SessionCommandPort);
		let wireListener: ((frame: SessionFrameEnvelope) => void) | undefined;
		const transport = {
			onEvent: (listener: (frame: SessionFrameEnvelope) => void): (() => void) => {
				wireListener = listener;
				return () => { wireListener = undefined; };
			},
			notify: () => undefined,
			request: async (frame: SessionFrameEnvelope): Promise<SessionFrameEnvelope> => {
				const request = frame.body as unknown as SessionCommandRequest;
				if (request.kind !== "prompt" && request.kind !== "steer" && request.kind !== "follow_up") throw new Error(`unexpected command ${request.kind}`);
				const result = await routes[request.kind](request, { connectionId: "connection_fixture" as ConnectionId, clientId: "fixture", isDriver: true });
				return { kind: "command_result", frameId: "result", protocolVersion: 3, body: result };
			},
		} as unknown as SessionClientTransport;
		const controller = new SessionInteractiveController({ transport, generation: 1 } as unknown as OwnedSessionHandle, {
			sessionId: "session_fixture", harnessProfile: standardHarnessProfileRef(), permissionProfile: "workspace-write",
			messages: [], warnings: [], auditEntries: [], selection: { thinkingLevel: "off" }, toolCount: 0, eventCursor: 0, driverRevision: 0,
		});
		try {
			if (active) wireListener?.({
				kind: "subscription_event", frameId: "agent-start", protocolVersion: 3,
				body: { sequence: 1, eventType: "agent.event", payload: { type: "agent_start", timestamp: 1, runId: "run_fixture" } },
			});
			await controller.prompt("请检查当前项目\n保留完整问题", behavior);
			expect(prompt).toHaveBeenCalledExactlyOnceWith("请检查当前项目\n保留完整问题", expectedBehavior);
		} finally { controller.dispose(); }
	});
});
