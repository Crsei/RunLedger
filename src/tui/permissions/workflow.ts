/** `/permissions` 的三项系统权限预设选择器。 */

import { builtinPermissionPresets, type BuiltinPermissionPresetId } from "../../security/config/presets.ts";
import { parseSecurityConfigDocument } from "../../security/config/schema.ts";
import type { SecurityConfigDocument } from "../../security/types.ts";
import type { RuntimeDigest } from "../../runtime/protocol/foundation.ts";
import type { SessionDomainMutationContext, SessionDomainRequestContext, SessionDomainResult } from "../../runtime/session-runtime/domain-router.ts";
import { SecondarySelectionView } from "../components/list-selection-modal.ts";
import type { Component } from "../index.ts";
import { makeSelectListTheme } from "../theme/factories.ts";
import type { Theme } from "../theme/theme.ts";
import { applySystemPermissionPreset } from "./preset-selection.ts";

interface PermissionSettingsController {
	readonly supports?: (operation: string) => boolean;
	readonly querySessionDomain?: (operation: string, payload: Record<string, unknown>, context: SessionDomainRequestContext) => Promise<SessionDomainResult>;
	readonly commandSessionDomain?: (operation: string, payload: Record<string, unknown>, context: SessionDomainMutationContext) => Promise<SessionDomainResult>;
}

export interface PermissionsWorkflowOptions {
	readonly controller: PermissionSettingsController | undefined;
	readonly theme: Theme;
	readonly showOverlay: (component: Component) => void;
	readonly closeOverlay: () => void;
	readonly getOverlay?: () => Component | undefined;
	readonly showNotice: (message: string, kind?: "note" | "error") => void;
	readonly requestRender: () => void;
	readonly nextRequest: () => { readonly correlationId: string; readonly effectId: string };
	readonly onApplied?: (profile: string) => void;
}

interface PermissionSettingsView {
	readonly document: SecurityConfigDocument;
	readonly sourceDigest: RuntimeDigest;
	readonly domainRevision: number;
	readonly editable: boolean;
	readonly effectiveProfile: string;
	readonly securityRevision: number;
	readonly presetAvailability: Readonly<Partial<Record<BuiltinPermissionPresetId, { readonly state: "available" | "unavailable"; readonly reason?: string }>>>;
}

const LABELS: Readonly<Record<BuiltinPermissionPresetId, string>> = Object.freeze({
	"workspace-write": "Ask for approval",
	"approve-for-me": "Approve for me",
	"danger-full-access": "Full Access",
});

export interface PermissionsOpenCallbacks {
	/** 用户在权限页放弃并返回(例如返回原审批弹窗)。 */
	readonly onCancel?: () => void;
	/** 权限页没能展示(Host 不可用/inspection 失败/recovery 要求);调用方必须恢复被挂起的输入。 */
	readonly onUnavailable?: () => void;
}

export class PermissionsWorkflow {
	readonly #options: PermissionsWorkflowOptions;
	#applying = false;
	#overlay?: Component;
	#callbacks: PermissionsOpenCallbacks = {};

	public constructor(options: PermissionsWorkflowOptions) {
		this.#options = options;
	}

	public async open(callbacks: PermissionsOpenCallbacks = {}): Promise<void> {
		this.#callbacks = callbacks;
		const controller = this.#options.controller;
		if (
			controller?.supports?.("security.settings.inspect") !== true ||
			controller.supports("session.security.apply") !== true ||
			controller.querySessionDomain === undefined ||
			controller.commandSessionDomain === undefined
		) {
			this.#options.showNotice("Permissions settings are unavailable from this Session Host.", "error");
			callbacks.onUnavailable?.();
			return;
		}
		try {
			const request = this.#options.nextRequest();
			const result = await controller.querySessionDomain("security.settings.inspect", { scope: "user" }, request);
			const availability = controller.supports("session.security.inspect")
				? await controller.querySessionDomain("session.security.inspect", {}, this.#options.nextRequest())
				: undefined;
			if (availability?.ok && availability.value.applicationState === "recovery_required") {
				this.#options.showNotice("Session permissions require recovery. Reconnect before running more tools.", "error");
				callbacks.onUnavailable?.();
				return;
			}
			const view = inspection(result, availability);
			if (view === undefined) {
				this.#options.showNotice("Permissions settings could not be inspected.", "error");
				callbacks.onUnavailable?.();
				return;
			}
			this.#openCards(view);
		} catch {
			this.#options.showNotice("Permissions settings could not be inspected. Reconnect and try again.", "error");
			callbacks.onUnavailable?.();
		}
	}

	#openCards(view: PermissionSettingsView): void {
		const current = view.effectiveProfile;
		const items = builtinPermissionPresets().map((preset) => {
			const availability = view.presetAvailability[preset.id];
			const unavailable = availability?.state === "unavailable";
			return {
				value: preset.id,
				name: LABELS[preset.id],
				description: unavailable ? `Unavailable: ${availability.reason ?? "security_constraint"}` : preset.description,
				isCurrent: current === preset.id,
				disabled: !view.editable || unavailable,
			};
		});
		const modal = new SecondarySelectionView({
			title: "Permissions",
			subtitle: view.editable
				? "Apply permissions to this Session and save as the default."
				: "Managed security policy is read-only in this Session.",
			items,
			detailLines: view.document.profile !== current ? [`Saved default: ${view.document.profile ?? "workspace-write"}. Current Session: ${current}.`] : [],
			initialSelectedValue: items.some((item) => item.value === current) ? current : "workspace-write",
			selectListTheme: makeSelectListTheme(this.#options.theme),
			footerHint: view.editable
				? "Press Enter to apply now or Esc to go back"
				: "Managed by organization; press Esc to go back",
			onSelect: (item) => {
				if (item.value === "danger-full-access") this.#openFullAccessConfirmation(view);
				else void this.#save(view, item.value as BuiltinPermissionPresetId);
			},
			onCancel: () => { this.#close(); this.#callbacks.onCancel?.(); },
		});
		this.#overlay = modal;
		this.#options.showOverlay(modal);
		this.#options.requestRender();
	}

	#openFullAccessConfirmation(view: PermissionSettingsView): void {
		const modal = new SecondarySelectionView({
			title: "Confirm Full Access",
			subtitle: "Allow normal commands, files outside this workspace and network access.",
			detailLines: [
				"System-destructive operations still require one-time confirmation.",
				"Deny rules and policy protections remain active.",
				"Already running commands keep their existing permissions.",
			],
			items: [
				{ value: "confirm", name: "Continue with Full Access", description: "Use only when you understand the risks." },
				{ value: "cancel", name: "Cancel", description: "Return to the permission choices." },
			],
			initialSelectedValue: "confirm",
			selectListTheme: makeSelectListTheme(this.#options.theme),
			footerHint: "Press Enter to confirm or Esc to keep the current permission",
			onSelect: (item) => {
				if (item.value === "confirm") void this.#save(view, "danger-full-access");
				else this.#openCards(view);
			},
			onCancel: () => this.#openCards(view),
		});
		this.#overlay = modal;
		this.#options.showOverlay(modal);
		this.#options.requestRender();
	}

	async #save(view: PermissionSettingsView, preset: BuiltinPermissionPresetId): Promise<void> {
		if (this.#applying) return;
		const controller = this.#options.controller;
		if (controller?.commandSessionDomain === undefined) {
			this.#options.showNotice("Permissions settings are unavailable from this Session Host.", "error");
			return;
		}
		const request = this.#options.nextRequest();
		this.#applying = true;
		try {
			const result = await controller.commandSessionDomain("session.security.apply", {
				scope: "user",
				expectedSourceDigest: view.sourceDigest,
				expectedSecurityRevision: view.securityRevision,
				document: applySystemPermissionPreset(view.document, preset),
			}, { ...request, expectedRevision: view.domainRevision });
			if (!result.ok) {
				const message = result.status === "stale"
					? "Permissions changed elsewhere. Reopen /permissions and try again."
					: result.code === "permissions_saved_not_applied"
						? "Permissions were saved, but this Session could not apply them. Reconnect to this Session and run /recovery assess."
						: result.status === "recovery_required"
							? "Permissions require recovery. Reconnect to this Session and run /recovery assess before retrying."
							: "Permissions could not be applied to this Session.";
				this.#options.showNotice(`${message} (${result.code})`, "error");
				return;
			}
			if (result.value.appliesTo !== "current_and_new_sessions" || typeof result.value.effectiveProfile !== "string") {
				this.#options.showNotice("The Session did not confirm the effective permissions. Reopen /permissions to inspect them.", "error");
				return;
			}
			this.#options.onApplied?.(result.value.effectiveProfile);
			this.#close();
			this.#options.showNotice("Permissions applied to this Session and saved as the default.", "note");
			this.#options.requestRender();
		} catch {
			this.#options.showNotice("The permission update could not be confirmed. Reopen /permissions to inspect the current state.", "error");
		} finally { this.#applying = false; }
	}

	#close(): void {
		if (this.#options.getOverlay === undefined || this.#options.getOverlay() === this.#overlay) this.#options.closeOverlay();
		this.#overlay = undefined;
	}
}

function inspection(result: SessionDomainResult, securityInspection?: SessionDomainResult): PermissionSettingsView | undefined {
	if (!result.ok || securityInspection?.ok !== true || typeof securityInspection.value.profile !== "string" || !Number.isSafeInteger(securityInspection.value.securityRevision)) return undefined;
	const document = parseSecurityConfigDocument(result.value.document);
	const sourceDigest = runtimeDigestOf(result.value.sourceDigest);
	return document.ok && sourceDigest !== undefined && typeof result.value.editable === "boolean"
		? {
			document: document.value,
			sourceDigest,
			domainRevision: result.domainRevision,
			editable: result.value.editable,
			effectiveProfile: securityInspection.value.profile,
			securityRevision: Number(securityInspection.value.securityRevision),
			presetAvailability: availabilityOf(securityInspection),
		}
		: undefined;
}

function availabilityOf(result: SessionDomainResult | undefined): PermissionSettingsView["presetAvailability"] {
	if (result?.ok !== true || !Array.isArray(result.value.presetAvailability)) return {};
	const availability: Partial<Record<BuiltinPermissionPresetId, { readonly state: "available" | "unavailable"; readonly reason?: string }>> = {};
	for (const entry of result.value.presetAvailability) {
		if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
		const record = entry as Record<string, unknown>;
		if ((record.id !== "workspace-write" && record.id !== "approve-for-me" && record.id !== "danger-full-access") || (record.state !== "available" && record.state !== "unavailable")) continue;
		availability[record.id] = {
			state: record.state,
			...(typeof record.reason === "string" && record.reason.length > 0 ? { reason: record.reason } : {}),
		};
	}
	return availability;
}

function runtimeDigestOf(value: unknown): RuntimeDigest | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	return record.algorithm === "sha256" && typeof record.digest === "string" && /^[a-f0-9]{64}$/u.test(record.digest)
		? record as unknown as RuntimeDigest
		: undefined;
}
