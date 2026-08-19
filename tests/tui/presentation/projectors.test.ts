/**
 * B1：presentation projectors —— 只读投影的验收点。
 *
 *   - projector 不接 renderer、Theme、controller instance 或 callback；
 *   - welcome/session/status/footer 使用同一 bootstrap generation；
 *   - 缺 Host authority 时显示 unavailable，不显示 0、空列表或伪 connected；
 *   - session/workspace/provider/model 标签经有界 + 终端安全处理。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createInitialTuiState } from "../../../src/tui/application/initial-state.ts";
import {
  availabilityReason,
  boundedField,
  projectActiveState,
  projectComposer,
  projectFooter,
  projectInteractivePresentation,
  projectSessionStrip,
  projectWelcome,
  sanitizeLabel,
} from "../../../src/tui/presentation/projectors.ts";
import type { TuiBootstrapSnapshot } from "../../../src/tui/presentation/types.ts";

const root = process.cwd();
const projectorsSource = readFileSync(join(root, "src/tui/presentation/projectors.ts"), "utf8");

const bootstrap: TuiBootstrapSnapshot = {
  workspaceLabel: "acme/runledger",
  session: { id: "session-1", format: "current-canonical", lifecycle: "active" },
  authorityGeneration: 7,
};

describe("B1 presentation projectors", () => {
  it("are pure: no renderer, Theme, controller instance or callback imports", () => {
    expect(projectorsSource).not.toContain("@opentui");
    expect(projectorsSource).not.toContain("theme/theme.ts");
    expect(projectorsSource).not.toContain("interactive-mode");
    expect(projectorsSource).not.toContain("=> (...args)");
  });

  it("welcome/session/status/footer derive from the same bootstrap generation", () => {
    const sessionStrip = projectSessionStrip(bootstrap);
    const activeState = projectActiveState(bootstrap);
    const footer = projectFooter(bootstrap, { status: "idle" });
    const welcome = projectWelcome(bootstrap, { versionLabel: "0.0.1" });
    expect(sessionStrip.authorityGeneration).toBe(7);
    expect(activeState.authorityGeneration).toBe(7);
    expect(footer.securityMode).toBe("unknown");
    expect(welcome.directoryLabel).toBe("acme/runledger");
    // 同 bootstrap 输入 → 确定性输出（同一 generation 的语义来源）
    expect(projectSessionStrip(bootstrap).sessionLabel).toBe(projectSessionStrip(bootstrap).sessionLabel);
    expect(projectActiveState(bootstrap).authorityGeneration).toBe(projectActiveState(bootstrap).authorityGeneration);
  });

  it("missing Host authority shows unavailable, never 0/empty/fake-connected", () => {
    const sessionStrip = projectSessionStrip(bootstrap);
    expect(sessionStrip.host).toEqual({ state: "unavailable", reason: "host-authority-not-connected" });
    expect(sessionStrip.connection).toBe("unknown");
    expect(sessionStrip.clientRole).toBe("unknown");
    const footer = projectFooter(bootstrap, { status: "idle" });
    expect(footer.host).toEqual({ state: "unavailable", reason: "host-authority-not-connected" });
    expect(availabilityReason({ state: "unavailable", reason: "no-facade" })).toBe("no-facade");
    expect(availabilityReason({ state: "available" })).toBe("available");
  });

  it("explicit host/role facts flow through when provided", () => {
    const sessionStrip = projectSessionStrip(bootstrap, {
      securityMode: "guarded",
      host: { state: "known", value: "host-1" },
      clientRole: "driver",
      connection: "connected",
      resync: "synchronized",
    });
    expect(sessionStrip.host).toEqual({ state: "known", value: "host-1" });
    expect(sessionStrip.clientRole).toBe("driver");
    expect(sessionStrip.connection).toBe("connected");
    expect(sessionStrip.securityMode).toBe("guarded");
  });

  it("labels are bounded and terminal-safe", () => {
    const dangerous = "\x1b[31mred\x1b[0m/session";
    const label = sanitizeLabel(dangerous, 80);
    expect(label).toBe("red/session");
    expect(label).not.toContain("\x1b");
    const long = "a".repeat(200);
    const bounded = sanitizeLabel(long, 32);
    expect(bounded.endsWith("…")).toBe(true);
    expect(new TextEncoder().encode(bounded).byteLength).toBeLessThanOrEqual(32 + 3);
    expect(boundedField(undefined)).toEqual({ state: "unknown", reason: "empty-label" });
    expect(boundedField("model-x")).toEqual({ state: "known", value: "model-x" });
  });

  it("active state and composer project bounded read-only views", () => {
    const active = projectActiveState(bootstrap, {
      priority: "approval",
      query: "running",
      activeTurn: { state: "known", value: 2 },
      pendingApprovalCount: { state: "known", value: 1 },
      recoveryRequired: true,
    });
    expect(active.priority).toBe("approval");
    expect(active.activeTurn).toEqual({ state: "known", value: 2 });
    expect(active.recoveryRequired).toBe(true);
    const composer = projectComposer({
      mode: "prompt",
      draft: "  hello \x1b[1mworld\x1b[0m  ",
      queuedCount: { state: "known", value: 0 },
      frozen: false,
    });
    expect(composer.mode).toBe("prompt");
    expect(composer.draft).toBe("hello world");
  });

	it("passes display-only thinking visibility through the canonical timeline projection", () => {
		const state = createInitialTuiState({ bootstrap });
		const assistant = {
			kind: "assistant" as const,
			id: "assistant:1",
			timestamp: "2026-08-20T00:00:00.000Z",
			displayOrder: 0,
			status: "succeeded" as const,
			streaming: false,
			thinking: { text: "reasoning", truncated: false, byteLength: 9 },
			text: { text: "answer", truncated: false, byteLength: 6 },
		};
		const withTimeline = {
			...state,
			timeline: { ...state.timeline, committedRows: [assistant], generation: 1 },
		};

		expect(projectInteractivePresentation(withTimeline).timeline).toHaveLength(2);
		expect(projectInteractivePresentation(withTimeline, { hideThinking: true }).timeline).toEqual([
			expect.objectContaining({ id: "timeline-assistant:1/text", content: "answer" }),
		]);
	});

	it("recovery-required has priority in the canonical footer projection", () => {
		const state = createInitialTuiState({ bootstrap });
		const recovery = projectInteractivePresentation({
			...state,
			recoveryRequired: true,
			transitionFrozen: true,
		});
		expect(recovery.footer.status).toBe("recovery-required");
		expect(recovery.activeState.priority).toBe("recovery");
	});
});
