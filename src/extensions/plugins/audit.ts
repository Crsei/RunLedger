import { resourceAudit } from "../integration/runtime-audit-adapter.ts";
import type { PluginDescriptor } from "./types.ts";

export function pluginStateAudit(input: { plugin: PluginDescriptor; sessionId: string; snapshotId: string; oldState: string; newState: string; occurredAt: string }) {
	return resourceAudit({ kind: "plugin.state/v1", sessionId: input.sessionId, snapshotId: input.snapshotId, descriptor: input.plugin.descriptor, occurredAt: input.occurredAt, payload: { source: input.plugin.descriptor.identity.source, oldState: input.oldState, newState: input.newState, digest: input.plugin.descriptor.manifest.combinedDigest, componentCounts: { skills: input.plugin.skillRoots.length, hooks: input.plugin.hookConfigs.length, mcp: input.plugin.mcpConfig ? 1 : 0 } } });
}
