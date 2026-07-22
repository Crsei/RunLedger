/** Resource lifecycle 的中立事件构造与 v3 payload 投影。 */

import { canonicalDigest } from "../protocol/v3/canonical-json.ts";
import { RuntimeContractError } from "../protocol/v3/errors.ts";
import type { RuntimeEventPayloadMap } from "../protocol/v3/event-payloads.ts";
import { isResourceIdentity, isResourceLifecycleEvent } from "./schemas.ts";
import type { ResourceLifecycleEvent, RuntimeResourceSnapshot } from "./types.ts";
import { RESOURCE_CONTRACT_SCHEMA_VERSION } from "./types.ts";

export const RESOURCE_EVENT_SCHEMA_VERSION = RESOURCE_CONTRACT_SCHEMA_VERSION;

type WithoutLifecycleDerivedFields<T> = T extends ResourceLifecycleEvent
	? Omit<T, "schemaVersion" | "identityDigest">
	: never;

export type CreateResourceLifecycleEventInput = WithoutLifecycleDerivedFields<ResourceLifecycleEvent>;

/**
 * lifecycle event 不携带 sequence/hash-chain；Event Store 在包装为 Runtime v3
 * envelope 时负责 eventId、sequence、hash 和 durable append。
 */
export function createResourceLifecycleEvent<T extends CreateResourceLifecycleEventInput>(
	input: T,
): Extract<ResourceLifecycleEvent, { state: T["state"] }> {
	if (!isResourceIdentity(input.identity)) {
		throw new RuntimeContractError({
			code: "invalid_schema",
			message: "resource lifecycle identity is invalid",
			retryable: false,
		});
	}
	const event = {
		...input,
		schemaVersion: RESOURCE_EVENT_SCHEMA_VERSION,
		identityDigest: canonicalDigest(input.identity),
	} as ResourceLifecycleEvent;
	if (!isResourceLifecycleEvent(event)) {
		throw new RuntimeContractError({
			code: "invariant_violation",
			message: "resource lifecycle event bindings are invalid",
			retryable: false,
		});
	}
	return event as Extract<ResourceLifecycleEvent, { state: T["state"] }>;
}

export function resourceLifecycleEventDigest(event: ResourceLifecycleEvent): string {
	if (!isResourceLifecycleEvent(event)) {
		throw new RuntimeContractError({
			code: "invalid_schema",
			message: "cannot digest an invalid resource lifecycle event",
			retryable: false,
		});
	}
	return canonicalDigest(event);
}

/** 只投影 v3 catalog 已拥有的 bounded 字段，不建立第二条资源事件链。 */
export function toResourceLifecycleRecordedPayload(
	event: ResourceLifecycleEvent,
): RuntimeEventPayloadMap["resource.lifecycle_recorded"] {
	if (!isResourceLifecycleEvent(event)) {
		throw new RuntimeContractError({
			code: "invalid_schema",
			message: "cannot project an invalid resource lifecycle event",
			retryable: false,
		});
	}
	return {
		resourceId: event.identity.resourceId,
		state: event.state,
		identityDigest: event.identityDigest,
		...(event.state === "approved" || event.state === "revoked" || event.state === "activated"
			? { receiptId: event.receiptId }
			: {}),
	};
}

export function toResourceSnapshotPayload(
	snapshot: RuntimeResourceSnapshot,
): RuntimeEventPayloadMap["resource.snapshot"] {
	return {
		snapshotId: snapshot.snapshotId,
		generation: snapshot.adapterGeneration,
		resourceCount: snapshot.resources.length,
		snapshotDigest: snapshot.digest,
	};
}
