/**
 * S7 拆分:plan workflow 与 domain command adapter。
 */

import { isValidPlanModeState } from "../../runtime/modes/plan/reducer.ts";
import type { PlanModeState } from "../../runtime/modes/plan/types.ts";
import { SecondarySelectionView, type SecondarySelectionItem } from "../components/list-selection-modal.ts";
import { makeSelectListTheme } from "../theme/factories.ts";
import { querySessionController, commandSessionController } from "../adapters/session-domain.ts";
import { unavailableCommandMessage } from "../commands/registry.ts";
import type { InteractiveModePorts } from "./types.ts";

export class PlanWorkflow {
	private readonly port: InteractiveModePorts;

	public constructor(port: InteractiveModePorts) {
		this.port = port;
	}

	public async runCompaction(arg: string): Promise<void> {
		const parts = arg.trim().split(/\s+/u).filter(Boolean);
		const flags = parts.filter((part) => part.startsWith("--"));
		if (flags.length > 1 || flags.some((flag) => flag !== "--strategy=single-pass" && flag !== "--strategy=hierarchical" && flag !== "--strategy=openai-responses-native")) {
			this.port.showNotice("Usage: /compact [--strategy=single-pass|hierarchical|openai-responses-native] [focus]", "error"); return;
		}
		const inspection = await querySessionController(this.port.controller, "compaction.list", {}, {
			correlationId: `corr-${this.port.nextCorrelationId()}`, effectId: `effect-${this.port.nextEffectId()}`,
		}).catch(() => undefined);
		if (inspection?.ok !== true) { this.port.showNotice("Compaction is unavailable in this Session.", "error"); return; }
		const focus = parts.filter((part) => !part.startsWith("--")).join(" ");
		this.port.showNotice("Compacting older history…", "note");
		await this.runDomainCommand("compact.run", {
			expectedRevision: inspection.domainRevision,
			...(flags[0] === undefined ? {} : { strategy: flags[0].slice("--strategy=".length) }),
			...(focus.length === 0 ? {} : { focus }),
		}, "/compact", false);
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
		if (port.controller?.supports?.("plan.request_approval") === true) {
			await this.openApprovalReview();
			return;
		}
		const effect = port.createEffect("plan.inspect");
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

	/** 审阅固定快照的全部正文；提交时绑定 revision、digest 与 approvalId。 */
	private async openApprovalReview(): Promise<void> {
		const port = this.port;
		const result = await querySessionController(port.controller, "plan.inspect", {}, {
			correlationId: `corr-${port.nextCorrelationId()}`, effectId: `effect-${port.nextEffectId()}`,
		}).catch(() => undefined);
		if (result?.ok !== true || !isValidPlanModeState(result.value.state) || typeof result.value.content !== "string") {
			port.showNotice("/plan review is unavailable; refresh after reconnecting.", "error"); return;
		}
		const state = result.value.state;
		// 固定短行分页，保证常见窄终端能够逐页审阅，不以截断摘要代替正文。
		const lines = result.value.content.replace(/[\x00-\x08\x0b-\x1f\x7f]/gu, "�").split("\n").flatMap((line) => {
			const chars = Array.from(line); const chunks: string[] = [];
			for (let index = 0; index < chars.length; index += 24) chunks.push(chars.slice(index, index + 24).join(""));
			return chunks.length === 0 ? [""] : chunks;
		});
		const pages = Math.max(1, Math.ceil(lines.length / 4));
		const show = (page: number): void => {
			const items: SecondarySelectionItem[] = [];
			if (page < pages - 1) items.push({ value: "next", name: "Next page" });
			if (page > 0) items.push({ value: "previous", name: "Previous page" });
			if (page === pages - 1) {
				if (state.status === "active") items.push({ value: "plan.request_approval", name: "Request approval", disabled: state.plan?.revision === 0 });
				if (state.status === "awaiting_approval") items.push({ value: "approve", name: "Approve this revision" }, { value: "reject", name: "Reject this revision" });
				if (state.status === "exit_pending") items.push({ value: "plan.settle_exit", name: "Finish plan workflow" });
			}
			if (state.status === "active" || state.status === "awaiting_approval") items.push({ value: "plan.cancel", name: "Cancel plan workflow" });
			items.push({ value: "close", name: "Close" });
			port.showOverlayModal(new SecondarySelectionView({
				title: `Plan · ${state.status} · ${page + 1}/${pages}`,
				subtitle: `rev ${state.plan?.revision ?? 0} · ${state.plan?.digest.digest.slice(0, 12) ?? "unavailable"}`,
				detailLines: lines.slice(page * 4, page * 4 + 4), items,
				footerHint: "Plan mode remains read-only. /mode default creates a new session.",
				selectListTheme: makeSelectListTheme(port.theme),
				onCancel: () => port.closeOverlay(),
				onSelect: (item) => {
					port.closeOverlay();
					if (item.value === "next") show(page + 1);
					else if (item.value === "previous") show(page - 1);
					else if (item.value !== "close") void this.resolveReview(item.value, state);
				},
			}), { anchor: "bottom-left" });
		};
		show(0);
	}

	private async resolveReview(action: string, state: PlanModeState): Promise<void> {
		const resolving = action === "approve" || action === "reject";
		const operation = resolving ? "plan.resolve_approval" : action;
		const body: Record<string, unknown> = { expectedRevision: state.revision };
		if (resolving || action === "plan.request_approval") {
			body.expectedPlanRevision = state.plan?.revision; body.expectedPlanDigest = state.plan?.digest;
		}
		if (resolving) { body.approvalId = state.approval?.approvalId; body.decision = action === "approve" ? "approved" : "rejected"; }
		await this.runDomainCommand(operation, body, "/plan", false);
		await this.openPlanWorkflow();
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
			port.showNotice(result.code === "operation_unavailable"
				? unavailableCommandMessage(commandName)
				: `${commandName} failed: ${result.code}`, "error");
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
		case "compact.run": return `estimated input ${String(body.beforeTokens)} → ${String(body.afterTokens)} tokens; original history preserved`;
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
