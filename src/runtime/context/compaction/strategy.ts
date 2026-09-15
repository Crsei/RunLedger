import { isOpenAICompactionState, type OpenAICompactionState } from "../../../api/openai-compaction-state.ts";
/** 压缩策略只生成候选；提交与恢复由 Session Owner 管理。 */
import type { RuntimeDigest } from "../../protocol/foundation.ts";
import { formatRegistry, validSummaryFormat, type SummaryFormatId, type SummaryPromptInput } from "./summary-format.ts";
import { conservativeTokenEstimate } from "../token-estimator.ts";

export interface CompactionStrategyKey { readonly id: string; readonly version: number }
export interface CompactionLimits {
	readonly maxInputTokensPerCall: number;
	readonly maxSummaryTokens: number;
	readonly maxSummaryBytes: number;
	readonly maxModelCalls: number;
	readonly maxTotalInputTokens: number;
	readonly maxTotalOutputTokens: number;
	readonly maxLevels: number;
	readonly deadlineMs: number;
}
export interface CompactionStrategyInput {
	readonly inputDigest: RuntimeDigest;
	/** 每个字符串是已验证的完整稳定 turn；来源映射由调用者持有。 */
	readonly units: readonly string[];
	readonly previousSummary?: string;
	readonly focus?: string;
	readonly limits: CompactionLimits;
}
export type CompactionFailureCode = "strategy_unavailable" | "invalid_input" | "input_too_large" | "budget_exhausted" | "cancelled" | "model_failed" | "invalid_output";
export type SummaryResult = { readonly ok: true; readonly text: string } | { readonly ok: false; readonly code: CompactionFailureCode };
export interface SummaryModelPort {
	generate(input: SummaryPromptInput & { readonly maxOutputTokens: number; readonly signal: AbortSignal }): Promise<SummaryResult>;
}
export interface PortableCompactionCandidate {
	readonly kind: "portable-summary";
	readonly formatVersion: 1;
	readonly inputDigest: RuntimeDigest;
	readonly text: string;
}
export type CompactionCandidate = PortableCompactionCandidate | { readonly kind: "openai-responses-compaction"; readonly formatVersion: 1; readonly inputDigest: RuntimeDigest; readonly state: OpenAICompactionState };
export interface NativeCompactionPort { generate(signal: AbortSignal): Promise<CompactionCandidate> }
export type CompactionStrategyResult = { readonly ok: true; readonly candidate: CompactionCandidate } | { readonly ok: false; readonly code: CompactionFailureCode };
export interface CompactionStrategy {
	readonly key: CompactionStrategyKey;
	readonly outputKind: CompactionCandidate["kind"];
	readonly formatId: SummaryFormatId | undefined;
	generate(input: CompactionStrategyInput, context: { readonly model: SummaryModelPort; readonly signal: AbortSignal; readonly native?: NativeCompactionPort }): Promise<CompactionStrategyResult>;
}

export function validSummary(text: string, limits: Pick<CompactionLimits, "maxSummaryTokens" | "maxSummaryBytes">): boolean {
	return text.trim().length > 0 && Buffer.byteLength(text) <= limits.maxSummaryBytes && conservativeTokenEstimate(text) <= limits.maxSummaryTokens;
}

/** registry 不接受代码路径；未知版本不回退到另一个实现。 */
export class CompactionStrategyRegistry {
	private readonly strategies = new Map<string, CompactionStrategy>();
	public constructor(strategies: readonly CompactionStrategy[]) {
		for (const strategy of strategies) {
			const key = `${strategy.key.id}@${strategy.key.version}`;
			if (!/^[a-z][a-z0-9-]{0,63}$/u.test(strategy.key.id) || !Number.isSafeInteger(strategy.key.version) || strategy.key.version < 1 || this.strategies.has(key)) throw new Error("invalid or duplicate compaction strategy");
			if (strategy.outputKind === "portable-summary" ? strategy.formatId === undefined || !Object.hasOwn(formatRegistry, strategy.formatId) : strategy.formatId !== undefined) throw new Error("invalid compaction strategy format");
			this.strategies.set(key, Object.freeze({ ...strategy, key: Object.freeze({ ...strategy.key }) }));
		}
	}
	public list(): readonly CompactionStrategyKey[] { return [...this.strategies.values()].map((strategy) => ({ ...strategy.key })); }
	public async generate(key: CompactionStrategyKey, input: CompactionStrategyInput, model: SummaryModelPort, signal: AbortSignal, native?: NativeCompactionPort): Promise<CompactionStrategyResult> {
		const strategy = this.strategies.get(`${key.id}@${key.version}`);
		if (strategy === undefined) return { ok: false, code: "strategy_unavailable" };
		if (input.units.length === 0 || input.units.some((unit) => typeof unit !== "string" || unit.length === 0)
			|| Object.values(input.limits).some((limit) => !Number.isSafeInteger(limit) || limit < 1)) return { ok: false, code: "invalid_input" };
		if (signal.aborted || Date.now() >= input.limits.deadlineMs) return { ok: false, code: "cancelled" };
		try {
			// 策略得到独立冻结快照，不能修改其他策略或原始会话的输入。
			const frozen = Object.freeze({ ...input, units: Object.freeze([...input.units]), limits: Object.freeze({ ...input.limits }), inputDigest: Object.freeze({ ...input.inputDigest }) });
			const formatBoundModel: SummaryModelPort = { generate: async (request) => {
				if (strategy.formatId === undefined || (request.format !== strategy.formatId && !(strategy.formatId === "headings@1" && request.format === "headings-update@1"))) return { ok: false, code: "invalid_input" };
				return model.generate(request);
			} };
			const result = await strategy.generate(frozen, { model: formatBoundModel, signal, ...(native === undefined ? {} : { native }) });
			if (signal.aborted || Date.now() >= input.limits.deadlineMs) return { ok: false, code: "cancelled" };
			if (!result.ok) return result;
			const candidate = JSON.parse(JSON.stringify(result.candidate)) as CompactionCandidate;
			freezeCandidate(candidate);
			if (candidate.kind !== strategy.outputKind || candidate.formatVersion !== 1 || candidate.inputDigest.digest !== input.inputDigest.digest
				|| (candidate.kind === "portable-summary" ? strategy.formatId === undefined || !validSummary(candidate.text, input.limits) || !validSummaryFormat(strategy.formatId, candidate.text)
					: !isOpenAICompactionState(candidate.state) || Buffer.byteLength(JSON.stringify(candidate.state)) > input.limits.maxSummaryBytes || candidate.state.estimatedTokens > input.limits.maxSummaryTokens)) return { ok: false, code: "invalid_output" };
			return { ok: true, candidate };
		} catch { return { ok: false, code: "model_failed" }; }
	}
}

function freezeCandidate(value: unknown): void {
	if (value === null || typeof value !== "object") return;
	for (const child of Object.values(value)) freezeCandidate(child);
	Object.freeze(value);
}
