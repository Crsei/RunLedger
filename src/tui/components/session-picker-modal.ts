import type { Component } from "../index.ts";
import { matchesKey } from "../index.ts";
import type { PresentationBlock } from "../presentation.ts";
import { fitLinesToWidth, fitToWidth } from "./render-width.ts";
import type { SessionCatalogItem } from "../sessions/types.ts";

/** 对照 codex resume_picker:pageUp/pageDown 步进。 */
const PAGE_STEP = 10;
/** 对照 codex SESSION_META_DATE_WIDTH:dense 模式日期列宽度。 */
const DENSE_DATE_WIDTH = 10;

export type SessionPickerSortKey = "updated" | "created";
export type SessionPickerFilterMode = "cwd" | "all";
export type SessionPickerDensity = "comfortable" | "dense";

export interface SessionPickerItem {
	readonly value: string;
	/** comfortable 主行:标题/preview/time fallback · status(· current)。 */
	readonly label: string;
	/** comfortable 元数据行:workspace · head · 相对时间。 */
	readonly description: string;
	/** dense 主行:日期列 + 标题/preview/time fallback。 */
	readonly denseLabel: string;
	/** dense 元数据行:最短信息。 */
	readonly denseDescription: string;
	/** ctrl+e 展开后的完整元数据(含完整 sessionId,可复制给 /resume <id>)。 */
	readonly expandedDescription: string;
	readonly workspaceId: string;
	readonly createdAtMs: number;
	readonly updatedAtMs: number;
	readonly current: boolean;
	/** 预拼好的搜索 haystack(小写)。 */
	readonly searchText: string;
}

export interface SessionPickerModalProps {
	readonly title: string;
	readonly items: SessionPickerItem[];
	/** 当前 session 的 workspaceId;缺省时 filter 锁定为 all。 */
	readonly currentWorkspaceId?: string;
	onSelect(item: SessionPickerItem): void;
	onCancel(): void;
}

/** codex format_relative_time:1m 内 just now,此后 Nm/Nh/Nd ago,再久落到日期。 */
export function formatRelativeTime(ms: number, nowMs: number): string {
	if (!Number.isFinite(ms) || !Number.isFinite(nowMs)) return "—";
	const diff = Math.max(0, nowMs - ms);
	const minute = 60_000;
	const hour = 60 * minute;
	const day = 24 * hour;
	if (diff < minute) return "just now";
	if (diff < hour) return `${Math.floor(diff / minute)}m ago`;
	if (diff < day) return `${Math.floor(diff / hour)}h ago`;
	if (diff < 7 * day) return `${Math.floor(diff / day)}d ago`;
	const date = new Date(ms);
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const dayOfMonth = String(date.getDate()).padStart(2, "0");
	return `${date.getFullYear()}-${month}-${dayOfMonth}`;
}

/** 把 SQLite catalog 投影富化为 picker 行;时间基准由调用方传入,便于测试。 */
export function buildSessionPickerItems(items: readonly SessionCatalogItem[], nowMs: number): SessionPickerItem[] {
	return items.map((item) => {
		const shortId = item.sessionId.startsWith("session_")
			? item.sessionId.slice("session_".length)
			: item.sessionId;
		const short = shortId.length > 8 ? shortId.slice(0, 8) : shortId;
		const displayId = `session_${short}`;
		const updated = formatRelativeTime(item.updatedAtMs, nowMs);
		const created = formatRelativeTime(item.createdAtMs, nowMs);
		const current = item.current ? " · current" : "";
		const head = `head ${item.headSequence}`;
		const driver = `driver ${item.driverRevision}`;
		const displayName = safePickerLabel(item.title ?? item.firstUserMessagePreview ?? `Untitled · ${created}`) || `Untitled · ${created}`;
		return {
			value: item.sessionId,
			label: `${displayName} · ${item.status}${current}`,
			description: `${item.workspaceId} · ${head} · ${updated}`,
			denseLabel: `${updated.padEnd(DENSE_DATE_WIDTH)}${displayName} · ${item.status}`,
			denseDescription: `${head} · ${item.workspaceId}`,
			expandedDescription: `${displayName} · ${item.sessionId} · ${item.workspaceId} · ${item.repositoryId} · ${head} · ${driver} · created ${created} · updated ${updated}${current}`,
			workspaceId: item.workspaceId,
			createdAtMs: item.createdAtMs,
			updatedAtMs: item.updatedAtMs,
			current: item.current,
			searchText: `${item.sessionId} ${displayId} ${displayName} ${item.title ?? ""} ${item.firstUserMessagePreview ?? ""} ${item.workspaceId} ${item.repositoryId} ${item.status}`.toLowerCase(),
		};
	});
}

function safePickerLabel(value: string, maxBytes = 120): string {
	const stripped = value
		.replace(/\x1b\[[0-9;?]*[a-zA-Z]/gu, "")
		.replace(/\x1b\][^\x07]*\x07/gu, "")
		.replace(/[\u0000-\u001F\u007F-\u009F]/gu, " ")
		.replace(/\s+/gu, " ")
		.trim();
	if (stripped.length === 0) return "";
	const bytes = new TextEncoder().encode(stripped);
	if (bytes.byteLength <= maxBytes) return stripped;
	const clipped = new TextDecoder().decode(bytes.subarray(0, maxBytes));
	return `${clipped.replace(/\uFFFD$/u, "")}…`;
}

export function filterSessionPickerItems(
	items: readonly SessionPickerItem[],
	filterMode: SessionPickerFilterMode,
	cwdFilter: string | undefined,
	query: string,
): SessionPickerItem[] {
	const normalized = query.trim().toLowerCase();
	const result: SessionPickerItem[] = [];
	for (const item of items) {
		if (filterMode === "cwd" && cwdFilter !== undefined && item.workspaceId !== cwdFilter) continue;
		if (normalized.length > 0 && !item.searchText.includes(normalized)) continue;
		result.push(item);
	}
	return result;
}

export function sortSessionPickerItems(items: readonly SessionPickerItem[], sortKey: SessionPickerSortKey): SessionPickerItem[] {
	return [...items].sort((a, b) => {
		const delta = sortKey === "updated" ? b.updatedAtMs - a.updatedAtMs : b.createdAtMs - a.createdAtMs;
		if (delta !== 0) return delta;
		return a.value < b.value ? -1 : a.value > b.value ? 1 : 0;
	});
}

/**
 * codex resume_picker 风格 /resume 选择器:
 *
 * - 布局:toolbar 行(Filter/Sort) + select(标题/搜索/多行列表) + 快捷键提示行;
 * - comfortable 每项两行(主行 + 元数据),dense 每项一行(crtl+o 切换);
 * - ctrl+e 展开选中项完整元数据,crtl+f 切换当前 workspace 过滤,crtl+s 切换
 *   按 Updated/Created 排序;输入即搜索(参考 codex type-to-search)。
 */
export class SessionPickerModal implements Component {
	private readonly props: SessionPickerModalProps;
	private query = "";
	private selectedIndex = 0;
	private sortKey: SessionPickerSortKey = "updated";
	private filterMode: SessionPickerFilterMode = "cwd";
	private density: SessionPickerDensity = "comfortable";
	private expandedValue: string | undefined;

	public constructor(props: SessionPickerModalProps) {
		this.props = props;
		if (props.currentWorkspaceId === undefined) this.filterMode = "all";
	}

	invalidate(): void {
		// 无缓存。
	}

	handleInput(data: string): void {
		if (matchesKey(data, "enter")) {
			const selected = this.visibleItems()[this.selectedIndex];
			if (selected) this.props.onSelect(selected);
			return;
		}
		if (matchesKey(data, "escape")) {
			if (this.query.length > 0) {
				this.query = "";
				this.selectedIndex = 0;
			} else {
				this.props.onCancel();
			}
			return;
		}
		if (matchesKey(data, "ctrl+c")) {
			this.props.onCancel();
			return;
		}
		if (matchesKey(data, "ctrl+e")) {
			this.toggleExpanded();
			return;
		}
		if (matchesKey(data, "ctrl+o")) {
			this.density = this.density === "comfortable" ? "dense" : "comfortable";
			return;
		}
		if (matchesKey(data, "ctrl+f")) {
			if (this.props.currentWorkspaceId !== undefined) {
				this.filterMode = this.filterMode === "cwd" ? "all" : "cwd";
				this.selectedIndex = 0;
			}
			return;
		}
		if (matchesKey(data, "ctrl+s")) {
			this.sortKey = this.sortKey === "updated" ? "created" : "updated";
			this.selectedIndex = 0;
			return;
		}
		if (matchesKey(data, "up")) {
			this.move(-1);
			return;
		}
		if (matchesKey(data, "down")) {
			this.move(1);
			return;
		}
		if (matchesKey(data, "pageUp")) {
			this.move(-PAGE_STEP);
			return;
		}
		if (matchesKey(data, "pageDown")) {
			this.move(PAGE_STEP);
			return;
		}
		if (matchesKey(data, "home")) {
			this.selectedIndex = 0;
			return;
		}
		if (matchesKey(data, "end")) {
			this.selectedIndex = Math.max(0, this.visibleItems().length - 1);
			return;
		}
		if (matchesKey(data, "backspace")) {
			this.query = Array.from(this.query).slice(0, -1).join("");
			this.selectedIndex = 0;
			return;
		}
		if (!/[\u0000-\u001f\u007f]/u.test(data)) {
			this.query += data;
			this.selectedIndex = 0;
		}
	}

	present(width?: number): PresentationBlock[] {
		const visible = this.visibleItems();
		const selectedIndex = this.clampedIndex(visible.length);
		const options = visible.length === 0
			? [{ value: "", label: "No matching sessions", description: "" }]
			: visible.map((item, index) => {
				const expanded = index === selectedIndex && this.expandedValue === item.value;
				return {
					value: item.value,
					label: this.density === "dense" ? item.denseLabel : item.label,
					description: expanded
						? item.expandedDescription
						: this.density === "dense"
							? item.denseDescription
							: item.description,
				};
			});
		return [
			{ id: "session-picker-toolbar", kind: "text", content: this.toolbarLine() },
			{
				id: "session-picker-select",
				kind: "select",
				title: `${this.props.title} (${visible.length})`,
				query: this.query,
				options,
				selectedIndex,
			},
			{ id: "session-picker-hints", kind: "text", content: this.hintsLine(visible.length, width) },
		];
	}

	render(width: number): string[] {
		const visible = this.visibleItems();
		const selectedIndex = this.clampedIndex(visible.length);
		const lines = [
			this.toolbarLine(),
			`${this.props.title} (${visible.length}) / ${this.query}`,
		];
		for (let index = 0; index < visible.length; index++) {
			const item = visible[index]!;
			const expanded = index === selectedIndex && this.expandedValue === item.value;
			const description = expanded
				? item.expandedDescription
				: this.density === "dense"
					? item.denseDescription
					: item.description;
			const label = this.density === "dense" ? item.denseLabel : item.label;
			lines.push(`${index === selectedIndex ? "→" : " "} ${label}  ${description}`);
		}
		if (visible.length === 0) lines.push("  No matching sessions");
		return fitLinesToWidth(lines, width);
	}

	private visibleItems(): SessionPickerItem[] {
		const filtered = filterSessionPickerItems(
			this.props.items,
			this.filterMode,
			this.props.currentWorkspaceId,
			this.query,
		);
		return sortSessionPickerItems(filtered, this.sortKey);
	}

	private clampedIndex(total: number): number {
		return Math.min(this.selectedIndex, Math.max(0, total - 1));
	}

	private move(delta: number): void {
		const total = this.visibleItems().length;
		if (total === 0) {
			this.selectedIndex = 0;
			return;
		}
		this.selectedIndex = Math.max(0, Math.min(total - 1, this.selectedIndex + delta));
	}

	private toggleExpanded(): void {
		const item = this.visibleItems()[this.selectedIndex];
		if (item === undefined) return;
		this.expandedValue = this.expandedValue === item.value ? undefined : item.value;
	}

	private toolbarLine(): string {
		const filter = this.props.currentWorkspaceId === undefined
			? `Filter: ${toolbarValue("All", true)}`
			: `Filter: ${toolbarValue("Cwd", this.filterMode === "cwd")} ${toolbarValue("All", this.filterMode === "all")}`;
		const sort = `Sort: ${toolbarValue("Updated", this.sortKey === "updated")} ${toolbarValue("Created", this.sortKey === "created")}`;
		return `${filter}   ${sort}`;
	}

	private hintsLine(total: number, width?: number): string {
		const escLabel = this.query.length > 0 ? "clear" : "close";
		const position = total === 0 ? 0 : this.selectedIndex + 1;
		const fitWidth = width === undefined ? 100 : Math.max(1, Math.floor(width));
		return [
			`enter resume · esc ${escLabel} · ↑/↓ browse · ctrl+e expand · ctrl+o density`,
			`ctrl+f filter · ctrl+s sort · ${position}/${total}`,
		].map((line) => fitToWidth(line, fitWidth)).join("\n");
	}
}

/** codex toolbar_value:active 用 [] 括起,inactive 保持裸文本。 */
function toolbarValue(label: string, active: boolean): string {
	return active ? `[${label}]` : ` ${label} `;
}
