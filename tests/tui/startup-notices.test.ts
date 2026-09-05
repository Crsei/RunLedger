import { describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../../src/tui/interactive-mode.ts";
import type { PresentationBlock } from "../../src/tui/presentation.ts";
import type { ChatContainer } from "../../src/tui/components/chat-container.ts";
import { ContractController, ContractTerminal, settleFrames } from "./fixtures/contract-integration.ts";
import { SessionInteractiveController } from "../../src/cli/session-interactive-controller.ts";
import type { OwnedSessionHandle } from "../../src/cli/session-client.ts";
import type { SessionClientTransport } from "../../src/runtime/session-server/client-transport.ts";
import type { SessionFrameEnvelope } from "../../src/runtime/session-server/protocol.ts";
import { standardHarnessProfileRef } from "../../src/runtime/harness-profiles/index.ts";

function liveController(sessionId: string, request: SessionClientTransport["request"]): SessionInteractiveController {
	const transport = {
		request: (frame: SessionFrameEnvelope) => frame.body.kind === "recovery_status"
			? Promise.resolve<SessionFrameEnvelope>({ frameId: "recovery", kind: "query_result", protocolVersion: 3, body: { ok: true, state: "ready", barrierState: "closed", unresolvedAttempts: 0, sideEffectSpawnCount: 0 } })
			: request(frame),
		onEvent: () => () => undefined,
		notify: () => undefined,
	} as unknown as SessionClientTransport;
	const handle = { transport, generation: 1, supports: () => false } as unknown as OwnedSessionHandle;
	return new SessionInteractiveController(handle, { sessionId, harnessProfile: standardHarnessProfileRef(), permissionProfile: "workspace-write", messages: [], warnings: [], auditEntries: [], selection: { thinkingLevel: "off" }, toolCount: 0, eventCursor: 0, driverRevision: 0 });
}

function rejection(): SessionFrameEnvelope {
	return { frameId: "rejected", kind: "command_result", protocolVersion: 3, body: { ok: false, code: "driver_lease_lost", detail: "driver was replaced" } };
}

function presentationText(block: PresentationBlock): string {
	if (block.kind === "notice") return block.message;
	if ("content" in block) return block.content ?? "";
	return "";
}

describe("startup notices", () => {
	it("projects real controller mutation warnings and unsubscribes before another session starts", async () => {
		let failLate!: (error: Error) => void;
		const controller = liveController("session_warning_old", async (frame) => {
			if (frame.body.kind === "clear_queues") return new Promise((_resolve, reject) => { failLate = reject; });
			return rejection();
		});
		const oldMode = new InteractiveMode({ controller, terminal: new ContractTerminal() });
		const oldRun = oldMode.run();
		await settleFrames();
		try {
			controller.interrupt();
			await vi.waitFor(() => expect(oldMode.getTuiState().timeline.committedRows).toContainEqual(expect.objectContaining({ kind: "notice", severity: "error", message: expect.objectContaining({ text: "interrupt failed: driver_lease_lost: driver was replaced" }) })));
			controller.clearAllQueues();
		} finally {
			oldMode.quit();
			await oldRun;
		}
		const rowsAfterQuit = oldMode.getTuiState().timeline.committedRows;
		const nextController = liveController("session_warning_new", async () => rejection());
		const nextMode = new InteractiveMode({ controller: nextController, terminal: new ContractTerminal() });
		const nextRun = nextMode.run();
		try {
			await settleFrames();
			failLate(new Error("late old-session failure"));
			await vi.waitFor(() => expect(controller.warnings).toContain("clear_queues failed: late old-session failure"));
			expect(oldMode.getTuiState().timeline.committedRows).toEqual(rowsAfterQuit);
			expect(nextMode.getTuiState().timeline.committedRows.filter((row) => row.kind === "notice")).toEqual([]);
		} finally {
			nextMode.quit();
			await nextRun;
			controller.dispose();
			nextController.dispose();
		}
	});

	it("projects only an unverified workspace capability with project warnings", () => {
		const mode = new InteractiveMode({
			controller: new ContractController({ warnings: ["project warning"] }),
			terminal: new ContractTerminal(),
			workspaceCapability: "ws:macos-unverified",
			syntaxThemeWarnings: ["syntax warning"],
		});
		try {
			const stateNotices = mode.getTuiState().timeline.committedRows
				.filter((row) => row.kind === "notice")
				.map((row) => ({ severity: row.severity, message: row.message.text }));
			expect(stateNotices).toEqual([
				{ severity: "warning", message: "ws:macos-unverified" },
				{ severity: "warning", message: "project warning" },
				{ severity: "warning", message: "syntax warning" },
			]);

			const refs = (mode as unknown as {
				refs: {
					chat: ChatContainer;
					footer: { present(width: number): PresentationBlock[] };
				};
			}).refs;
			const conversation = refs.chat.present(120).map(presentationText).join("\n");
			expect(conversation).toContain("warning: ws:macos-unverified");
			expect(conversation).toContain("warning: project warning");
			expect(conversation).toContain("warning: syntax warning");

			const footer = refs.footer.present(200).map((block) => block.kind === "status-line"
				? block.segments.map((segment) => segment.text).join(" · ")
				: "").join("\n");
			expect(footer).not.toContain("ws:linux-verified");
		} finally {
			mode.quit();
		}
	});

	it("does not project a verified workspace capability into startup notices", () => {
		const mode = new InteractiveMode({
			controller: new ContractController(),
			terminal: new ContractTerminal(),
			workspaceCapability: "ws:linux-verified",
		});
		try {
			const notices = mode.getTuiState().timeline.committedRows.filter((row) => row.kind === "notice");
			expect(notices).toHaveLength(0);

			const refs = (mode as unknown as { refs: { chat: ChatContainer } }).refs;
			const conversation = refs.chat.present(120).map(presentationText).join("\n");
			expect(conversation).not.toContain("ws:linux-verified");
		} finally {
			mode.quit();
		}
	});
});
