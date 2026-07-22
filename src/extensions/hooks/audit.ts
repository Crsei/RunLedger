import { resourceAudit } from "../integration/runtime-audit-adapter.ts";
import type { HookDescriptor, HookRunOutcome } from "./types.ts";

export function hookRunAudit(input: { hook: HookDescriptor; outcome: HookRunOutcome; sessionId: string; snapshotId: string; eventId: string; occurredAt: string }) {
	return resourceAudit({ kind: "hook.run/v1", sessionId: input.sessionId, snapshotId: input.snapshotId, descriptor: input.hook.descriptor, occurredAt: input.occurredAt, payload: { eventId: input.eventId, decision: input.outcome.decision, status: input.outcome.status, failureMode: input.outcome.failureMode, durationMs: input.outcome.durationMs, exitCode: input.outcome.exitCode, inputDigest: input.outcome.inputDigest, stdoutDigest: input.outcome.stdoutDigest, stderrDigest: input.outcome.stderrDigest, ...(input.outcome.inputSpill ? { inputSpill: input.outcome.inputSpill } : {}), ...(input.outcome.outputSpill ? { outputSpill: input.outcome.outputSpill } : {}) } });
}
