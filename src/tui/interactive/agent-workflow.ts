/**
 * S7 拆分:agent workflow —— 有界 child Agent 的只读面板与取消。
 *
 * 查询走 `agent.inspect` effect workflow(typed adapter 投影,不解析 raw
 * domain 响应);取消走 Session domain 的 `agent.cancel` mutation。
 *
 * 取消不经过 `runSessionMutation` 的 idle 门控:root turn 阻塞在
 * `spawn_agent` 上时 child 才是活的,idle 门控会让面板永远无法取消。
 * driver、manifest、expectedRevision 与 recovery barrier 仍由 Session
 * domain 自己强制,这里不重复实现权限判定。
 */

import type { AgentActivityCounts, AgentNodeView } from "../agents/types.ts";
import { AgentsModal } from "../components/agents-modal.ts";
import { commandSessionController } from "../adapters/session-domain.ts";
import type { InteractiveModePorts } from "./types.ts";

/** 面板一次渲染所需的完整投影；revision 同时是 cancel 的 expectedRevision。 */
interface AgentPanelSnapshot {
	readonly revision: number;
	readonly counts: AgentActivityCounts;
	readonly agents: readonly AgentNodeView[];
}

export class AgentWorkflow {
	private readonly port: InteractiveModePorts;

	public constructor(port: InteractiveModePorts) {
		this.port = port;
	}

	/** `/agents`:列出当前 Session 的 child Agent,支持刷新与取消。 */
	public async openAgentsPanel(): Promise<void> {
		const port = this.port;
		if (port.store.getState().capabilities.agents.state !== "available") {
			port.showNotice("Bounded subagent activity is unavailable in this session.", "error");
			return;
		}
		const snapshot = await this.inspect();
		if (snapshot === undefined) return;
		let modal: AgentsModal | undefined;
		modal = new AgentsModal({
			title: `/agents (${snapshot.agents.length})`,
			counts: snapshot.counts,
			agents: snapshot.agents,
			onCancelAgent: (agent) => {
				void this.cancelAgent(agent, snapshot.revision, modal);
			},
			onRefresh: () => {
				void this.refresh(modal);
			},
			onClose: () => port.closeOverlay(),
		});
		port.showOverlayModal(modal, { anchor: "bottom-left" });
	}

	private async refresh(modal: AgentsModal | undefined): Promise<void> {
		if (modal === undefined) return;
		const snapshot = await this.inspect();
		if (snapshot === undefined) return;
		modal.update(snapshot.agents, snapshot.counts);
		this.port.uiRequestRender();
	}

	/** 取消绑定面板展示的那次 graph revision,不再额外查询一次。 */
	private async cancelAgent(agent: AgentNodeView, revision: number, modal: AgentsModal | undefined): Promise<void> {
		const port = this.port;
		const result = await commandSessionController(port.controller, "agent.cancel", { agentId: agent.agentId }, {
			correlationId: `corr-${port.nextCorrelationId()}`,
			effectId: `effect-${port.nextEffectId()}`,
			expectedRevision: revision,
		}).catch((error: unknown) => {
			port.showNotice(`/agents cancel failed: ${String(error)}`, "error");
			return undefined;
		});
		if (result === undefined) return;
		if (!result.ok) {
			port.showNotice(`/agents cancel failed: ${result.code}`, "error");
			return;
		}
		// cancel 成功即已收束 durable terminal;重新查询以展示权威状态而不是本地推断。
		const fresh = await this.inspect();
		if (fresh === undefined) return;
		if (modal !== undefined) {
			modal.update(fresh.agents, fresh.counts);
			port.uiRequestRender();
		}
		port.showNotice(`/agents: ${agent.agentId} ${terminalSummary(fresh, agent.agentId)}`, "note");
	}

	/**
	 * workflow 对 agent.inspect 不产生 empty(reducer 的 agentWorkflow 分支固定 ready),
	 * 因此这里只处理 ready/error/unavailable。
	 */
	private async inspect(): Promise<AgentPanelSnapshot | undefined> {
		const port = this.port;
		const effect = port.createEffect("agent.inspect");
		port.store.dispatch({ type: "query.start", effect });
		port.runner.dispatch(effect);
		const workflow = await port.waitForWorkflow("agentWorkflow", effect.correlationId);
		if (workflow.state === "ready") {
			const value = workflow.value as { readonly revision?: unknown; readonly counts?: unknown; readonly agents?: unknown };
			if (typeof value.revision !== "number" || !Array.isArray(value.agents) || typeof value.counts !== "object" || value.counts === null) {
				port.showNotice("/agents query returned a malformed projection.", "error");
				return undefined;
			}
			return {
				revision: value.revision,
				counts: value.counts as AgentActivityCounts,
				agents: value.agents as readonly AgentNodeView[],
			};
		}
		if (workflow.state === "error") {
			port.showNotice(`/agents query failed: ${workflow.message}`, "error");
			return undefined;
		}
		port.showNotice(`/agents is unavailable: ${workflow.state === "unavailable" ? workflow.reason : "unknown outcome"}`, "error");
		return undefined;
	}
}

function terminalSummary(snapshot: AgentPanelSnapshot, agentId: string): string {
	const agent = snapshot.agents.find((candidate) => candidate.agentId === agentId);
	if (agent === undefined) return "is no longer present in the agent graph";
	return agent.reasonCode === undefined ? agent.state : `${agent.state} (${agent.reasonCode.text})`;
}
