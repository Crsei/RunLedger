/**
 * Footer 组件 —— 屏幕底部一行的 status / hint / model 组合显示。
 *
 * 对照 development-doc/tui/02-component-spec.md §2。
 *
 * 设计:
 *   - Footer 不订阅事件,通过 FooterSnapshotProvider 在 render 时 pull 当前快照;
 *   - render(width) 返回单行字符串;
 *   - 主题由 props.theme 注入;使用 status / hint / muted 色槽;
 *   - 失败护栏:provider 任何方法抛错时,Footer 自身 catch 并展示 "[footer:err]"。
 */

import type { Component } from "../index.ts";
import type { Theme } from "../theme/theme.ts";
import type { FooterSnapshotProvider } from "../types.ts";
import { fitToWidth, padToWidth } from "./render-width.ts";
import { formatActiveDuration } from "../timeline/selectors.ts";
import type { PresentationBlock } from "../presentation.ts";
import type { StatusLineSegment } from "../highlight/status-style.ts";
import { sanitizeLabel } from "../presentation/projectors.ts";
import { visibleWidth } from "../primitives.ts";
import { formatUsageSegments } from "../../runtime/usage/index.ts";

const DEFAULT_SEPARATOR = " · ";

interface FooterDisplaySettings {
	readonly statusLine: {
		readonly preset: "default" | "compact" | "minimal";
		readonly separator: string;
		readonly sessionAccent: boolean;
	};
	readonly display: {
		readonly hideToolActivity: boolean;
		readonly showTokenUsage: boolean;
	};
}

export interface FooterProps {
  theme: Theme;
  /** InteractiveMode 实现的快照 provider;Footer 周期性 pull。 */
  provider: FooterSnapshotProvider;
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
			? [padToWidth(block.segments.map((segment) => segment.text).join(block.separator ?? DEFAULT_SEPARATOR), width)]
			: []);
	}

	present(width: number): PresentationBlock[] {
		try {
			const settings = this.displaySettings();
			const fitted = fitStatusLineSegments(this.segments(settings), width, settings.statusLine.separator);
			const separator = settings.statusLine.separator === DEFAULT_SEPARATOR ? {} : { separator: settings.statusLine.separator };
			const blocks: PresentationBlock[] = [{ kind: "status-line", segments: fitted, ...separator }];
			const usage = settings.display.showTokenUsage && settings.statusLine.preset !== "minimal"
				? this.usageSegments(width, settings.statusLine.separator)
				: [];
			if (usage.length > 0) blocks.push({ kind: "status-line", segments: usage, ...separator });
			return blocks;
		} catch {
			return [{ kind: "status-line", segments: [{ accent: "state", text: "[footer:err]" }] }];
		}
	}

	private segments(settings: FooterDisplaySettings): StatusLineSegment[] {
	    try {
      const streaming = this.props.provider.isStreaming();
      const stopReason = this.props.provider.getStopReason();
      const modelId = this.props.provider.getModelId();
      const providerId = this.props.provider.getProviderId?.();
      const thinking = this.props.provider.getThinkingLevel?.();
      const workspaceDisplayAbsolutePath = this.props.provider.getWorkspaceDisplayAbsolutePath?.();
      const gitBranchLabel = this.props.provider.getGitBranchLabel?.();
	      const planProgress = this.props.provider.getPlanProgress?.();
	      const contextUsage = settings.display.showTokenUsage && settings.statusLine.preset !== "minimal"
			? this.props.provider.getContextUsage?.()
			: undefined;
	      const usageSnapshot = settings.display.showTokenUsage && settings.statusLine.preset !== "minimal"
			? this.props.provider.getUsageSnapshot?.()
			: undefined;
      const threadLabel = this.props.provider.getThreadLabel?.();
      const timing = this.props.provider.getRunTiming?.();
      const now = this.props.provider.now?.() ?? Date.now();
      const activeDurationMs = timing === undefined
        ? 0
        : timing.activeDurationMs + (timing.state === "working" && timing.lastResumedAtMs !== undefined ? Math.max(0, now - timing.lastResumedAtMs) : 0);
      const status = timing?.state === "recovery_required"
        ? "Recovery required"
        : timing?.state === "working"
        ? `Working ${formatActiveDuration(activeDurationMs)}`
        : timing?.state === "waiting"
          ? `Waiting for input · ${formatActiveDuration(activeDurationMs)}`
          : streaming ? "..." : stopReason ? `done:${stopReason}` : "idle";
	  const segments: StatusLineSegment[] = [];
	  if (status !== "idle") segments.push({ accent: "state", text: status });
	  segments.push(
		...(workspaceDisplayAbsolutePath ? [{ accent: "path" as const, text: workspaceDisplayAbsolutePath }] : []),
		...(gitBranchLabel ? [{ accent: "branch" as const, text: gitBranchLabel }] : []),
		{ accent: "model", text: `${providerId ? `${providerId}/` : ""}${modelId}${thinking ? ` · think:${thinking}` : ""}` },
		...(settings.statusLine.preset !== "minimal" && !settings.display.hideToolActivity && planProgress !== undefined && validProgress(planProgress)
			? [{ accent: "progress" as const, text: `plan (${planProgress.completed}/${planProgress.total})` }]
			: []),
			...(settings.display.showTokenUsage && settings.statusLine.preset !== "minimal" && usageSnapshot === undefined && knownNonNegative(contextUsage?.totalTokens)
				? [{ accent: "usage" as const, text: `usage ${formatTokenCount(contextUsage.totalTokens)}` }]
				: []),
			...(settings.display.showTokenUsage && settings.statusLine.preset !== "minimal" && usageSnapshot === undefined && knownNonNegative(contextUsage?.totalTokens) && knownPositive(contextUsage.contextWindow)
				? [{ accent: "limit" as const, text: `limit ${Math.min(100, Math.round((contextUsage.totalTokens / contextUsage.contextWindow) * 100))}%` }]
			: []),
		...(settings.statusLine.preset !== "minimal" && settings.statusLine.sessionAccent && threadLabel ? [{ accent: "thread" as const, text: threadLabel }] : []),
	  );
	  const presetSegments = settings.statusLine.preset === "minimal"
		? segments.filter((segment) => segment.accent === "state" || segment.accent === "model")
		: settings.statusLine.preset === "compact"
			? segments.filter((segment) => segment.accent !== "path" && segment.accent !== "progress")
			: segments;
	  return presetSegments
		.map((segment) => ({ ...segment, text: sanitizeLabel(segment.text) }))
		.filter((segment) => segment.text.length > 0);
    } catch {
      // 失败护栏:provider 抛错时给出可观测的占位,不影响整屏渲染
      return [{ accent: "state", text: "[footer:err]" }];
	    }
  }

	private usageSegments(width: number, separator: string): StatusLineSegment[] {
		try {
			const snapshot = this.props.provider.getUsageSnapshot?.();
			if (snapshot === undefined) return [];
			const segments = formatUsageSegments(snapshot).map((segment) => ({ ...segment }));
			return fitUsageStatusLineSegments(segments, width, separator);
		} catch {
			return [];
		}
	}

	private displaySettings(): FooterDisplaySettings {
		return normalizeFooterDisplaySettings(this.props.provider.getDisplaySettings?.());
	}

}

export function formatTokenCount(value: number): string {
	if (value < 1_000) return String(value);
	if (value < 1_000_000) return `${(value / 1_000).toFixed(1)}k`;
	return `${(value / 1_000_000).toFixed(1)}m`;
}

function validProgress(progress: { readonly completed: number; readonly total: number }): boolean {
	return Number.isSafeInteger(progress.completed)
		&& Number.isSafeInteger(progress.total)
		&& progress.total > 0
		&& progress.completed >= 0
		&& progress.completed <= progress.total;
}

function knownNonNegative(value: number | undefined): value is number {
	return value !== undefined && Number.isFinite(value) && value >= 0;
}

function knownPositive(value: number | undefined): value is number {
	return value !== undefined && Number.isFinite(value) && value > 0;
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
export function fitStatusLineSegments(input: readonly StatusLineSegment[], width: number, separator = DEFAULT_SEPARATOR): StatusLineSegment[] {
	return fitStatusLineSegmentsWithRules(input, width, IDENTITY_DROP_RULES, safeSeparator(separator));
}

/** usage 行与 identity 行独立拟合，窄屏保留 output/rate/context 核心数值。 */
export function fitUsageStatusLineSegments(input: readonly StatusLineSegment[], width: number, separator = DEFAULT_SEPARATOR): StatusLineSegment[] {
	return fitStatusLineSegmentsWithRules(input, width, USAGE_DROP_RULES, safeSeparator(separator));
}

function fitStatusLineSegmentsWithRules(
	input: readonly StatusLineSegment[],
	width: number,
	dropRules: readonly ((segment: StatusLineSegment) => boolean)[],
	separator: string,
): StatusLineSegment[] {
	const safeWidth = Math.max(0, Math.floor(width));
	let segments = input
		.map((segment) => ({ ...segment, text: sanitizeLabel(segment.text) }))
		.filter((segment) => segment.text.length > 0);
	for (const shouldDrop of dropRules) {
		if (statusLineWidth(segments, separator) <= safeWidth) break;
		segments = segments.filter((segment) => !shouldDrop(segment));
	}
	while (segments.length > 1 && separatorWidth(segments, separator) >= safeWidth) segments.pop();
	let excess = Math.max(0, statusLineWidth(segments, separator) - safeWidth);
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
		excess = Math.max(0, statusLineWidth(segments, separator) - safeWidth);
	}
	return segments;
}

function statusLineWidth(segments: readonly StatusLineSegment[], separator: string): number {
	return segments.reduce((total, segment) => total + visibleWidth(segment.text), 0) + separatorWidth(segments, separator);
}

function separatorWidth(segments: readonly StatusLineSegment[], separator: string): number {
	return Math.max(0, segments.length - 1) * visibleWidth(separator);
}

function safeSeparator(value: string): string {
	return value.trim().length > 0 && value.length <= 16 && !/[\u0000-\u001f\u007f]/u.test(value)
		? value
		: DEFAULT_SEPARATOR;
}

function normalizeFooterDisplaySettings(value: unknown): FooterDisplaySettings {
	const raw = isRecord(value) ? value : {};
	const statusLine = isRecord(raw.statusLine) ? raw.statusLine : {};
	const display = isRecord(raw.display) ? raw.display : {};
	const preset = statusLine.preset === "compact" || statusLine.preset === "minimal" ? statusLine.preset : "default";
	const separator = typeof statusLine.separator === "string" ? safeSeparator(statusLine.separator) : DEFAULT_SEPARATOR;
	return {
		statusLine: {
			preset,
			separator,
			sessionAccent: statusLine.sessionAccent !== false,
		},
		display: {
			hideToolActivity: display.hideToolActivity === true,
			showTokenUsage: display.showTokenUsage !== false,
		},
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function minimumWidth(accent: StatusLineSegment["accent"]): number {
	if (accent === "model") return 12;
	if (accent === "path") return 8;
	if (accent === "metadata") return 16;
	return 4;
}
