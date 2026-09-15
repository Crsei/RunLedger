import { quantityValue, type UsageQuantity, type UsageSnapshot } from "../runtime/usage/index.ts";

export interface ExitSummary {
	readonly sessionId: string;
	readonly resumable: boolean;
	readonly usage: UsageSnapshot;
	readonly runledgerDir?: string;
}

/**
 * 在备用屏幕销毁并完成 detach 后输出，保留到终端正常滚动历史。
 * 空会话(未写入任何用户消息，退出时已被回收)不输出任何内容，返回空串。
 */
export function formatExitSummary(summary: ExitSummary): string {
	if (!summary.resumable) return "";
	const prefix = summary.runledgerDir === undefined ? "" : `RUNLEDGER_DIR=${shellQuote(summary.runledgerDir)} `;
	const lines = [
		"",
		"Disconnected from this session. The interactive turn is no longer running.",
		"",
		`Reconnect: ${prefix}runledger --session-id ${shellQuote(summary.sessionId)}`,
	];
	const usage = summary.usage.cumulative;
	let tokens = `Token usage so far: total=${formatQuantity(usage.tokenTotal)} input=${formatQuantity(usage.input)}`;
	if (quantityValue(usage.cacheRead) !== undefined) tokens += ` (+ ${formatQuantity(usage.cacheRead)} cached)`;
	if (quantityValue(usage.cacheWrite) !== undefined) tokens += ` cache-write=${formatQuantity(usage.cacheWrite)}`;
	tokens += ` output=${formatQuantity(usage.output)}`;
	if (quantityValue(usage.reasoning) !== undefined) tokens += ` (reasoning ${formatQuantity(usage.reasoning)})`;
	lines.push("", tokens, "");
	return lines.join("\n");
}

function formatQuantity(quantity: UsageQuantity | undefined): string {
	const value = quantityValue(quantity);
	return value === undefined ? "unknown" : `${quantity?.state === "estimated" ? "~" : ""}${value.toLocaleString("en-US")}`;
}

function shellQuote(value: string): string {
	return /^[a-zA-Z0-9_./:-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}
