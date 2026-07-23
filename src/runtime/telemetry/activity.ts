/** Telemetry 复用 RuntimeActivity 的唯一 canonical schema/projector，不维护第二套 digest。 */

import type { RuntimeEventV3 } from "../protocol/v3/events.ts";
import { projectRuntimeActivityEvents } from "../activity/projection.ts";
import {
	RUNTIME_ACTIVITY_PROJECTION_SCHEMA_VERSION,
	type RuntimeActivityProjection,
	type RuntimeActivityResult,
} from "../activity/types.ts";

export {
	LEGACY_RUNTIME_ACTIVITY_PROJECTION_SCHEMA_VERSION,
	LegacyRuntimeActivityProjectionV1Schema,
	RUNTIME_ACTIVITY_PROJECTION_SCHEMA_VERSION,
	RuntimeActivityHeartbeatSchema,
	RuntimeActivityProjectionSchema,
	isLegacyRuntimeActivityProjectionV1,
	isRuntimeActivityProjection,
	runtimeActivityProjectionBody,
	runtimeActivityStatus,
} from "../activity/types.ts";
export type {
	LegacyRuntimeActivityProjectionV1,
	RuntimeActivityError,
	RuntimeActivityErrorCode,
	RuntimeActivityHeartbeat,
	RuntimeActivityLifecycle,
	RuntimeActivityProjection,
	RuntimeActivityResult,
	RuntimeActivityStatus,
} from "../activity/types.ts";

/** 兼容 telemetry public surface 的旧常量名；值对应 canonical v2。 */
export const RUNTIME_ACTIVITY_SCHEMA_VERSION = RUNTIME_ACTIVITY_PROJECTION_SCHEMA_VERSION;
export type RuntimeActivityState = RuntimeActivityProjection;

/** 兼容 telemetry public surface 的旧函数名；输入现在必须是完整 canonical session event chain。 */
export function projectRuntimeActivity(
	events: readonly RuntimeEventV3[],
): RuntimeActivityResult<RuntimeActivityProjection> {
	return projectRuntimeActivityEvents(events);
}
