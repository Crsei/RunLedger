import type { Usage } from "../../types.ts";
import type { AgentMessage, AssistantAgentMessage } from "../types.ts";

export type UsageQuantitySource = "provider" | "replayed" | "metered" | "estimated";

export type UsageQuantity =
	| { readonly state: "exact" | "estimated"; readonly value: number; readonly source: UsageQuantitySource }
	| { readonly state: "unknown" | "unavailable" | "not-applicable"; readonly reason: string };

export interface UsageObservation {
	readonly id: string;
	readonly usage?: Usage;
	readonly source?: UsageQuantitySource;
	readonly durationMs?: number;
	readonly ttftMs?: number;
	readonly timingSource?: "provider" | "measured";
	readonly streamStartedAtMs?: number;
	readonly observedAtMs?: number;
	readonly status?: "streaming" | "completed" | "error" | "aborted";
}

export interface UsageAccumulator {
	readonly observations: Readonly<Record<string, UsageObservation>>;
	readonly latestRequestId?: string;
	readonly stickyRate?: UsageQuantity;
}

export interface UsageSnapshot {
	readonly cumulative: {
		readonly input: UsageQuantity;
		readonly output: UsageQuantity;
		readonly cacheRead: UsageQuantity;
		readonly cacheWrite: UsageQuantity;
		readonly tokenTotal: UsageQuantity;
		readonly cost: UsageQuantity;
	};
	readonly latestRequest?: {
		readonly input: UsageQuantity;
		readonly output: UsageQuantity;
		readonly cacheRead: UsageQuantity;
		readonly cacheWrite: UsageQuantity;
		readonly durationMs: UsageQuantity;
		readonly ttftMs: UsageQuantity;
		readonly outputTokensPerSecond: UsageQuantity;
	};
	readonly context?: {
		readonly usedTokens: UsageQuantity;
		readonly contextWindow: UsageQuantity;
		readonly percent: UsageQuantity;
	};
	readonly status: "idle" | "streaming" | "waiting" | "error" | "unavailable";
}

export interface UsageContextInput {
	readonly usedTokens?: number;
	readonly contextWindow?: number;
}

export interface UsageDisplaySegment {
	readonly accent: "usage" | "limit";
	readonly text: string;
}

export function createUsageAccumulator(): UsageAccumulator {
	return { observations: {} };
}

export function applyUsageObservation(state: UsageAccumulator, observation: UsageObservation): UsageAccumulator {
	let stickyRate = state.stickyRate;
	if (observation.status !== "error" && observation.status !== "aborted") {
		const usage = usageQuantity(observation.usage, "output", observation.source ?? "provider");
		const rate = calculateOutputTokensPerSecond({
			outputTokens: quantityValue(usage),
			providerDurationMs: observation.timingSource === "measured" ? undefined : observation.durationMs,
			measuredDurationMs: observation.timingSource === "measured" ? observation.durationMs : undefined,
			streamStartedAtMs: observation.streamStartedAtMs,
			nowMs: observation.observedAtMs,
			isStreaming: observation.status === "streaming",
		});
		if (rate !== null) {
			stickyRate = exact(rate, observation.timingSource === "provider" ? "provider" : "metered");
		}
	}
	return {
		observations: { ...state.observations, [observation.id]: observation },
		latestRequestId: observation.id,
		...(stickyRate === undefined ? {} : { stickyRate }),
	};
}

export function calculateOutputTokensPerSecond(input: {
	readonly outputTokens?: number;
	readonly providerDurationMs?: number;
	readonly measuredDurationMs?: number;
	readonly streamStartedAtMs?: number;
	readonly nowMs?: number;
	readonly isStreaming?: boolean;
}): number | null {
	if (!isSafeNumber(input.outputTokens) || input.outputTokens <= 0) return null;
	let durationMs: number | undefined;
	if (input.providerDurationMs !== undefined) durationMs = input.providerDurationMs;
	else if (input.measuredDurationMs !== undefined) durationMs = input.measuredDurationMs;
	else if (input.isStreaming === true && input.streamStartedAtMs !== undefined && input.nowMs !== undefined) {
		durationMs = input.nowMs - input.streamStartedAtMs;
	}
	if (!isSafeNumber(durationMs) || durationMs < 100) return null;
	const rate = input.outputTokens * 1_000 / durationMs;
	return Number.isFinite(rate) && rate >= 0 ? rate : null;
}

export function calculateCacheHitPercent(input: {
	readonly input?: number;
	readonly cacheRead?: number;
	readonly cacheWrite?: number;
}): number | null {
	if (!isSafeNumber(input.input) || !isSafeNumber(input.cacheRead) || !isSafeNumber(input.cacheWrite)) return null;
	const denominator = input.input + input.cacheRead + input.cacheWrite;
	if (!Number.isFinite(denominator) || denominator <= 0) return null;
	const percent = input.cacheRead / denominator * 100;
	return Number.isFinite(percent) && percent >= 0 ? percent : null;
}

export function usageSnapshot(
	state: UsageAccumulator,
	context: UsageContextInput | undefined,
	status: UsageSnapshot["status"],
): UsageSnapshot {
	const observations = Object.values(state.observations);
	const input = sumField(observations, "input");
	const output = sumField(observations, "output");
	const cacheRead = sumField(observations, "cacheRead");
	const cacheWrite = sumField(observations, "cacheWrite");
	const tokenTotal = addQuantities([input, output, cacheWrite], "token-total");
	const cost = sumField(observations, "cost");
	const latest = state.latestRequestId === undefined ? undefined : state.observations[state.latestRequestId];
	const latestRequest = latest === undefined ? undefined : {
		input: usageQuantity(latest.usage, "input", latest.source ?? "provider"),
		output: usageQuantity(latest.usage, "output", latest.source ?? "provider"),
		cacheRead: usageQuantity(latest.usage, "cacheRead", latest.source ?? "provider"),
		cacheWrite: usageQuantity(latest.usage, "cacheWrite", latest.source ?? "provider"),
		durationMs: timingQuantity(latest.durationMs, latest.timingSource === "measured" ? "metered" : "provider", "duration-not-reported"),
		ttftMs: timingQuantity(latest.ttftMs, "provider", "ttft-not-reported"),
		outputTokensPerSecond: state.stickyRate ?? unknown("rate-not-measured"),
	};
	const contextSnapshot = context === undefined ? undefined : {
		usedTokens: contextQuantity(context.usedTokens, "context-used-not-reported"),
		contextWindow: contextQuantity(context.contextWindow, "context-window-not-reported"),
		percent: contextPercent(context.usedTokens, context.contextWindow),
	};
	return {
		cumulative: { input, output, cacheRead, cacheWrite, tokenTotal, cost },
		...(latestRequest === undefined ? {} : { latestRequest }),
		...(contextSnapshot === undefined ? {} : { context: contextSnapshot }),
		status,
	};
}

export function formatUsageSegments(snapshot: UsageSnapshot): readonly UsageDisplaySegment[] {
	const segments: UsageDisplaySegment[] = [];
	const pushUsage = (text: string): void => { segments.push({ accent: "usage", text }); };
	const pushLimit = (text: string): void => { segments.push({ accent: "limit", text }); };
	const input = quantityValue(snapshot.cumulative.input);
	const output = quantityValue(snapshot.cumulative.output);
	const cacheRead = quantityValue(snapshot.cumulative.cacheRead);
	const cacheWrite = quantityValue(snapshot.cumulative.cacheWrite);
	const cost = quantityValue(snapshot.cumulative.cost);
	if (input !== undefined) pushUsage(`in ${formatTokenCount(input)}`);
	if (output !== undefined) pushUsage(`out ${formatTokenCount(output)}`);
	if (cacheRead !== undefined) pushUsage(`cache-read ${formatTokenCount(cacheRead)}`);
	if (cacheWrite !== undefined) pushUsage(`cache-write ${formatTokenCount(cacheWrite)}`);
	const hit = calculateCacheHitPercent({ input, cacheRead, cacheWrite });
	if (hit !== null) pushUsage(`hit ${formatPercent(hit)}%`);
	const rate = quantityValue(snapshot.latestRequest?.outputTokensPerSecond);
	if (rate !== undefined) pushUsage(`${rate.toFixed(1)} tok/s`);
	if (cost !== undefined) pushUsage(formatCost(cost));
	const context = snapshot.context;
	const used = quantityValue(context?.usedTokens);
	const window = quantityValue(context?.contextWindow);
	const percent = quantityValue(context?.percent);
	if (used !== undefined && window !== undefined && window > 0) {
		pushLimit(`ctx ${formatTokenCount(used)}/${formatTokenCount(window)}${percent === undefined ? "" : ` (${formatPercent(percent)}%)`}`);
	} else if (used !== undefined) {
		pushLimit(`ctx ${formatTokenCount(used)}`);
	} else if (window !== undefined && window > 0) {
		pushLimit(`ctx window ${formatTokenCount(window)}`);
	}
	return segments;
}

/** Replay seed and live projection share the same observation shape. */
export function usageObservationFromAssistantMessage(
	id: string,
	message: AssistantAgentMessage,
	source: UsageQuantitySource = "provider",
	status: UsageObservation["status"] = message.stopReason === "error" || message.stopReason === "aborted" ? "error" : "completed",
): UsageObservation {
	return {
		id,
		usage: message.usage,
		durationMs: message.durationMs,
		ttftMs: message.ttftMs,
		timingSource: message.timingSource,
		source,
		status,
	};
}

export function seedUsageAccumulator(messages: readonly AgentMessage[]): UsageAccumulator {
	let state = createUsageAccumulator();
	for (let index = 0; index < messages.length; index += 1) {
		const message = messages[index];
		if (message?.role !== "assistant") continue;
		state = applyUsageObservation(state, usageObservationFromAssistantMessage(`assistant:${index}`, message, "replayed"));
	}
	return state;
}

export function quantityValue(quantity: UsageQuantity | undefined): number | undefined {
	return quantity?.state === "exact" || quantity?.state === "estimated" ? quantity.value : undefined;
}

export function formatTokenCount(value: number): string {
	if (!isSafeNumber(value)) return "?";
	if (value < 1_000) return String(value);
	if (value < 1_000_000) return `${(value / 1_000).toFixed(1)}k`;
	return `${(value / 1_000_000).toFixed(1)}m`;
}

function formatCost(value: number): string {
	return `$${value.toFixed(2)}`;
}

function formatPercent(value: number): string {
	return value.toFixed(1);
}

function sumField(observations: readonly UsageObservation[], field: "input" | "output" | "cacheRead" | "cacheWrite" | "cost"): UsageQuantity {
	if (observations.length === 0) return unknown(`no-${field}`);
	return addQuantities(observations.map((observation) => usageQuantity(observation.usage, field, observation.source ?? "provider")), field);
}

function addQuantities(values: readonly UsageQuantity[], field: string): UsageQuantity {
	if (values.length === 0) return unknown(`no-${field}`);
	let total = 0;
	let source: UsageQuantitySource = "provider";
	for (const value of values) {
		if (!isKnownQuantity(value)) return unknown(`${field}:${value.reason}`);
		total += value.value;
		if (value.source === "replayed") source = "replayed";
		else if (value.source === "metered" && source === "provider") source = "metered";
		else if (value.source === "estimated" && source === "provider") source = "estimated";
	}
	return isSafeNumber(total) ? exact(total, source) : unavailable(`${field}:overflow`);
}

function usageQuantity(usage: Usage | undefined, field: "input" | "output" | "cacheRead" | "cacheWrite" | "cost", source: UsageQuantitySource): UsageQuantity {
	if (usage === undefined) return unknown("provider-did-not-report-usage");
	const value = field === "cost" ? usage.cost.total : usage[field];
	const reported = usage.reported?.[field];
	if (reported === false) return unknown(`${field}:not-reported`);
	if (!isSafeNumber(value)) return unavailable(`${field}:invalid`);
	if (value === 0 && reported !== true) return unknown(`${field}:presence-unknown`);
	return exact(value, source);
}

function timingQuantity(value: number | undefined, source: UsageQuantitySource, reason: string): UsageQuantity {
	if (value === undefined) return unknown(reason);
	return isSafeNumber(value) ? exact(value, source) : unavailable(`${reason}:invalid`);
}

function contextQuantity(value: number | undefined, reason: string): UsageQuantity {
	if (value === undefined) return unknown(reason);
	return isSafeNumber(value) ? exact(value, "metered") : unavailable(`${reason}:invalid`);
}

function contextPercent(used: number | undefined, window: number | undefined): UsageQuantity {
	if (!isSafeNumber(used) || !isSafeNumber(window)) return unknown("context-percent-unavailable");
	if (window <= 0) return unknown("context-window-not-positive");
	const percent = Math.min(100, used / window * 100);
	return Number.isFinite(percent) ? exact(percent, "metered") : unavailable("context-percent-invalid");
}

function exact(value: number, source: UsageQuantitySource): UsageQuantity {
	return { state: "exact", value, source };
}

function unknown(reason: string): UsageQuantity {
	return { state: "unknown", reason };
}

function unavailable(reason: string): UsageQuantity {
	return { state: "unavailable", reason };
}

function isSafeNumber(value: number | undefined): value is number {
	return value !== undefined && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
}

function isKnownQuantity(value: UsageQuantity): value is Extract<UsageQuantity, { readonly state: "exact" | "estimated" }> {
	return value.state === "exact" || value.state === "estimated";
}
