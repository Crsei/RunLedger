/**
 * McpServersModal —— /mcp 管理视图。
 *
 * 对照 codex-rs `bottom_pane/mcp_server_elicitation.rs` 的列表+详情形态
 * (不做新增 server 的表单;server 配置权威在 canonical mcp.json):
 *   - 一级列表:server 名 + [state] + transport · tool 数 + 必需标记;
 *   - Enter 展开该 server:tools(只读/破坏性标记)+ diagnostics;
 *   - r 重启选中 server;Esc 关闭(详情页 Esc 返回列表);
 *   - update(servers) 供 restart 完成后外部刷新。
 */

import type { Component } from "../index.ts";
import { matchesKey, visibleWidth } from "../index.ts";
import { wrapBold, wrapDim } from "../theme/ansi.ts";
import { fitLinesToWidth, fitToWidth } from "./render-width.ts";

export interface McpServerViewItem {
	readonly serverId: string;
	readonly displayName: string;
	readonly transport: string;
	readonly required: boolean;
	readonly state: string;
	readonly generation: number;
	readonly tools: readonly {
		readonly rawName: string;
		readonly description?: string;
		readonly isReadOnly: boolean;
		readonly isDestructive: boolean;
	}[];
	readonly diagnostics: readonly {
		readonly code: string;
		readonly message: string;
		readonly severity: string;
	}[];
}

export interface McpServersModalProps {
	readonly title?: string;
	readonly servers: readonly McpServerViewItem[];
	readonly maxVisible?: number;
	readonly onRestart: (server: McpServerViewItem) => void;
	readonly onCancel: () => void;
}

const DEFAULT_MAX_VISIBLE = 8;

export class McpServersModal implements Component {
	private readonly props: McpServersModalProps;
	private servers: readonly McpServerViewItem[];
	private selectedIndex = 0;
	private expanded: McpServerViewItem | undefined;

	constructor(props: McpServersModalProps) {
		this.props = props;
		this.servers = props.servers;
	}

	/** restart 完成后外部刷新;保持展开与选择。 */
	update(servers: readonly McpServerViewItem[]): void {
		const previousId = this.expanded?.serverId;
		this.servers = servers;
		this.expanded = servers.find((server) => server.serverId === previousId) ?? undefined;
		if (this.servers.length > 0) this.selectedIndex = Math.min(this.selectedIndex, this.servers.length - 1);
	}

	invalidate(): void {
		// 无缓存。
	}

	handleInput(data: string): void {
		if (this.expanded !== undefined) {
			if (matchesKey(data, "r")) {
				this.props.onRestart(this.expanded);
				return;
			}
			if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || matchesKey(data, "enter") || matchesKey(data, "backspace")) {
				this.expanded = undefined;
			}
			return;
		}
		if (matchesKey(data, "up")) {
			this.selectedIndex = this.servers.length === 0
				? 0
				: (this.selectedIndex - 1 + this.servers.length) % this.servers.length;
			return;
		}
		if (matchesKey(data, "down")) {
			this.selectedIndex = this.servers.length === 0 ? 0 : (this.selectedIndex + 1) % this.servers.length;
			return;
		}
		if (matchesKey(data, "pageUp")) {
			const maxVisible = this.props.maxVisible ?? DEFAULT_MAX_VISIBLE;
			this.selectedIndex = Math.max(0, this.selectedIndex - maxVisible);
			return;
		}
		if (matchesKey(data, "pageDown")) {
			const maxVisible = this.props.maxVisible ?? DEFAULT_MAX_VISIBLE;
			this.selectedIndex = Math.min(Math.max(0, this.servers.length - 1), this.selectedIndex + maxVisible);
			return;
		}
		if (matchesKey(data, "enter")) {
			const selected = this.servers[this.selectedIndex];
			if (selected) this.expanded = selected;
			return;
		}
		if (matchesKey(data, "r")) {
			const selected = this.servers[this.selectedIndex];
			if (selected) this.props.onRestart(selected);
			return;
		}
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.props.onCancel();
		}
	}

	render(width: number): string[] {
		const lines: string[] = [wrapBold(this.props.title ?? `MCP Servers (${this.servers.length})`)];
		if (this.expanded !== undefined) {
			lines.push(...this.renderDetail(this.expanded, width));
		} else {
			lines.push(wrapDim("Enter to inspect a server; r to restart; Esc to close"));
			if (this.servers.length === 0) {
				lines.push(wrapDim("No MCP servers are configured."));
			} else {
				const maxVisible = this.props.maxVisible ?? DEFAULT_MAX_VISIBLE;
				const start = Math.max(0, Math.min(
					this.selectedIndex - Math.floor(maxVisible / 2),
					Math.max(0, this.servers.length - maxVisible),
				));
				const visible = this.servers.slice(start, start + maxVisible);
				visible.forEach((server, offset) => {
					const index = start + offset;
					const selected = index === this.selectedIndex;
					const prefix = selected ? "› " : "  ";
					const marker = `[${server.state}]`;
					const requiredMark = server.required ? " required" : "";
					const summary = `${server.transport} · ${server.tools.length} tools${requiredMark}`;
					lines.push(fitToWidth(`${prefix}${server.displayName}  ${marker}  ${wrapDim(summary)}`, width));
				});
			}
		}
		return fitLinesToWidth(lines, width);
	}

	private renderDetail(server: McpServerViewItem, width: number): string[] {
		const lines: string[] = [
			wrapDim(`${server.displayName}  [${server.state}]  ${server.transport}${server.required ? " · required" : ""}`),
			"",
			wrapDim("Tools:"),
		];
		if (server.tools.length === 0) {
			lines.push(wrapDim("  (none)"));
		} else {
			for (const tool of server.tools) {
				const flag = tool.isReadOnly ? "read-only" : tool.isDestructive ? "destructive" : "guarded";
				const desc = tool.description !== undefined ? `  ${wrapDim(tool.description)}` : "";
				lines.push(fitToWidth(`  ${tool.rawName}  ${wrapDim(`(${flag})`)}${desc}`, width));
			}
		}
		lines.push("", wrapDim("Diagnostics:"));
		if (server.diagnostics.length === 0) {
			lines.push(wrapDim("  (none)"));
		} else {
			for (const item of server.diagnostics) {
				lines.push(fitToWidth(`  [${item.severity}] ${item.code}: ${item.message}`, width));
			}
		}
		lines.push(wrapDim("Press r to restart; Esc to go back"));
		return lines;
	}
}

export function truncateMcpName(name: string, limit: number): string {
	if (visibleWidth(name) <= limit) return name;
	const body = Array.from(name).reduce((acc, char) => {
		if (visibleWidth(acc + char) + 1 > limit) return acc;
		return acc + char;
	}, "");
	return `${body}…`;
}
