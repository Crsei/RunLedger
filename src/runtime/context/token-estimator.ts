const MAX_ESTIMATE = 4_194_304;

export interface ProviderUsageSample {
	inputChars: number;
	inputBytes: number;
	inputTokens: number;
}

function clampEstimate(value: number): number {
	if (!Number.isFinite(value) || value < 0) return MAX_ESTIMATE;
	return Math.min(MAX_ESTIMATE, Math.ceil(value));
}

/** UTF-8 byte upper bound；对 CJK/emoji 比 chars/4 更保守。 */
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
		// 只允许把估算调得更保守，异常/缺失 receipt 不会降低安全边界。
		this.#tokensPerByte = Math.max(this.#tokensPerByte, observed * 1.1);
	}

	public estimate(content: string): number {
		const fallback = conservativeTokenEstimate(content);
		const calibrated = clampEstimate(Buffer.byteLength(content, "utf8") * this.#tokensPerByte + 8);
		return Math.max(fallback, calibrated);
	}
}
