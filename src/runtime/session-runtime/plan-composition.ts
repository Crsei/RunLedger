/** Session Owner Runtime 的 Plan Mode 被动状态投影。 */

import type { SessionStore } from "../../storage/session-store/session-store.ts";
import { isValidPlanModeState } from "../modes/plan/reducer.ts";
import type { PlanModeState } from "../modes/plan/types.ts";
import { runtimeDigest, type RuntimeDigest, type RuntimeStreamHead } from "../protocol/foundation.ts";
import { createRuntimeId, parseRuntimeId, type RepositoryId, type SessionId } from "../protocol/ids.ts";

const EMPTY_EVENT_HASH = runtimeDigest("runledger-empty-runtime-stream");

export interface SessionPlanInspection extends Readonly<Record<string, unknown>> {
	readonly repositoryId: RepositoryId;
	readonly state: PlanModeState;
}

export interface SessionPlanInspectionOptions {
	readonly sessionId: SessionId;
	readonly store: SessionStore;
	readonly policyCeilingDigest: RuntimeDigest;
}

/**
 * 从 Session catalog 与已校验的 append-only event head 重建未激活 Plan 状态。
 * 当前 Session Runtime 尚未开放 Plan mutation，因此不能产生 active 状态或
 * 伪造 plan artifact；一旦 mutation 接线，须改为重放 canonical Plan events。
 */
export function createSessionPlanInspection(options: SessionPlanInspectionOptions): () => SessionPlanInspection {
	return () => {
		const catalog = options.store.getSession(options.sessionId);
		if (catalog === undefined) throw new Error(`session not found during plan inspection: ${options.sessionId}`);
		const workspaceId = parseRuntimeId("workspace", catalog.workspaceId);
		const repositoryId = parseRuntimeId("repository", catalog.repositoryId);
		if (workspaceId === undefined || repositoryId === undefined) {
			throw new Error("session plan identity failed validation");
		}
		const events = options.store.replaySessionEvents(options.sessionId);
		const head = events.at(-1);
		const sourceHead: RuntimeStreamHead = {
			streamId: options.sessionId,
			sequence: head?.sequence ?? 0,
			eventHash: head === undefined
				? EMPTY_EVENT_HASH
				: { algorithm: "sha256", digest: head.currentEventHash as RuntimeDigest["digest"] },
		};
		const goalId = createRuntimeId("goal", runtimeDigest({ sessionId: options.sessionId, workspaceId }).digest.slice(0, 48));
		const updatedAt = new Date(head?.createdAtMs ?? catalog.createdAtMs).toISOString();
		const projection = {
			status: "inactive" as const,
			sessionId: options.sessionId,
			goalId,
			revision: 0,
			policyCeilingDigest: options.policyCeilingDigest,
			sourceHead,
			completeness: "complete" as const,
			updatedAt,
		};
		const state: PlanModeState = {
			...projection,
			projectionDigest: runtimeDigest(projection),
		};
		if (!isValidPlanModeState(state)) throw new Error("session plan projection failed validation");
		return { repositoryId, state };
	};
}
