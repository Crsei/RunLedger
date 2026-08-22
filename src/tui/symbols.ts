import { STATUS_INDICATOR_FRAMES } from "./opentui/block-layout.ts";

export type SymbolPreset = "unicode" | "nerd" | "ascii";

export interface StatusSymbols {
	readonly activityFrames: readonly string[];
	readonly waitingGlyph: string;
}

const NERD_STATUS_FRAMES = [
	"󱑖", "󱑋", "󱑌", "󱑍", "󱑎", "󱑏", "󱑐", "󱑑", "󱑒", "󱑓", "󱑔", "󱑕",
] as const;

const SYMBOL_PRESETS: Readonly<Record<SymbolPreset, StatusSymbols>> = Object.freeze({
	unicode: Object.freeze({ activityFrames: STATUS_INDICATOR_FRAMES, waitingGlyph: "⏸" }),
	nerd: Object.freeze({ activityFrames: NERD_STATUS_FRAMES, waitingGlyph: "\uf04c" }),
	ascii: Object.freeze({ activityFrames: ["|", "/", "-", "\\"], waitingGlyph: "||" }),
});

/** 返回稳定的状态展示符号；非法运行时输入安全回退 Unicode。 */
export function statusSymbolsFor(preset?: SymbolPreset): StatusSymbols {
	switch (preset) {
		case "nerd":
		case "ascii":
		case "unicode":
			return SYMBOL_PRESETS[preset];
		default:
			return SYMBOL_PRESETS.unicode;
	}
}
