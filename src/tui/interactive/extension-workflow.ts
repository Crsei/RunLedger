/**
 * S7 拆分:extension workflow —— MCP/plugins/skills/hooks 管理。
 *
 * 所有查询/变更经 Session domain effect workflow;失败投影 typed notice。
 */

import { McpServersModal, type McpServerViewItem } from "../components/mcp-servers-modal.ts";
import { ExtensionToggleModal, type ExtensionToggleItem } from "../components/extension-toggle-modal.ts";
import { SelectorModal } from "../components/selector-modal.ts";
import { makeSelectListTheme } from "../theme/factories.ts";
import { querySessionController, commandSessionController } from "../adapters/session-domain.ts";
import type { ExtensionResourceView } from "../extensions/types.ts";
import type { SelectItem } from "../primitives.ts";
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

	/** /skillsproviders:只读 provider status 列表（mutation 仍走 authenticated Session command）。 */
	public async openSkillProvidersModal(): Promise<void> {
		const port = this.port;
		const context = { correlationId: `corr-${port.nextCorrelationId()}`, effectId: `effect-${port.nextEffectId()}` };
		const result = await querySessionController(port.controller, "skill.provider.list", {}, context).catch((error: unknown) => {
			port.showNotice(`/skillsproviders query failed: ${String(error)}`, "error");
			return undefined;
		});
		if (result === undefined) return;
		if (!result.ok) {
			port.showNotice(`/skillsproviders query failed: ${result.code}`, "error");
			return;
		}
		const rawItems = isRecordArray(result.value?.items) ? result.value.items : [];
		const items: SelectItem[] = rawItems.flatMap((item) => {
			if (!isRecord(item) || typeof item.providerId !== "string") return [];
			const state = typeof item.state === "string" ? item.state : "unknown";
			const candidateCount = typeof item.candidateCount === "number" ? item.candidateCount : 0;
			const activeCount = typeof item.activeCount === "number" ? item.activeCount : 0;
			const failedCount = typeof item.failedCount === "number" ? item.failedCount : 0;
			const label = `${item.providerId} — ${state}`;
			const description = `candidates=${candidateCount} active=${activeCount} failed=${failedCount}`;
			return [{ value: item.providerId, label, description }];
		});
		const modal = new SelectorModal({
			theme: port.theme,
			selectListTheme: makeSelectListTheme(port.theme),
			title: `/skillsproviders (${items.length})`,
			items,
			onCancel: () => port.closeOverlay(),
		});
		port.showOverlayModal(modal, { anchor: "bottom-left" });
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
		const showTrust = kind === "plugin" || kind === "hook";
		const showReload = kind === "plugin";
		let modal: ExtensionToggleModal | undefined;
		modal = new ExtensionToggleModal({
			title: `${commandName} (${items.length})`,
			subtitle: kind === "skill"
				? "Turn skills on or off. Changes apply to the owning plugin and are saved automatically."
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
				void this.trustExtensionItem(kind, item, modal);
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
			this.port.showNotice(`${kind} ${item.name} has no owning plugin and cannot be toggled.`, "error");
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

	private async trustExtensionItem(kind: "plugin" | "skill" | "hook", item: ExtensionToggleItem, modal: ExtensionToggleModal | undefined): Promise<void> {
		if (item.pluginId === undefined) {
			this.port.showNotice(`${kind} ${item.name} has no owning plugin and cannot be re-trusted.`, "error");
			return;
		}
		const ok = await this.runSessionMutation(item.trusted ? "plugin.untrust" : "plugin.trust", { pluginId: item.pluginId }, `/${kind} trust`);
		if (!ok || modal === undefined) return;
		const fresh = await this.queryExtensionResources(kind, `/${kind}`);
		if (fresh !== undefined) modal.update(fresh.map(resourceToToggleItem));
	}

	private async reloadExtensions(kind: "plugin" | "skill" | "hook", commandName: string, modal: ExtensionToggleModal | undefined): Promise<void> {
		const ok = await this.runSessionMutation("extension.reload", {}, commandName);
		if (!ok || modal === undefined) return;
		const fresh = await this.queryExtensionResources(kind, commandName);
		if (fresh !== undefined) modal.update(fresh.map(resourceToToggleItem));
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
