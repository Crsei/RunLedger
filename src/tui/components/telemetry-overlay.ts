import { matchesKey, type Component } from "../index.ts";
import { fitLinesToWidth } from "./render-width.ts";
import type { PresentationBlock } from "../presentation.ts";
import type { SessionId } from "../../runtime/protocol/ids.ts";
import type { LocalTelemetryQuery } from "../../runtime/telemetry/local/query.ts";
import type { SessionTelemetryReport, TelemetryMetric } from "../../runtime/telemetry/local/report.ts";
import type { ObservationUnit } from "../../runtime/telemetry/local/types.ts";

export interface TelemetryRefreshHandle {
	cancel(): void;
}

export type TelemetryRefreshScheduler = (
	refresh: () => void,
	intervalMs: number,
) => TelemetryRefreshHandle;

export interface TelemetryOverlayComponentOptions {
	readonly query: LocalTelemetryQuery;
	readonly sessionId: SessionId;
	readonly onClose?: () => void;
	readonly onChange?: () => void;
	readonly getViewportHeight?: () => number;
	readonly scheduleRefresh?: TelemetryRefreshScheduler;
}

const REFRESH_INTERVAL_MS = 1_000;

/**
 * `/telemetry` 的只读 projection。组件只消费 LocalTelemetryQuery，不接触
 * layout、文件路径或 settings；refresh 是有界的 1 Hz，不能被 stream chunk
 * 频率放大。关闭时取消 timer，active turn 继续由 Session Owner 执行。
 */
export class TelemetryOverlayComponent implements Component {
	private readonly query: LocalTelemetryQuery;
	private readonly sessionId: SessionId;
	private readonly onClose?: () => void;
	private readonly onChange?: () => void;
	private readonly getViewportHeight: () => number;
	private readonly scheduleRefresh: TelemetryRefreshScheduler;
	private report: SessionTelemetryReport | undefined;
	private errorCode: string | undefined;
	private loading = false;
	private active = false;
	private closed = false;
	private refreshing = false;
	private refreshHandle: TelemetryRefreshHandle | undefined;
	private scrollOffset = 0;

	public constructor(options: TelemetryOverlayComponentOptions) {
		this.query = options.query;
		this.sessionId = options.sessionId;
		this.onClose = options.onClose;
		this.onChange = options.onChange;
		this.getViewportHeight = options.getViewportHeight ?? (() => 16);
		this.scheduleRefresh = options.scheduleRefresh ?? defaultRefreshScheduler;
	}

	public async open(): Promise<void> {
		if (this.active || this.closed) return;
		this.active = true;
		await this.refreshNow();
		if (this.active && this.refreshHandle === undefined) {
			this.refreshHandle = this.scheduleRefresh(() => { void this.refreshNow(); }, REFRESH_INTERVAL_MS);
		}
	}

	public async refreshNow(): Promise<void> {
		if (!this.active || this.refreshing) return;
		this.refreshing = true;
		this.loading = this.report === undefined;
		this.errorCode = undefined;
		this.onChange?.();
		try {
			const result = await this.query.report({ sessionId: this.sessionId });
			if (!this.active) return;
			if (result.ok) {
				this.report = result.report;
				this.errorCode = undefined;
			} else {
				this.errorCode = result.code;
			}
		} catch {
			this.errorCode = "query_failed";
		} finally {
			this.loading = false;
			this.refreshing = false;
			this.onChange?.();
		}
	}

	public close(): void {
		if (this.closed) return;
		this.closed = true;
		this.active = false;
		this.refreshHandle?.cancel();
		this.refreshHandle = undefined;
		this.onClose?.();
	}

	public invalidate(): void {}

	public present(width: number): PresentationBlock[] {
		return [{ kind: "text", content: this.render(width).join("\n") }];
	}

	public render(width: number): string[] {
		const lines = this.report === undefined
			? this.loading
				? ["Telemetry", "Loading local observations…"]
				: ["Telemetry", `Unavailable: ${this.errorCode ?? "no_report"}`]
			: renderReport(this.report, width);
		const viewportHeight = Math.max(1, Math.floor(this.getViewportHeight()));
		const maxOffset = Math.max(0, lines.length - viewportHeight);
		this.scrollOffset = Math.min(this.scrollOffset, maxOffset);
		const visible = lines.slice(this.scrollOffset, this.scrollOffset + viewportHeight);
		if (maxOffset > 0) {
			visible.push(`(${this.scrollOffset + 1}-${Math.min(lines.length, this.scrollOffset + viewportHeight)}/${lines.length} · ↑↓/PgUp/PgDn · Esc closes)`);
		}
		return fitLinesToWidth(visible, width);
	}

	public handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.close();
			return;
		}
		const page = Math.max(1, Math.floor(this.getViewportHeight()) - 1);
		if (matchesKey(data, "up")) this.scroll(-1);
		else if (matchesKey(data, "down")) this.scroll(1);
		else if (matchesKey(data, "pageUp")) this.scroll(-page);
		else if (matchesKey(data, "pageDown")) this.scroll(page);
		else if (matchesKey(data, "home")) this.scrollOffset = 0;
		else if (matchesKey(data, "end")) this.scrollOffset = Number.MAX_SAFE_INTEGER;
		else return;
		this.onChange?.();
	}

	private scroll(delta: number): void {
		this.scrollOffset = Math.max(0, this.scrollOffset + delta);
	}
}

function defaultRefreshScheduler(refresh: () => void, intervalMs: number): TelemetryRefreshHandle {
	const timer = setInterval(refresh, intervalMs);
	if (typeof timer === "object" && timer !== null && "unref" in timer && typeof timer.unref === "function") timer.unref();
	return { cancel: () => clearInterval(timer) };
}

function renderReport(report: SessionTelemetryReport, width: number): string[] {
	const recording = report.source.trace.state === "recording_off" ? "disabled" : report.source.trace.state;
	const summary = [
		"Summary",
		`Recording: ${recording}`,
		`Session: ${report.sessionId}`,
		`Traces: ${report.summary.traceCount}`,
		`Duration: ${report.summary.durationMs === null ? "unavailable" : `${report.summary.durationMs}ms`}`,
		`Observations: ${report.summary.observationCount}`,
		`Turns/model calls: ${report.summary.turnCount}/${report.summary.modelCallCount}`,
	];
	const traffic = [
		"Traffic",
		metricLine("LLM HTTP", report.traffic.llmHttp.tx, report.traffic.llmHttp.rx),
		metricLine("LLM SSE", report.traffic.llmSse.tx, report.traffic.llmSse.rx),
		metricLine("LLM WebSocket", report.traffic.llmWebsocket.tx, report.traffic.llmWebsocket.rx),
		metricLine("MCP HTTP", report.traffic.mcpHttp.tx, report.traffic.mcpHttp.rx),
		metricLine("Governed HTTP", report.traffic.governedHttp.tx, report.traffic.governedHttp.rx),
		metricLine("Gateway", report.traffic.gateway.tx, report.traffic.gateway.rx),
		metricLine("Process stdin", report.traffic.processIo.stdin.observed, report.traffic.processIo.stdin.retained, "observed/retained"),
		metricLine("Process stdout", report.traffic.processIo.stdout.observed, report.traffic.processIo.stdout.retained, "observed/retained"),
		metricLine("Process stderr", report.traffic.processIo.stderr.observed, report.traffic.processIo.stderr.retained, "observed/retained"),
		metricLine("Process PTY", report.traffic.processIo.ptyOutput.observed, report.traffic.processIo.ptyOutput.retained, "observed/retained"),
	];
	const memory = [
		"Memory",
		peakMetricLine("Owner RSS", report.memory.runtimeRssBytes),
		peakMetricLine("V8 heap used", report.memory.runtimeHeapUsedBytes),
		peakMetricLine("Logical state", report.memory.logicalStateBytes),
		peakMetricLine("Context tokens", report.memory.contextCurrentTokens),
		peakMetricLine("Managed RSS", report.memory.managedProcessRssBytes),
		peakMetricLine("Managed PSS", report.memory.managedProcessPssBytes),
		peakMetricLine("Managed USS", report.memory.managedProcessUssBytes),
	];
	const progress = [
		"Progress",
		"Plan/Step/Attempt/Verification: unavailable (M4)",
	];
	const coverage = [
		"Coverage",
		...report.coverage.map((entry) => `  ${entry.key}: ${entry.state}${entry.reason === undefined ? "" : ` (${entry.reason})`}`),
	];
	if (width < 88) return ["Telemetry", ...summary, "", ...traffic, "", ...memory, "", ...progress, "", ...coverage];
	return ["Telemetry", ...twoColumn(summary, [...traffic, "", ...memory], width), "", ...twoColumn(progress, coverage, width)];
}

function twoColumn(left: readonly string[], right: readonly string[], width: number): string[] {
	const columnWidth = Math.max(20, Math.floor((Math.max(1, width) - 3) / 2));
	const rows = Math.max(left.length, right.length);
	return Array.from({ length: rows }, (_, index) => {
		const leftText = left[index] ?? "";
		const rightText = right[index] ?? "";
		return `${leftText.padEnd(columnWidth, " ")} │ ${rightText}`;
	});
}

function metricLine<TUnit extends ObservationUnit>(
	label: string,
	left: TelemetryMetric<TUnit>,
	right?: TelemetryMetric<TUnit>,
	rightLabel = "rx",
): string {
	if (right === undefined) return `  ${label}: ${quantityText(left)} samples=${left.sampleCount}`;
	return `  ${label}: tx=${quantityText(left)} ${rightLabel === "observed/retained" ? "retained" : "rx"}=${quantityText(right)} samples=${left.sampleCount}`;
}

function quantityText<TUnit extends ObservationUnit>(metric: TelemetryMetric<TUnit>): string {
	const quantity = metric.sum;
	return quantity.availability === "available" ? `${quantity.value}${quantity.unit === "bytes" ? "B" : ""}` : `unavailable:${quantity.reason}`;
}

function peakMetricLine<TUnit extends ObservationUnit>(label: string, metric: TelemetryMetric<TUnit>): string {
	const quantity = metric.peak;
	const value = quantity.availability === "available"
		? `${quantity.value}${quantity.unit === "bytes" ? "B" : ""}`
		: `unavailable:${quantity.reason}`;
	return `  ${label}: peak=${value} samples=${metric.sampleCount}`;
}
