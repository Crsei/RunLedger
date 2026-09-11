import { afterEach, describe, expect, it, vi } from "vitest";
import { InteractiveMode, type InteractiveModeOptions } from "../../src/tui/interactive-mode.ts";
import { TUI } from "../../src/tui/primitives.ts";
import { TranscriptOverlayComponent } from "../../src/tui/transcript-view.ts";
import type { SessionDomainResult } from "../../src/runtime/session-runtime/domain-router.ts";
import { PromptDumpWorkflow } from "../../src/tui/interactive/prompt-dump-workflow.ts";
import type { InteractiveModePorts, PromptDumpDocument, PromptDumpPort } from "../../src/tui/interactive/types.ts";
import { RequestDumpPager } from "../../src/runtime/session-runtime/request-dump-pager.ts";
import { findCommand } from "../../src/tui/commands/registry.ts";
import { ContractController, ContractTerminal } from "./fixtures/contract-integration.ts";

afterEach(() => vi.restoreAllMocks());

function notices(mode: InteractiveMode): string {
	return mode.getTuiState().timeline.committedRows.flatMap((row) => row.kind === "notice" ? [row.message.text] : []).join("\n");
}
function overlayText(mode: InteractiveMode): string {
	return mode.overlayComponent instanceof TranscriptOverlayComponent ? mode.overlayComponent.render(120).join("\n") : "";
}
async function withMode(controller: ContractController, run: (mode: InteractiveMode, terminal: ContractTerminal) => Promise<void>, options: Omit<InteractiveModeOptions, "controller" | "terminal"> = {}) {
	const terminal = new ContractTerminal(100, 30);
	const mode = new InteractiveMode({ controller, terminal, ...options });
	const running = mode.run();
	try { await Promise.resolve(); await Promise.resolve(); await run(mode, terminal); }
	finally { mode.quit(); await running; }
}

describe("/dump raw request export", () => {
	it("is read-only, accepts explicit views, and requires request inspection", () => {
		expect(findCommand("dump")).toMatchObject({ canonicalName: "dump", actionType: "ui.dump", requiredOperation: "session.request.inspect",
			supportsInlineArgs: true, availableDuringTask: true, policy: { draft: "allowed", history: "allowed", query: "allowed", frozen: "allowed" } });
	});

	it("exports unchanged large system text while sanitizing and bounding only the preview", async () => {
		const content = "raw\u001b\u0085中文\r\n" + "long prompt\n".repeat(22_000);
		const documents: PromptDumpDocument[] = [];
		const clipboard = vi.spyOn(TUI.prototype, "writeClipboard").mockReturnValue(true);
		const promptDumpPort: PromptDumpPort = { write: async (document) => { documents.push(document); return { ok: true, path: "/tmp/dump.txt", metadataPath: "/tmp/dump.metadata.json" }; } };
		const pager = new RequestDumpPager((view) => ({ ok: true, dump: { content,
			metadata: { view, layer: "provider-input", mediaType: "text/plain", capturedAtMs: 1_700_000_000_000, state: "completed", model: "captured-model", requestId: "captured-request" } } }));
		let pages = 0;
		const controller = new ContractController({ supportedOperations: ["session.request.inspect"], querySessionDomain: async (operation, payload) => {
			expect(operation).toBe("session.request.inspect");
			expect(payload.view).toBe("system");
			pages++;
			const result = pager.read(payload);
			if (!result.ok) throw new Error(result.code);
			return result.value;
		} });
		await withMode(controller, async (mode) => {
			mode.echoPrompt("/dump system");
			await vi.waitFor(() => expect(notices(mode)).toContain("File: /tmp/dump.txt"));
			expect(overlayText(mode)).toContain("raw��中文");
			expect(overlayText(mode)).not.toContain("## Configuration");
			expect(notices(mode)).toContain("captured-request");
			expect(notices(mode)).toContain("Metadata: /tmp/dump.metadata.json");
		}, { promptDumpPort });
		expect(pages).toBeGreaterThan(1);
		expect(documents).toHaveLength(1);
		expect(documents[0]?.content).toBe(content);
		expect(clipboard).toHaveBeenCalledTimes(1);
		expect(clipboard).toHaveBeenCalledWith(content);
		expect(documents[0]?.metadata.model).toBe("captured-model");
	});

	it("shows missing capture without producing a substitute file", async () => {
		class EmptyController extends ContractController {
			override readonly querySessionDomain = async (operation: string): Promise<SessionDomainResult> => ({ ok: false, status: "failed", code: "provider_request_unavailable", operation });
		}
		const write = vi.fn();
		await withMode(new EmptyController({ supportedOperations: ["session.request.inspect"] }), async (mode) => {
			mode.echoPrompt("/dump");
			await vi.waitFor(() => expect(notices(mode)).toContain("No provider request captured"));
			expect(overlayText(mode)).toBe("");
		}, { promptDumpPort: { write } });
		expect(write).not.toHaveBeenCalled();
	});

	it("does not publish a delayed export into a different session", async () => {
		let sessionId = "first";
		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => { release = resolve; });
		const controller = new ContractController({ supportedOperations: ["session.request.inspect"], querySessionDomain: async () => {
			await gate;
			const pager = new RequestDumpPager(() => ({ ok: true, dump: { content: "first session system", metadata: { view: "request", layer: "provider-input", mediaType: "text/plain", capturedAtMs: 1, state: "completed" } } }));
			const result = pager.read({});
			if (!result.ok) throw new Error(result.code);
			return result.value;
		} });
		const showNotice = vi.fn();
		const showOverlayModal = vi.fn();
		const write = vi.fn();
		// 只提供失效返回前可触达的端口，意外进入渲染路径会使测试失败。
		const workflow = new PromptDumpWorkflow({ controller, getSessionId: () => sessionId, nextCorrelationId: () => "corr",
			nextEffectId: () => "effect", showNotice, showOverlayModal, promptDumpPort: { write }, quitting: false } as unknown as InteractiveModePorts);
		const pending = workflow.run("");
		sessionId = "second";
		release?.();
		await pending;
		expect(showNotice).not.toHaveBeenCalled();
		expect(showOverlayModal).not.toHaveBeenCalled();
		expect(write).not.toHaveBeenCalled();
	});

	it("rejects unknown arguments", async () => {
		await withMode(new ContractController({ supportedOperations: ["session.request.inspect"] }), async (mode) => {
			mode.echoPrompt("/dump now");
			await vi.waitFor(() => expect(notices(mode)).toContain("Usage: /dump [request|system|assembled|base]"));
		});
	});

	it("does not call an unsupported operation", async () => {
		const query = vi.fn();
		await withMode(new ContractController({ supportedOperations: [], querySessionDomain: query }), async (mode) => {
			mode.echoPrompt("/dump");
			await vi.waitFor(() => expect(notices(mode)).toContain("unavailable"));
		});
		expect(query).not.toHaveBeenCalled();
	});
});
