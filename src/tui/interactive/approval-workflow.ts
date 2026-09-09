/**
 * S7 拆分:approval/credential reverse-request workflow。
 *
 * 只收集并返回决策;Host receipt 未接入前不更新 approval workflow。
 * approval 与 credential 共用既有 UI authority(PermissionRequestView / auth modal)。
 */

import { PermissionRequestView } from "../components/permission-request-view.ts";
import { SelectorModal } from "../components/selector-modal.ts";
import { AuthInputModal } from "../components/auth-input-modal.ts";
import { makeSelectListTheme } from "../theme/factories.ts";
import { approvalChoices, approvalDecisionBody, parseApprovalReverseRequest, type ApprovalDecision } from "../approval.ts";
import { decodeAuthEvent, decodeAuthPrompt } from "../../runtime/session-runtime/credential-reverse-request.ts";
import type { AuthEvent, AuthPrompt } from "../../auth/types.ts";
import type { SessionFrameEnvelope } from "../../runtime/session-server/protocol.ts";
import type { InteractiveModePorts } from "./types.ts";

/**
 * Host reverse frame 的结构投影(只读 body);不 import legacy Host 类型,
 * 保持本模块在 check-session-owner-boundaries 的 R0 豁免之外。
 */
export interface HostReverseFrame {
	readonly body: Record<string, unknown>;
}

export class ApprovalWorkflow {
	private readonly port: InteractiveModePorts;
	/** 活跃 permission view(approval 测试读取);busy 拒绝依赖它。 */
	activePermissionView: PermissionRequestView | undefined;

	public constructor(port: InteractiveModePorts) {
		this.port = port;
	}

	/** Host 逆向 approval 请求：只收集并返回决策；Host receipt 未接入前不更新 approval workflow。 */
	public handleReverseRequest(frame: HostReverseFrame, signal: AbortSignal): Promise<Record<string, unknown>> {
		return this.handleApprovalReverseRequest(frame.body, signal);
	}

	/** Session reverse-request 的唯一 TUI 分派：approval 与 credential 共用既有 UI authority。 */
	public handleSessionReverseRequest(frame: SessionFrameEnvelope, signal: AbortSignal): Promise<Record<string, unknown>> {
		const requestKind = typeof frame.body.kind === "string" ? frame.body.kind : undefined;
		if (requestKind === "approval_prompt") {
			const body = isRecord(frame.body.body) ? frame.body.body : undefined;
			return body === undefined
				? Promise.resolve({ ok: false, code: "reverse_request_invalid" })
				: this.handleApprovalReverseRequest(body, signal);
		}
		if (requestKind === "credential_prompt" || requestKind === "credential_event") {
			return this.handleCredentialReverseRequest(frame, signal);
		}
		return Promise.resolve({ ok: false, code: "reverse_request_invalid" });
	}

	private handleApprovalReverseRequest(body: Record<string, unknown>, signal: AbortSignal): Promise<Record<string, unknown>> {
		const port = this.port;
		const view = parseApprovalReverseRequest(body);
		if (!view) return Promise.resolve({ ok: false, code: "reverse_request_invalid" });
		if (this.activePermissionView !== undefined) return Promise.resolve({ ok: false, code: "approval_busy" });
		if (signal.aborted) return Promise.resolve({ ok: false, code: "approval_aborted" });
		const deadline = view.expiresAt === undefined ? undefined : Date.parse(view.expiresAt);
		if (deadline !== undefined && (!Number.isFinite(deadline) || deadline <= Date.now())) {
			port.showNotice("Approval expired; command was not run", "error");
			return Promise.resolve({ ok: false, code: "approval_expired" });
		}
		return new Promise<Record<string, unknown>>((resolve) => {
			let settled = false;
			let expiryTimeout: ReturnType<typeof setTimeout> | undefined;
			const finish = (responseBody: Record<string, unknown>): void => {
				if (settled) return;
				settled = true;
				if (expiryTimeout !== undefined) clearTimeout(expiryTimeout);
				signal.removeEventListener("abort", onAbort);
				if (port.ui.getOverlay() === permissionView) {
					port.closeOverlay();
					port.ui.setFocus(port.refs.editor);
				}
				if (this.activePermissionView === permissionView) this.activePermissionView = undefined;
				port.uiRequestRender();
				resolve(responseBody);
			};
			const onAbort = (): void => {
				finish({ ok: false, code: "approval_aborted" });
			};
			const expire = (): void => {
				if (settled) return;
				port.showNotice("Approval expired; command was not run", "error");
				finish({ ok: false, code: "approval_expired" });
			};
			const choose = (decision: ApprovalDecision): void => {
				if (deadline !== undefined && Date.now() >= deadline) {
					expire();
					return;
				}
				// 这里只记录用户决策意图；Host 是否接受由 reverse response 的调用方确认。
				port.dispatchTimeline([{
					type: "notice",
					generation: 0,
					correlationId: `approval-${port.store.getState().timeline.committedRows.length}`,
					severity: "info",
					message: { text: `approval ${decision.decision} for ${view.toolName}`, truncated: false, byteLength: new TextEncoder().encode(`approval ${decision.decision} for ${view.toolName}`).byteLength },
				}]);
				finish(approvalDecisionBody(decision));
				if (decision.decision === "deny" || decision.decision === "cancel") {
					// 先让 reverse response 的 continuation 发送 deny，再中断 canonical turn，
					// 避免模型把单次拒绝当成可继续重试的新 permission 请求。
					queueMicrotask(() => this.interruptCurrentTurn());
				}
			};
			const choices = approvalChoices(view);
			const permissionView = new PermissionRequestView({
				request: view,
				choices,
				onSelect: (choice) => choose(choice.decision),
				onCancel: () => choose({ decision: "cancel" }),
				onChange: () => port.uiRequestRender(),
				...(port.openPermissions === undefined || port.controller?.supports?.("session.security.apply") !== true ? {} : {
					onPermissions: () => port.openPermissions!(() => {
						if (!settled && !signal.aborted) port.showOverlayModal(permissionView, { anchor: "bottom-left" });
					}),
				}),
			});
			signal.addEventListener("abort", onAbort, { once: true });
			if (port.ui.hasOverlay()) port.closeOverlay();
			this.activePermissionView = permissionView;
			port.showOverlayModal(permissionView, { anchor: "bottom-left" });
			if (deadline !== undefined) {
				expiryTimeout = setTimeout(expire, Math.max(0, deadline - Date.now()));
			}
			port.uiRequestRender();
		});
	}

	/**
	 * Session 协议 credential reverse-request:`/login` 的 secret/select 提示
	 * 由 server 侧 domain 经 reverse_request 投递到这里渲染,并把用户输入
	 * 经 reverse_response 送回;credential_event(info/auth_url/device_code)只展示。
	 */
	public handleCredentialReverseRequest(frame: SessionFrameEnvelope, signal: AbortSignal): Promise<Record<string, unknown>> {
		const port = this.port;
		const body = frame.body;
		const requestKind = typeof body.kind === "string" ? body.kind : undefined;
		if (requestKind === "credential_prompt") {
			const prompt = decodeAuthPrompt(body.body);
			if (prompt === undefined) return Promise.resolve({ ok: false, code: "reverse_request_invalid" });
			// 提示用户 modal 已打开(部分终端下 overlay 渲染偶发不可见,notice 兜底)。
			port.showNotice(`Credential prompt: ${prompt.message}`, "note");
			return new Promise<Record<string, unknown>>((resolve) => {
				let settled = false;
				const finish = (result: Record<string, unknown>): void => {
					if (settled) return;
					settled = true;
					port.closeOverlay();
					resolve(result);
				};
				const onAbort = (): void => finish({ ok: false, code: "aborted" });
				void this.promptAuth(prompt, new AbortController()).then(
					(value) => finish({ ok: true, value }),
					() => finish({ ok: false, code: "aborted" }),
				);
				if (signal.aborted) {
					onAbort();
					return;
				}
				signal.addEventListener("abort", onAbort, { once: true });
			});
		}
		if (requestKind === "credential_event") {
			const event = decodeAuthEvent(body.body);
			if (event === undefined) return Promise.resolve({ ok: false, code: "reverse_request_invalid" });
			this.showAuthEvent(event);
			return Promise.resolve({});
		}
		return Promise.resolve({ ok: false, code: "reverse_request_invalid" });
	}

	/** facade 暴露:有活跃 approval view 时返回 true(供 Ctrl+C/退出路由判断)。 */
	public hasActivePermissionView(): boolean {
		return this.activePermissionView !== undefined;
	}

	public interruptCurrentTurn(): void {
		this.port.interruptCurrentTurn();
	}

	private promptAuth(prompt: AuthPrompt, owner: AbortController): Promise<string> {
		const port = this.port;
		if (prompt.type === "select") {
			return new Promise((resolve, reject) => {
				const cancel = () => {
					port.closeOverlay();
					reject(new Error("Authentication cancelled"));
				};
				const modal = new SelectorModal({
					theme: port.theme,
					selectListTheme: makeSelectListTheme(port.theme),
					title: prompt.message,
					items: prompt.options.map((option) => ({
						value: option.id,
						label: option.label,
						description: option.description,
					})),
					onSelect: (item) => {
						port.closeOverlay();
						resolve(item.value);
					},
					onCancel: () => {
						owner.abort();
						cancel();
					},
				});
				prompt.signal?.addEventListener("abort", cancel, { once: true });
				port.showOverlayModal(modal, { anchor: "bottom-left" });
			});
		}
		return new Promise((resolve, reject) => {
			const cancel = () => {
				port.closeOverlay();
				reject(new Error("Authentication cancelled"));
			};
			const modal = new AuthInputModal({
				title: prompt.type === "secret" ? "Secret" : "Authentication input",
				message: prompt.message,
				placeholder: prompt.placeholder,
				secret: prompt.type === "secret",
				onSubmit: (value) => {
					port.closeOverlay();
					resolve(value);
				},
				onCancel: () => {
					owner.abort();
					cancel();
				},
			});
			prompt.signal?.addEventListener("abort", cancel, { once: true });
			port.showOverlayModal(modal, { anchor: "bottom-left" });
		});
	}

	public showAuthEvent(event: AuthEvent): void {
		const port = this.port;
		if (event.type === "info") {
			const links = event.links?.map((link) => link.url).join(" ") ?? "";
			port.showNotice(`${event.message}${links ? ` ${links}` : ""}`);
		} else if (event.type === "auth_url") {
			port.showNotice(`${event.instructions ?? "Open this URL:"} ${event.url}`);
		} else if (event.type === "device_code") {
			port.showNotice(`Open ${event.verificationUri} and enter code ${event.userCode}`);
		} else {
			port.showNotice(event.message);
		}
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
