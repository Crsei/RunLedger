import { AGENT_MODES, agentModeIdentityPresentation, isAgentMode, resolveAgentMode } from "../../runtime/harness-profiles/agent-mode.ts";
import { sanitizeLabel } from "../presentation/projectors.ts";
import { SecondarySelectionView } from "../components/list-selection-modal.ts";
import { makeSelectListTheme } from "../theme/factories.ts";
/**
 * S7 拆分:session workflow —— new/resume/fork/rename/catalog。
 *
 * 所有会话切换/改名经 typed Session Domain effect workflow 与 catalog CAS;
 * 不直接调用 controller 的 mutable session 操作。
 */

import { normalizeSessionTitle } from "../../runtime/session-owner/title.ts";
import { SessionPickerModal, buildSessionPickerItems, formatRelativeTime } from "../components/session-picker-modal.ts";
import { WELCOME_SESSION_SLOTS } from "../components/welcome.ts";
import { isSessionCatalogResult, isSessionTitleResult, type SessionCatalogResult, type SessionTransitionResult } from "../sessions/types.ts";
import type { InteractiveModePorts } from "./types.ts";

export class SessionWorkflow {
	private readonly port: InteractiveModePorts;

	public constructor(port: InteractiveModePorts) {
		this.port = port;
	}

	/** 不修改既有 profile；所有入口复用 catalog CAS 与 session.create。 */
	public async switchAgentMode(requestedMode?: string): Promise<void> {
		const requested = requestedMode?.trim();
		if (requested !== undefined && requested !== "" && !isAgentMode(requested)) {
			this.port.showNotice("Usage: /mode [default|minimal|plan]", "error");
			return;
		}
		if (this.rejectSessionTransition()) return;
		if (this.port.refs.editor.getText().trim() !== "") {
			this.port.showNotice("Agent mode creates a new Session. Submit or clear the current draft first; your draft is preserved.", "note");
			return;
		}
		const catalog = await this.loadSessionCatalog();
		if (catalog === undefined) return;
		const current = catalog.items.find((item) => item.current && item.sessionId === this.port.getSessionId());
		if (current === undefined) {
			this.port.showNotice("Current Session is missing from the canonical catalog.", "error");
			return;
		}
		if (requested === undefined || requested === "") {
			const presentation = agentModeIdentityPresentation({ id: current.harnessProfileId, version: current.harnessProfileVersion });
			const modal = new SecondarySelectionView({
				title: "Select agent mode",
				subtitle: `Current: ${presentation?.mode ?? "unavailable"} (${current.harnessProfileId}@${current.harnessProfileVersion}). Creates a new Session; this Session remains resumable.`,
				items: [...AGENT_MODES.map((mode) => {
					const target = resolveAgentMode(mode);
					return {
						value: mode, name: mode,
						description: !target.ok ? "Unavailable" : mode === "default" ? "Standard toolset (subject to policy)" : mode === "minimal" ? "Shell-only primitive toolset" : "Read/analyze; write only the plan artifact",
						isCurrent: target.ok && target.ref.id === current.harnessProfileId && target.ref.version === current.harnessProfileVersion,
					};
				}), { value: "tools", name: "Current tools", description: "Inspect the effective model-visible tool table" }],
				selectListTheme: makeSelectListTheme(this.port.theme),
				onSelect: (item) => { this.port.closeOverlay(); if (item.value === "tools") this.showCurrentTools(); else void this.switchAgentMode(item.value); },
				onCancel: () => this.port.closeOverlay(),
			});
			this.port.showOverlayModal(modal, { anchor: "bottom-left" }, "session");
			return;
		}
		const target = resolveAgentMode(requested);
		if (!target.ok) { this.port.showNotice(`Agent mode unavailable: ${target.code}`, "error"); return; }
		if (target.ref.id === current.harnessProfileId && target.ref.version === current.harnessProfileVersion) {
			this.port.showNotice(`Mode ${requested} is already current (${target.ref.id}@${target.ref.version}).`);
			return;
		}
		this.port.showNotice(`Creating a new ${requested} Session. Current Session can be resumed.`);
		const transition = await this.runSessionTransition("session.create", { expectedRevision: catalog.revision, agentMode: requested });
		if (transition !== undefined) await this.port.requestExit({ kind: "switch", action: "new", target: { sessionId: transition.targetSessionId } });
	}

	private showCurrentTools(): void {
		const names = this.port.getHarnessToolNames?.();
		this.port.showOverlayModal(new SecondarySelectionView({
			title: "Current model tools",
			subtitle: names === undefined ? "Effective tool table is unavailable on this connection." : `${names.length} tools from the current Session composition`,
			items: (names ?? []).map((name) => ({ value: name, name: sanitizeLabel(name, 256) })),
			selectListTheme: makeSelectListTheme(this.port.theme),
			footerHint: "Arrow keys to browse; Esc to return",
			onSelect: () => undefined,
			onCancel: () => { this.port.closeOverlay(); void this.switchAgentMode(); },
		}), { anchor: "bottom-left" }, "session");
	}

	/** S2:/resume 从 SQLite authority 拉取 catalog，不读取旧 JSONL selector。 */
	public async openSessionCatalog(): Promise<void> {
		const catalog = await this.loadSessionCatalog();
		if (catalog === undefined) return;
		if (catalog.items.length === 0) {
			this.port.showNotice("No canonical sessions are available.", "error");
			return;
		}
		const current = catalog.items.find((item) => item.current);
		const modal = new SessionPickerModal({
			title: "/resume",
			items: buildSessionPickerItems(catalog.items, Date.now()),
			currentWorkspaceId: current?.workspaceId,
			onSelect: (item) => {
				this.port.closeOverlay();
				const selected = catalog.items.find((candidate) => candidate.sessionId === item.value);
				if (selected === undefined) return;
				if (selected.current) {
					this.port.showNotice(`${selected.sessionId} is already current.`);
					return;
				}
				void this.resumeSession(selected.sessionId, catalog.revision);
			},
			onCancel: () => this.port.closeOverlay(),
		});
		this.port.showOverlayModal(modal, { anchor: "bottom-left" }, "session");
	}

	/** S2:/new 使用刚读取的 catalog revision 做 CAS，成功后只返回 switch intent。 */
	public async createNewSession(requestedProfile?: string): Promise<void> {
		if (this.rejectSessionTransition()) return;
		const profile = requestedProfile?.trim();
		if (profile !== undefined && profile !== "" && profile !== "standard" && profile !== "minimal") {
			this.port.showNotice("Usage: /new [standard|minimal]", "error");
			return;
		}
		const catalog = await this.loadSessionCatalog();
		if (catalog === undefined) return;
		const transition = await this.runSessionTransition("session.create", {
			expectedRevision: catalog.revision,
			...(profile === undefined || profile === "" ? {} : { harnessProfileId: profile }),
		});
		if (transition !== undefined) await this.port.requestExit({ kind: "switch", action: "new", target: { sessionId: transition.targetSessionId } });
	}

	/** S2:/resume [sessionId]；无参数时复用 canonical catalog selector。 */
	public async resumeSession(targetSessionId?: string, knownRevision?: number): Promise<void> {
		if (this.rejectSessionTransition()) return;
		if (targetSessionId === undefined) {
			await this.openSessionCatalog();
			return;
		}
		let revision = knownRevision;
		if (revision === undefined) {
			const catalog = await this.loadSessionCatalog();
			if (catalog === undefined) return;
			const target = catalog.items.find((item) => item.sessionId === targetSessionId);
			if (target === undefined) {
				this.port.showNotice(`Session not found: ${targetSessionId}`, "error");
				return;
			}
			revision = catalog.revision;
		}
		const transition = await this.runSessionTransition("session.resume", { targetSessionId, expectedRevision: revision });
		if (transition !== undefined) await this.port.requestExit({ kind: "switch", action: "resume", target: { sessionId: transition.targetSessionId } });
	}

	/** S2:/fork 从 catalog 的 current row 读取 durable head，并同时 fence catalog/head。 */
	public async forkCurrentSession(argument = ""): Promise<void> {
		const args = argument.trim().split(/\s+/u).filter(Boolean);
		const at = args.find((arg) => arg.startsWith("--at="));
		if (new Set(args).size !== args.length || args.filter((arg) => arg.startsWith("--at=")).length > 1
			|| args.some((arg) => arg !== "--raw" && !/^--at=[1-9][0-9]*$/u.test(arg)) || (at !== undefined && !Number.isSafeInteger(Number(at.slice(5))))) {
			this.port.showNotice("Usage: /fork [--raw] [--at=sequence]", "error"); return;
		}
		if (this.rejectSessionTransition()) return;
		const catalog = await this.loadSessionCatalog();
		if (catalog === undefined) return;
		const current = catalog.items.find((item) => item.current && item.sessionId === this.port.getSessionId());
		if (current === undefined) {
			this.port.showNotice("Current Session is missing from the canonical catalog.", "error");
			return;
		}
		const transition = await this.runSessionTransition("session.fork", {
			sourceSessionId: current.sessionId,
			...(args.includes("--raw") ? { compaction: "raw" } : {}),
			...(at === undefined ? {} : { throughSequence: Number(at.slice(5)) }),
			expectedSourceHeadSequence: current.headSequence,
			expectedRevision: catalog.revision,
		});
		if (transition !== undefined) await this.port.requestExit({ kind: "switch", action: "fork", target: { sessionId: transition.targetSessionId } });
	}

	/** `/rename <title>` uses the typed Session Domain effect workflow and catalog CAS. */
	public async renameCurrentSession(title: string): Promise<void> {
		const normalizedTitle = normalizeSessionTitle(title);
		if (normalizedTitle === null || /[\u0000-\u001F\u007F-\u009F]/u.test(title) || /\u001B(?:\[[0-?]*[ -\/]*[@-~]|\][^\u0007]*(?:\u0007|$))/u.test(title)) {
			this.port.showNotice("Usage: /rename <title>", "error");
			return;
		}
		if (this.rejectSessionTransition()) return;
		const catalog = await this.loadSessionCatalog();
		if (catalog === undefined) return;
		const current = catalog.items.find((item) => item.sessionId === this.port.getSessionId());
		if (current === undefined) {
			this.port.showNotice("Current Session is missing from the canonical catalog.", "error");
			return;
		}
		const port = this.port;
		if (port.sessionPort === undefined) {
			port.showNotice("Session title mutation is unavailable on this connection.", "error");
			return;
		}
		const effect = port.createEffect("session.rename", {
			title: normalizedTitle,
			expectedRevision: catalog.revision,
			expectedTitle: current.title ?? null,
		});
		port.store.dispatch({ type: "query.start", effect });
		port.runner.dispatch(effect);
		const workflow = await port.waitForWorkflow("sessionWorkflow", effect.correlationId);
		if (workflow.state !== "ready" || !isSessionTitleResult(workflow.value)) {
			if (workflow.state === "error") port.showNotice(`/rename failed: ${workflow.message ?? "unknown outcome"}`, "error");
			else port.showNotice("/rename did not complete.", "error");
			return;
		}
		const result = workflow.value;
		port.store.dispatch({
			type: "session.title.changed",
			generation: port.store.getState().authorityGeneration,
			sessionId: result.sessionId,
			title: result.title,
		});
		// The mutation result is authoritative for the immediate header; requery
		// the catalog so picker/workflow state is refreshed from the same domain.
		await this.loadSessionCatalog();
		port.showNotice(`Session renamed: ${result.title}`);
		port.uiRequestRender();
	}

	private rejectSessionTransition(): boolean {
		if (this.port.inFlight()) {
			this.port.showNotice("Session transitions are available when the current turn is idle.", "note");
			return true;
		}
		if (this.port.store.getState().capabilities.sessionMutation.state !== "available") {
			this.port.showNotice("Session mutation is unavailable on this connection.", "error");
			return true;
		}
		return false;
	}

	public async loadSessionCatalog(): Promise<SessionCatalogResult | undefined> {
		const port = this.port;
		if (port.store.getState().capabilities.sessionCatalog.state !== "available") {
			port.showNotice("Session catalog is unavailable on this connection.", "error");
			return undefined;
		}
		const effect = port.createEffect("session.list");
		port.store.dispatch({ type: "query.start", effect });
		port.runner.dispatch(effect);
		const workflow = await port.waitForWorkflow("sessionWorkflow", effect.correlationId);
		if (workflow.state === "ready") {
			const value = workflow.value as SessionCatalogResult;
			if (value.kind === "catalog") return value;
		}
		if (workflow.state === "error") port.showNotice(`Session catalog failed: ${workflow.message ?? "unknown"}`, "error");
		else port.showNotice("Session catalog is empty or unavailable.", "error");
		return undefined;
	}

	/** welcome 后台目录刷新失败时静默返回，不阻塞输入也不追加 notice。 */
	public async refreshWelcomeSessions(): Promise<void> {
		const welcome = this.port.refs.welcome;
		if (welcome === undefined) return;
		if (this.port.store.getState().capabilities.sessionCatalog.state !== "available") return;
		const effect = this.port.createEffect("session.list");
		this.port.store.dispatch({ type: "query.start", effect });
		this.port.runner.dispatch(effect);
		const workflow = await this.port.waitForWorkflow("sessionWorkflow", effect.correlationId);
		if (workflow.state !== "ready" || !isSessionCatalogResult(workflow.value)) return;
		const now = Date.now();
		welcome.setRecentSessions(workflow.value.items.slice(0, WELCOME_SESSION_SLOTS).map((item) => ({
			name: item.title ?? item.firstUserMessagePreview ?? item.sessionId,
			timeAgo: formatRelativeTime(item.updatedAtMs, now),
		})));
		this.port.uiRequestRender();
	}

	private async runSessionTransition(
		type: "session.create" | "session.resume" | "session.fork",
		payload: Record<string, unknown>,
	): Promise<SessionTransitionResult | undefined> {
		const effect = this.port.createEffect(type, payload);
		this.port.store.dispatch({ type: "query.start", effect });
		this.port.runner.dispatch(effect);
		const workflow = await this.port.waitForWorkflow("sessionWorkflow", effect.correlationId);
		if (workflow.state === "ready") {
			const value = workflow.value as SessionTransitionResult;
			if (value.kind === "transition") return value;
		}
		if (workflow.state === "error") this.port.showNotice(`Session transition failed: ${workflow.message ?? "unknown"}`, "error");
		else this.port.showNotice("Session transition did not complete.", "error");
		return undefined;
	}
}
