/**
 * P1 修复回归测试（InteractiveMode 层）。
 *
 *   - P1-3:handleReverseRequest 只返回 Host 决策，不伪造 approval receipt/workflow 完成；
 *   - P1-5:requestQuit 取消 in-flight effects 并清理 active timeline rows；
 *   - P2-2:destroy cleanup 全局清 active rows。
 */

import { describe, expect, it, vi } from "vitest";
import { Agent } from "../../src/runtime/agent.ts";
import { mockModel } from "../../src/runtime/providers/mock-stream.ts";
import { InteractiveMode } from "../../src/tui/interactive-mode.ts";
import type { Terminal } from "../../src/tui/index.ts";
import type { HostFrameEnvelope } from "../../src/runtime/host/types.ts";
import type { ProviderWorkflowPort, ProviderCatalogSnapshot } from "../../src/tui/providers/types.ts";
import { ContractController, settleFrames } from "./fixtures/contract-integration.ts";

class FakeTerminal implements Terminal {
  private input: ((data: string) => void) | undefined;
  get columns(): number { return 100; }
  get rows(): number { return 30; }
  get kittyProtocolActive(): boolean { return false; }
  start(onInput: (data: string) => void): void { this.input = onInput; }
  stop(): void { this.input = undefined; }
  async drainInput(): Promise<void> {}
  write(): void {}
  moveBy(): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(): void {}
  setProgress(): void {}
  send(data: string): void { this.input?.(data); }
}

function reverseFrame(): HostFrameEnvelope {
  return {
    frameId: "frame-1",
    kind: "reverse_request",
    protocolVersion: 1,
    body: { requestType: "permission", toolName: "bash", summary: "run ls", cwd: "/tmp" },
  } as HostFrameEnvelope;
}

describe("P1 regression fixes at InteractiveMode level", () => {
	it("keeps the TUI alive while projecting Host reconnect lifecycle states", () => {
		const mode = new InteractiveMode({ controller: new ContractController(), terminal: new FakeTerminal() });
		mode.setHostConnectionState("reconnecting");
		expect(JSON.stringify(mode.getTuiState())).toContain("Host reconnecting");
		mode.setHostConnectionState("ready");
		expect(JSON.stringify(mode.getTuiState())).toContain("Host reconnected");
		mode.setHostConnectionState("build_mismatch");
		expect(JSON.stringify(mode.getTuiState())).toContain("Host build mismatch");
	});

	it("P1-3: reverse approval returns a decision without fabricating a completed workflow", async () => {
		const controller = new ContractController();
		const mode = new InteractiveMode({ controller, terminal: new FakeTerminal() });
		const signal = new AbortController().signal;
		const pending = mode.handleReverseRequest(reverseFrame(), signal);
		expect(mode.getTuiState().capabilities.approval.state).toBe("unavailable");
		expect(mode.getTuiState().approvalWorkflow.state).toBe("unavailable");
		// 选择 deny
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
		const ui = (mode as unknown as { ui: { hasOverlay(): boolean } }).ui;
		expect(ui.hasOverlay()).toBe(true);
		// 直接调 modal 选择项：找到 overlay 的 SelectList 并选择 deny
		const overlay = (mode as unknown as { ui: { overlay: { getSelectedItem?: () => { value: string } | null; handleInput?(data: string): void } | undefined } }).ui.overlay;
		overlay?.handleInput?.("\x1b[B"); // 下移到 deny
		overlay?.handleInput?.("\r");
		const body = await pending;
		expect(body).toEqual({ ok: true, decision: "deny" });
		expect(mode.getTuiState().approvalWorkflow.state).toBe("unavailable");
	});

	it("P1-3: aborting a reverse request leaves the unavailable approval workflow unchanged", async () => {
		const controller = new ContractController();
		const mode = new InteractiveMode({ controller, terminal: new FakeTerminal() });
		const abort = new AbortController();
		const pending = mode.handleReverseRequest(reverseFrame(), abort.signal);
		expect(mode.getTuiState().approvalWorkflow.state).toBe("unavailable");
		abort.abort();
		const body = await pending;
		expect(body).toEqual({ ok: false, code: "approval_aborted" });
		expect(mode.getTuiState().approvalWorkflow.state).toBe("unavailable");
	});

	it("P1-5: requestQuit cancels in-flight effects and cleans active timeline rows", async () => {
		const terminal = new FakeTerminal();
		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => { release = resolve; });
		let signalSeen: AbortSignal | undefined;
		const port: ProviderWorkflowPort = {
			list: async (request) => {
				signalSeen = request.signal;
				await gate;
				return { ok: true, ref: request, value: { providers: [], models: [], generation: 1 } satisfies ProviderCatalogSnapshot };
			},
			select: async (request) => ({ ok: false, ref: request, error: { code: "x", message: "y", retryable: false } }),
		};
		const agent = new Agent({
			initialState: { systemPrompt: "test", model: mockModel },
			streamFn: () => { throw new Error("stream not called"); },
		});
		// 通过真实 composition：controller 提供 provider 端口；注入慢 port
		const controller = new ContractController();
		const mode = new InteractiveMode({ controller, terminal } as never);
		// 替换 runner 端口（测试接缝：验证 cancelAll 语义）
		const ports = (mode as unknown as { ports: { provider?: ProviderWorkflowPort } }).ports;
		ports.provider = port;
		const running = mode.run();
		const handleEvent = (Reflect.get(mode, "handleEvent") as (e: unknown) => void).bind(mode);
		handleEvent({ type: "message_start", timestamp: 0, role: "assistant" });
		const dispatchTimeline = (Reflect.get(mode, "dispatchTimeline") as (e: unknown[]) => void).bind(mode);
		dispatchTimeline([{ type: "tool_start", generation: 1, correlationId: "call-1", row: { kind: "tool", id: "tool:call-1", timestamp: "2026-08-06T00:00:00.000Z", displayOrder: 0, status: "running", toolCallId: "call-1", toolName: { text: "bash", truncated: false, byteLength: 4 }, presentation: { state: "known", value: { renderer: "shell", title: { text: "bash", truncated: false, byteLength: 4 }, chips: [], body: [], timestamps: { startedAt: "2026-08-06T00:00:00.000Z" } } } } }]);
		expect(mode.getTuiState().timeline.activeOrder).toEqual(["assistant:0", "call-1"]);
		// 触发 effect（挂在慢 gate 上）
		const createEffect = (Reflect.get(mode, "createEffect") as (t: string) => { type: string; generation: number; effectId: string; correlationId: string }).bind(mode);
		const effect = createEffect("provider.list");
		const runner = (mode as unknown as { runner: { dispatch(e: unknown): void } }).runner;
		runner.dispatch(effect);
		// quit：应取消 in-flight effect + cleanup destroy 清 active rows
		mode.quit();
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
		expect(signalSeen?.aborted).toBe(true);
		expect(mode.getTuiState().timeline.activeOrder).toEqual([]);
		release?.();
		await running;
		await settleFrames();
		expect(vi).toBeDefined();
	});
});
