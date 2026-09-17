import type { Static } from "typebox";
import type { WebTrajectoryRecordSchema } from "@runledger/collab-web/contracts";
import type { TrajectoryRecord } from "../runtime/contracts/trajectory.ts";
import { safeText } from "../runtime/trajectory/projection.ts";
import { publicId } from "./timeline-projector.ts";

export function trajectoryDto(record: TrajectoryRecord): Static<typeof WebTrajectoryRecordSchema> {
  return { id: publicId(record.id), parentId: record.parentId ? publicId(record.parentId) : null,
    runId: publicId(record.runId), stepId: record.stepId ? publicId(record.stepId) : null,
    kind: record.kind, name: safeText(record.name, 512), summary: safeText(record.summary, 4096), state: record.state,
    provider: record.provider ?? null, model: record.model ?? null, startedAtMs: record.startedAtMs ?? null, endedAtMs: record.endedAtMs ?? null,
    durationMs: record.durationMs ?? null, ttftMs: record.ttftMs ?? null, inputTokens: record.inputTokens ?? null,
    outputTokens: record.outputTokens ?? null, cacheReadTokens: record.cacheReadTokens ?? null,
    costUsd: record.costUsd ?? null, usageSource: record.usageSource ?? null, costSource: record.costSource ?? null,
    source: record.source, input: record.input, output: record.output };
}
