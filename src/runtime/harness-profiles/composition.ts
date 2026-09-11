/** Durable profile ref 到模型可见 composition 的纯解析。 */

import { runtimeDigest } from "../protocol/foundation.ts";
import type { AgentTool } from "../types.ts";
import { harnessToolReceiptTable } from "./tool-receipt-table.ts";
import { projectHarnessTools } from "./tool-projection.ts";
import { resolveHarnessProfile } from "./resolver.ts";
import type { HarnessProfileDescriptor, HarnessProfileRef, ResolvedHarnessComposition } from "./types.ts";

export interface ResolveHarnessCompositionInput {
	readonly ref: HarnessProfileRef;
	readonly systemPrompt: string;
	readonly governedTools: readonly AgentTool[];
}

export class HarnessCompositionError extends Error {
	public readonly code: string;

	public constructor(code: string, message: string) {
		super(message);
		this.name = "HarnessCompositionError";
		this.code = code;
	}
}

/** composition root 在创建有生命周期的资源前也使用同一基座校验。 */
export function assertAssembledPromptBase(descriptor: HarnessProfileDescriptor, systemPrompt: string): void {
	const fixedBase = descriptor.prompt.mode === "assembled" ? descriptor.prompt.text : undefined;
	if (fixedBase !== undefined && systemPrompt !== fixedBase && !systemPrompt.startsWith(`${fixedBase}\n\n`)) {
		throw new HarnessCompositionError("harness_prompt_override_conflict", "assembled prompt must preserve the profile's fixed base");
	}
}

export function resolveHarnessComposition(
	input: ResolveHarnessCompositionInput,
): ResolvedHarnessComposition {
	const resolved = resolveHarnessProfile(input.ref);
	if (!resolved.ok) throw new HarnessCompositionError(resolved.error.code, resolved.error.message);
	assertAssembledPromptBase(resolved.descriptor, input.systemPrompt);
	const systemPrompt = resolved.descriptor.prompt.mode === "complete"
		? resolved.descriptor.prompt.text!
		: input.systemPrompt;
	const projected = projectHarnessTools(resolved.descriptor, input.governedTools);
	const promptDigest = runtimeDigest({ mode: resolved.descriptor.prompt.mode, text: systemPrompt });
	const contextPolicyDigest = runtimeDigest({
		assembler: "assembleAgentModelContext@1",
		history: "selected",
		extensionSources: resolved.descriptor.extensions.context,
	});
	const manifestFormat = "descriptor-digests@1";
	const toolManifestDigest = runtimeDigest(harnessToolReceiptTable(projected.tools));
	const compositionDigest = runtimeDigest({
		manifestFormat,
		ref: resolved.ref,
		promptDigest,
		toolManifestDigest,
		contextPolicyDigest,
		extensions: resolved.descriptor.extensions,
		multiAgent: resolved.descriptor.multiAgent,
	});
	return Object.freeze({
		manifestFormat,
		ref: resolved.ref,
		systemPrompt,
		tools: projected.tools,
		promptDigest,
		toolManifestDigest,
		contextPolicyDigest,
		compositionDigest,
	});
}
