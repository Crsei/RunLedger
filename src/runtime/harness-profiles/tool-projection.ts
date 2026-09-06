/** Harness Profile 对 governed capability catalog 的纯投影。 */

import type { HarnessProfileDescriptor } from "./types.ts";
import type { AgentTool } from "../types.ts";
import { runtimeDigest, type RuntimeDigest } from "../protocol/foundation.ts";
import { createMinimalBashDelegate, HarnessToolProjectionError } from "./minimal-bash.ts";

const MINIMAL_MANIFESTS: Readonly<Record<number, string>> = {
	1: "3325e5598de3f84582ef89c65532a6c969355c3eb4821bd19c4529ea7bdacafc",
	2: "ae5d2f08cd47a0c48d2a1408eae36e4cac0376a3f8a7d9bc339b8894c2350712",
};

export interface HarnessToolProjection {
	readonly tools: readonly AgentTool[];
	readonly manifestDigest: RuntimeDigest;
}

export function projectHarnessTools(
	descriptor: HarnessProfileDescriptor,
	governedTools: readonly AgentTool[],
): HarnessToolProjection {
	if (descriptor.tools.mode === "standard") return projection(governedTools);

	const projected = descriptor.tools.allowlist.map((name) => {
		const matches = governedTools.filter((tool) => tool.name === name);
		if (matches.length !== 1) {
			throw new HarnessToolProjectionError(
				`minimal governed tool must exist exactly once: ${name} (found ${matches.length})`,
			);
		}
		const tool = matches[0]!;
		return name === "bash" ? createMinimalBashDelegate(tool) : tool;
	});
	const result = projection(projected);
	const expected = descriptor.id === "plan" ? "7b5b2a3c5e04a75321d057bbdc9dac200dc97878088e62427f49afb1c3640f5e" : MINIMAL_MANIFESTS[descriptor.version];
	if (result.manifestDigest.digest !== expected) {
		throw new HarnessToolProjectionError(
			`${descriptor.id}@${descriptor.version} tool manifest drift: ${result.manifestDigest.digest}`,
		);
	}
	return result;
}

function projection(tools: readonly AgentTool[]): HarnessToolProjection {
	const frozen = Object.freeze([...tools]);
	return Object.freeze({
		tools: frozen,
		manifestDigest: runtimeDigest(frozen.map((tool) => ({
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters,
		}))),
	});
}
