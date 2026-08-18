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
	it("buffers snapshot-to-listener run events and deduplicates replayed completion", async () => {
		let wireListener: ((frame: SessionFrameEnvelope) => void) | undefined;
		const endFrame: SessionFrameEnvelope = {
			frameId: "event-2", kind: "subscription_event", protocolVersion: 3,
			body: { sequence: 2, eventType: "agent.event", payload: { type: "agent_end", timestamp: 200, runId: "run-race", stopReason: "stop", elapsedMs: 100, activeDurationMs: 100, messageCountAtEnd: 2 } },
		};
		const transport = {
			request: async (): Promise<SessionFrameEnvelope> => {
				wireListener?.({ frameId: "event-1", kind: "subscription_event", protocolVersion: 3, body: { sequence: 1, eventType: "agent.event", payload: { type: "agent_start", timestamp: 100, runId: "run-race" } } });
				wireListener?.(endFrame);
				return { frameId: "subscribed", kind: "command_result", protocolVersion: 3, body: { ok: true, cursor: 0 } };
			},
			onEvent: (listener: (frame: SessionFrameEnvelope) => void): (() => void) => { wireListener = listener; return () => { wireListener = undefined; }; },
			notify: () => undefined,
		} as unknown as SessionClientTransport;
		const handle = { transport, sessionId: "session_fixture", generation: 1, supports: () => true } as unknown as OwnedSessionHandle;
		const instance = new SessionInteractiveController(handle, { sessionId: "session_fixture", messages: [], warnings: [], auditEntries: [], selection: { thinkingLevel: "off" }, toolCount: 0, eventCursor: 0, driverRevision: 0, agentRuns: [] });
		expect(await instance.resumeEvents()).toBe("subscribed");
		const seen: string[] = [];
		instance.subscribe((event) => { seen.push(`${event.type}:${event.type === "agent_start" || event.type === "agent_end" ? event.runId : ""}`); });
		wireListener?.(endFrame);
		expect(seen).toEqual(["agent_start:run-race", "agent_end:run-race"]);
		expect(instance.recoveryCursor()).toBe(2);
	});

	it("delivers a durable session.title_changed subscription event to title listeners", () => {
		let wireListener: ((frame: SessionFrameEnvelope) => void) | undefined;
		const transport = {
			request: async (): Promise<SessionFrameEnvelope> => ({ frameId: "unused", kind: "command_result", protocolVersion: 3, body: { ok: true } }),
			onEvent: (listener: (frame: SessionFrameEnvelope) => void): (() => void) => { wireListener = listener; return () => { wireListener = undefined; }; },
			notify: () => undefined,
		} as unknown as SessionClientTransport;
		const handle = { transport, sessionId: "session_fixture", generation: 1, supports: () => true } as unknown as OwnedSessionHandle;
		const instance = new SessionInteractiveController(handle, {
			sessionId: "session_fixture", messages: [], warnings: [], auditEntries: [], selection: { thinkingLevel: "off" }, toolCount: 0, eventCursor: 0, driverRevision: 0,
		});
		const seen: unknown[] = [];
		instance.subscribeSessionTitleChanged((event) => seen.push(event));

		wireListener?.({
			frameId: "title-event",
			kind: "subscription_event",
			protocolVersion: 3,
			body: {
				sequence: 1,
				eventType: "session.title_changed",
				payload: { title: "Fix login flow", source: "user" },
			},
		});

		expect(seen).toEqual([{ sessionId: "session_fixture", title: "Fix login flow", source: "user", sequence: 1 }]);
		expect(instance.recoveryCursor()).toBe(1);
	});

	it("delivers idle recap status as a transient non-agent event", () => {
		let wireListener: ((frame: SessionFrameEnvelope) => void) | undefined;
		const transport = {
			request: async (): Promise<SessionFrameEnvelope> => ({ frameId: "unused", kind: "command_result", protocolVersion: 3, body: { ok: true } }),
			onEvent: (listener: (frame: SessionFrameEnvelope) => void): (() => void) => { wireListener = listener; return () => { wireListener = undefined; }; },
			notify: () => undefined,
		} as unknown as SessionClientTransport;
		const handle = { transport, sessionId: "session_fixture", generation: 1, supports: () => true } as unknown as OwnedSessionHandle;
		const instance = new SessionInteractiveController(handle, {
			sessionId: "session_fixture", messages: [], warnings: [], auditEntries: [], selection: { thinkingLevel: "off" }, toolCount: 0, eventCursor: 0, driverRevision: 0,
		});
		const seen: unknown[] = [];
		instance.subscribeIdleRecap((event) => seen.push(event));

		wireListener?.({
			frameId: "recap-event",
			kind: "subscription_event",
			protocolVersion: 3,
			body: {
				eventType: "session.idle_recap",
				payload: { sessionId: "session_fixture", requestId: "recap_1", ownerGeneration: 1, activityGeneration: 2, driverRevision: 3, text: "ship the next action" },
			},
		});

		expect(seen).toEqual([expect.objectContaining({ requestId: "recap_1", text: "ship the next action" })]);
	});
	it("rejects malformed query correlation locally without sending a frame", async () => {
		let requestCount = 0;
		const transport = {
			request: async (): Promise<SessionFrameEnvelope> => {
				requestCount += 1;
				throw new Error("wire should not be reached");
			},
			onEvent: (): (() => void) => () => undefined,
		} as unknown as SessionClientTransport;
		const handle = {
			transport,
			sessionId: "session_fixture",
			generation: 7,
			supports: (operation: string) => operation === "session.catalog.list",
		} as unknown as OwnedSessionHandle;
		const instance = new SessionInteractiveController(handle, {
			sessionId: "session_fixture", messages: [], warnings: [], auditEntries: [], selection: { thinkingLevel: "off" }, toolCount: 0, eventCursor: 0, driverRevision: 0,
		});
		await expect(instance.querySessionDomain("session.catalog.list", {}, { correlationId: "", effectId: "effect-valid" })).resolves.toEqual({
			ok: false,
			status: "failed",
			code: "invalid_domain_context",
			operation: "session.catalog.list",
		});
		expect(requestCount).toBe(0);
	});

	it("rejects an observer Session domain mutation before sending a frame", async () => {
		let requestCount = 0;
		const transport = {
			request: async (): Promise<SessionFrameEnvelope> => {
				requestCount += 1;
				throw new Error("wire should not be reached");
			},
			onEvent: (): (() => void) => () => undefined,
		} as unknown as SessionClientTransport;
		const handle = {
			transport,
			sessionId: "session_fixture",
			generation: 7,
			supports: (operation: string) => operation === "session.create",
		} as unknown as OwnedSessionHandle;
		const snapshot: SessionInteractiveSnapshot = {
			sessionId: "session_fixture",
			messages: [],
			warnings: [],
			auditEntries: [],
			selection: { thinkingLevel: "off" },
			toolCount: 0,
			eventCursor: 0,
			driverRevision: 3,
		};
		const instance = new SessionInteractiveController(handle, snapshot);
		const commandSessionDomain = (instance as unknown as {
			commandSessionDomain?: (operation: string, payload: Record<string, unknown>, context: { correlationId: string; effectId: string; expectedRevision: number }) => Promise<Record<string, unknown>>;
		}).commandSessionDomain;
		expect(commandSessionDomain).toBeDefined();
		await expect(commandSessionDomain!.call(instance, "session.create", {}, {
			correlationId: "correlation_observer_create",
			effectId: "effect_observer_create",
			expectedRevision: 1,
		})).resolves.toEqual({
			ok: false,
			status: "denied",
			code: "driver_required",
			operation: "session.create",
		});
		expect(requestCount).toBe(0);
	});

	it("rejects an invalid expected revision locally for a driver", async () => {
		let requestCount = 0;
		const transport = {
			request: async (): Promise<SessionFrameEnvelope> => {
				requestCount += 1;
				throw new Error("wire should not be reached");
			},
			onEvent: (): (() => void) => () => undefined,
		} as unknown as SessionClientTransport;
		const handle = {
			transport,
			sessionId: "session_fixture",
			generation: 7,
			supports: (operation: string) => operation === "session.create",
		} as unknown as OwnedSessionHandle;
		const instance = new SessionInteractiveController(handle, {
			sessionId: "session_fixture",
			messages: [],
			warnings: [],
			auditEntries: [],
			selection: { thinkingLevel: "off" },
			toolCount: 0,
			eventCursor: 0,
			driverRevision: 3,
		});
		instance.setConnectionRole("driver");

		await expect(instance.commandSessionDomain("session.create", {}, {
			correlationId: "correlation_invalid_revision",
			effectId: "effect_invalid_revision",
			expectedRevision: -1,
		})).resolves.toEqual({
			ok: false,
			status: "failed",
			code: "invalid_expected_revision",
			operation: "session.create",
		});
		expect(requestCount).toBe(0);
	});

	it("rejects an unnegotiated domain operation locally without sending a frame", async () => {
		let requestCount = 0;
		const transport = {
			request: async (): Promise<SessionFrameEnvelope> => {
				requestCount += 1;
				throw new Error("wire should not be reached");
			},
			onEvent: (): (() => void) => () => undefined,
		} as unknown as SessionClientTransport;
		const handle = {
			transport,
			supports: (operation: string) => operation === "security.inspect",
		} as unknown as OwnedSessionHandle;
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
		const instance = new SessionInteractiveController(handle, snapshot);
		await expect(instance.querySessionDomain("plan.inspect", {}, {
			correlationId: "correlation_plan_inspect",
			effectId: "effect_plan_inspect",
		})).resolves.toMatchObject({
			ok: false,
			status: "unavailable",
			code: "operation_unavailable",
			operation: "plan.inspect",
		});
		expect(requestCount).toBe(0);
	});

	it("无 detail 时抛出 code", async () => {
		await expect(controller(undefined).prompt("hi")).rejects.toThrow("domain_prompt_failed");
	});

	it("有 detail 时把 detail 拼进错误信息", async () => {
		await expect(controller("No model selected. Use /provider or /model.").prompt("hi")).rejects.toThrow(
			"domain_prompt_failed: No model selected. Use /provider or /model.",
		);
	});
});

describe("SessionInteractiveController login over the wire", () => {
	it("sends a login command and returns a status marker on success", async () => {
		const frames: Array<{ kind: string; body: Record<string, unknown> }> = [];
		const transport = {
			request: async (frame: SessionFrameEnvelope): Promise<SessionFrameEnvelope> => {
				frames.push({ kind: frame.kind, body: frame.body as Record<string, unknown> });
				return { kind: "command_result" as const, protocolVersion: 1, frameId: "result_1", body: { ok: true, kind: "login", result: {} } };
			},
			onEvent: (): (() => void) => () => undefined,
		} as unknown as SessionClientTransport;
		const handle = { transport } as unknown as OwnedSessionHandle;
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
		const instance = new SessionInteractiveController(handle, snapshot);
		await expect(instance.login("deepseek", "api_key", undefined as never)).resolves.toBeDefined();
		expect(frames[0]).toMatchObject({ kind: "command_request" });
		expect((frames[0]?.body as Record<string, unknown>).kind).toBe("login");
		expect((frames[0]?.body as Record<string, unknown>).body).toEqual({ providerId: "deepseek", authType: "api_key" });
	});

	it("surfaces login_failed detail when the runtime rejects", async () => {
		const transport = {
			request: async (): Promise<SessionFrameEnvelope> => ({
				kind: "command_result" as const,
				protocolVersion: 1,
				frameId: "result_1",
				body: { ok: false, code: "login_failed", detail: "login cancelled by user" },
			}),
			onEvent: (): (() => void) => () => undefined,
		} as unknown as SessionClientTransport;
		const handle = { transport } as unknown as OwnedSessionHandle;
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
		const instance = new SessionInteractiveController(handle, snapshot);
		await expect(instance.login("deepseek", "api_key", undefined as never)).rejects.toThrow("login_failed: login cancelled by user");
	});
});
