/**
 * Presentation part 的稳定性契约。
 *
 * 这是 UI 派生状态，不写回 Timeline/session。generation 回退代表新的
 * retry/session lineage，旧 part 的缓存与投影不能继续复用。
 */

export interface PresentationPart {
	readonly entryId: string;
	readonly partId: string;
	readonly contentGeneration: number;
	readonly finalized: boolean;
}

export type PartGenerationTransition = "initial" | "same" | "advanced" | "rewound";

/** finalized 且仍属于同一 content generation 的 part 才能声明 byte-stable。 */
export function settled(part: PresentationPart, previous?: PresentationPart): boolean {
	if (!part.finalized) return false;
	if (previous === undefined) return true;
	return previous.finalized
		&& previous.partId === part.partId
		&& previous.contentGeneration === part.contentGeneration;
}

export function comparePartGeneration(previous: number, next: number): Exclude<PartGenerationTransition, "initial"> {
	if (next < previous) return "rewound";
	if (next > previous) return "advanced";
	return "same";
}

/** 以 partId 为键保留 presentation generation fence。 */
export class PartGenerationFence {
	private readonly generations = new Map<string, number>();

	observe(part: PresentationPart): PartGenerationTransition {
		const previous = this.generations.get(part.partId);
		if (previous === undefined) {
			this.generations.set(part.partId, part.contentGeneration);
			return "initial";
		}
		const transition = comparePartGeneration(previous, part.contentGeneration);
		if (transition !== "same") this.generations.set(part.partId, part.contentGeneration);
		return transition;
	}

	reset(): void {
		this.generations.clear();
	}
}
