/**
 * Goal Mode 的被动状态投影。
 *
 * 未启用 goal 的会话（minimal）与尚未建立 domain 的路径共用同一基线构造；
 * standard 会话由 SessionGoalDomain 重放 canonical goal events 提供 active 状态。
 */

import type { SessionStore } from "../../storage/session-store/session-store.ts";
import { createGoalBaseState } from "../modes/goal/reducer.ts";
import type { GoalModeState } from "../modes/goal/types.ts";
import { runtimeDigest, type RuntimeDigest, type RuntimeStreamHead } from "../protocol/foundation.ts";
import { createRuntimeId, parseRuntimeId, type RepositoryId, type SessionId } from "../protocol/ids.ts";

const EMPTY_EVENT_HASH = runtimeDigest("runledger-empty-runtime-stream");

export interface SessionGoalInspection extends Readonly<Record<string, unknown>> {
	readonly repositoryId: RepositoryId;
	readonly state: GoalModeState;
}

export interface SessionGoalInspectionOptions {
	readonly sessionId: SessionId;
	readonly store: SessionStore;
	readonly policyCeilingDigest: RuntimeDigest;
}

/** goal id 由 session 与 workspace 派生：一个 session 只有一个 root goal 槽位。 */
export function sessionGoalId(sessionId: SessionId, workspaceId: string): GoalModeState["goalId"] {
	return createRuntimeId("goal", runtimeDigest({ sessionId, workspaceId }).digest.slice(0, 48));
}

/**
 * 从 Session catalog 与已校验的 append-only event head 重建 inactive Goal 状态。
 * 该路径不产生目标，也不猜测历史 goal 事件。
 */
export function createSessionGoalInspection(options: SessionGoalInspectionOptions): () => SessionGoalInspection {
	return () => {
		const catalog = options.store.getSession(options.sessionId);
		if (catalog === undefined) throw new Error(`session not found during goal inspection: ${options.sessionId}`);
		const workspaceId = parseRuntimeId("workspace", catalog.workspaceId);
		const repositoryId = parseRuntimeId("repository", catalog.repositoryId);
		if (workspaceId === undefined || repositoryId === undefined) {
			throw new Error("session goal identity failed validation");
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
		return {
			repositoryId,
			state: createGoalBaseState({
				sessionId: options.sessionId,
				goalId: sessionGoalId(options.sessionId, catalog.workspaceId),
				policyCeilingDigest: options.policyCeilingDigest,
				sourceHead,
				updatedAt: new Date(head?.createdAtMs ?? catalog.createdAtMs).toISOString(),
			}),
		};
	};
}
