/** Harness Profile 对 governed capability catalog 的纯投影。 */

import type { HarnessProfileDescriptor } from "./types.ts";
import type { AgentTool } from "../types.ts";
import { runtimeDigest, type RuntimeDigest } from "../protocol/foundation.ts";
import { frozenToolManifest } from "./frozen-manifests.ts";
import { createMinimalBashDelegate, HarnessToolProjectionError } from "./minimal-bash.ts";

export interface HarnessToolProjection {
	readonly tools: readonly AgentTool[];
	readonly manifestDigest: RuntimeDigest;
}

export function projectHarnessTools(
	descriptor: HarnessProfileDescriptor,
	governedTools: readonly AgentTool[],
): HarnessToolProjection {
	// standard 直通:catalog 增长(新增模型可见工具)不改变本 profile 语义,故不 pin。
	if (descriptor.tools.mode === "standard") return projection(governedTools);

	const projected = descriptor.tools.allowlist.map((name) => {
		const matches = governedTools.filter((tool) => tool.name === name);
		if (matches.length !== 1) {
			throw new HarnessToolProjectionError(
				`governed tool must exist exactly once for ${descriptor.id}@${descriptor.version}: ${name} (found ${matches.length})`,
			);
		}
		const tool = matches[0]!;
		return name === "bash" ? createMinimalBashDelegate(tool) : tool;
	});
	const result = projection(projected);
	const frozen = frozenToolManifest(descriptor.id, descriptor.version);
	if (frozen === undefined) {
		throw new HarnessToolProjectionError(
			`${descriptor.id}@${descriptor.version} is an allowlist profile without a frozen tool manifest`,
		);
	}
	if (result.manifestDigest.digest !== frozen.raw) {
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
