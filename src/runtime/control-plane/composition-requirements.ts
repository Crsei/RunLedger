/** Production Control Plane 的冻结最低 adapter 矩阵。 */

import { canonicalDigest } from "../protocol/v3/canonical-json.ts";
import {
	CONTROL_PLANE_FEATURES,
	type ControlPlaneFeature,
} from "./types.ts";

export const PRODUCTION_FEATURE_REQUIREMENTS_VERSION = 1 as const;

export const PRODUCTION_ADAPTER_KINDS = [
	"daemon_core",
	"event_store",
	"model_provider",
	"session_reader",
	"session_writer",
	"workspace",
	"capability_gateway",
	"approval",
	"sandbox",
	"artifact",
	"artifact_key_provider",
	"resource_catalog",
	"resource_invoker",
	"verifier_registry",
	"change_proposal",
	"credential_broker",
	"forge_provider",
	"human_gate",
	"managed_policy",
	"remote_executor",
	"telemetry_exporter",
	"event_delivery",
	"activity",
] as const;

export type ProductionAdapterKind = (typeof PRODUCTION_ADAPTER_KINDS)[number];

export interface ProductionFeatureRequirementRow {
	feature: ControlPlaneFeature;
	owner: ProductionAdapterKind;
	requiredAdapters: readonly ProductionAdapterKind[];
	allowDegradedOwner: boolean;
}

export interface ProductionFeatureRequirementsMatrixV1 {
	version: typeof PRODUCTION_FEATURE_REQUIREMENTS_VERSION;
	rows: readonly ProductionFeatureRequirementRow[];
	sessionMutationRequiredAdapters: readonly ProductionAdapterKind[];
	reservedAdapterKinds: readonly ProductionAdapterKind[];
}

export interface EffectiveProductionFeatureRequirementRow extends ProductionFeatureRequirementRow {
	enabled: boolean;
}

const adapterOrder = new Map(PRODUCTION_ADAPTER_KINDS.map((kind, index) => [kind, index] as const));

export function orderProductionAdapterKinds(
	kinds: readonly ProductionAdapterKind[],
): readonly ProductionAdapterKind[] {
	return [...new Set(kinds)].sort(
		(left, right) => (adapterOrder.get(left) ?? Number.MAX_SAFE_INTEGER) -
			(adapterOrder.get(right) ?? Number.MAX_SAFE_INTEGER),
	);
}

function row(
	feature: ControlPlaneFeature,
	owner: ProductionAdapterKind,
	requiredAdapters: readonly ProductionAdapterKind[],
	allowDegradedOwner = false,
): ProductionFeatureRequirementRow {
	return Object.freeze({
		feature,
		owner,
		requiredAdapters: Object.freeze(orderProductionAdapterKinds(requiredAdapters)),
		allowDegradedOwner,
	});
}

const rowsByFeature: Readonly<Record<ControlPlaneFeature, ProductionFeatureRequirementRow>> = {
	session: row("session", "session_reader", ["event_store", "session_reader"]),
	turn: row("turn", "session_writer", [
		"event_store",
		"model_provider",
		"session_writer",
		"workspace",
		"capability_gateway",
		"approval",
		"sandbox",
		"artifact",
		"artifact_key_provider",
		"resource_catalog",
		"resource_invoker",
		"verifier_registry",
	]),
	queue: row("queue", "session_writer", ["event_store", "session_reader", "session_writer"]),
	approval: row("approval", "approval", ["event_store", "capability_gateway", "approval"]),
	change_proposal: row("change_proposal", "forge_provider", [
		"event_store",
		"capability_gateway",
		"artifact",
		"artifact_key_provider",
		"verifier_registry",
		"change_proposal",
		"credential_broker",
		"forge_provider",
	]),
	human_gate: row("human_gate", "human_gate", [
		"event_store",
		"change_proposal",
		"human_gate",
		"managed_policy",
	]),
	artifact: row("artifact", "artifact", [
		"event_store",
		"capability_gateway",
		"artifact",
		"artifact_key_provider",
	]),
	event_subscription: row("event_subscription", "event_delivery", [
		"event_store",
		"session_reader",
		"event_delivery",
	]),
	activity: row("activity", "activity", ["event_store", "activity"]),
	health: row("health", "daemon_core", ["daemon_core"], true),
	shutdown: row("shutdown", "daemon_core", [
		"daemon_core",
		"event_store",
		"session_writer",
		"workspace",
		"capability_gateway",
		"approval",
		"sandbox",
		"artifact",
		"artifact_key_provider",
		"resource_invoker",
		"verifier_registry",
	]),
	consumer_checkpoint: row("consumer_checkpoint", "event_delivery", ["event_store", "event_delivery"]),
};

export const PRODUCTION_FEATURE_REQUIREMENTS_V1: ProductionFeatureRequirementsMatrixV1 = Object.freeze({
	version: PRODUCTION_FEATURE_REQUIREMENTS_VERSION,
	rows: Object.freeze(CONTROL_PLANE_FEATURES.map((feature) => rowsByFeature[feature])),
	sessionMutationRequiredAdapters: Object.freeze(orderProductionAdapterKinds([
		"event_store",
		"model_provider",
		"session_reader",
		"session_writer",
		"workspace",
		"capability_gateway",
		"approval",
		"sandbox",
		"artifact",
		"artifact_key_provider",
		"resource_catalog",
		"resource_invoker",
		"verifier_registry",
	])),
	reservedAdapterKinds: Object.freeze(orderProductionAdapterKinds([
		"managed_policy",
		"credential_broker",
		"forge_provider",
		"human_gate",
		"remote_executor",
		"telemetry_exporter",
	])),
});

export const PRODUCTION_FEATURE_REQUIREMENTS_V1_DIGEST = canonicalDigest(
	PRODUCTION_FEATURE_REQUIREMENTS_V1,
);

export function minimumProductionRequirement(
	feature: ControlPlaneFeature,
): ProductionFeatureRequirementRow {
	return rowsByFeature[feature];
}

export function defaultEffectiveProductionRequirements(): readonly EffectiveProductionFeatureRequirementRow[] {
	return PRODUCTION_FEATURE_REQUIREMENTS_V1.rows.map((minimum) => Object.freeze({
		...minimum,
		requiredAdapters: Object.freeze([...minimum.requiredAdapters]),
		enabled: true,
	}));
}

export function productionEffectiveRequirementsDigest(
	rows: readonly EffectiveProductionFeatureRequirementRow[],
): string {
	return canonicalDigest({
		featureMatrixVersion: PRODUCTION_FEATURE_REQUIREMENTS_VERSION,
		protocolMinimumMatrixDigest: PRODUCTION_FEATURE_REQUIREMENTS_V1_DIGEST,
		rows,
	});
}
