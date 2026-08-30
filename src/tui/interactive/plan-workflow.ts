/**
 * S7 拆分:plan workflow 与 domain command adapter。
 */

import { querySessionController, commandSessionController } from "../adapters/session-domain.ts";
import type { InteractiveModePorts } from "./types.ts";

export class PlanWorkflow {
	private readonly port: InteractiveModePorts;

	public constructor(port: InteractiveModePorts) {
		this.port = port;
	}

	/** B7:/plan 走 plan.inspect workflow（typed adapter 投影，不再 raw 解析）。 */
	public async openPlanWorkflow(): Promise<void> {
		const port = this.port;
		if (port.store.getState().capabilities.plan.state !== "available") {
			port.showNotice("/plan requires an authenticated Host connection.", "error");
			return;
		}
		if (port.inFlight()) {
			port.showNotice("/plan is available when the current turn is idle.", "note");
			return;
		}
		const effect = port.createEffect("plan.inspect", { planId: "", expectedRevision: 0 });
		port.store.dispatch({ type: "query.start", effect });
		port.runner.dispatch(effect);
		const workflow = await port.waitForWorkflow("planWorkflow", effect.correlationId);
		if (workflow.state === "ready") {
			const view = workflow.value as { readonly reference?: { readonly planId: string; readonly revision: number; readonly digestPrefix: { readonly text: string } }; readonly title: { readonly text: string }; readonly status: string; readonly summary: { readonly text: string } };
			port.showNotice(
				`/plan: ${view.title.text} · ${view.status} · rev=${view.reference?.revision ?? 0}${view.summary.text.length > 0 ? ` · ${view.summary.text}` : ""}`,
			);
			return;
		}
		if (workflow.state === "error") {
			port.showNotice(`/plan failed: ${workflow.message}`, "error");
			return;
		}
		port.showNotice("/plan state is unavailable in this session.", "error");
	}

	/** 执行已协商的 Session domain 命令并把 typed 结果投影成 notice。 */
	public async runDomainCommand(
		operation: string,
		body: Record<string, unknown>,
		commandName: string,
		readOnly: boolean,
	): Promise<void> {
		const port = this.port;
		if (port.inFlight()) {
			port.showNotice(`${commandName} is available when the current turn is idle.`, "note");
			return;
		}
		const effectId = port.nextEffectId();
		const correlationId = port.nextCorrelationId();
		const context = { correlationId: `corr-${correlationId}`, effectId: `effect-${effectId}` };
		const expectedRevision = typeof body.expectedRevision === "number" && Number.isSafeInteger(body.expectedRevision) ? body.expectedRevision : 0;
		const result = await (readOnly
			? querySessionController(port.controller, operation, body, context)
			: commandSessionController(port.controller, operation, body, { ...context, expectedRevision })).catch((error: unknown) => {
			port.showNotice(`${commandName} failed: ${String(error)}`, "error");
			return undefined;
		});
		if (result === undefined) return;
		if (!result.ok) {
			port.showNotice(`${commandName} failed: ${result.code}`, "error");
			return;
		}
		const text = compactDomainResult(operation, result.value);
		port.showNotice(`${commandName}: ${text}`, "note");
	}
}

/** 把 domain 命令结果压缩为单行 notice 文本（只读展示，不解析执行）。 */
function compactDomainResult(operation: string, body: Record<string, unknown>): string {
	if (body.ok === false) {
		return typeof body.code === "string" ? `rejected: ${body.code}` : "rejected";
	}
	const short = (value: unknown, max = 240): string => {
		const text = typeof value === "string" ? value : JSON.stringify(value);
		return text.length > max ? `${text.slice(0, max)}…` : text;
	};
	switch (operation) {
		case "plan.inspect": {
			const state = isRecord(body.state) ? body.state : undefined;
			if (state === undefined) return "no plan state";
			return `status=${String(state.status ?? "?")} revision=${String(state.revision ?? "?")}${state.approval === undefined ? "" : ` approval=${String((state.approval as { status?: string }).status ?? "?")}`}`;
		}
		case "compaction.list": {
			const checkpoints = Array.isArray(body.checkpoints) ? body.checkpoints : [];
			return `checkpoints=${checkpoints.length}${checkpoints.length === 0 ? "" : ` latest=${String((checkpoints.at(-1) as { status?: string } | undefined)?.status ?? "?")}`}`;
		}
		case "memory.inspect": {
			const memory = isRecord(body.memory) ? body.memory : undefined;
			if (memory === undefined) return "no memory state";
			return `records=${String(memory.recordCount ?? "?")} proposals=${String(memory.proposalCount ?? "?")} generation=${String(memory.generation ?? "?")}`;
		}
		case "memory.propose": {
			const proposal = isRecord(body.proposal) ? body.proposal : undefined;
			return proposal === undefined ? "proposal created" : `proposal ${String(proposal.proposalId ?? "?")} pending approval`;
		}
		default:
			return short(body);
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
