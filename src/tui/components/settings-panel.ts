import { matchesKey, type Component, type SelectListTheme } from "../index.ts";
import { fitLinesToWidth } from "./render-width.ts";
import { parseSettingCliValue } from "../../storage/settings-service.ts";
import type { SettingPath, SettingValue } from "../../storage/settings-schema.ts";
import { groupSettings, settingValueChoices, type SettingsSelectorGroup, type SettingsSelectorItem } from "../settings-selector.ts";

export type SettingsPanelWriteResult =
	| { readonly ok: true; readonly value?: SettingValue }
	| { readonly ok: false; readonly message: string };

export type SettingsPanelResult =
	| { readonly ok: true; readonly path: SettingPath; readonly value: SettingValue }
	| { readonly ok: false; readonly path: SettingPath; readonly message: string };

export interface SettingsPanelProps {
	readonly items: readonly SettingsSelectorItem[];
	readonly selectListTheme: SelectListTheme;
	readonly onSet: (path: SettingPath, value: string) => Promise<SettingsPanelWriteResult>;
	readonly onReset: (path: SettingPath) => Promise<SettingsPanelWriteResult>;
	readonly onCancel: () => void;
	readonly onResult?: (result: SettingsPanelResult) => void;
}

type SettingsPanelView = "groups" | "settings" | "values" | "input";

/**
 * TUI settings editor。所有写入都回调 composition 提供的 SettingsService port；
 * 组件只持有当前 immutable list 的 presentation copy，不接触 layout、文件或 raw JSON。
 */
export class SettingsPanel implements Component {
	private readonly props: SettingsPanelProps;
	private readonly values = new Map<SettingPath, SettingsSelectorItem>();
	private view: SettingsPanelView = "groups";
	private groupIndex = 0;
	private settingIndex = 0;
	private valueIndex = 0;
	private input = "";
	private busy = false;

	public constructor(props: SettingsPanelProps) {
		this.props = props;
		for (const item of props.items) this.values.set(item.path, item);
	}

	public invalidate(): void {}

	public handleInput(data: string): void {
		if (this.busy) return;
		if (this.view === "input") {
			this.handleInputValue(data);
			return;
		}
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			if (this.view === "groups") this.props.onCancel();
			else if (this.view === "settings") this.view = "groups";
			else this.view = "settings";
			return;
		}
		const entries = this.currentEntries();
		if (matchesKey(data, "up")) {
			this.move(-1, entries.length);
			return;
		}
		if (matchesKey(data, "down")) {
			this.move(1, entries.length);
			return;
		}
		if (matchesKey(data, "enter")) this.confirm();
	}

	public render(width: number): string[] {
		const lines = this.view === "groups"
			? this.renderGroups()
			: this.view === "settings"
				? this.renderSettings()
				: this.view === "values"
					? this.renderValues()
					: this.renderInput();
		return fitLinesToWidth(lines, width);
	}

	private groups(): readonly SettingsSelectorGroup[] {
		return groupSettings([...this.values.values()]);
	}

	private selectedGroup(): SettingsSelectorGroup | undefined {
		return this.groups()[this.groupIndex];
	}

	private selectedItem(): SettingsSelectorItem | undefined {
		return this.selectedGroup()?.items[this.settingIndex];
	}

	private currentEntries(): readonly string[] {
		if (this.view === "groups") return this.groups().map((group) => group.name);
		if (this.view === "settings") return this.selectedGroup()?.items.map((item) => item.path) ?? [];
		if (this.view === "values") return this.valueEntries();
		return [];
	}

	private valueEntries(): readonly string[] {
		const item = this.selectedItem();
		if (item === undefined) return [];
		return [...(settingValueChoices(item.path, item.value) ?? []), "__reset__"];
	}

	private move(direction: -1 | 1, length: number): void {
		if (length === 0) return;
		if (this.view === "groups") this.groupIndex = (this.groupIndex + direction + length) % length;
		else if (this.view === "settings") this.settingIndex = (this.settingIndex + direction + length) % length;
		else this.valueIndex = (this.valueIndex + direction + length) % length;
	}

	private confirm(): void {
		if (this.view === "groups") {
			if (this.selectedGroup() === undefined) return;
			this.settingIndex = 0;
			this.view = "settings";
			return;
		}
		if (this.view === "settings") {
			const item = this.selectedItem();
			if (item === undefined) return;
			this.valueIndex = 0;
			this.input = this.valueText(item.value);
			this.view = settingValueChoices(item.path, item.value) === undefined ? "input" : "values";
			return;
		}
		if (this.view === "values") {
			const item = this.selectedItem();
			const entry = this.valueEntries()[this.valueIndex];
			if (item === undefined || entry === undefined) return;
			if (entry === "__reset__") void this.commitReset(item);
			else void this.commitSet(item, entry);
		}
	}

	private handleInputValue(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.view = "settings";
			return;
		}
		if (matchesKey(data, "enter")) {
			const item = this.selectedItem();
			if (item !== undefined) void this.commitSet(item, this.input);
			return;
		}
		if (matchesKey(data, "backspace")) {
			this.input = Array.from(this.input).slice(0, -1).join("");
			return;
		}
		if (matchesKey(data, "ctrl+u")) {
			this.input = "";
			return;
		}
		if (/^[\u0000-\u001f\u007f]$/u.test(data)) return;
		this.input += data;
	}

	private async commitSet(item: SettingsSelectorItem, value: string): Promise<void> {
		this.busy = true;
		try {
			const result = await this.props.onSet(item.path, value);
			if (!result.ok) {
				this.props.onResult?.({ ok: false, path: item.path, message: result.message });
				return;
			}
			const nextValue = result.value === undefined ? parseSettingCliValue(value) : result.value;
			this.values.set(item.path, { ...item, value: nextValue });
			this.view = "settings";
			this.props.onResult?.({ ok: true, path: item.path, value: nextValue });
		} catch (error) {
			this.props.onResult?.({ ok: false, path: item.path, message: String(error) });
		} finally {
			this.busy = false;
		}
	}

	private async commitReset(item: SettingsSelectorItem): Promise<void> {
		this.busy = true;
		try {
			const result = await this.props.onReset(item.path);
			if (!result.ok) {
				this.props.onResult?.({ ok: false, path: item.path, message: result.message });
				return;
			}
			const nextValue = result.value === undefined ? item.defaultValue : result.value;
			this.values.set(item.path, { ...item, value: nextValue });
			this.view = "settings";
			this.props.onResult?.({ ok: true, path: item.path, value: nextValue });
		} catch (error) {
			this.props.onResult?.({ ok: false, path: item.path, message: String(error) });
		} finally {
			this.busy = false;
		}
	}

	private renderGroups(): string[] {
		const groups = this.groups();
		return [
			"Settings",
			"Select a group. Enter opens settings; Esc closes.",
			...groups.map((group, index) => `${index === this.groupIndex ? "›" : " "} ${group.name} (${group.items.length})`),
		];
	}

	private renderSettings(): string[] {
		const group = this.selectedGroup();
		const items = group?.items ?? [];
		return [
			`Settings / ${group?.name ?? ""}`,
			"Enter edits a value; Esc returns to groups.",
			...items.map((item, index) => `${index === this.settingIndex ? "›" : " "} ${item.path} = ${this.valueText(item.value)} [${item.apply}]`),
		];
	}

	private renderValues(): string[] {
		const item = this.selectedItem();
		const entries = this.valueEntries();
		return [
			`Settings / ${item?.path ?? ""}`,
			"Choose a value; the last option resets to the schema default.",
			...entries.map((entry, index) => `${index === this.valueIndex ? "›" : " "} ${entry === "__reset__" ? `reset (${this.valueText(item?.defaultValue)})` : entry}`),
		];
	}

	private renderInput(): string[] {
		const item = this.selectedItem();
		return [
			`Edit ${item?.path ?? "setting"}`,
			`Current: ${this.valueText(item?.value)}`,
			`> ${this.input}`,
			`Enter saves (${item?.apply ?? ""}); Esc cancels`,
		];
	}

	private valueText(value: SettingValue | undefined): string {
		if (value === undefined) return "undefined";
		if (typeof value === "string") return value;
		if (typeof value === "number" || typeof value === "boolean") return String(value);
		return JSON.stringify(value);
	}
}
