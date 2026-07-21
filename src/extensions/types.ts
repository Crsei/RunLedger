/**
 * Extension domain 的 M0/M1 数据层。
 *
 * TODO(extension-M1): 增加 manifest/frontmatter 解析、exact identity、资源扫描
 * 和 trust receipt 投影。此文件不加载文件、不启动进程，也不连接 MCP SDK。
 */

import type { ResourceIdentity, ResourceProvenance } from "../runtime/resources/types.ts";

export type ExtensionKind = "plugin" | "skill" | "hook" | "mcp";
export type ExtensionSource = "builtin" | "user" | "project" | "plugin" | "session";

export interface ExtensionIdentity {
	kind: ExtensionKind;
	qualifiedId: string;
	version: string;
	source: ExtensionSource;
	digest: string;
}

export interface ExtensionResourceDescriptor {
	identity: ExtensionIdentity;
	resource: ResourceIdentity;
	provenance: ResourceProvenance;
	enabled: boolean;
	trusted: boolean;
	ready: boolean;
}

export interface ExtensionComponentCounts {
	plugins: number;
	skills: number;
	hooks: number;
	mcpServers: number;
	ready: number;
	blocked: number;
	error: number;
}
