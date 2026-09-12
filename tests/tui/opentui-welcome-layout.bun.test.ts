import { describe, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import type { TUI } from "../../src/tui/primitives.ts";
import { InteractiveMode } from "../../src/tui/interactive-mode.ts";
import { mockModel } from "../../src/runtime/providers/mock-stream.ts";
import { createOpenTuiComponentRuntimeFromRenderer, type OpenTuiComponentRuntime } from "../../src/tui/opentui/component-runtime.ts";
import { ContractController, ContractTerminal, settleFrames } from "./fixtures/contract-integration.ts";

const workspace = "/data2-HDD-SATA-20T/Digital_avatar/haoweiyao/RunLedger";

async function renderStartup(showWelcome: boolean, withModel = false): Promise<string> {
	const setup = await createTestRenderer({ width: 80, height: 24 });
	const terminal = new ContractTerminal(80, 24);
	const controller = new ContractController({
		supportedOperations: [],
		...(withModel ? { selection: {
			provider: "azure-openai-responses",
			model: { ...mockModel, provider: "azure-openai-responses", id: "gpt-4.1-mini", contextWindow: 1_000_000 },
			thinkingLevel: "off" as const,
		} } : {}),
	});
	const mode = new InteractiveMode({
		controller,
		terminal,
		showWelcome,
		version: "test",
		harnessProfile: { id: "standard", version: 1 },
		permissionProfile: "workspace-write",
		workspaceDisplayAbsolutePath: workspace,
		gitBranchLabel: "main",
	});
	const { ui } = mode as unknown as { ui: TUI };
	const runtime = createOpenTuiComponentRuntimeFromRenderer(setup.renderer, { onInput: () => {}, onResize: () => {} });
	// 使用真实 InteractiveMode 组件树与帧预算，仅替换终端 transport。
	(ui as unknown as { runtime: OpenTuiComponentRuntime }).runtime = runtime;
	const running = mode.run();
	try {
		await settleFrames();
		await setup.renderOnce();
		return setup.captureCharFrame();
	} finally {
		mode.echoPrompt("/quit");
		await running;
		controller.dispose();
	}
}

describe("80x24 startup layout", () => {
	test("keeps the Harness profile above Welcome when a model adds a context footer row", async () => {
		const frame = await renderStartup(true, true);
		expect(frame).toContain("Harness: standard@1");
		expect(frame).toContain("RunLedger vtest");
		expect(frame).toContain("/ for commands");
		expect(frame).toContain("think:off");
		expect(frame).toContain("ctx window 1.0m");
	});

	test("keeps Welcome title and primary shortcuts in the first native viewport", async () => {
		const frame = await renderStartup(true);
		expect(frame).toContain("RunLedger vtest");
		expect(frame).toContain("Welcome back!");
		expect(frame).toContain("/ for commands");
		expect(frame).toContain("Enter to send");
		expect(frame).toContain("Message RunLedger");
	});

	test("keeps the complete thinking value in the native footer after indentation", async () => {
		const frame = await renderStartup(false);
		expect(frame.trimEnd().split("\n").at(-1)).toContain("think:off");
	});
});
