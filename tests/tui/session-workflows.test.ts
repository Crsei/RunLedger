import { describe, expect, it, vi } from "vitest";
import type { SessionDomainResult } from "../../src/runtime/session-runtime/domain-router.ts";
import { InteractiveMode } from "../../src/tui/interactive-mode.ts";
import { ContractController, ContractTerminal, contractAssistantMessage, settleFrames } from "./fixtures/contract-integration.ts";
import type { SessionIdleRecapEvent } from "../../src/runtime/interactive-session-controller.ts";
import { SessionInteractiveController } from "../../src/cli/session-interactive-controller.ts";
import type { OwnedSessionHandle } from "../../src/cli/session-client.ts";
import type { SessionClientTransport } from "../../src/runtime/session-server/client-transport.ts";
import type { SessionFrameEnvelope } from "../../src/runtime/session-server/protocol.ts";

const catalogItems = [
	{ sessionId: "contract-session", workspaceId: "workspace-1", repositoryId: "repository-1", status: "active", createdAtMs: 1, updatedAtMs: 3, headSequence: 7, driverRevision: 1, current: true },
	{ sessionId: "session-paused", workspaceId: "workspace-1", repositoryId: "repository-1", status: "paused", createdAtMs: 2, updatedAtMs: 4, headSequence: 5, driverRevision: 0, current: false },
];

function sessionController() {
	const controller = new ContractController({
		supportedOperations: ["session.catalog.list", "session.create", "session.resume", "session.fork"],
	});
	const querySessionDomain = vi.fn(async (operation: string): Promise<SessionDomainResult> => ({
		ok: true,
		status: "ok",
		operation,
		domainRevision: 2,
		value: { items: catalogItems },
	}));
	const commandSessionDomain = vi.fn(async (operation: string): Promise<SessionDomainResult> => ({
		ok: true,
		status: "ok",
		operation,
		domainRevision: operation === "session.resume" ? 2 : 3,
		value: { targetSessionId: operation === "session.resume" ? "session-paused" : operation === "session.create" ? "session-new" : "session-fork" },
		receipt: operation === "session.resume" ? undefined : { attemptId: `attempt-${operation}`, commandId: `command-${operation}`, outcome: "committed" },
	}));
	Object.assign(controller, { querySessionDomain, commandSessionDomain });
	return { controller, querySessionDomain, commandSessionDomain };
}

describe("S2 InteractiveMode session workflows", () => {
	it("re-seeds usage from canonical messages when owner recovery changes state", () => {
		const canonical = contractAssistantMessage({
			usage: {
				input: 10,
				output: 5,
				cacheRead: 20,
				cacheWrite: 1,
				totalTokens: 36,
				cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 },
				reported: { input: true, output: true, cacheRead: true, cacheWrite: true, cost: true },
			},
		});
		const controller = new ContractController({ messages: [canonical] });
		const mode = new InteractiveMode({ controller, terminal: new ContractTerminal() });
		const applyRecoveryStatus = Reflect.get(mode, "applyRecoveryStatus");
		expect(typeof applyRecoveryStatus).toBe("function");
		if (typeof applyRecoveryStatus !== "function") return;

		const handleEvent = Reflect.get(mode, "handleEvent");
		expect(typeof handleEvent).toBe("function");
		if (typeof handleEvent !== "function") return;
		const dispatch = (handleEvent as (event: { type: "message_start" | "message_end"; timestamp: number; role: "assistant"; stopReason?: string; message?: typeof canonical }) => void).bind(mode);
		dispatch({ type: "message_start", timestamp: 10, role: "assistant" });
		dispatch({ type: "message_end", timestamp: 11, role: "assistant", stopReason: "stop", message: { ...canonical, usage: { ...canonical.usage, output: 99, totalTokens: 130 } } });
		expect(mode.getUsageSnapshot().cumulative.output).toMatchObject({ state: "exact", value: 104 });

		(applyRecoveryStatus as (status: { state: string; barrierState: "open" | "closed"; unresolvedAttempts: number; sideEffectSpawnCount: number }) => void).call(mode, {
			state: "recovery_required",
			barrierState: "open",
			unresolvedAttempts: 1,
			sideEffectSpawnCount: 0,
		});
		expect(mode.getUsageSnapshot().status).toBe("unavailable");
		expect(mode.getUsageSnapshot().cumulative.output).toMatchObject({ state: "exact", value: 5 });

		(applyRecoveryStatus as (status: { state: string; barrierState: "open" | "closed"; unresolvedAttempts: number; sideEffectSpawnCount: number }) => void).call(mode, {
			state: "ready",
			barrierState: "closed",
			unresolvedAttempts: 0,
			sideEffectSpawnCount: 0,
		});
		expect(mode.getUsageSnapshot().cumulative.output).toMatchObject({ state: "exact", value: 5 });
		mode.quit();
	});

	it("seeds each newly opened resume or fork view from that session's canonical messages", () => {
		const message = (output: number) => contractAssistantMessage({
			usage: {
				input: 1,
				output,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 1 + output,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				reported: { input: true, output: true, cacheRead: true, cacheWrite: true, cost: true },
			},
		});
		const resumed = new InteractiveMode({
			controller: new ContractController({ messages: [message(2)] }),
			terminal: new ContractTerminal(),
		});
		const forked = new InteractiveMode({
			controller: new ContractController({ messages: [message(2), message(3)] }),
			terminal: new ContractTerminal(),
		});
		try {
			expect(resumed.getUsageSnapshot().cumulative.output).toMatchObject({ state: "exact", value: 2 });
			expect(forked.getUsageSnapshot().cumulative.output).toMatchObject({ state: "exact", value: 5 });
		} finally {
			resumed.quit();
			forked.quit();
		}
	});

	it("keeps the owner-side editor state empty after Enter submits through the TCP controller", async () => {
		const terminal = new ContractTerminal();
		const editorActivity: boolean[] = [];
		const transport = {
			request: async (frame: SessionFrameEnvelope): Promise<SessionFrameEnvelope> => {
				if (frame.kind === "command_request" && frame.body.kind === "editor_activity") {
					const body = frame.body.body as { readonly empty?: unknown };
					if (typeof body.empty === "boolean") editorActivity.push(body.empty);
				}
				return { frameId: `result-${editorActivity.length}`, kind: "command_result", protocolVersion: 3, body: { ok: true } };
			},
			onEvent: (): (() => void) => () => undefined,
			notify: () => undefined,
		} as unknown as SessionClientTransport;
		const handle = {
			transport,
			sessionId: "contract-session",
			generation: 4,
			supports: () => true,
		} as unknown as OwnedSessionHandle;
		const controller = new SessionInteractiveController(handle, {
			sessionId: "contract-session",
			messages: [],
			warnings: [],
			auditEntries: [],
			selection: { thinkingLevel: "off" },
			toolCount: 0,
			eventCursor: 0,
			driverRevision: 1,
		});
		controller.setConnectionRole("driver");
		const mode = new InteractiveMode({ controller, terminal });
		const running = mode.run();
		try {
			await settleFrames();
			terminal.send("ship recap");
			terminal.send("\r");
			await vi.waitFor(() => expect(editorActivity.length).toBeGreaterThanOrEqual(2));

			expect(editorActivity).toContain(false);
			expect(editorActivity.at(-1)).toBe(true);
		} finally {
			mode.quit();
			await running;
			controller.dispose();
		}
	});

	it("uses the negotiated Session owner generation as the TUI stale-result fence", () => {
		const { controller } = sessionController();
		Object.defineProperty(controller, "authorityGeneration", { value: 17 });
		const mode = new InteractiveMode({ controller, terminal: new ContractTerminal() });
		try {
			expect(mode.getTuiState().authorityGeneration).toBe(17);
		} finally {
			mode.quit();
		}
	});

	it("keeps the canonical session id hidden until the durable title arrives", async () => {
		const controller = new ContractController();
		const mode = new InteractiveMode({ controller, terminal: new ContractTerminal() });
		const running = mode.run();
		try {
			await settleFrames();
			expect(mode.getThreadLabel()).toBeUndefined();
			controller.emitTitleChanged({ sessionId: controller.sessionId, title: "Fix login flow", source: "auto" });
			await settleFrames();
			expect(mode.getThreadLabel()).toBe("Fix login flow");
		} finally {
			mode.quit();
			await running;
		}
	});

	it("/resume opens the canonical catalog and selection returns a resume switch intent", async () => {
		const terminal = new ContractTerminal();
		const { controller, querySessionDomain, commandSessionDomain } = sessionController();
		const mode = new InteractiveMode({ controller, terminal });
		const running = mode.run();
		await (mode as unknown as { openSessionCatalog(): Promise<void> }).openSessionCatalog();
		await settleFrames();
		const overlay = (mode as unknown as {
			ui: { getOverlay(): { present?(): readonly { readonly kind: string; readonly title?: string }[] } | undefined };
		}).ui.getOverlay();
		const selectBlock = overlay?.present?.().find((block) => block.kind === "select");
		expect(selectBlock).toMatchObject({ kind: "select", title: "/resume (2)" });
		expect(querySessionDomain).toHaveBeenCalledWith("session.catalog.list", {}, expect.objectContaining({ correlationId: expect.any(String), effectId: expect.any(String) }));
		// 默认按 updated desc 排序:session-paused(updatedAtMs=4)位于第 0 项。
		terminal.send("\r");
		const intent = await running;
		expect(commandSessionDomain).toHaveBeenCalledWith("session.resume", { targetSessionId: "session-paused" }, expect.objectContaining({ expectedRevision: 2 }));
		expect(intent).toEqual({ kind: "switch", action: "resume", target: { sessionId: "session-paused" } });
		expect(controller.disposed).toBe(false);
	});

	it("/new creates in the current catalog revision and returns a new-session switch intent", async () => {
		const terminal = new ContractTerminal();
		const { controller, commandSessionDomain } = sessionController();
		const mode = new InteractiveMode({ controller, terminal });
		const running = mode.run();
		await (mode as unknown as { createNewSession(): Promise<void> }).createNewSession();
		expect(await running).toEqual({ kind: "switch", action: "new", target: { sessionId: "session-new" } });
		expect(commandSessionDomain).toHaveBeenCalledWith("session.create", {}, expect.objectContaining({ expectedRevision: 2 }));
	});

	it("/fork sends the current durable head fence and returns a fork switch intent", async () => {
		const terminal = new ContractTerminal();
		const { controller, commandSessionDomain } = sessionController();
		const mode = new InteractiveMode({ controller, terminal });
		const running = mode.run();
		await (mode as unknown as { forkCurrentSession(): Promise<void> }).forkCurrentSession();
		expect(await running).toEqual({ kind: "switch", action: "fork", target: { sessionId: "session-fork" } });
		expect(commandSessionDomain).toHaveBeenCalledWith(
			"session.fork",
			{ sourceSessionId: "contract-session", expectedSourceHeadSequence: 7 },
			expect.objectContaining({ expectedRevision: 2 }),
		);
	});

	it("/rename dispatches through the effect runner and requeries the canonical catalog", async () => {
		let currentTitle: string | undefined;
		const querySessionDomain = vi.fn(async (operation: string): Promise<Record<string, unknown>> => ({
			domainRevision: 2,
			items: catalogItems.map((item) => item.current && currentTitle === undefined
				? { ...item, title: "Existing title", titleSource: "user", titleUpdatedAtMs: 9 }
				: currentTitle === undefined
				? item
				: { ...item, title: currentTitle, titleSource: "user", titleUpdatedAtMs: 10 }),
		}));
		const commandSessionDomain = vi.fn(async (operation: string, body: Record<string, unknown>): Promise<Record<string, unknown>> => {
				expect(operation).toBe("session.title.set");
				expect(body.expectedTitle).toBe("Existing title");
			currentTitle = String(body.title);
				return {
					domainRevision: 3,
					sessionId: "contract-session",
					title: currentTitle,
					titleSource: "user",
					titleUpdatedAtMs: 10,
					catalogRevision: 3,
				};
		});
		const controller = new ContractController({
			supportedOperations: ["session.catalog.list", "session.title.set"],
			querySessionDomain,
			commandSessionDomain,
		});
		const mode = new InteractiveMode({ controller, terminal: new ContractTerminal() });
		try {
			await (mode as unknown as { renameCurrentSession(title: string): Promise<void> }).renameCurrentSession("Fix login flow");
				expect(commandSessionDomain).toHaveBeenCalledWith("session.title.set", {
					title: "Fix login flow",
					source: "user",
					expectedTitle: "Existing title",
				}, expect.objectContaining({ expectedRevision: 2 }));
			expect(querySessionDomain).toHaveBeenCalledTimes(2);
		expect(mode.getTuiState().sessionWorkflow).toMatchObject({
				state: "ready",
				value: { kind: "catalog", items: expect.arrayContaining([expect.objectContaining({ title: "Fix login flow", titleSource: "user" })]) },
			});
		} finally {
			mode.quit();
		}
	});

	it("refreshes the catalog and bootstrap when a subscribed title event arrives", async () => {
		const querySessionDomain = vi.fn(async (): Promise<Record<string, unknown>> => ({
			domainRevision: 2,
			items: catalogItems,
		}));
		const controller = new ContractController({
			supportedOperations: ["session.catalog.list"],
			querySessionDomain,
		});
		const mode = new InteractiveMode({ controller, terminal: new ContractTerminal() });
		const running = mode.run();
		try {
			await settleFrames();
			controller.emitTitleChanged({ sessionId: "contract-session", title: "External title", source: "user", sequence: 8 });
			await vi.waitFor(() => expect(querySessionDomain).toHaveBeenCalledTimes(1));
			expect(mode.getTuiState().bootstrap.session).toMatchObject({ id: "contract-session", title: "External title" });
		} finally {
			mode.quit();
			await running;
		}
	});

	it("quit returns a typed quit intent without disposing the Session client", async () => {
		const terminal = new ContractTerminal();
		const { controller } = sessionController();
		const mode = new InteractiveMode({ controller, terminal });
		const running = mode.run();
		mode.quit();
		expect(await running).toEqual({ kind: "quit" });
		expect(controller.disposed).toBe(false);
	});

	it("does not let stale idle recap events replace or clear the current transient status", async () => {
		const controller = new ContractController();
		const listeners = new Set<(event: SessionIdleRecapEvent) => void>();
		let emitRecap!: (event: SessionIdleRecapEvent) => void;
		Object.assign(controller, {
			subscribeIdleRecap: (listener: (event: SessionIdleRecapEvent) => void) => {
				listeners.add(listener);
				emitRecap = (event) => { for (const current of listeners) current(event); };
				return () => listeners.delete(listener);
			},
		});
		const mode = new InteractiveMode({ controller, terminal: new ContractTerminal() });
		const running = mode.run();
		try {
			await settleFrames();
			const status = (mode as unknown as { refs: { status: { render(width: number): string[] } } }).refs.status;
			emitRecap({ sessionId: controller.sessionId, requestId: "recap-new", ownerGeneration: 1, activityGeneration: 2, text: "current recap" });
			expect(status.render(100)[0]).toContain("current recap");
			emitRecap({ sessionId: controller.sessionId, requestId: "recap-old", ownerGeneration: 1, activityGeneration: 1, text: "stale recap" });
			expect(status.render(100)[0]).toContain("current recap");
			emitRecap({ sessionId: controller.sessionId, requestId: "recap-old", ownerGeneration: 1, activityGeneration: 1, cleared: true });
			expect(status.render(100)[0]).toContain("current recap");
			emitRecap({ sessionId: controller.sessionId, requestId: "recap-new", ownerGeneration: 1, activityGeneration: 2, cleared: true });
			expect(status.render(100)[0]).not.toContain("recap:");
		} finally {
			mode.quit();
			await running;
		}
	});
});
