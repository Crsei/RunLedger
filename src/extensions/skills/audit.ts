import { canonicalDigest } from "../../runtime/protocol/v3/canonical-json.ts";
import { resourceAudit } from "../integration/runtime-audit-adapter.ts";
import type { SkillDescriptor, SkillTrigger } from "./types.ts";

export function skillInvocationAudit(input: { skill: SkillDescriptor; sessionId: string; snapshotId: string; trigger: SkillTrigger; argument?: string; occurredAt: string }) {
	return resourceAudit({ kind: "skill.invocation/v1", sessionId: input.sessionId, snapshotId: input.snapshotId, descriptor: input.skill.descriptor, occurredAt: input.occurredAt, payload: { skillDigest: input.skill.bodyDigest, trigger: input.trigger, ...(input.argument ? { argumentDigest: canonicalDigest(input.argument), argumentPreview: input.argument.slice(0, 256) } : {}) } });
}
