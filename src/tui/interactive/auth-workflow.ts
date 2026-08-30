/**
 * S7 拆分:auth workflow —— provider/login/logout 与 credential 交互。
 *
 * 所有交互(secret/URL/device code 提示)是短生命周期 owner:interaction
 * 在 auth.login effect 期间注入,结束后立即解除。
 */

import { SelectorModal } from "../components/selector-modal.ts";
import { SearchableSelectorModal } from "../components/searchable-selector-modal.ts";
import { AuthInputModal } from "../components/auth-input-modal.ts";
import { makeSelectListTheme } from "../theme/factories.ts";
import type { AuthEvent, AuthInteraction, AuthPrompt, AuthType } from "../../auth/types.ts";
import type { InteractiveModePorts } from "./types.ts";

export class AuthWorkflow {
	private readonly port: InteractiveModePorts;

	public constructor(port: InteractiveModePorts) {
		this.port = port;
	}

	/** B5:/provider 走 provider workflow；configured → model selector，否则 auth 流。 */
	public async openProviderSelector(): Promise<void> {
		const port = this.port;
		if (port.store.getState().capabilities.provider.state !== "available") {
			port.showNotice("Provider configuration is unavailable in this session.", "error");
			return;
		}
		const effect = port.createEffect("provider.list");
		port.store.dispatch({ type: "query.start", effect });
		port.runner.dispatch(effect);
		const workflow = await port.waitForWorkflow("providerWorkflow", effect.correlationId);
		if (workflow.state !== "ready") {
			port.showNotice("Provider configuration is unavailable in this session.", "error");
			return;
		}
		const providers = (workflow.value as { readonly providers?: readonly { readonly providerId: string; readonly label: { readonly text: string }; readonly status: string; readonly authKinds: readonly string[] }[] }).providers ?? [];
		const modal = new SearchableSelectorModal({
			title: "/provider — all built-ins",
			items: providers.map((provider) => ({
				value: provider.providerId,
				label: provider.label.text,
				description: provider.status === "ready"
					? "configured"
					: provider.authKinds.length > 0
						? `login: ${provider.authKinds.join("/")}`
						: "ambient credential required",
			})),
			maxVisible: 12,
			onSelect: (item) => {
				port.closeOverlay();
				const provider = providers.find((entry) => entry.providerId === item.value);
				if (!provider) return;
				if (provider.status === "ready") {
					port.openModelSelector(provider.providerId);
				} else if (provider.authKinds.length > 0) {
					void this.startLogin(provider.providerId);
				} else {
					port.showNotice(
						`${provider.label.text} uses ambient credentials. Configure its environment/profile, then reopen /provider.`,
						"error",
					);
				}
			},
			onCancel: () => port.closeOverlay(),
		});
		port.showOverlayModal(modal, { anchor: "bottom-left" });
	}

	/** B5:/login 走 auth workflow（auth.inspect 找 provider，再 auth.login effect）。 */
	public async openLoginSelector(providerId?: string): Promise<void> {
		const port = this.port;
		if (port.store.getState().capabilities.auth.state !== "available") {
			port.showNotice("Login is unavailable in this session.", "error");
			return;
		}
		const effect = port.createEffect("auth.inspect");
		port.store.dispatch({ type: "query.start", effect });
		port.runner.dispatch(effect);
		const workflow = await port.waitForWorkflow("authWorkflow", effect.correlationId);
		if (workflow.state !== "ready") {
			port.showNotice("Login is unavailable in this session.", "error");
			return;
		}
		const providers = (workflow.value as { readonly providers?: readonly { readonly providerId: string; readonly providerLabel: { readonly text: string }; readonly configured: string; readonly authKind: string }[] }).providers ?? [];
		if (providerId) {
			const provider = providers.find((entry) => entry.providerId === providerId);
			if (!provider) {
				port.showNotice(`Unknown provider: ${providerId}`, "error");
				return;
			}
			await this.startLogin(provider.providerId);
			return;
		}
		const loginable = providers.filter((provider) => provider.authKind !== "unknown" && provider.configured !== "yes");
		if (loginable.length === 0) {
			port.showNotice("No providers require interactive login.", "note");
			return;
		}
		const modal = new SearchableSelectorModal({
			title: "/login — provider",
			items: loginable.map((provider) => ({
				value: provider.providerId,
				label: provider.providerLabel.text,
				description: provider.authKind,
			})),
			maxVisible: 12,
			onSelect: (item) => {
				port.closeOverlay();
				const provider = loginable.find((entry) => entry.providerId === item.value);
				if (provider) void this.startLogin(provider.providerId);
			},
			onCancel: () => port.closeOverlay(),
		});
		port.showOverlayModal(modal, { anchor: "bottom-left" });
	}

	/** B5:auth.login effect；interaction（secret/URL 提示）是短生命周期 owner。 */
	public async startLogin(providerId: string): Promise<void> {
		const port = this.port;
		if (port.store.getState().capabilities.auth.state !== "available") {
			port.showNotice("Login is unavailable in this session.", "error");
			return;
		}
		const authKind = await this.providerAuthKind(providerId);
		if (authKind === undefined) {
			port.showNotice(`${providerId} has no interactive login flow; configure ambient credentials.`, "error");
			return;
		}
		const abortController = new AbortController();
		const interaction: AuthInteraction = {
			signal: abortController.signal,
			prompt: (prompt) => this.promptAuth(prompt, abortController),
			notify: (event) => this.showAuthEvent(event),
		};
		port.authAdapter.setAuthInteraction(interaction);
		port.showNotice(`Starting ${authKind} login for ${providerId}…`);
		const effect = port.createEffect("auth.login", { providerId, authKind });
		port.store.dispatch({ type: "query.start", effect });
		port.runner.dispatch(effect);
		const workflow = await port.waitForWorkflow("authWorkflow", effect.correlationId);
		port.authAdapter.setAuthInteraction(undefined);
		if (workflow.state === "ready") {
			port.showNotice(`Authenticated ${providerId}.`);
			port.openModelSelector(providerId);
		} else if (workflow.state === "error") {
			if (!abortController.signal.aborted) port.showNotice(`Login failed: ${workflow.message}`, "error");
		} else {
			port.showNotice(`Login is unavailable: ${workflow.state === "unavailable" ? workflow.reason : "unknown outcome"}`, "error");
		}
	}

	/** B5:从 auth workflow 读 provider 的 authKind（避免直接调 controller）。 */
	private async providerAuthKind(providerId: string): Promise<"api-key" | "oauth" | undefined> {
		const effect = this.port.createEffect("auth.inspect");
		this.port.store.dispatch({ type: "query.start", effect });
		this.port.runner.dispatch(effect);
		const workflow = await this.port.waitForWorkflow("authWorkflow", effect.correlationId);
		if (workflow.state !== "ready") return undefined;
		const providers = (workflow.value as { readonly providers?: readonly { readonly providerId: string; readonly authKind: string }[] }).providers ?? [];
		const kind = providers.find((entry) => entry.providerId === providerId)?.authKind;
		return kind === "oauth" ? "oauth" : kind === "api-key" ? "api-key" : undefined;
	}

	private promptAuth(prompt: AuthPrompt, owner: AbortController): Promise<string> {
		if (prompt.type === "select") {
			return new Promise((resolve, reject) => {
				const cancel = () => {
					this.port.closeOverlay();
					reject(new Error("Authentication cancelled"));
				};
				const modal = new SelectorModal({
					theme: this.port.theme,
					selectListTheme: makeSelectListTheme(this.port.theme),
					title: prompt.message,
					items: prompt.options.map((option) => ({
						value: option.id,
						label: option.label,
						description: option.description,
					})),
					onSelect: (item) => {
						this.port.closeOverlay();
						resolve(item.value);
					},
					onCancel: () => {
						owner.abort();
						cancel();
					},
				});
				prompt.signal?.addEventListener("abort", cancel, { once: true });
				this.port.showOverlayModal(modal, { anchor: "bottom-left" });
			});
		}
		return new Promise((resolve, reject) => {
			const cancel = () => {
				this.port.closeOverlay();
				reject(new Error("Authentication cancelled"));
			};
			const modal = new AuthInputModal({
				title: prompt.type === "secret" ? "Secret" : "Authentication input",
				message: prompt.message,
				placeholder: prompt.placeholder,
				secret: prompt.type === "secret",
				onSubmit: (value) => {
					this.port.closeOverlay();
					resolve(value);
				},
				onCancel: () => {
					owner.abort();
					cancel();
				},
			});
			prompt.signal?.addEventListener("abort", cancel, { once: true });
			this.port.showOverlayModal(modal, { anchor: "bottom-left" });
		});
	}

	public showAuthEvent(event: AuthEvent): void {
		if (event.type === "info") {
			const links = event.links?.map((link) => link.url).join(" ") ?? "";
			this.port.showNotice(`${event.message}${links ? ` ${links}` : ""}`);
		} else if (event.type === "auth_url") {
			this.port.showNotice(`${event.instructions ?? "Open this URL:"} ${event.url}`);
		} else if (event.type === "device_code") {
			this.port.showNotice(`Open ${event.verificationUri} and enter code ${event.userCode}`);
		} else {
			this.port.showNotice(event.message);
		}
	}

	/** B5:/logout 走 auth.logout effect；controller/Host 返回 authoritative 结果。 */
	public async handleLogout(providerId?: string): Promise<void> {
		const port = this.port;
		if (port.store.getState().capabilities.auth.state !== "available") {
			port.showNotice("Logout is unavailable in this session.", "error");
			return;
		}
		const id = providerId ?? port.controller?.currentSelection.provider;
		if (!id) {
			port.showNotice("No provider selected.", "error");
			return;
		}
		const effect = port.createEffect("auth.logout", { providerId: id });
		port.store.dispatch({ type: "query.start", effect });
		port.runner.dispatch(effect);
		const workflow = await port.waitForWorkflow("authWorkflow", effect.correlationId);
		if (workflow.state === "ready") {
			port.showNotice(`Logged out ${id}.`);
		} else if (workflow.state === "error") {
			port.showNotice(`Logout failed: ${workflow.message}`, "error");
		}
	}
}
