/** 模型 composition 的 bounded receipt；不保存 prompt 或 extension 正文。 */

import { runtimeDigest } from "../protocol/foundation.ts";
import type {
	HarnessCompositionReceipt,
	HarnessProfileDescriptor,
	ResolvedHarnessComposition,
} from "./types.ts";

export function createHarnessCompositionReceipt(input: {
	readonly sessionId: string;
	readonly ownerGeneration: number;
	readonly descriptor: HarnessProfileDescriptor;
	readonly composition: ResolvedHarnessComposition;
}): HarnessCompositionReceipt {
	return Object.freeze({
		sessionId: input.sessionId,
		ownerGeneration: input.ownerGeneration,
		profile: input.composition.ref,
		promptDigest: input.composition.promptDigest,
		tools: Object.freeze(input.composition.tools.map((tool) => Object.freeze({
			name: tool.name,
			descriptorDigest: runtimeDigest({
				description: tool.description,
				parameters: tool.parameters,
			}),
		}))),
		toolManifestDigest: input.composition.toolManifestDigest,
		contextPolicyDigest: input.composition.contextPolicyDigest,
		extensions: input.descriptor.extensions,
		multiAgent: input.descriptor.multiAgent,
		compositionDigest: input.composition.compositionDigest,
	});
}
