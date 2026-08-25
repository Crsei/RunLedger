export type ComposerShapeId = string;
export type ComposerStatusAttachment = "top-border" | "top-rule-chip" | "none";
export type ComposerBottomBar = "none" | "left" | "full";
export type ComposerScrollbarState = "none" | "track" | "thumb";

export interface ComposerGlyphs {
	readonly horizontal: string;
	readonly vertical: string;
	readonly topLeft: string;
	readonly topRight: string;
	readonly bottomLeft: string;
	readonly bottomRight: string;
	readonly scrollbarTrack: string;
	readonly scrollbarThumb: string;
}

export const DEFAULT_COMPOSER_GLYPHS: ComposerGlyphs = Object.freeze({
	horizontal: "─",
	vertical: "│",
	topLeft: "╭",
	topRight: "╮",
	bottomLeft: "╰",
	bottomRight: "╯",
	scrollbarTrack: "░",
	scrollbarThumb: "█",
});

export interface ComposerMeasureContext {
	readonly terminalWidth: number;
	readonly inputText: string;
	readonly placeholder: string;
	readonly cursorOffset: number;
	readonly scrollbarVisible: boolean;
}

export interface ComposerStatusContent {
	readonly identity: string;
	readonly usage: string;
}

export interface ComposerShapeSettingsPort {
	save(shape: string): Promise<{ readonly ok: true } | { readonly ok: false; readonly code: string }>;
}

export interface ComposerInputRow {
	readonly text: string;
	readonly logicalLine: number;
	readonly visualRow: number;
	readonly isFirst: boolean;
	readonly isLast: boolean;
	readonly cursorOffset?: number;
	readonly scrollbar: ComposerScrollbarState;
}

export interface ComposerTextRun {
	readonly text: string;
	readonly role: "chrome" | "prompt" | "input" | "status" | "scrollbar";
	readonly foregroundColor?: string;
	readonly backgroundColor?: string;
	readonly bold?: boolean;
}

export interface ComposerChromeRow {
	readonly kind: "top" | "input" | "bottom" | "bottom-bar" | "gap";
	readonly text: string;
	readonly width: number;
	readonly runs: readonly ComposerTextRun[];
}

export interface ComposerChromeContext {
	readonly measure: ComposerMeasureContext;
	readonly availableWidth: number;
	readonly status: ComposerStatusContent;
	readonly glyphs: ComposerGlyphs;
	readonly paddingX: number;
	readonly promptGutter: number;
	readonly sideChromeWidth: number;
	readonly borderColor: string;
	readonly accentColor: string;
	readonly surfaceColor: string;
	readonly inputRow?: ComposerInputRow;
	readonly rowIndex?: number;
	readonly rowCount?: number;
}

export interface ComposerStyle {
	readonly id: ComposerShapeId;
	readonly label: string;
	readonly description: string;
	readonly sideBorders: boolean;
	/** native 文本起点相对逻辑输入起点额外保留的 cell。 */
	readonly inputLeadingWidth?: number;
	readonly verticalChrome: 0 | 1 | 2;
	readonly statusAttachment: ComposerStatusAttachment;
	readonly bottomBar: ComposerBottomBar;
	readonly bottomBarGap: number;
	readonly defaultPromptGutter: number;
	defaultPaddingX(context: ComposerMeasureContext): number;
	sideChromeWidth(context: ComposerMeasureContext): number;
	renderTop(context: ComposerChromeContext): ComposerChromeRow | undefined;
	renderRow(context: ComposerChromeContext, row: ComposerInputRow): ComposerChromeRow;
	renderBottom(context: ComposerChromeContext): ComposerChromeRow | undefined;
	renderBottomBar(context: ComposerChromeContext): ComposerChromeRow | undefined;
}
