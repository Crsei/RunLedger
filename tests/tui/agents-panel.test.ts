/**
 * /agents 面板接线验收 —— 真实 InteractiveMode + 真实 EffectRunner/资源 adapter，
 * 只替换 Session domain 通道(controller)。覆盖:
 *   - `/agents` 走 `agent.inspect` 查询并打开 overlay;
 *   - 取消经 `agent.cancel` mutation 发出,带查询到的 graph revision;
 *   - 不协商 `agent.inspect` 时不构造端口,命令给出 typed notice 而不发请求。
 */

import { describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../../src/tui/interactive-mode.ts";
import { AgentsModal } from "../../src/tui/components/agents-modal.ts";
import type { TUI } from "../../src/tui/index.ts";
import { findCommand } from "../../src/tui/commands/registry.ts";
import { ContractController, ContractTerminal, settleFrames } from "./fixtures/contract-integration.ts";

/** 私有的 workflow 协作者与 renderer；测试只经公开命令入口与 overlay 观察。 */
interface InteractiveModeInternals {
	readonly ui: TUI;
	readonly agentWorkflow: { openAgentsPanel(): Promise<void> };
}

function internals(mode: InteractiveMode): InteractiveModeInternals {
	return mode as unknown as InteractiveModeInternals;
}

function notices(mode: InteractiveMode): string {
  return mode.getTuiState().timeline.committedRows
    .flatMap((row) => row.kind === "notice" ? [row.message.text] : [])
    .join("\n");
}

function overlayOf(mode: InteractiveMode): AgentsModal {
	const overlay = internals(mode).ui.getOverlay();
	if (!(overlay instanceof AgentsModal)) throw new Error("expected the agents modal overlay");
	return overlay;
}

const GRAPH = {
  revision: 7,
  counts: { totalAgents: 2, nonTerminalChildren: 1, remainingLifetimeSlots: 2 },
  nodes: [
    { agentId: "agent_root", role: "root", state: "running", usage: { modelTurns: 2, toolCalls: 3, activeDurationMs: 100 } },
    { agentId: "agent_child_live", parentAgentId: "agent_root", role: "research", state: "running", usage: { modelTurns: 1, toolCalls: 2, activeDurationMs: 2000 } },
  ],
};

const TERMINATED = {
  revision: 8,
  counts: { totalAgents: 2, nonTerminalChildren: 0, remainingLifetimeSlots: 2 },
  nodes: [
    { agentId: "agent_root", role: "root", state: "running", usage: { modelTurns: 2, toolCalls: 3, activeDurationMs: 100 } },
    { agentId: "agent_child_live", parentAgentId: "agent_root", role: "research", state: "stopped", reasonCode: "cancelled", usage: { modelTurns: 1, toolCalls: 2, activeDurationMs: 2000 } },
  ],
};

/** /agents 测试用 controller:同时暴露可断言的两个 domain 通道 spy。 */
interface AgentPanelController {
  readonly controller: ContractController;
  readonly query: ReturnType<typeof vi.fn>;
  readonly command: ReturnType<typeof vi.fn>;
}

/** fixture 的 query/command 已包成 SessionDomainResult，这里只返回投影 body。 */
function controllerWith(graph: readonly Record<string, unknown>[]): AgentPanelController {
  let index = 0;
  const query = vi.fn(async () => graph[Math.min(index++, graph.length - 1)]);
  const command = vi.fn(async () => ({ report: { outcome: "stopped" } }));
  const controller = new ContractController({
    supportedOperations: ["agent.inspect", "agent.cancel"],
    querySessionDomain: query,
    commandSessionDomain: command,
  });
  return { controller, query, command };
}

async function withMode(controller: ContractController, run: (mode: InteractiveMode) => Promise<void>): Promise<void> {
  const mode = new InteractiveMode({ controller, terminal: new ContractTerminal(100, 30) });
  const running = mode.run();
  try {
    await settleFrames();
    await run(mode);
  } finally {
    mode.quit();
    await running;
  }
}

describe("TUI /agents panel wiring", () => {
  it("registers /agents against the negotiated agent.inspect operation", () => {
    expect(findCommand("agents")).toMatchObject({
      canonicalName: "agents",
      actionType: "agent.inspect",
      category: "agents",
      requiredOperation: "agent.inspect",
      availableDuringTask: true,
    });
  });

  it("opens the child panel from the inspected graph and lists non-root children only", async () => {
    const { controller, query } = controllerWith([GRAPH]);
    await withMode(controller, async (mode) => {
      await internals(mode).agentWorkflow.openAgentsPanel();
      await settleFrames();
      const rendered = overlayOf(mode).render(120).join("\n");
      expect(rendered).toContain("/agents (1)");
      expect(rendered).toContain("agent_child_live");
      expect(rendered).not.toContain("agent_root");
      expect(query).toHaveBeenCalledWith("agent.inspect", {}, expect.objectContaining({ correlationId: expect.any(String), effectId: expect.any(String) }));
    });
  });

  it("cancels the selected child with the inspected graph revision and refreshes from the domain", async () => {
    const { controller, command } = controllerWith([GRAPH, TERMINATED]);
    await withMode(controller, async (mode) => {
      await internals(mode).agentWorkflow.openAgentsPanel();
      await settleFrames();
      overlayOf(mode).handleInput("x");
      await settleFrames();
      expect(command).toHaveBeenCalledWith(
        "agent.cancel",
        { agentId: "agent_child_live" },
        expect.objectContaining({ expectedRevision: 7 }),
      );
      // 取消后按域返回的权威状态重绘,而不是本地推断。
      expect(overlayOf(mode).render(120).join("\n")).toContain("stopped");
      expect(notices(mode)).toContain("cancelled");
    });
  });

  it("reports unavailability instead of querying when the Session does not negotiate agent.inspect", async () => {
    const query = vi.fn(async () => ({}));
    const controller = new ContractController({ supportedOperations: [], querySessionDomain: query });
    await withMode(controller, async (mode) => {
      expect(mode.getTuiState().capabilities.agents.state).toBe("unavailable");
      await internals(mode).agentWorkflow.openAgentsPanel();
      expect(notices(mode)).toContain("unavailable in this session");
      expect(query).not.toHaveBeenCalled();
    });
  });
});
