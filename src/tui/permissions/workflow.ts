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
	readonly showNotice: (message: string, kind?: "note" | "error") => void;
	readonly requestRender: () => void;
	readonly nextRequest: () => { readonly correlationId: string; readonly effectId: string };
}

interface PermissionSettingsView {
	readonly document: SecurityConfigDocument;
	readonly sourceDigest: RuntimeDigest;
	readonly domainRevision: number;
	readonly editable: boolean;
	readonly presetAvailability: Readonly<Partial<Record<BuiltinPermissionPresetId, { readonly state: "available" | "unavailable"; readonly reason?: string }>>>;
}

const LABELS: Readonly<Record<BuiltinPermissionPresetId, string>> = Object.freeze({
	"workspace-write": "Ask for approval",
	"approve-for-me": "Approve for me",
	"danger-full-access": "Full Access",
});

export class PermissionsWorkflow {
	readonly #options: PermissionsWorkflowOptions;

	public constructor(options: PermissionsWorkflowOptions) {
		this.#options = options;
	}

	public async open(): Promise<void> {
		const controller = this.#options.controller;
		if (
			controller?.supports?.("security.settings.inspect") !== true ||
			controller.querySessionDomain === undefined ||
			controller.commandSessionDomain === undefined
		) {
			this.#options.showNotice("Permissions settings are unavailable from this Session Host.", "error");
			return;
		}
		const request = this.#options.nextRequest();
		const result = await controller.querySessionDomain("security.settings.inspect", { scope: "user" }, request);
		const availability = controller.supports("session.security.inspect")
			? await controller.querySessionDomain("session.security.inspect", {}, this.#options.nextRequest())
			: undefined;
		const view = inspection(result, availability);
		if (view === undefined) {
			this.#options.showNotice("Permissions settings could not be inspected.", "error");
			return;
		}
		this.#openCards(view);
	}

	#openCards(view: PermissionSettingsView): void {
		const current = view.document.profile ?? "workspace-write";
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
				? "Choose how new Sessions can access files, commands, and the network."
				: "Managed security policy is read-only in this Session.",
			items,
			initialSelectedValue: items.some((item) => item.value === current) ? current : "workspace-write",
			selectListTheme: makeSelectListTheme(this.#options.theme),
			footerHint: view.editable
				? "Press Enter to save for new Sessions or Esc to go back"
				: "Managed by organization; press Esc to go back",
			onSelect: (item) => {
				if (item.value === "danger-full-access") this.#openFullAccessConfirmation(view);
				else void this.#save(view, item.value as BuiltinPermissionPresetId);
			},
			onCancel: () => this.#options.closeOverlay(),
		});
		this.#options.showOverlay(modal);
		this.#options.requestRender();
	}

	#openFullAccessConfirmation(view: PermissionSettingsView): void {
		const modal = new SecondarySelectionView({
			title: "Confirm Full Access",
			subtitle: "This allows editing files outside this workspace and network access without routine approval.",
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
		this.#options.showOverlay(modal);
		this.#options.requestRender();
	}

	async #save(view: PermissionSettingsView, preset: BuiltinPermissionPresetId): Promise<void> {
		const controller = this.#options.controller;
		if (controller?.commandSessionDomain === undefined) {
			this.#options.showNotice("Permissions settings are unavailable from this Session Host.", "error");
			return;
		}
		const request = this.#options.nextRequest();
		const result = await controller.commandSessionDomain("security.settings.update", {
			scope: "user",
			expectedSourceDigest: view.sourceDigest,
			document: applySystemPermissionPreset(view.document, preset),
		}, { ...request, expectedRevision: view.domainRevision });
		if (!result.ok) {
			this.#options.showNotice(result.status === "stale" ? "Permissions changed elsewhere. Reopen /permissions and try again." : "Permissions could not be saved.", "error");
			return;
		}
		this.#options.closeOverlay();
		this.#options.showNotice("Permissions saved. The change applies to new Sessions.", "note");
		this.#options.requestRender();
	}
}

function inspection(result: SessionDomainResult, securityInspection?: SessionDomainResult): PermissionSettingsView | undefined {
	if (!result.ok) return undefined;
	const document = parseSecurityConfigDocument(result.value.document);
	const sourceDigest = runtimeDigestOf(result.value.sourceDigest);
	return document.ok && sourceDigest !== undefined && typeof result.value.editable === "boolean"
		? {
			document: document.value,
			sourceDigest,
			domainRevision: result.domainRevision,
			editable: result.value.editable,
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
