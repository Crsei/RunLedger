/**
 * Footer 组件 —— 注册表驱动的多行参数展示。
 *
 * 对照 development-doc/tui/02-component-spec.md §2。
 *
 * 设计:
 *   - Footer 不订阅业务事件,通过 FooterSnapshotProvider 每帧 pull 一次快照;
 *   - 字段注册、排序和窄屏优先级由 FooterFieldRegistry 管理;
 *   - render(width) 返回零到多行纯文本 fallback;
 *   - 失败护栏:快照或投影失败时展示 "[footer:err]"。
 */

import type { Component } from "../index.ts";
import type { Theme } from "../theme/theme.ts";
import type { FooterSnapshotProvider } from "../types.ts";
import { fitToWidth, padToWidth } from "./render-width.ts";
import type { PresentationBlock } from "../presentation.ts";
import type { StatusLineSegment } from "../highlight/status-style.ts";
import { sanitizeLabel } from "../presentation/projectors.ts";
import { visibleWidth } from "../primitives.ts";
import { fitProjectedFooterRows, type FooterFieldRegistry } from "../footer/field-registry.ts";

export interface FooterProps {
  theme: Theme;
  /** InteractiveMode 实现的快照 provider;Footer 周期性 pull。 */
  provider: FooterSnapshotProvider;
  /** InteractiveMode 实例级动态字段目录。 */
  registry: FooterFieldRegistry;
}

export class Footer implements Component {
  private readonly props: FooterProps;

  constructor(props: FooterProps) {
    this.props = props;
  }

  invalidate(): void {
    // 无缓存
  }

  render(width: number): string[] {
	return this.present(width).flatMap((block) => block.kind === "status-line"
		? [padToWidth(block.segments.map((segment) => segment.text).join(" · "), width)]
		: []);
  }

  present(width: number): PresentationBlock[] {
		try {
			const snapshot = this.props.provider.getFooterSnapshot();
			return fitProjectedFooterRows(this.props.registry.project(snapshot).rows, width).map((row) => ({
				kind: "status-line" as const,
				segments: row.fields.map((field) => field.segment),
			}));
		} catch {
			return [{ kind: "status-line", segments: [{ accent: "state", text: "[footer:err]" }] }];
		}
	}

}

const OPTIONAL_DROP_ORDER: readonly StatusLineSegment["accent"][] = [
	"mode", "usage", "limit", "progress", "branch",
];

const IDENTITY_DROP_RULES: readonly ((segment: StatusLineSegment) => boolean)[] = OPTIONAL_DROP_ORDER.map((accent) =>
	(segment) => segment.accent === accent,
);

const USAGE_DROP_RULES: readonly ((segment: StatusLineSegment) => boolean)[] = [
	(segment) => segment.text.startsWith("$"),
	(segment) => segment.text.startsWith("hit "),
	(segment) => segment.text.startsWith("cache-read ") || segment.text.startsWith("cache-write "),
	(segment) => segment.text.startsWith("in "),
];

/** 保留 state/session-or-thread/path/model，窄屏先移除能力等可选段，再按显示列截断最长核心段。 */
export function fitStatusLineSegments(input: readonly StatusLineSegment[], width: number): StatusLineSegment[] {
	return fitStatusLineSegmentsWithRules(input, width, IDENTITY_DROP_RULES);
}

/** usage 行与 identity 行独立拟合，窄屏保留 output/rate/context 核心数值。 */
export function fitUsageStatusLineSegments(input: readonly StatusLineSegment[], width: number): StatusLineSegment[] {
	return fitStatusLineSegmentsWithRules(input, width, USAGE_DROP_RULES);
}

function fitStatusLineSegmentsWithRules(
	input: readonly StatusLineSegment[],
	width: number,
	dropRules: readonly ((segment: StatusLineSegment) => boolean)[],
): StatusLineSegment[] {
	const safeWidth = Math.max(0, Math.floor(width));
	let segments = input
		.map((segment) => ({ ...segment, text: sanitizeLabel(segment.text) }))
		.filter((segment) => segment.text.length > 0);
	for (const shouldDrop of dropRules) {
		if (statusLineWidth(segments) <= safeWidth) break;
		segments = segments.filter((segment) => !shouldDrop(segment));
	}
	while (segments.length > 1 && separatorWidth(segments) >= safeWidth) segments.pop();
	let excess = Math.max(0, statusLineWidth(segments) - safeWidth);
	while (excess > 0) {
		const candidate = segments
			.map((segment, index) => ({ index, width: visibleWidth(segment.text), minimum: minimumWidth(segment.accent) }))
			.filter((entry) => entry.width > entry.minimum)
			.sort((left, right) => (right.width - right.minimum) - (left.width - left.minimum))[0];
		if (candidate === undefined) break;
		const target = Math.max(candidate.minimum, candidate.width - excess);
		segments = segments.map((segment, index) => index === candidate.index
			? { ...segment, text: fitToWidth(segment.text, target) }
			: segment);
		excess = Math.max(0, statusLineWidth(segments) - safeWidth);
	}
	return segments;
}

function statusLineWidth(segments: readonly StatusLineSegment[]): number {
	return segments.reduce((total, segment) => total + visibleWidth(segment.text), 0) + separatorWidth(segments);
}

function separatorWidth(segments: readonly StatusLineSegment[]): number {
	return Math.max(0, segments.length - 1) * 3;
}

function minimumWidth(accent: StatusLineSegment["accent"]): number {
	if (accent === "model") return 12;
	if (accent === "path") return 8;
	if (accent === "metadata") return 16;
	return 4;
}
