import { getSettingDefinition, type SettingApplyMode, type SettingPath, type SettingScope, type SettingValue } from "../storage/settings-schema.ts";

export interface SettingsSelectorItem {
	readonly path: SettingPath;
	readonly value: SettingValue;
	readonly defaultValue: SettingValue;
	readonly apply: SettingApplyMode;
	readonly scope: readonly SettingScope[];
}

export interface SettingsSelectorGroup {
	readonly name: string;
	readonly items: readonly SettingsSelectorItem[];
}

/** 把 service 的 typed list 投影成稳定的 TUI 分组；不读取或写入 settings 文件。 */
export function groupSettings(items: readonly SettingsSelectorItem[]): readonly SettingsSelectorGroup[] {
	const groups = new Map<string, SettingsSelectorItem[]>();
	for (const item of items) {
		const definition = getSettingDefinition(item.path);
		if (definition === undefined) continue;
		const group = groups.get(definition.group) ?? [];
		group.push(item);
		groups.set(definition.group, group);
	}
	return [...groups.entries()]
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([name, group]) => Object.freeze({
			name,
			items: Object.freeze([...group].sort((left, right) => left.path.localeCompare(right.path))),
		}));
}

/** 可离散选择的值；数值/路径/列表返回 undefined，由输入 modal 编辑。 */
export function settingValueChoices(path: SettingPath, value: SettingValue): readonly string[] | undefined {
	if (typeof value === "boolean") return ["true", "false"];
	switch (path) {
		case "symbolPreset": return ["unicode", "nerd", "ascii"];
		case "statusLine.preset": return ["default", "compact", "minimal"];
		case "steeringMode":
		case "followUpMode": return ["one-at-a-time", "all"];
		case "compaction.strategy": return ["off", "summary"];
		case "memory.backend": return ["off", "local"];
		case "tools.approval": return ["record", "off"];
		case "tools.approvalMode": return ["always-ask", "write", "yolo"];
		default:
			void value;
			return undefined;
	}
}
