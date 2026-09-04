/** Durable profile ref 到模型可见 composition 的纯解析。 */

import { runtimeDigest } from "../protocol/foundation.ts";
import type { AgentTool } from "../types.ts";
import { projectHarnessTools } from "./tool-projection.ts";
import { resolveHarnessProfile } from "./resolver.ts";
import type { HarnessProfileRef, ResolvedHarnessComposition } from "./types.ts";

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

export function resolveHarnessComposition(
	input: ResolveHarnessCompositionInput,
): ResolvedHarnessComposition {
	const resolved = resolveHarnessProfile(input.ref);
	if (!resolved.ok) throw new HarnessCompositionError(resolved.error.code, resolved.error.message);
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
	const compositionDigest = runtimeDigest({
		ref: resolved.ref,
		promptDigest,
		toolManifestDigest: projected.manifestDigest,
		contextPolicyDigest,
		extensions: resolved.descriptor.extensions,
		multiAgent: resolved.descriptor.multiAgent,
	});
	return Object.freeze({
		ref: resolved.ref,
		systemPrompt,
		tools: projected.tools,
		promptDigest,
		toolManifestDigest: projected.manifestDigest,
		contextPolicyDigest,
		compositionDigest,
	});
}
