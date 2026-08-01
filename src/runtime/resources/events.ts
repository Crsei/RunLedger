/**
 * Resource lifecycle 的中立事件辅助函数。
 *
 * TODO(runtime-phase-5): 事件应接入 Runtime catalog/event sink，并由上游
 * Event Store 负责 sequence、hash-chain 和 durability；本文件不自行写 ledger。
 */

import type { SnapshotId } from "../protocol/ids.ts";
import type { ResourceIdentity, ResourceLifecycleEvent } from "./types.ts";

export function createResourceLifecycleEvent(
	identity: ResourceIdentity,
	state: ResourceLifecycleEvent["state"],
	snapshotId: SnapshotId,
	reason?: string,
): ResourceLifecycleEvent {
	return {
		identity,
		state,
		snapshotId,
		...(reason ? { reason } : {}),
	};
}
