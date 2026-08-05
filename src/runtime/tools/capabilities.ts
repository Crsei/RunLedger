/** Stable capability claims for builtin tools.
 *
 * The Host policy evaluates these claims, never the tool name.  A tool that
 * has no entry remains an unknown effect and is denied by active Plan Mode.
 */

import type { CapabilityClaim, CapabilityName } from "../protocol/capability.ts";
import { runtimeDigest } from "../protocol/foundation.ts";
import type { AgentTool } from "../types.ts";

type ClaimKind = Extract<CapabilityName, "repository_read" | "workspace_write" | "process" | "network">;

const READ_TOOLS = new Set(["read", "grep", "find", "glob", "ls"]);
const WRITE_TOOLS = new Set(["write", "edit", "MultiEdit", "TodoWrite"]);
const PROCESS_TOOLS = new Set(["bash", "process_output", "process_wait", "write_stdin", "process_stop", "process_resize"]);

export function builtinCapabilityClaims(toolName: string): readonly CapabilityClaim[] | undefined {
	const name: ClaimKind | undefined = READ_TOOLS.has(toolName)
		? "repository_read"
		: WRITE_TOOLS.has(toolName)
			? "workspace_write"
			: PROCESS_TOOLS.has(toolName)
				? "process"
				: toolName === "WebFetch" ? "network" : undefined;
	if (name === undefined) return undefined;
	const resourceKind = name === "repository_read" || name === "workspace_write" ? "filesystem" : name === "network" ? "network" : "process";
	return [{
		name,
		resourceKind,
		resourceDigest: runtimeDigest({ builtin: toolName, resourceKind }),
		constraintsDigest: runtimeDigest({ builtin: toolName, capability: name }),
		scope: "invocation",
	}];
}

export function withBuiltinCapabilityClaims<T extends AgentTool>(tool: T): T {
	const claims = builtinCapabilityClaims(tool.name);
	return claims === undefined ? tool : { ...tool, capabilityClaims: claims } as T;
}
