/**
 * Resource lifecycle 的中立事件辅助函数。
 *
 * TODO(runtime-phase-5): 事件应接入 Runtime v3 catalog/event sink，并由上游
 * Event Store 负责 sequence、hash-chain 和 durability；本文件不自行写 ledger。
 */

import type { SnapshotId } from "../protocol/v3/ids.ts";
import type { ResourceIdentity, ResourceLifecycleEvent } from "./types.ts";

export const RESOURCE_EVENT_SCHEMA_VERSION = 1 as const;

export function createResourceLifecycleEvent(
	identity: ResourceIdentity,
	state: ResourceLifecycleEvent["state"],
	snapshotId: SnapshotId,
	reason?: string,
): ResourceLifecycleEvent {
	return {
		schemaVersion: RESOURCE_EVENT_SCHEMA_VERSION,
		identity,
		state,
		snapshotId,
		...(reason ? { reason } : {}),
	};
}
