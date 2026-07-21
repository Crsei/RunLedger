/**
 * Plan Mode schema guard。
 *
 * TODO(runtime-phase-6): 补齐合法 transition table、expected-revision conflict
 * 和 approval digest pin 的 TypeBox/golden contract。
 */

import type { PlanModeState } from "./types.ts";

export const PLAN_MODE_SCHEMA_VERSION = 1 as const;

export function isPlanModeState(value: unknown): value is PlanModeState {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return false;
	}
	const candidate = value as Record<string, unknown>;
	return (
		(candidate.status === "inactive" ||
			candidate.status === "pending" ||
			candidate.status === "active" ||
			candidate.status === "awaiting_approval" ||
			candidate.status === "exit_pending") &&
		typeof candidate.revision === "number" &&
		Number.isInteger(candidate.revision) &&
		candidate.revision >= 0 &&
		typeof candidate.updatedAt === "string"
	);
}
