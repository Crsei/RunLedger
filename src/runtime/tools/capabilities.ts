/** Stable capability claims for builtin tools.
 *
 * The Host policy evaluates these claims, never the tool name.  A tool that
 * has no entry remains an unknown effect and is denied by active Plan Mode.
 */

import type { CapabilityClaim, CapabilityName } from "../protocol/capability.ts";
import { runtimeDigest } from "../protocol/foundation.ts";
import type { AgentTool } from "../types.ts";

type ClaimKind = Extract<CapabilityName, "repository_read" | "workspace_write" | "process" | "network">;

// 只列实际注册的工具名:别名调用(历史 `find`)解析到 glob 实例,claims 随实例走。
const READ_TOOLS = new Set(["read", "grep", "glob", "ls"]);
/**
 * `ask` 是只读交互:不碰文件系统/进程/网络,只读用户输入,并且是 Plan Mode
 * 下唯一向用户澄清的通道(上游同为 approval `read` tier 且列入 Code Mode 顶层保留集)。
 * 因此归入 repository_read tier —— 这是当前 claim 表里唯一的「无副作用」类,
 * 缺 claim 会被 Plan Mode 当 unknown effect 一律 deny。
 * 注意 resourceKind 取 `filesystem` 是 claim 表的粗粒度桶(见 plan/policy.ts
 * 的 `repository_read + filesystem` 才允许的判定),不代表它真的读文件。
 */
const READ_INTERACTION_TOOLS = new Set(["ask"]);
const WRITE_TOOLS = new Set(["write", "edit", "MultiEdit", "todo", "manage_skill", "checkpoint", "rewind"]);
const PROCESS_TOOLS = new Set(["bash", "process_output", "process_wait", "write_stdin", "process_stop", "process_resize"]);

export function builtinCapabilityClaims(toolName: string): readonly CapabilityClaim[] | undefined {
	// `ask` 与 read/grep/glob/ls 同属只读 tier(理由见 READ_INTERACTION_TOOLS 注释)。
	const readOnly = READ_TOOLS.has(toolName) || READ_INTERACTION_TOOLS.has(toolName);
	const name: ClaimKind | undefined = readOnly
		? "repository_read"
		: WRITE_TOOLS.has(toolName)
			? "workspace_write"
			: PROCESS_TOOLS.has(toolName)
				? "process"
			: toolName === "WebFetch" || toolName === "web_search" || toolName === "github" || toolName === "image_gen" ? "network" : undefined;
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
