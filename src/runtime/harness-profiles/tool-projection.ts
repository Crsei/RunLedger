/** Harness Profile 对 governed capability catalog 的纯投影。 */

import type { HarnessProfileDescriptor } from "./types.ts";
import type { AgentTool } from "../types.ts";
import { runtimeDigest, type RuntimeDigest } from "../protocol/foundation.ts";
import { createMinimalBashDelegate, HarnessToolProjectionError } from "./minimal-bash.ts";

const MINIMAL_V1_TOOL_MANIFEST_DIGEST = "3325e5598de3f84582ef89c65532a6c969355c3eb4821bd19c4529ea7bdacafc";

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
	if (result.manifestDigest.digest !== MINIMAL_V1_TOOL_MANIFEST_DIGEST) {
		throw new HarnessToolProjectionError(
			`minimal@1 tool manifest drift: ${result.manifestDigest.digest}`,
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
