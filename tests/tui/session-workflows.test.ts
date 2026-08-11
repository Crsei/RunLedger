import { describe, expect, it, vi } from "vitest";
import type { SessionDomainResult } from "../../src/runtime/session-runtime/domain-router.ts";
import { InteractiveMode } from "../../src/tui/interactive-mode.ts";
import { ContractController, ContractTerminal, settleFrames } from "./fixtures/contract-integration.ts";

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

	it("quit returns a typed quit intent without disposing the Session client", async () => {
		const terminal = new ContractTerminal();
		const { controller } = sessionController();
		const mode = new InteractiveMode({ controller, terminal });
		const running = mode.run();
		mode.quit();
		expect(await running).toEqual({ kind: "quit" });
		expect(controller.disposed).toBe(false);
	});
});
