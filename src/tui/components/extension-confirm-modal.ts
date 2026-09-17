/**
 * ExtensionConfirmModal —— extension 管理的二次确认边界。
 *
 * `trust`/`untrust` 不是可随手回退的 toggle：授予信任等于把该内容的执行权交给
 * host，撤销信任会让已就绪的 geneneration 立即失效。因此这类 mutation 必须先经
 * 一个显式确认视图，而不是单键直接生效；未来的 TUI install/upgrade/config 入口
 * 也复用同一个边界。
 *
 * 契约：`y`/Enter 确认、`n`/Esc/Ctrl+C 取消；渲染只有标题 + 有界明细 + 提示行，
 * 不持有任何 authority，也不自己执行 mutation（回调由 workflow 提供）。
 */

import type { Component } from "../primitives.ts";
import { matchesKey } from "../primitives.ts";
import { wrapBold, wrapDim } from "../theme/ansi.ts";
import { fitLinesToWidth, fitToWidth } from "./render-width.ts";

export interface ExtensionConfirmModalProps {
	readonly title: string;
	/** 有界明细行（调用方负责截断）；用于说明这次 mutation 的实际影响。 */
	readonly detailLines?: readonly string[];
	readonly onConfirm: () => void;
	readonly onCancel: () => void;
}

const FOOTER_HINT = "Press Enter or y to confirm; Esc or n to cancel";

export class ExtensionConfirmModal implements Component {
	private readonly props: ExtensionConfirmModalProps;

	constructor(props: ExtensionConfirmModalProps) {
		this.props = props;
	}

	invalidate(): void {
		// 无缓存。
	}

	handleInput(data: string): void {
		if (matchesKey(data, "enter") || matchesKey(data, "y")) {
			this.props.onConfirm();
			return;
		}
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || matchesKey(data, "n")) {
			this.props.onCancel();
		}
	}

	render(width: number): string[] {
		const lines: string[] = [wrapBold(this.props.title)];
		for (const detail of this.props.detailLines ?? []) lines.push(fitToWidth(wrapDim(detail), width));
		lines.push("", wrapDim(FOOTER_HINT));
		return fitLinesToWidth(lines, width);
	}
}
