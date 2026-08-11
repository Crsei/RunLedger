/**
 * ExtensionToggleModal —— codex 风格 enable/disable 视图(/skills /plugins /hooks)。
 *
 * 对照 codex-rs `bottom_pane/skills_toggle_view.rs`:
 *   - header:bold 标题 + dim 副标题;
 *   - 搜索区:dim 占位行 + "> " 前缀输入行(搜索输入永远优先,Space 专用于 toggle);
 *   - 行:`› [x] name  desc...` / `  [ ] name  desc...`(enabled 标记 + desc 列);
 *   - Space/Enter toggle;t 切换信任(仅 showTrust);r 全量 reload(仅 showReload);
 *     Esc/Ctrl+C 关闭;
 *   - footer dim 按键提示行(自动生成);
 *   - update(items) 供 mutation 完成后外部刷新内容。
 *
 * 与 codex 的差异:RunLedger 的 skill/hook 状态是 plugin 级,行内同时展示
 * enabled/trusted/ready 三态,desc 列复用现有 ListSelectionModal 的对齐截断。
 */

import type { Component } from "../index.ts";
import { matchesKey, visibleWidth } from "../index.ts";
import { wrapBold, wrapDim } from "../theme/ansi.ts";
import { fitLinesToWidth, fitToWidth } from "./render-width.ts";

export interface ExtensionToggleItem {
	readonly resourceId: string;
	readonly name: string;
	readonly description?: string;
	readonly pluginId?: string;
	readonly enabled: boolean;
	readonly trusted: boolean;
	readonly ready: boolean;
	/** trust 状态展示词(trusted/untrusted/stale/revoked/unknown)。 */
	readonly trustLabel: string;
}

export interface ExtensionToggleModalProps {
	readonly title: string;
	readonly subtitle?: string;
	readonly items: readonly ExtensionToggleItem[];
	readonly maxVisible?: number;
	/** 是否展示信任操作(t 键 + 行内 trust 标记)。 */
	readonly showTrust?: boolean;
	/** 是否展示全量 reload(r 键)。 */
	readonly showReload?: boolean;
	readonly onToggle: (item: ExtensionToggleItem) => void;
	readonly onTrust?: (item: ExtensionToggleItem) => void;
	readonly onReload?: () => void;
	readonly onCancel: () => void;
}

const DEFAULT_MAX_VISIBLE = 8;

export class ExtensionToggleModal implements Component {
	private readonly props: ExtensionToggleModalProps;
	private items: readonly ExtensionToggleItem[];
	private query = "";
	private selectedIndex = 0;

	constructor(props: ExtensionToggleModalProps) {
		this.props = props;
		this.items = props.items;
	}

	/** mutation 完成后外部刷新;保持当前选择与搜索词。 */
	update(items: readonly ExtensionToggleItem[]): void {
		this.items = items;
		const len = this.filtered().length;
		if (len > 0) this.selectedIndex = Math.min(this.selectedIndex, len - 1);
	}

	invalidate(): void {
		// 无缓存。
	}

	handleInput(data: string): void {
		const items = this.filtered();
		if (matchesKey(data, "up")) {
			this.selectedIndex = items.length === 0 ? 0 : (this.selectedIndex - 1 + items.length) % items.length;
			return;
		}
		if (matchesKey(data, "down")) {
			this.selectedIndex = items.length === 0 ? 0 : (this.selectedIndex + 1) % items.length;
			return;
		}
		if (matchesKey(data, "pageUp")) {
			const maxVisible = this.props.maxVisible ?? DEFAULT_MAX_VISIBLE;
			this.selectedIndex = Math.max(0, this.selectedIndex - maxVisible);
			return;
		}
		if (matchesKey(data, "pageDown")) {
			const maxVisible = this.props.maxVisible ?? DEFAULT_MAX_VISIBLE;
			this.selectedIndex = Math.min(Math.max(0, items.length - 1), this.selectedIndex + maxVisible);
			return;
		}
		if (matchesKey(data, "backspace")) {
			this.query = Array.from(this.query).slice(0, -1).join("");
			this.selectedIndex = 0;
			return;
		}
		if (data === " " || matchesKey(data, "space") || matchesKey(data, "enter")) {
			const selected = items[this.selectedIndex];
			if (selected) this.props.onToggle(selected);
			return;
		}
		if (matchesKey(data, "t")) {
			const selected = items[this.selectedIndex];
			if (selected && this.props.showTrust && this.props.onTrust) this.props.onTrust(selected);
			return;
		}
		if (matchesKey(data, "r")) {
			if (this.props.showReload && this.props.onReload) this.props.onReload();
			return;
		}
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.props.onCancel();
			return;
		}
		if (!/[\u0000-\u001f\u007f]/u.test(data) && data !== " ") {
			this.query += data;
			this.selectedIndex = 0;
		}
	}

	render(width: number): string[] {
		const items = this.filtered();
		const maxVisible = this.props.maxVisible ?? DEFAULT_MAX_VISIBLE;
		const lines: string[] = [wrapBold(this.props.title)];
		if (this.props.subtitle !== undefined) lines.push(wrapDim(this.props.subtitle));
		lines.push("", wrapDim("Type to search"));
		const queryLine = this.query.length === 0 ? wrapDim("> ") : `> ${this.query}`;
		lines.push(fitToWidth(queryLine, width));
		if (items.length === 0) {
			lines.push(wrapDim("No matching items"));
		} else {
			const start = Math.max(0, Math.min(
				this.selectedIndex - Math.floor(maxVisible / 2),
				Math.max(0, items.length - maxVisible),
			));
			const visible = items.slice(start, start + maxVisible);
			// desc 列:可见行 name(含标记)最大宽度 + 2,上限 70% 宽(对照 codex compute_desc_col)。
			const maxNameWidth = visible.reduce((max, item) => Math.max(max, visibleWidth(this.rowName(item))), 0);
			const descCol = Math.min(width - 1, Math.floor(width * 0.7), 3 + maxNameWidth + 2);
			visible.forEach((item, offset) => {
				const index = start + offset;
				const selected = index === this.selectedIndex;
				const prefix = selected ? "› " : "  ";
				const marker = item.enabled ? "[x]" : "[ ]";
				const name = this.rowName(item);
				const nameLimit = Math.max(0, descCol - 2 - 5);
				const fittedName = truncateName(name, nameLimit);
				const used = visibleWidth(prefix) + visibleWidth(`${marker} `) + visibleWidth(fittedName);
				const gap = Math.max(0, descCol - used);
				const description = item.description !== undefined ? wrapDim(item.description) : "";
				const line = `${prefix}${marker} ${fittedName}${" ".repeat(gap)}${description}`;
				lines.push(fitToWidth(selected ? `${line}` : line, width));
			});
		}
		lines.push(wrapDim(this.footerHint()));
		return fitLinesToWidth(lines, width);
	}

	/** name + 三态标记(对照 codex row name;trusted 与 ready 以 dim 后缀展示)。 */
	private rowName(item: ExtensionToggleItem): string {
		const suffix: string[] = [];
		if (this.props.showTrust) suffix.push(item.trustLabel);
		if (!item.ready && (item.enabled || item.trusted)) suffix.push("not-ready");
		return suffix.length === 0 ? item.name : `${item.name} (${suffix.join(", ")})`;
	}

	private footerHint(): string {
		const parts: string[] = ["Press Space or Enter to toggle"];
		if (this.props.showTrust) parts.push("t to trust/untrust");
		if (this.props.showReload) parts.push("r to reload");
		parts.push("Esc to close");
		return parts.join("; ");
	}

	private filtered(): ExtensionToggleItem[] {
		const normalized = this.query.trim().toLowerCase();
		if (normalized.length === 0) return [...this.items];
		return this.items.filter((item) =>
			`${item.resourceId} ${item.name} ${item.description ?? ""} ${item.trustLabel}`.toLowerCase().includes(normalized),
		);
	}
}

/** 超宽时按可见宽度截断并追加 "…"(对照 ListSelectionModal)。 */
function truncateName(name: string, limit: number): string {
	if (visibleWidth(name) <= limit) return name;
	const body = Array.from(name).reduce((acc, char) => {
		if (visibleWidth(acc + char) + 1 > limit) return acc;
		return acc + char;
	}, "");
	return `${body}…`;
}
