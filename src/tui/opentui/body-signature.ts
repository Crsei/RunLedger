/**
 * Timeline body 的 block 级签名。
 *
 * finalized part 只以 identity + contentGeneration 参与签名；活跃 part
 * 才计算正文的短摘要，并以原文作低代价碰撞兜底。这样单个 delta 不会
 * 为历史 part 重新执行 blockText/join。
 */

export interface BodySignatureInput {
	readonly key: string;
	readonly partId?: string;
	readonly kind: string;
	readonly streaming: boolean;
	readonly contentGeneration?: number;
	readonly finalized?: boolean;
	readonly contentKey: string;
}

export interface BodySignatureSnapshot {
	readonly signature: readonly string[];
	readonly changed: boolean;
	readonly changedKeys: readonly string[];
}

interface SignatureEntry {
	readonly token: string;
	readonly contentKey: string;
}

export class BodySignatureTracker {
	private previousOrder: readonly string[] = [];
	private readonly previousEntries = new Map<string, SignatureEntry>();

	update(inputs: readonly BodySignatureInput[]): BodySignatureSnapshot {
		const nextEntries = new Map<string, SignatureEntry>();
		const signature: string[] = [];
		const changedKeys: string[] = [];
		const changed = new Set<string>();

		for (const input of inputs) {
			const stable = input.finalized === true && input.contentGeneration !== undefined;
			const token = stable
				? stableToken(input)
				: liveToken(input);
			const entry: SignatureEntry = { token, contentKey: input.contentKey };
			nextEntries.set(input.key, entry);
			signature.push(token);

			const previous = this.previousEntries.get(input.key);
			if (previous === undefined || previous.token !== token || (!stable && previous.contentKey !== input.contentKey)) {
				changed.add(input.partId ?? input.key);
			}
		}

		for (const key of this.previousOrder) {
			if (!nextEntries.has(key)) changed.add(key);
		}
		for (const input of inputs) {
			const key = input.partId ?? input.key;
			if (changed.has(key)) changedKeys.push(key);
		}
		for (const key of this.previousOrder) {
			if (!nextEntries.has(key) && !changedKeys.includes(key)) changedKeys.push(key);
		}

		const orderChanged = inputs.length !== this.previousOrder.length
			|| inputs.some((input, index) => input.key !== this.previousOrder[index]);
		this.previousOrder = inputs.map((input) => input.key);
		this.previousEntries.clear();
		for (const [key, entry] of nextEntries) this.previousEntries.set(key, entry);

		return { signature, changed: orderChanged || changedKeys.length > 0, changedKeys };
	}
}

function stableToken(input: BodySignatureInput): string {
	return `${input.key}\u0000${input.kind}\u0000${input.streaming ? "1" : "0"}\u0000stable\u0000${input.contentGeneration}`;
}

function liveToken(input: BodySignatureInput): string {
	return `${input.key}\u0000${input.kind}\u0000${input.streaming ? "1" : "0"}\u0000live\u0000${input.contentGeneration ?? ""}\u0000${input.contentKey.length}\u0000${hashText(input.contentKey)}`;
}

function hashText(value: string): string {
	let hash = 2166136261;
	for (let index = 0; index < value.length; index += 1) {
		hash ^= value.charCodeAt(index);
		hash = Math.imul(hash, 16777619);
	}
	return (hash >>> 0).toString(16);
}
