import type { Component } from "../primitives.ts";
import { truncateToWidth, visibleWidth } from "../primitives.ts";
import type { Theme } from "../theme/theme.ts";
import { wrapBold, wrapDim, wrapFg } from "../theme/ansi.ts";
import { fitToWidth } from "./render-width.ts";
import { logoLineWidth, renderLogo } from "./logo.ts";
import { pickTip, renderWelcomeTip, TIPS } from "./welcome-tips.ts";

/** 固定槽位避免后台 catalog 刷新时改变 welcome 盒高。 */
export const WELCOME_SESSION_SLOTS = 4;

export interface RecentSession {
	readonly name: string;
	readonly timeAgo: string;
}

export interface WelcomeComponentProps {
	readonly version: string;
	readonly theme: Theme;
	readonly modelLabel?: string;
	readonly providerLabel?: string;
	readonly thinkingLabel?: string;
	readonly directoryLabel?: string;
	readonly branchLabel?: string;
	readonly recentSessions?: readonly RecentSession[];
}

/** 两栏启动页；窄终端仅保留左栏，盒下 Tip 保持同一宽度预算。 */
export class WelcomeComponent implements Component {
	readonly version: string;
	readonly theme: Theme;
	private modelLabel: string;
	private providerLabel: string;
	private readonly thinkingLabel: string;
	private readonly directoryLabel: string;
	private readonly branchLabel: string;
	private recentSessions: readonly RecentSession[];
	private selectedTip: string | undefined;
	private cachedWidth = -1;
	private cachedLines: string[] | undefined;

	constructor(props: WelcomeComponentProps) {
		this.version = props.version;
		this.theme = props.theme;
		this.modelLabel = props.modelLabel ?? "unknown";
		this.providerLabel = props.providerLabel ?? "unknown";
		this.thinkingLabel = props.thinkingLabel ?? "unknown";
		this.directoryLabel = props.directoryLabel ?? "unknown";
		this.branchLabel = props.branchLabel ?? "unknown";
		this.recentSessions = props.recentSessions ?? [];
	}

	get tip(): string | undefined {
		if (this.selectedTip === undefined) this.selectedTip = pickTip(TIPS, Math.random()) || undefined;
		return this.selectedTip;
	}

	invalidate(): void {
		this.cachedWidth = -1;
		this.cachedLines = undefined;
	}

	setModel(modelLabel: string, providerLabel: string): void {
		this.modelLabel = modelLabel;
		this.providerLabel = providerLabel;
		this.invalidate();
	}

	setRecentSessions(sessions: readonly RecentSession[]): void {
		this.recentSessions = sessions;
		this.invalidate();
	}

	render(width: number): string[] {
		if (this.cachedLines !== undefined && this.cachedWidth === width) return this.cachedLines;
		this.cachedLines = this.renderLines(width);
		this.cachedWidth = width;
		return this.cachedLines;
	}

	private renderLines(termWidth: number): string[] {
		const safeTermWidth = Math.max(0, Math.floor(termWidth));
		const boxWidth = Math.min(100, Math.max(0, safeTermWidth - 2));
		if (boxWidth < 4) return [];

		const dualContentWidth = boxWidth - 3;
		const minLeftCol = 12;
		const minRightCol = 20;
		const preferredLeftCol = Math.min(logoLineWidth() + 2, 46);
		const leftMinContentWidth = Math.max(
			minLeftCol,
			visibleWidth("Welcome back!"),
			visibleWidth(this.modelLabel),
			visibleWidth(this.providerLabel),
		);
		const desiredLeftCol = Math.min(preferredLeftCol, Math.max(minLeftCol, Math.floor(dualContentWidth * 0.4)));
		const dualLeftCol = dualContentWidth >= minRightCol + 1
			? Math.min(desiredLeftCol, dualContentWidth - minRightCol)
			: Math.max(1, dualContentWidth - 1);
		const dualRightCol = Math.max(1, dualContentWidth - dualLeftCol);
		const showRightColumn = boxWidth >= 60 && dualLeftCol >= leftMinContentWidth && dualRightCol >= minRightCol;
		const leftCol = showRightColumn ? dualLeftCol : boxWidth - 2;
		const rightCol = showRightColumn ? dualRightCol : 0;

		const border = (text: string) => wrapDim(wrapFg(this.theme.border)(text));
		const horizontal = (count: number) => border("─".repeat(Math.max(0, count)));
		const title = ` RunLedger v${this.version} `;
		const titlePrefix = "───";
		const titleSpace = boxWidth - 2;
		const styledTitle = border(titlePrefix) + wrapFg(this.theme.muted)(title);
		const titleWidth = visibleWidth(titlePrefix) + visibleWidth(title);
		const lines: string[] = [
			titleWidth >= titleSpace
				? border("┌") + truncateToWidth(styledTitle, titleSpace) + border("┐")
				: border("┌") + styledTitle + horizontal(titleSpace - titleWidth) + border("┐"),
		];

		const leftLines = [
			"",
			this.centerText(wrapBold("Welcome back!"), leftCol),
			"",
			...renderLogo(this.theme).map((line) => this.centerText(fitToWidth(line, leftCol), leftCol)),
			"",
			this.centerText(wrapFg(this.theme.muted)(this.modelLabel), leftCol),
			this.centerText(wrapFg(this.theme.secondary)(this.providerLabel), leftCol),
		];

		if (showRightColumn) {
			const sectionSeparator = ` ${horizontal(rightCol - 2)}`;
			const rightLines = [
				` ${wrapBold(wrapFg(this.theme.accent)("Quick keys"))}`,
				` ${wrapFg(this.theme.muted)("/")}${wrapFg(this.theme.hint)(" for commands")}`,
				` ${wrapFg(this.theme.muted)("Enter")}${wrapFg(this.theme.hint)(" to send")}`,
				` ${wrapFg(this.theme.muted)("Alt+Enter")}${wrapFg(this.theme.hint)(" to queue follow-up")}`,
				` ${wrapFg(this.theme.muted)("Ctrl+C")}${wrapFg(this.theme.hint)(" to interrupt")}`,
				` ${wrapFg(this.theme.muted)("Ctrl+D")}${wrapFg(this.theme.hint)(" to exit")}`,
				sectionSeparator,
				` ${wrapBold(wrapFg(this.theme.accent)("Session"))}`,
				this.sessionLine("model", this.modelLabel, rightCol),
				this.sessionLine("provider", this.providerLabel, rightCol),
				this.sessionLine("thinking", this.thinkingLabel, rightCol),
				this.sessionLine("dir", this.directoryLabel, rightCol),
				this.sessionLine("branch", this.branchLabel, rightCol),
				sectionSeparator,
				` ${wrapBold(wrapFg(this.theme.accent)("Recent sessions"))}`,
				...this.renderRecentLines(rightCol),
				"",
			];
			for (let index = 0; index < Math.max(leftLines.length, rightLines.length); index++) {
				lines.push(`${border("│")}${this.fitAndPad(leftLines[index] ?? "", leftCol)}${border("│")}${this.fitAndPad(rightLines[index] ?? "", rightCol)}${border("│")}`);
			}
			lines.push(`${border("└")}${horizontal(leftCol)}${border("┴")}${horizontal(rightCol)}${border("┘")}`);
		} else {
			for (const line of leftLines) lines.push(`${border("│")}${this.fitAndPad(line, leftCol)}${border("│")}`);
			lines.push(`${border("└")}${horizontal(leftCol)}${border("┘")}`);
		}

		lines.push(...renderWelcomeTip(this.tip ?? "", this.theme, boxWidth));
		return lines.map((line) => fitToWidth(line, safeTermWidth));
	}

	private sessionLine(label: string, value: string, width: number): string {
		return ` ${wrapFg(this.theme.muted)(label)}${wrapFg(this.theme.hint)(":")} ${wrapFg(this.theme.status)(fitToWidth(value, Math.max(0, width - 12)))}`;
	}

	private renderRecentLines(width: number): string[] {
		const lines: string[] = [];
		if (this.recentSessions.length === 0) {
			lines.push(` ${wrapDim(wrapFg(this.theme.muted)("No recent sessions"))}`);
		} else {
			for (const session of this.recentSessions.slice(0, WELCOME_SESSION_SLOTS)) {
				const prefix = " • ";
				const suffix = ` (${session.timeAgo})`;
				const nameBudget = Math.max(1, width - visibleWidth(prefix) - visibleWidth(suffix) - 1);
				const name = visibleWidth(session.name) > nameBudget
					? truncateToWidth(session.name, nameBudget)
					: session.name;
				lines.push(` ${wrapDim(wrapFg(this.theme.muted)(prefix))}${wrapFg(this.theme.hint)(name)}${wrapDim(wrapFg(this.theme.muted)(suffix))}`);
			}
		}
		while (lines.length < WELCOME_SESSION_SLOTS) lines.push("");
		return lines;
	}

	private centerText(text: string, width: number): string {
		const textWidth = visibleWidth(text);
		if (textWidth >= width) return text;
		const left = Math.floor((width - textWidth) / 2);
		return `${" ".repeat(left)}${text}${" ".repeat(width - textWidth - left)}`;
	}

	private fitAndPad(text: string, width: number): string {
		const fitted = fitToWidth(text, width);
		return fitted + " ".repeat(Math.max(0, width - visibleWidth(fitted)));
	}
}
