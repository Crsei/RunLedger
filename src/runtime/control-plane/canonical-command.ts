/** schema v1/v2 mutation 共用的 canonical command journal 合同。 */

import type { CanonicalCommandType } from "../protocol/v3/coordination.ts";
import { Check } from "typebox/value";
import {
	ControlPlaneAgentMutationEffectV2Schema,
	type ControlPlaneAgentMutationEffectV2,
} from "./multi-agent-contracts.ts";
import {
	PlanContextMemoryMutationEffectV2Schema,
	type PlanContextMemoryMutationEffectV2,
} from "./plan-context-memory-contracts.ts";
import {
	isControlPlaneCommandEffect,
	type ControlPlaneCommandEffect,
} from "./types.ts";

export type CanonicalCommandEffect =
	| ControlPlaneCommandEffect
	| ControlPlaneAgentMutationEffectV2
	| PlanContextMemoryMutationEffectV2;

export function isControlPlaneAgentMutationEffectV2(
	value: unknown,
): value is ControlPlaneAgentMutationEffectV2 {
	return Check(ControlPlaneAgentMutationEffectV2Schema, value);
}

export function isCanonicalCommandEffect(
	value: unknown,
): value is CanonicalCommandEffect {
	return isControlPlaneCommandEffect(value) ||
		isControlPlaneAgentMutationEffectV2(value) ||
		Check(PlanContextMemoryMutationEffectV2Schema, value);
}

export function canonicalCommandEffectMatches(
	commandType: CanonicalCommandType,
	value: unknown,
): value is CanonicalCommandEffect {
	return isCanonicalCommandEffect(value) && value.type === commandType;
}
