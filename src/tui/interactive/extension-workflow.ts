/**
 * S7 拆分:extension workflow —— MCP/plugins/skills/hooks 管理。
 *
 * 所有查询/变更经 Session domain effect workflow;失败投影 typed notice。
 */

import { McpServersModal, type McpServerViewItem } from "../components/mcp-servers-modal.ts";
import { ExtensionToggleModal, type ExtensionToggleItem } from "../components/extension-toggle-modal.ts";
import { ExtensionConfirmModal } from "../components/extension-confirm-modal.ts";
import { querySessionController, commandSessionController } from "../adapters/session-domain.ts";
import type { ExtensionResourceView } from "../extensions/types.ts";
import type { InteractiveModePorts } from "./types.ts";

export class ExtensionWorkflow {
	private readonly port: InteractiveModePorts;

	public constructor(port: InteractiveModePorts) {
		this.port = port;
	}

	/** B4+:打开 MCP server 管理视图(/mcp)。经 mcp.list 查询真实 catalog,
	 *  r 重启走 mcp.restart,操作成功后重新查询刷新。 */
	public openMcpServerSelector(): Promise<void> {
		return this.openMcpServersModal();
	}

	/** B4+:打开 plugins/skills/hooks 管理视图(/plugins /skills /hooks)。 */
	public openExtensionSelector(operation: "plugin.list" | "skill.list" | "hook.list", _kindLabel: string, commandName: string): Promise<void> {
		const kind = operation === "plugin.list" ? "plugin" : operation === "skill.list" ? "skill" : "hook";
		if (kind === "plugin") void this.notifyPendingMarketplaceUpdates();
		return this.openExtensionToggleModal(kind, commandName);
	}

	/** /mcp:server 列表 + Enter 详情 + r 重启,全部经 Session domain 通道。 */
	private async openMcpServersModal(): Promise<void> {
		const port = this.port;
		if (port.store.getState().capabilities.mcp.state !== "available") {
			port.showNotice("MCP catalog is unavailable in this session.", "error");
			return;
		}
		const servers = await this.queryMcpServers();
		if (servers === undefined) return;
		let modal: McpServersModal | undefined;
		modal = new McpServersModal({
			title: `/mcp (${servers.length})`,
			servers,
			onRestart: (server) => {
				void this.restartMcpServer(server, modal);
			},
			onCancel: () => port.closeOverlay(),
		});
		port.showOverlayModal(modal, { anchor: "bottom-left" });
	}

	private async restartMcpServer(server: McpServerViewItem, modal: McpServersModal | undefined): Promise<void> {
		const { serverId } = server;
		const ok = await this.runSessionMutation("mcp.restart", { serverId }, "/mcp restart");
		if (!ok || modal === undefined) return;
		const fresh = await this.queryMcpServers();
		if (fresh !== undefined) {
			modal.update(fresh);
			this.port.showNotice(`/mcp: ${server.displayName} restarted.`, "note");
		}
	}

	private async queryMcpServers(): Promise<McpServerViewItem[] | undefined> {
		const port = this.port;
		const context = { correlationId: `corr-${port.nextCorrelationId()}`, effectId: `effect-${port.nextEffectId()}` };
		const result = await querySessionController(port.controller, "mcp.list", {}, context).catch((error: unknown) => {
			port.showNotice(`/mcp query failed: ${String(error)}`, "error");
			return undefined;
		});
		if (result === undefined) return undefined;
		if (!result.ok) {
			port.showNotice(`/mcp query failed: ${result.code}`, "error");
			return undefined;
		}
		const items = isRecordArray(result.value?.items) ? result.value.items : isRecordArray(result.value?.servers) ? result.value.servers : [];
		return items.flatMap((item) => {
			if (!isRecord(item)) return [];
			const view = mcpServerViewFromDomain(item);
			return view === undefined ? [] : [view];
		});
	}

	/** /plugins /skills /hooks:codex 风格 toggle 视图,Space/Enter 切换 enable,t 信任。 */
	private async openExtensionToggleModal(kind: "plugin" | "skill" | "hook", commandName: string): Promise<void> {
		const port = this.port;
		const resources = await this.queryExtensionResources(kind, commandName);
		if (resources === undefined) return;
		if (resources.length === 0) {
			port.showNotice(`No ${kind} resources are discovered in the current snapshot.`, "note");
			return;
		}
		const items: ExtensionToggleItem[] = resources.map(resourceToToggleItem);
		const showTrust = true;
		const showReload = kind === "plugin" || kind === "skill";
		let modal: ExtensionToggleModal | undefined;
		// 确认/取消之后回到同一个 toggle 视图（保留搜索词与选中行）。
		const restore = (): void => {
			if (modal !== undefined) port.showOverlayModal(modal, { anchor: "bottom-left" });
		};
		modal = new ExtensionToggleModal({
			title: `${commandName} (${items.length})`,
			subtitle: kind === "skill"
				? "Review discovered skills. Press t to trust or untrust; r rescans directories."
				: kind === "hook"
					? "Toggle hooks and review their trust. Changes apply to the owning plugin."
					: "Enable, disable, trust or untrust plugins. Changes are saved automatically.",
			items,
			showTrust,
			showReload,
			onToggle: (item) => {
				void this.toggleExtensionItem(kind, item, modal);
			},
			onTrust: (item) => {
				void this.trustExtensionItem(kind, item, modal, restore);
			},
			onReload: () => {
				void this.reloadExtensions(kind, commandName, modal);
			},
			onCancel: () => port.closeOverlay(),
		});
		port.showOverlayModal(modal, { anchor: "bottom-left" });
	}

	private async toggleExtensionItem(kind: "plugin" | "skill" | "hook", item: ExtensionToggleItem, modal: ExtensionToggleModal | undefined): Promise<void> {
		if (item.pluginId === undefined) {
			this.port.showNotice(kind === "skill" ? "Press t to trust or untrust this standalone skill." : `${kind} ${item.name} has no owning plugin and cannot be toggled.`, "note");
			return;
		}
		const ok = await this.runSessionMutation(item.enabled ? "plugin.disable" : "plugin.enable", { pluginId: item.pluginId }, `/${kind} toggle`);
		if (!ok || modal === undefined) return;
		const fresh = await this.queryExtensionResources(kind, `/${kind}`);
		if (fresh !== undefined) {
			modal.update(fresh.map(resourceToToggleItem));
			this.port.uiRequestRender();
		}
	}

	private async trustExtensionItem(kind: "plugin" | "skill" | "hook", item: ExtensionToggleItem, modal: ExtensionToggleModal | undefined, restore: () => void): Promise<void> {
		if (item.pluginId === undefined && kind !== "skill") {
			this.port.showNotice(`${kind} ${item.name} has no owning plugin and cannot be re-trusted.`, "error");
			return;
		}
		const standaloneSkill = kind === "skill" && item.pluginId === undefined;
		const operation = standaloneSkill ? (item.trusted ? "skill.untrust" : "skill.trust") : (item.trusted ? "plugin.untrust" : "plugin.trust");
		const payload = standaloneSkill ? { skillId: item.resourceId } : { pluginId: item.pluginId };
		const granting = operation === "plugin.trust" || operation === "skill.trust";
		const commandName = `/${kind} trust`;
		// 确认边界：t 只打开确认视图，真正的 mutation 只在确认后执行。
		this.port.showOverlayModal(new ExtensionConfirmModal({
			title: granting ? `Trust ${item.name}?` : `Revoke trust for ${item.name}?`,
			detailLines: granting
				? [
					"Trust binds the current content digest to a receipt for this resource.",
					"Any content change makes the receipt stale, so trust must be granted again.",
					"Trust does not enable the resource; enable remains a separate decision.",
				]
				: ["Revoking trust immediately disables the host for this content until it is trusted again."],
			onConfirm: () => {
				void this.applyTrustChange(kind, operation, payload, commandName, modal, restore);
			},
			onCancel: () => restore(),
		}), { anchor: "bottom-left" });
	}

	/** 确认后的实际动作；成功或失败都回到 toggle 视图，失败原因走 typed notice。 */
	private async applyTrustChange(
		kind: "plugin" | "skill" | "hook",
		operation: string,
		payload: Record<string, unknown>,
		commandName: string,
		modal: ExtensionToggleModal | undefined,
		restore: () => void,
	): Promise<void> {
		const ok = await this.runSessionMutation(operation, payload, commandName);
		if (ok && modal !== undefined) {
			const fresh = await this.queryExtensionResources(kind, commandName);
			if (fresh !== undefined) modal.update(fresh.map(resourceToToggleItem));
		}
		restore();
		this.port.uiRequestRender();
	}

	/**
	 * D10：`autoUpdate` 的 `notify` 需要一个真实可见出口。打开 `/plugins` 时把
	 * 分发账本里的待更新项转成一条 notice；没有待更新项或该会话未暴露
	 * `marketplace.discover` 时静默跳过，绝不阻塞视图。
	 */
	private async notifyPendingMarketplaceUpdates(): Promise<void> {
		const port = this.port;
		const context = { correlationId: `corr-${port.nextCorrelationId()}`, effectId: `effect-${port.nextEffectId()}` };
		const result = await querySessionController(port.controller, "marketplace.discover", {}, context).catch(() => undefined);
		if (result === undefined || !result.ok) return;
		const pending = result.value.pendingUpdates;
		if (!Array.isArray(pending) || pending.length === 0) return;
		const names = pending.flatMap((item) => (isRecord(item) && typeof item.packageId === "string" ? [item.packageId] : []));
		const label = names.length > 0 ? names.slice(0, 3).join(", ") : `${pending.length} plugin(s)`;
		port.showNotice(`${pending.length} plugin update(s) available (${label}); run marketplace upgrade to apply.`, "note");
	}

	private async reloadExtensions(kind: "plugin" | "skill" | "hook", commandName: string, modal: ExtensionToggleModal | undefined): Promise<void> {
		const ok = await this.runSessionMutation("extension.reload", {}, commandName);
		if (!ok || modal === undefined) return;
		const fresh = await this.queryExtensionResources(kind, commandName);
		if (fresh !== undefined) {
			modal.update(fresh.map(resourceToToggleItem));
			this.port.uiRequestRender();
		}
	}

	/** Session domain mutation 公共 runner;失败投影 typed notice,返回成功与否。 */
	public async runSessionMutation(operation: string, body: Record<string, unknown>, commandName: string): Promise<boolean> {
		const port = this.port;
		if (port.inFlight()) {
			port.showNotice(`${commandName} is available when the current turn is idle.`, "note");
			return false;
		}
		const effectId = port.nextEffectId();
		const correlationId = port.nextCorrelationId();
		const context = { correlationId: `corr-${correlationId}`, effectId: `effect-${effectId}` };
		const result = await commandSessionController(port.controller, operation, body, { ...context, expectedRevision: 0 }).catch((error: unknown) => {
			port.showNotice(`${commandName} failed: ${String(error)}`, "error");
			return undefined;
		});
		if (result === undefined) return false;
		if (!result.ok) {
			port.showNotice(`${commandName} failed: ${result.code}`, "error");
			return false;
		}
		return true;
	}

	/** 经 extension.inspect workflow 查询快照并按 kind 过滤(只读)。 */
	private async queryExtensionResources(kind: "plugin" | "skill" | "hook", commandName: string): Promise<ExtensionResourceView[] | undefined> {
		const port = this.port;
		if (port.store.getState().capabilities.extensions.state !== "available") {
			port.showNotice("Session domain query is unavailable in this session.", "error");
			return undefined;
		}
		const effect = port.createEffect("extension.inspect");
		port.store.dispatch({ type: "query.start", effect });
		port.runner.dispatch(effect);
		const workflow = await port.waitForWorkflow("extensionWorkflow", effect.correlationId);
		if (workflow.state === "ready") {
			const value = workflow.value as { readonly resources?: readonly ExtensionResourceView[] };
			return (value.resources ?? []).filter((resource) => resource.kind === kind);
		}
		if (workflow.state === "empty") {
			return [];
		}
		if (workflow.state === "error") {
			port.showNotice(`${commandName} query failed: ${workflow.message}`, "error");
			return undefined;
		}
		port.showNotice(`${commandName} query is unavailable: ${workflow.state === "unavailable" ? workflow.reason : "unknown outcome"}`, "error");
		return undefined;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRecordArray(value: unknown): value is readonly Record<string, unknown>[] {
	return Array.isArray(value) && value.every((item) => isRecord(item));
}

/** mcp.list raw snapshot -> McpServersModal 视图项(bounded,缺失字段落缺省)。 */
function mcpServerViewFromDomain(value: Record<string, unknown>): McpServerViewItem | undefined {
	const serverId = typeof value.serverId === "string" ? value.serverId : "";
	const displayName = typeof value.displayName === "string" ? value.displayName : serverId;
	if (displayName.length === 0) return undefined;
	const tools = isRecordArray(value.tools) ? value.tools.map((tool) => ({
		rawName: typeof tool.rawName === "string" ? tool.rawName : typeof tool.name === "string" ? tool.name : "unknown",
		...(typeof tool.description === "string" && tool.description.length > 0 ? { description: tool.description.slice(0, 200) } : {}),
		isReadOnly: tool.isReadOnly === true,
		isDestructive: tool.isDestructive !== false,
	})) : [];
	const diagnostics = isRecordArray(value.diagnostics) ? value.diagnostics.map((item) => ({
		code: typeof item.code === "string" ? item.code : "mcp.diagnostic",
		message: typeof item.message === "string" ? item.message : "",
		severity: typeof item.severity === "string" ? item.severity : "error",
	})).filter((item) => item.message.length > 0) : [];
	return {
		serverId: serverId || `mcp-server:${displayName}`,
		displayName,
		transport: typeof value.transport === "string" ? value.transport : "unknown",
		required: value.required === true,
		state: typeof value.state === "string" ? value.state : "stopped",
		generation: typeof value.generation === "number" ? value.generation : 0,
		tools,
		diagnostics,
	};
}

/** ExtensionResourceView(typed adapter 投影)-> ExtensionToggleModal 项。 */
function resourceToToggleItem(resource: ExtensionResourceView): ExtensionToggleItem {
	return {
		resourceId: resource.resourceId,
		name: resource.label.text,
		...(resource.description === undefined ? {} : { description: resource.description.text }),
		...(resource.pluginId === undefined ? {} : { pluginId: resource.pluginId.text }),
		enabled: resource.enabled,
		trusted: resource.trusted,
		ready: resource.ready,
		trustLabel: resource.trust,
	};
}
