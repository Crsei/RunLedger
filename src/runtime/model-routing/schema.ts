/**
 * Model routing contract guard。
 *
 * TODO(runtime-phase-6): 使用 TypeBox schema 固定 unknown profile、manifest
 * drift 和 incompatible reasoning/tool protocol 的可审计错误。
 */

import type { ModelRouteDecision } from "./types.ts";

export function isModelRouteDecision(value: unknown): value is ModelRouteDecision {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return false;
	}
	const candidate = value as Record<string, unknown>;
	return (
		(candidate.outcome === "compatible" || candidate.outcome === "fork" || candidate.outcome === "deny") &&
		typeof candidate.targetModelId === "string" &&
		typeof candidate.reason === "string" &&
		typeof candidate.decisionDigest === "string"
	);
}
