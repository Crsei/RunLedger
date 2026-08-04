const MAX_ESTIMATE = 4_194_304;

export interface ProviderUsageSample {
	readonly inputChars: number;
	readonly inputBytes: number;
	readonly inputTokens: number;
}

function clampEstimate(value: number): number {
	if (!Number.isFinite(value) || value < 0) return MAX_ESTIMATE;
	return Math.min(MAX_ESTIMATE, Math.ceil(value));
}

/** UTF-8 字节上界估算；对多字节文本保持保守，不依赖 provider tokenizer。 */
export function conservativeTokenEstimate(content: string): number {
	if (content.length === 0) return 0;
	const bytes = Buffer.byteLength(content, "utf8");
	return clampEstimate(Math.max(content.length / 3, bytes / 3) + 8);
}

export class TokenEstimator {
	#tokensPerByte = 1 / 3;

	public observe(sample: ProviderUsageSample): void {
		if (
			!Number.isSafeInteger(sample.inputChars) || sample.inputChars < 0 ||
			!Number.isSafeInteger(sample.inputBytes) || sample.inputBytes <= 0 ||
			!Number.isSafeInteger(sample.inputTokens) || sample.inputTokens < 0
		) return;
		const observed = sample.inputTokens / sample.inputBytes;
		if (!Number.isFinite(observed) || observed <= 0 || observed > 4) return;
		// 只允许提高保守度，异常或缺失 receipt 不会降低安全边界。
		this.#tokensPerByte = Math.max(this.#tokensPerByte, observed * 1.1);
	}

	public estimate(content: string): number {
		const fallback = conservativeTokenEstimate(content);
		const calibrated = clampEstimate(Buffer.byteLength(content, "utf8") * this.#tokensPerByte + 8);
		return Math.max(fallback, calibrated);
	}
}
