/** 用户级 compact 默认值；一次操作冻结一次配置。 */
export interface CompactionSettings {
	readonly enabled: boolean;
	readonly nativeMode: "standalone" | "streaming";
	readonly pruneSuperseded: boolean;
	readonly dropUseless: boolean;
	readonly strategy: "single-pass" | "hierarchical" | "handoff" | "openai-responses-native";
	readonly retainRecentTokens: number;
	readonly maxSummaryTokens: number;
	readonly maxSummaryBytes: number;
	readonly maxModelCalls: number;
	readonly maxTotalInputTokens: number;
	readonly maxTotalOutputTokens: number;
	readonly maxLevels: number;
	readonly timeoutMs: number;
	readonly auto: boolean;
	readonly threshold: number;
	readonly thresholdTokens?: number;
	readonly reserveTokens?: number;
	readonly summaryModel?: { readonly provider: string; readonly id: string };
}

export const DEFAULT_COMPACTION_SETTINGS: CompactionSettings = Object.freeze({
	enabled: true, nativeMode: "standalone", pruneSuperseded: true, dropUseless: false, strategy: "single-pass", retainRecentTokens: 20_000,
	maxSummaryTokens: 4096, maxSummaryBytes: 32_000,
	maxModelCalls: 16, maxTotalInputTokens: 1_000_000, maxTotalOutputTokens: 65_536,
	maxLevels: 5, timeoutMs: 120_000, auto: false, threshold: 0.85,
});

export function parseCompactionSettings(value: unknown): CompactionSettings {
	if (value === undefined) return DEFAULT_COMPACTION_SETTINGS;
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("invalid compaction settings");
	const record = value as Record<string, unknown>;
	if (Object.hasOwn(record, "retainRecentTurns")) throw new Error("compaction retainRecentTurns was replaced by retainRecentTokens; set an explicit token budget");
	if (Object.keys(record).some((key) => !Object.hasOwn(DEFAULT_COMPACTION_SETTINGS, key) && !["summaryModel", "reserveTokens", "thresholdTokens"].includes(key))) throw new Error("unknown compaction setting");
	for (const key of ["reserveTokens", "thresholdTokens"] as const) {
		if (record[key] !== undefined && (typeof record[key] !== "number" || !Number.isSafeInteger(record[key]) || record[key] < 1 || record[key] > 4_000_000)) throw new Error(`invalid compaction ${key}`);
	}
	const merged = { ...DEFAULT_COMPACTION_SETTINGS, ...record };
	if ((merged.nativeMode !== "standalone" && merged.nativeMode !== "streaming") || typeof merged.pruneSuperseded !== "boolean" || typeof merged.dropUseless !== "boolean" || typeof merged.enabled !== "boolean" || typeof merged.auto !== "boolean" || (merged.strategy !== "single-pass" && merged.strategy !== "hierarchical" && merged.strategy !== "handoff" && merged.strategy !== "openai-responses-native")
		|| typeof merged.threshold !== "number" || !Number.isFinite(merged.threshold) || merged.threshold < 0.1 || merged.threshold > 0.95) throw new Error("invalid compaction policy");
	const bounds = {
		retainRecentTokens: [1, 1_000_000], maxSummaryTokens: [32, 32_768], maxSummaryBytes: [128, 131_072],
		maxModelCalls: [1, 64], maxTotalInputTokens: [128, 4_000_000], maxTotalOutputTokens: [32, 262_144],
		maxLevels: [1, 8], timeoutMs: [1000, 600_000],
	} as const;
	for (const [key, [min, max]] of Object.entries(bounds)) {
		const number = merged[key as keyof typeof bounds];
		if (!Number.isSafeInteger(number) || number < min || number > max) throw new Error(`invalid compaction ${key}`);
	}
	if (merged.summaryModel !== undefined) {
		const model = merged.summaryModel;
		if (typeof model !== "object" || model === null || Array.isArray(model) || Object.keys(model).sort().join() !== "id,provider"
			|| typeof model.provider !== "string" || model.provider.length === 0 || model.provider.length > 128
			|| typeof model.id !== "string" || model.id.length === 0 || model.id.length > 256) throw new Error("invalid compaction summaryModel");
	}
	return Object.freeze({ ...merged, ...(merged.summaryModel === undefined ? {} : { summaryModel: Object.freeze({ ...merged.summaryModel }) }) });
}
