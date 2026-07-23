import { resourceAudit } from "../integration/runtime-audit-adapter.ts";
import type { McpServerDescriptor, McpServerState, McpToolDefinition } from "./types.ts";

export function mcpServerAudit(input: { server: McpServerDescriptor; sessionId: string; snapshotId: string; oldState: McpServerState; newState: McpServerState; reason?: string; durationMs: number; occurredAt: string }) {
	return resourceAudit({ kind: "mcp.server/v1", sessionId: input.sessionId, snapshotId: input.snapshotId, descriptor: input.server.descriptor, occurredAt: input.occurredAt, payload: { transport: input.server.config.transport, oldState: input.oldState, newState: input.newState, durationMs: input.durationMs, ...(input.reason ? { reason: input.reason } : {}) } });
}

export function mcpToolAudit(input: { server: McpServerDescriptor; tool: McpToolDefinition; sessionId: string; snapshotId: string; toolCallId: string; durationMs: number; resultSize: number; isError: boolean; occurredAt: string }) {
	return resourceAudit({ kind: "mcp.tool/v1", sessionId: input.sessionId, snapshotId: input.snapshotId, descriptor: input.server.descriptor, occurredAt: input.occurredAt, payload: { toolName: input.tool.rawName, runtimeName: input.tool.runtimeName, toolCallId: input.toolCallId, durationMs: input.durationMs, resultSize: input.resultSize, isError: input.isError } });
}
