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
		if (flags.length > 1 || flags.some((flag) => flag !== "--strategy=single-pass" && flag !== "--strategy=hierarchical" && flag !== "--strategy=handoff" && flag !== "--strategy=openai-responses-native")) {
			this.port.showNotice("Usage: /compact [--strategy=single-pass|hierarchical|handoff|openai-responses-native] [focus]", "error"); return;
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
		const state = result?.ok === true ? result.value.state : undefined;
		const content = result?.ok === true && typeof result.value.content === "string" ? result.value.content : undefined;
		if (state === undefined || !isValidPlanModeState(state) || (content === undefined && state.status !== "inactive")) {
			port.showNotice("/plan review is unavailable; refresh after reconnecting.", "error"); return;
		}
		// 固定短行分页，保证常见窄终端能够逐页审阅，不以截断摘要代替正文。
		const lines = (content ?? "No plan yet. Enter plan mode to explore and write one.").replace(/[\x00-\x08\x0b-\x1f\x7f]/gu, "�").split("\n").flatMap((line) => {
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
				if (state.status === "inactive") {
					items.push({ value: "plan.enter", name: "Enter plan mode" });
				}
				if (state.status === "active") {
					items.push({ value: "plan.request_approval", name: "Request approval", disabled: state.plan?.revision === 0 });
					items.push({ value: "plan.exit", name: "Exit plan mode" });
				}
				if (state.status === "awaiting_approval") {
					items.push({ value: "approve", name: "Approve and implement here" });
					items.push({ value: "approve_compact", name: "Approve, compact, then implement" });
					items.push({ value: "approve_fresh", name: "Approve as a fresh session" });
					items.push({ value: "changes_requested", name: "Request changes" });
					items.push({ value: "reject", name: "Reject this revision" });
				}
				if (state.status === "exit_pending") items.push({ value: "plan.settle_exit", name: "Finish plan workflow" });
				if (state.status === "inactive" || state.status === "active" || state.status === "awaiting_approval") {
					items.push({ value: "plan.export", name: "Export plan to <home>/plans" });
				}
			}
			if (state.status === "active" || state.status === "awaiting_approval") items.push({ value: "plan.cancel", name: "Cancel plan workflow" });
			items.push({ value: "close", name: "Close" });
			port.showOverlayModal(new SecondarySelectionView({
				title: `Plan · ${state.status} · ${page + 1}/${pages}`,
				subtitle: `rev ${state.plan?.revision ?? 0} · ${state.plan?.digest.digest.slice(0, 12) ?? "unavailable"}`,
				detailLines: lines.slice(page * 4, page * 4 + 4), items,
				footerHint: "Plan mode is read-only. Approving keeps this session; /mode default starts a separate implementation session.",
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
		// 三条实施路径共用同一审批：批准 → 结束工作流 → 提交实施轮。
		// 差异只在实施轮进入哪个上下文（本会话 / 先压缩 / 新会话）。
		const approvalMode = action === "approve" ? "here" : action === "approve_compact" ? "compact" : action === "approve_fresh" ? "fresh" : undefined;
		if (approvalMode !== undefined) {
			await this.approveAndImplement(approvalMode, state);
			return;
		}
		const resolving = action === "reject" || action === "changes_requested";
		const operation = resolving ? "plan.resolve_approval" : action;
		const body: Record<string, unknown> = { expectedRevision: state.revision };
		if (resolving || action === "plan.request_approval") {
			body.expectedPlanRevision = state.plan?.revision; body.expectedPlanDigest = state.plan?.digest;
		}
		if (resolving) { body.approvalId = state.approval?.approvalId; body.decision = action; }
		await this.runDomainCommand(operation, body, "/plan", false);
		// 要求修改后的意见由用户下一条消息承载，不在此处代写正文。
		if (action === "changes_requested") {
			this.port.showNotice("Plan mode is active again. Send your change requests as a normal message.", "note");
		}
		await this.openPlanWorkflow();
	}

	/**
	 * 批准后按选定路径进入实施。批准绑定当前 revision/digest；
	 * fresh 路径走 plan.handoff 创建实施会话，here/compact 留在原会话并在
	 * settle_exit 后把已批准正文作为实施轮提交。
	 */
	private async approveAndImplement(mode: "here" | "compact" | "fresh", state: PlanModeState): Promise<void> {
		const port = this.port;
		const approved = await commandSessionController(port.controller, "plan.resolve_approval", {
			expectedRevision: state.revision,
			expectedPlanRevision: state.plan?.revision,
			expectedPlanDigest: state.plan?.digest,
			approvalId: state.approval?.approvalId,
			decision: "approved",
		}, {
			correlationId: `corr-${port.nextCorrelationId()}`, effectId: `effect-${port.nextEffectId()}`, expectedRevision: state.revision,
		}).catch(() => undefined);
		if (approved?.ok !== true || !isValidPlanModeState(approved.value.state)) {
			port.showNotice(`/plan approval failed: ${approved?.ok === false ? approved.code : "unavailable"}`, "error");
			return;
		}
		const approvedState = approved.value.state;
		const planBody = typeof approved.value.content === "string" ? approved.value.content : undefined;
		const settle = await commandSessionController(port.controller, "plan.settle_exit", { expectedRevision: approvedState.revision }, {
			correlationId: `corr-${port.nextCorrelationId()}`, effectId: `effect-${port.nextEffectId()}`, expectedRevision: approvedState.revision,
		}).catch(() => undefined);
		if (settle?.ok !== true) {
			port.showNotice(`/plan exit failed: ${settle?.ok === false ? settle.code : "unavailable"}`, "error");
			return;
		}
		if (mode === "fresh") {
			const handoff = await commandSessionController(port.controller, "plan.handoff", { expectedRevision: approvedState.revision }, {
				correlationId: `corr-${port.nextCorrelationId()}`, effectId: `effect-${port.nextEffectId()}`, expectedRevision: approvedState.revision,
			}).catch(() => undefined);
			port.showNotice(handoff?.ok === true
				? "Approved plan handed off. Open the new session to implement it (mode: default)."
				: `Approved plan handoff failed: ${handoff?.ok === false ? handoff.code : "unavailable"}`, handoff?.ok === true ? "note" : "error");
			return;
		}
		if (mode === "compact") {
			await this.runCompaction("");
		}
		// 实施轮只带已批准正文；历史与其余上下文由当前会话自然携带。
		if (planBody === undefined) {
			port.showNotice("Approved, but the plan body is unavailable; run /plan to review it before implementing.", "error");
			return;
		}
		port.showNotice("Approved. Starting the implementation turn with the approved plan.", "note");
		port.echoPrompt(`Implement the approved plan exactly as written, top to bottom.\n\n<approved-plan revision="${state.plan?.revision ?? 0}">\n${planBody}\n</approved-plan>`);
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
