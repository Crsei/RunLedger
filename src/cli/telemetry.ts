import type { EffectiveRecordingConfig } from "../storage/settings-manager.ts";
import type { RunledgerLayout } from "../runtime/contracts/storage-layout.ts";
import type { SessionId } from "../runtime/protocol/ids.ts";
import {
	createLocalTelemetryQuery,
	type LocalTelemetryQuery,
	type TelemetryQueryResult,
	type TelemetryReportRequest,
	type TelemetryStatusReport,
} from "../runtime/telemetry/local/query.ts";
import type { SessionTelemetryReport, TelemetryMetric } from "../runtime/telemetry/local/report.ts";

export type TelemetryOutputFormat = "table" | "json";

export type TelemetryCliCommand =
	| { readonly kind: "status"; readonly format: TelemetryOutputFormat }
	| { readonly kind: "report"; readonly selector: TelemetryReportRequest; readonly format: TelemetryOutputFormat };

export type TelemetryCliParseResult =
	| { readonly ok: true; readonly command: TelemetryCliCommand }
	| { readonly ok: false; readonly code: "missing_command" | "unknown_command" | "invalid_format" | "missing_value" | "selector_conflict" | "missing_selector"; readonly detail: string };

export class TelemetryCliError extends Error {
	public readonly code: Exclude<TelemetryCliParseResult, { readonly ok: true }>["code"] | "query_failed";

	public constructor(code: TelemetryCliError["code"], detail: string) {
		super(`${code}: ${detail}`);
		this.name = "TelemetryCliError";
		this.code = code;
	}
}

export interface RunTelemetryCommandOptions {
	readonly layout?: RunledgerLayout;
	readonly recording?: EffectiveRecordingConfig;
	readonly query?: LocalTelemetryQuery;
	readonly write?: (text: string) => void;
}

export function parseTelemetryArgs(argv: readonly string[]): TelemetryCliParseResult {
	const subcommand = argv[0];
	if (subcommand === undefined) return { ok: false, code: "missing_command", detail: "expected status or report" };
	if (subcommand !== "status" && subcommand !== "report") return { ok: false, code: "unknown_command", detail: subcommand };
	let format: TelemetryOutputFormat = "table";
	let session: string | undefined;
	let latest = false;
	for (let index = 1; index < argv.length; index += 1) {
		const arg = argv[index]!;
		if (arg === "--format") {
			const value = argv[++index];
			if (value === undefined) return { ok: false, code: "missing_value", detail: "--format" };
			if (value !== "table" && value !== "json") return { ok: false, code: "invalid_format", detail: value };
			format = value;
			continue;
		}
		if (subcommand === "report" && arg === "--session") {
			const value = argv[++index];
			if (value === undefined) return { ok: false, code: "missing_value", detail: "--session" };
			session = value;
			continue;
		}
		if (subcommand === "report" && arg === "--latest") {
			latest = true;
			continue;
		}
		return { ok: false, code: "unknown_command", detail: arg };
	}
	if (subcommand === "status") return { ok: true, command: { kind: "status", format } };
	if (session !== undefined && latest) return { ok: false, code: "selector_conflict", detail: "--session and --latest are mutually exclusive" };
	if (session === undefined && !latest) return { ok: false, code: "missing_selector", detail: "report requires --session <id> or --latest" };
	return {
		ok: true,
		command: {
			kind: "report",
			selector: latest ? { latest: true } : { sessionId: session as SessionId },
			format,
		},
	};
}

export async function runTelemetryCommand(argv: readonly string[], options: RunTelemetryCommandOptions): Promise<void> {
	const parsed = parseTelemetryArgs(argv);
	if (!parsed.ok) throw new TelemetryCliError(parsed.code, parsed.detail);
	const query = options.query ?? (options.layout === undefined ? undefined : createLocalTelemetryQuery({ layout: options.layout, recording: options.recording }));
	if (query === undefined) throw new TelemetryCliError("query_failed", "telemetry query is not configured");
	const output = parsed.command.kind === "status"
		? renderTelemetryStatus(await query.status(), parsed.command.format)
		: renderQueryResult(await query.report(parsed.command.selector), parsed.command.format);
	(options.write ?? ((text) => process.stdout.write(text))).call(undefined, `${output}\n`);
}

function renderQueryResult(result: TelemetryQueryResult, format: TelemetryOutputFormat): string {
	if (!result.ok) throw new TelemetryCliError("query_failed", result.code);
	return renderTelemetryReport(result.report, format);
}

export function renderTelemetryReport(report: SessionTelemetryReport, format: TelemetryOutputFormat): string {
	if (format === "json") return JSON.stringify(report, null, 2);
	const lines = [
		"Telemetry report",
		`Session: ${report.sessionId}`,
		`Traces: ${report.summary.traceCount} (${report.source.trace.state})`,
		`Duration: ${report.summary.durationMs === null ? "unavailable" : `${report.summary.durationMs}ms`}`,
		`Observations: ${report.summary.observationCount}`,
		`Turns/model calls: ${report.summary.turnCount}/${report.summary.modelCallCount}`,
		"",
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
		"",
		"Memory",
		peakMetricLine("Owner RSS", report.memory.runtimeRssBytes),
		peakMetricLine("V8 heap used", report.memory.runtimeHeapUsedBytes),
		peakMetricLine("Logical state", report.memory.logicalStateBytes),
		peakMetricLine("Managed RSS", report.memory.managedProcessRssBytes),
		peakMetricLine("Managed PSS", report.memory.managedProcessPssBytes),
		peakMetricLine("Managed USS", report.memory.managedProcessUssBytes),
		"",
		"Progress",
		"  unavailable (Plan/Step/Attempt/Verification is deferred to M4)",
		"",
		"Coverage",
		...report.coverage.map((entry) => `  ${entry.key}: ${entry.state}${entry.reason === undefined ? "" : ` (${entry.reason})`}`),
	];
	return lines.join("\n");
}

export function renderTelemetryStatus(status: TelemetryStatusReport, format: TelemetryOutputFormat): string {
	if (format === "json") return JSON.stringify(status, null, 2);
	return [
		"Telemetry status",
		`Recording: ${status.recording.mode} / ${status.recording.failurePolicy}`,
		`Local store: ${status.localStore.state}`,
		`Runtime memory: ${status.memory.runtime}`,
		`Managed process memory: ${status.memory.managedProcessTree}`,
		`OTel exporter: ${status.otelExporter.state}`,
		"Transport declarations:",
		...status.transportCoverage.map((entry) => `  ${entry.transport}: ${entry.state} (${entry.owner})`),
	].join("\n");
}

function metricLine(
	label: string,
	left: TelemetryMetric<"bytes">,
	right?: TelemetryMetric<"bytes">,
	rightLabel = "rx",
): string {
	const leftLabel = right === undefined ? "value" : rightLabel === "observed/retained" ? "observed" : "tx";
	const leftValue = quantityText(left);
	if (right === undefined) return `  ${label}: ${leftLabel}=${leftValue} samples=${left.sampleCount}`;
	return `  ${label}: ${leftLabel}=${leftValue} ${rightLabel === "observed/retained" ? "retained" : "rx"}=${quantityText(right)} samples=${left.sampleCount}`;
}

function quantityText(metric: TelemetryMetric<"bytes">): string {
	const quantity = metric.sum;
	return quantity.availability === "available" ? `${quantity.value}B` : `unavailable:${quantity.reason}`;
}

function peakMetricLine(label: string, metric: TelemetryMetric<"bytes">): string {
	const quantity = metric.peak;
	const value = quantity.availability === "available" ? `${quantity.value}B` : `unavailable:${quantity.reason}`;
	return `  ${label}: peak=${value} samples=${metric.sampleCount}`;
}
