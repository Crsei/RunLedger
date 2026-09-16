/**
 * AgentsModal —— 有界 child Agent 面板(/agents)。
 *
 * 对照 codex 的二级列表形态(标题 + 副标题 + 列表 + footer hint):
 *   - 行:`› ● Id ⟨role⟩  state  turns/tools/duration`,state 用固定字形;
 *   - Enter 展开单个 child 的完整 agentId、父 identity、usage 与 terminal reason;
 *   - x 取消选中 child(经 Session domain 的 agent.cancel),root 不在列表中;
 *   - r 重新查询;Esc 关闭(详情页 Esc 返回列表);
 *   - update(agents, counts) 供取消或刷新后外部替换内容。
 *
 * 组件只消费已投影的 typed view,不读 graph、不解析 raw domain 响应。
 */

import type { Component } from "../primitives.ts";
import { matchesKey } from "../primitives.ts";
import { wrapBold, wrapDim } from "../theme/ansi.ts";
import { fitLinesToWidth, fitToWidth } from "./render-width.ts";
import type { SafeCount } from "../presentation/tools/types.ts";
import type { AgentActivityCounts, AgentNodeState, AgentNodeView } from "../agents/types.ts";

export interface AgentsModalProps {
	readonly title: string;
	readonly counts: AgentActivityCounts;
	readonly agents: readonly AgentNodeView[];
	readonly maxVisible?: number;
	readonly onCancelAgent: (agent: AgentNodeView) => void;
	readonly onRefresh: () => void;
	readonly onClose: () => void;
}

const DEFAULT_MAX_VISIBLE = 8;

/** 只有非终态 child 可以取消；静态字符串键查表用 Record,不用 Set。 */
const CANCELLABLE_STATE: Readonly<Partial<Record<AgentNodeState, true>>> = Object.freeze({
	requested: true,
	prepared: true,
	running: true,
	recovery_required: true,
});

export class AgentsModal implements Component {
	private readonly props: AgentsModalProps;
	private agents: readonly AgentNodeView[];
	private counts: AgentActivityCounts;
	private selectedIndex = 0;
	private expanded: AgentNodeView | undefined;

	constructor(props: AgentsModalProps) {
		this.props = props;
		this.agents = props.agents;
		this.counts = props.counts;
		this.expanded = undefined;
	}

	/** 取消或刷新后外部替换内容;保持当前选中 agentId 与展开态。 */
	update(agents: readonly AgentNodeView[], counts: AgentActivityCounts): void {
		const previousId = this.expanded?.agentId;
		this.agents = agents;
		this.counts = counts;
		this.expanded = previousId === undefined ? undefined : agents.find((agent) => agent.agentId === previousId);
		if (this.agents.length === 0) {
			this.selectedIndex = 0;
			return;
		}
		this.selectedIndex = Math.min(this.selectedIndex, this.agents.length - 1);
	}

	invalidate(): void {
		// 无缓存。
	}

	handleInput(data: string): void {
		if (matchesKey(data, "up")) {
			this.move(-1);
			return;
		}
		if (matchesKey(data, "down")) {
			this.move(1);
			return;
		}
		if (matchesKey(data, "pageUp")) {
			this.move(-(this.props.maxVisible ?? DEFAULT_MAX_VISIBLE));
			return;
		}
		if (matchesKey(data, "pageDown")) {
			this.move(this.props.maxVisible ?? DEFAULT_MAX_VISIBLE);
			return;
		}
		if (matchesKey(data, "enter")) {
			const selected = this.agents[this.selectedIndex];
			if (selected !== undefined) this.expanded = this.expanded?.agentId === selected.agentId ? undefined : selected;
			return;
		}
		if (matchesKey(data, "x")) {
			const selected = this.agents[this.selectedIndex];
			if (selected !== undefined && CANCELLABLE_STATE[selected.state] === true) this.props.onCancelAgent(selected);
			return;
		}
		if (matchesKey(data, "r")) {
			this.props.onRefresh();
			return;
		}
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			if (this.expanded !== undefined) {
				this.expanded = undefined;
				return;
			}
			this.props.onClose();
		}
	}

	render(width: number): string[] {
		const lines: string[] = [
			wrapBold(this.props.title),
			wrapDim(`total ${formatCount(this.counts.totalAgents)} · active ${formatCount(this.counts.nonTerminalChildren)} · free slots ${formatCount(this.counts.remainingLifetimeSlots)}`),
		];
		if (this.agents.length === 0) {
			lines.push("", wrapDim("No child agents have been delegated in this Session."));
			lines.push(wrapDim("Esc to close"));
			return fitLinesToWidth(lines, width);
		}
		if (this.expanded !== undefined) {
			lines.push(...this.renderDetail(this.expanded, width));
		} else {
			lines.push("");
			lines.push(...this.renderRows(width));
		}
		lines.push(wrapDim(this.expanded === undefined
			? "Enter to inspect; x to cancel a live child; r to refresh; Esc to close"
			: "Esc to go back"));
		return fitLinesToWidth(lines, width);
	}

	private renderRows(width: number): string[] {
		const maxVisible = this.props.maxVisible ?? DEFAULT_MAX_VISIBLE;
		const start = Math.max(0, Math.min(
			this.selectedIndex - Math.floor(maxVisible / 2),
			Math.max(0, this.agents.length - maxVisible),
		));
		return this.agents.slice(start, start + maxVisible).map((agent, offset) => {
			const selected = start + offset === this.selectedIndex;
			const prefix = selected ? "› " : "  ";
			const summary = `${agent.state}  ${formatCount(agent.usage.modelTurns)} turns · ${formatCount(agent.usage.toolCalls)} tools · ${formatDuration(agent.usage.activeDurationMs)}`;
			// 与 /mcp 列表一致：整行交给 fitToWidth 截断，不为超长 agentId 单独做列宽计算。
			return fitToWidth(`${prefix}${stateGlyph(agent.state)} ${agent.agentId} ⟨${agent.role}⟩  ${wrapDim(summary)}`, width);
		});
	}

	private renderDetail(agent: AgentNodeView, width: number): string[] {
		const lines: string[] = [
			"",
			wrapDim(`agentId  ${agent.agentId}`),
			wrapDim(`parent   ${agent.parentAgentId ?? "root"}`),
			wrapDim(`state    ${agent.state}${agent.reasonCode === undefined ? "" : ` · ${agent.reasonCode.text}`}`),
			wrapDim(`usage    ${formatCount(agent.usage.modelTurns)} model turns · ${formatCount(agent.usage.toolCalls)} tool calls · ${formatDuration(agent.usage.activeDurationMs)}`),
			wrapDim(`report   ${agent.reportBytes === undefined ? "not reported" : `${formatCount(agent.reportBytes)} bytes`}`),
		];
		// 只有非终态 child 可以取消;终态行给出明确原因而不是静默无响应。
		lines.push("", wrapDim(CANCELLABLE_STATE[agent.state] === true
			? "Press x to cancel this child; Esc to go back"
			: "This child is terminal; Esc to go back"));
		return lines;
	}

	private move(delta: number): void {
		if (this.agents.length === 0) return;
		this.selectedIndex = Math.min(Math.max(0, this.selectedIndex + delta), this.agents.length - 1);
	}
}

function stateGlyph(state: AgentNodeState): string {
	switch (state) {
		case "requested": return "○";
		case "prepared": return "◐";
		case "running": return "●";
		case "completed": return "✓";
		case "failed": return "✗";
		case "stopped": return "■";
		case "recovery_required": return "!";
		case "unknown": return "?";
	}
}

/** 缺失的用量保持 "unknown",不由空值推断为 0。 */
function formatCount(value: SafeCount): string {
	return value.state === "known" ? String(value.value) : "unknown";
}

function formatDuration(value: SafeCount): string {
	if (value.state !== "known") return "unknown";
	const seconds = value.value / 1000;
	return seconds < 10 ? `${seconds.toFixed(1)}s` : `${Math.round(seconds)}s`;
}
