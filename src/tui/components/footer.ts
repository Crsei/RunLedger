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
	return [padToWidth(fitStatusLineSegments(this.segments(), width).map((segment) => segment.text).join(" · "), width)];
  }

  present(width: number): PresentationBlock[] {
	const fitted = fitStatusLineSegments(this.segments(), width);
	return [{ kind: "status-line", segments: fitted }];
  }

  private segments(): StatusLineSegment[] {
    let left: string;
    let middle: string;
    let right: string;
    try {
      const streaming = this.props.provider.isStreaming();
      const stopReason = this.props.provider.getStopReason();
      const sessionId = this.props.provider.getSessionId();
      const modelId = this.props.provider.getModelId();
      const providerId = this.props.provider.getProviderId?.();
      const thinking = this.props.provider.getThinkingLevel?.();
      const workspaceCapability = this.props.provider.getWorkspaceCapability?.();
	  const workspaceDisplayAbsolutePath = this.props.provider.getWorkspaceDisplayAbsolutePath?.();
	  const gitBranchLabel = this.props.provider.getGitBranchLabel?.();
      const planProgress = this.props.provider.getPlanProgress?.();
      const contextUsage = this.props.provider.getContextUsage?.();
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
      left = status;
      middle = sessionId.length > 0 ? sessionId : "<no-session>";
	  const segments: StatusLineSegment[] = [
		{ accent: "state", text: status },
		...(workspaceDisplayAbsolutePath ? [{ accent: "path" as const, text: workspaceDisplayAbsolutePath }] : []),
		...(gitBranchLabel ? [{ accent: "branch" as const, text: gitBranchLabel }] : []),
		...(sessionId.length > 0 && !threadLabel ? [{ accent: "metadata" as const, text: sessionId }] : []),
		{ accent: "model", text: `${providerId ? `${providerId}/` : ""}${modelId}${thinking ? ` · think:${thinking}` : ""}` },
		...(workspaceCapability ? [{ accent: "mode" as const, text: workspaceCapability }] : []),
		...(planProgress !== undefined && validProgress(planProgress)
			? [{ accent: "progress" as const, text: `plan (${planProgress.completed}/${planProgress.total})` }]
			: []),
		...(knownNonNegative(contextUsage?.totalTokens)
			? [{ accent: "usage" as const, text: `usage ${formatTokenCount(contextUsage.totalTokens)}` }]
			: []),
		...(knownNonNegative(contextUsage?.totalTokens) && knownPositive(contextUsage.contextWindow)
			? [{ accent: "limit" as const, text: `limit ${Math.min(100, Math.round((contextUsage.totalTokens / contextUsage.contextWindow) * 100))}%` }]
			: []),
		...(threadLabel ? [{ accent: "thread" as const, text: threadLabel }] : []),
	  ];
	  return segments
		.map((segment) => ({ ...segment, text: sanitizeLabel(segment.text) }))
		.filter((segment) => segment.text.length > 0);
    } catch {
      // 失败护栏:provider 抛错时给出可观测的占位,不影响整屏渲染
      left = "[footer:err]";
      middle = "";
      right = "";
    }
	return [
		{ accent: "state", text: left },
		...(middle ? [{ accent: "metadata" as const, text: middle }] : []),
		...(right ? [{ accent: "model" as const, text: right }] : []),
	];
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

/** 保留 state/session-or-thread/path/model，窄屏先移除能力等可选段，再按显示列截断最长核心段。 */
export function fitStatusLineSegments(input: readonly StatusLineSegment[], width: number): StatusLineSegment[] {
	const safeWidth = Math.max(0, Math.floor(width));
	let segments = input
		.map((segment) => ({ ...segment, text: sanitizeLabel(segment.text) }))
		.filter((segment) => segment.text.length > 0);
	for (const accent of OPTIONAL_DROP_ORDER) {
		if (statusLineWidth(segments) <= safeWidth) break;
		segments = segments.filter((segment) => segment.accent !== accent);
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
	return segments.reduce((total, segment) => total + visibleWidth(segment.text), separatorWidth(segments));
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
