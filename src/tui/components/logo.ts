import { visibleWidth } from "../primitives.ts";
import type { Theme } from "../theme/theme.ts";
import { wrapBold, wrapDim, wrapFg } from "../theme/ansi.ts";

/** Welcome Logo 的默认字母；settings.json 可通过 `logo` 覆盖。 */
export const DEFAULT_LOGO_LETTERS = "runledger";

/** Logo 配置允许的最大字母数，避免配置直接放大启动页布局。 */
export const MAX_LOGO_LETTERS = 32;

/**
 * 每个 Logo 字母对应的三行字形。
 *
 * 字形保留原 Welcome 页的 opencode 风格视觉语言，但数据按字母拆开，
 * 因此 Logo 文案变化时不需要再维护 left/right 两段硬编码字符串。
 */
export const LOGO_LETTER_FORMS = {
	r: ["█▀▀█", "█▀▀▀", "▀▀▀▀"],
	u: ["█▀▀█", "█__█", "▀▀▀▀"],
	n: ["█▀▀█", "█^^█", "▀▀▀▀"],
	l: ["█▀▀▀", "█▀▀▀", "▀▀▀▀"],
	e: ["█▀▀▀", "█▀▀▀", "▀▀▀▀"],
	d: ["█▀▀▄", "█__█", "▀▀▀▀"],
	g: ["█▀▀▄", "█▀▀█", "▀▀▀▀"],
} as const;

export type LogoLetter = keyof typeof LOGO_LETTER_FORMS;

const LOGO_LETTERS_PATTERN = /^[a-z]+$/u;

export interface LogoGlyph {
	readonly letter: LogoLetter;
	readonly rows: readonly string[];
}

/** 字形之间的列间距。 */
export const LOGO_GAP = 1;

/** left/right 兼容视图；新代码应使用 mapLogoLetters/renderLogo。 */
export const logo = {
	letters: DEFAULT_LOGO_LETTERS,
	left: buildLogoRows(DEFAULT_LOGO_LETTERS.slice(0, 3)),
	right: buildLogoRows(DEFAULT_LOGO_LETTERS.slice(3)),
} as const;

/**
 * 清洗 settings 中的 Logo 字母。
 * 只接受已经有字形映射的 ASCII 字母；非法值统一回退默认 Logo。
 */
export function normalizeLogoLetters(value?: string): string {
	const candidate = (value ?? DEFAULT_LOGO_LETTERS).trim().toLowerCase();
	if (
		candidate.length === 0 ||
		candidate.length > MAX_LOGO_LETTERS ||
		!LOGO_LETTERS_PATTERN.test(candidate) ||
		[...candidate].some((letter) => !Object.hasOwn(LOGO_LETTER_FORMS, letter))
	) {
		return DEFAULT_LOGO_LETTERS;
	}
	return candidate;
}

/** 将配置的每一个字母映射为对应三行字形。 */
export function mapLogoLetters(value?: string): readonly LogoGlyph[] {
	const letters = normalizeLogoLetters(value);
	return [...letters].map((letter) => {
		const key = letter as LogoLetter;
		return { letter: key, rows: LOGO_LETTER_FORMS[key] };
	});
}

/** 生成未着色的 Logo 行，供兼容布局/宽度计算使用。 */
function buildLogoRows(value?: string): readonly string[] {
	const glyphs = mapLogoLetters(value);
	const rowCount = glyphs[0]?.rows.length ?? 0;
	return Array.from({ length: rowCount }, (_, rowIndex) =>
		glyphs.map((glyph) => glyph.rows[rowIndex] ?? "").join(" ".repeat(LOGO_GAP)),
	);
}

/** 根据配置的字母计算单行可见宽度。 */
export function logoLineWidth(value?: string): number {
	const glyphs = mapLogoLetters(value);
	return glyphs.reduce(
		(width, glyph, index) => width + (index === 0 ? 0 : LOGO_GAP) + visibleWidth(glyph.rows[0] ?? ""),
		0,
	);
}

function paint(line: string, style: (text: string) => string): string {
	let output = "";
	for (const character of line) output += character === " " ? character : style(character);
	return output;
}

/**
 * 按字母逐字形渲染 Logo：前 3 个字母使用 dim，其余字母使用 bold；
 * 每个字母均保持一字母一字形的映射关系。
 */
export function renderLogo(theme: Theme, value?: string): string[] {
	const glyphs = mapLogoLetters(value);
	const rowCount = glyphs[0]?.rows.length ?? 0;
	const dim = (text: string) => wrapDim(wrapFg(theme.muted)(text));
	const bright = (text: string) => wrapBold(wrapFg(theme.primary)(text));
	return Array.from({ length: rowCount }, (_, rowIndex) =>
		glyphs
			.map((glyph, glyphIndex) => paint(glyph.rows[rowIndex] ?? "", glyphIndex < 3 ? dim : bright))
			.join(" ".repeat(LOGO_GAP)),
	);
}
