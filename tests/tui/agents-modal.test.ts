/**
 * AgentsModal 单元测试 —— /agents 面板的行渲染、取消门控与刷新。
 *
 * 只断言用户可见行为:行内容来自 typed view、终态 child 不可取消、
 * update 保持选中、缺失 usage 显示 unknown 而不是 0。
 */

import { describe, expect, it, vi } from "vitest";
import { AgentsModal } from "../../src/tui/components/agents-modal.ts";
import type { AgentActivityCounts, AgentNodeView } from "../../src/tui/agents/types.ts";

const counts: AgentActivityCounts = {
	totalAgents: { state: "known", value: 2 },
	nonTerminalChildren: { state: "known", value: 1 },
	remainingLifetimeSlots: { state: "known", value: 2 },
};

function agent(overrides: Partial<AgentNodeView> = {}): AgentNodeView {
	return {
		agentId: "agent_child_alpha",
		role: "research",
		state: "running",
		parentAgentId: "agent_root",
		usage: {
			modelTurns: { state: "known", value: 3 },
			toolCalls: { state: "known", value: 5 },
			activeDurationMs: { state: "known", value: 1500 },
		},
		...overrides,
	};
}

function modal(agents: readonly AgentNodeView[], overrides: Partial<ConstructorParameters<typeof AgentsModal>[0]> = {}) {
	return new AgentsModal({
		title: `/agents (${agents.length})`,
		counts,
		agents,
		onCancelAgent: () => undefined,
		onRefresh: () => undefined,
		onClose: () => undefined,
		...overrides,
	});
}

describe("AgentsModal", () => {
	it("renders one bounded row per child with state, usage, and graph counts", () => {
		const lines = modal([agent(), agent({ agentId: "agent_child_beta", role: "review", state: "completed" })]).render(120).join("\n");
		expect(lines).toContain("/agents (2)");
		expect(lines).toContain("total 2 · active 1 · free slots 2");
		expect(lines).toContain("agent_child_alpha");
		expect(lines).toContain("running");
		expect(lines).toContain("3 turns · 5 tools · 1.5s");
		expect(lines).toContain("agent_child_beta");
	});

	it("keeps unknown usage visible instead of rendering a zero sentinel", () => {
		const lines = modal([agent({
			usage: {
				modelTurns: { state: "unknown", reason: "not-reported" },
				toolCalls: { state: "known", value: 0 },
				activeDurationMs: { state: "unknown", reason: "not-reported" },
			},
		})]).render(120).join("\n");
		expect(lines).toContain("unknown turns · 0 tools · unknown");
	});

	it("renders an explicit empty state when no child was delegated", () => {
		const lines = modal([]).render(100).join("\n");
		expect(lines).toContain("No child agents have been delegated in this Session.");
	});

	it("cancels only non-terminal children and ignores x on a terminal row", () => {
		const onCancelAgent = vi.fn();
		const live = modal([agent()], { onCancelAgent });
		live.handleInput("x");
		expect(onCancelAgent).toHaveBeenCalledTimes(1);
		expect(onCancelAgent.mock.calls[0]?.[0]).toMatchObject({ agentId: "agent_child_alpha" });

		const done = modal([agent({ state: "completed" })], { onCancelAgent });
		done.handleInput("x");
		expect(onCancelAgent).toHaveBeenCalledTimes(1);
	});

	it("details the selected child and keeps selection across a refresh", () => {
		const first = agent();
		const second = agent({ agentId: "agent_child_beta", state: "completed", reasonCode: { text: "budget_exhausted", truncated: false, byteLength: 16 } });
		const view = modal([first, second]);
		view.handleInput("\x1b[B");
		view.handleInput("\r");
		const detail = view.render(120).join("\n");
		expect(detail).toContain("agentId  agent_child_beta");
		expect(detail).toContain("budget_exhausted");
		expect(detail).toContain("This child is terminal");

		view.update([first, second], counts);
		view.handleInput("\x1b");
		expect(view.render(120).join("\n")).toContain("Enter to inspect");
	});

	it("refreshes on r and closes on escape from the list", () => {
		const onRefresh = vi.fn();
		const onClose = vi.fn();
		const view = modal([agent()], { onRefresh, onClose });
		view.handleInput("r");
		expect(onRefresh).toHaveBeenCalledTimes(1);
		view.handleInput("\x1b");
		expect(onClose).toHaveBeenCalledTimes(1);
	});
});
