import { describe, expect, it } from "vitest";
import {
	createProductionAdapterEvidence,
	createProductionCompositionReceipt,
	validateProductionCompositionReceipt,
	type ManagedPolicyCompositionRef,
	type ProductionAdapterEvidence,
	type ProductionAdapterKind,
} from "../../../src/daemon/production-composition.ts";
import {
	defaultEffectiveProductionRequirements,
	productionEffectiveRequirementsDigest,
	PRODUCTION_FEATURE_REQUIREMENTS_V1_DIGEST,
} from "../../../src/runtime/control-plane/composition-requirements.ts";
import { canonicalDigest } from "../../../src/runtime/protocol/v3/canonical-json.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/v3/ids.ts";
import type { ControlPlaneFeature } from "../../../src/runtime/control-plane/types.ts";

const ISSUED_AT = "2026-07-22T00:00:01.000Z";
const EXPIRES_AT = "2026-07-22T00:10:01.000Z";
const ADAPTER_EXPIRES_AT = "2026-07-22T00:20:01.000Z";
const VALIDATED_AT = new Date("2026-07-22T00:05:00.000Z");
const scope = {
	authorityId: createRuntimeId("authority", "production-composition"),
	tenantId: createRuntimeId("tenant", "production-composition"),
	serverInstanceId: createRuntimeId("runtime", "production-composition"),
	runtimeGeneration: 7,
};

function adapter(kind: ProductionAdapterKind, features: readonly ControlPlaneFeature[]) {
	return createProductionAdapterEvidence({
		kind,
		adapterId: `runledger.production.${kind}`,
		implementationId: `src/production/${kind}.ts#adapter`,
		implementationDigest: canonicalDigest({ kind, field: "implementation" }),
		configDigest: canonicalDigest({ kind, field: "config" }),
		generation: scope.runtimeGeneration,
		health: "healthy",
		features,
		probe: {
			status: "passed",
			checkedAt: ISSUED_AT,
			expiresAt: ADAPTER_EXPIRES_AT,
			evidenceDigest: canonicalDigest({ kind, field: "probe" }),
		},
		trust: {
			status: "trusted",
			issuerId: "runledger.production.trust",
			issuedAt: ISSUED_AT,
			expiresAt: ADAPTER_EXPIRES_AT,
			evidenceDigest: canonicalDigest({ kind, field: "trust" }),
		},
	});
}

function receipt(
	adapters: readonly ProductionAdapterEvidence[],
	options: {
		managedPolicyRef?: ManagedPolicyCompositionRef;
		effectiveRequirements?: ReturnType<typeof defaultEffectiveProductionRequirements>;
	} = {},
) {
	return createProductionCompositionReceipt({
		...scope,
		issuerId: "runledger.production.composer",
		issuedAt: ISSUED_AT,
		expiresAt: EXPIRES_AT,
		adapters,
		...(options.managedPolicyRef ? { managedPolicyRef: options.managedPolicyRef } : {}),
		...(options.effectiveRequirements ? { effectiveRequirements: options.effectiveRequirements } : {}),
	});
}

function validate(value: unknown, expected = scope) {
	return validateProductionCompositionReceipt(value, expected, { at: VALIDATED_AT });
}

function turnAdapters(): readonly ProductionAdapterEvidence[] {
	return [
		adapter("daemon_core", ["health", "shutdown"]),
		adapter("event_store", ["session", "turn", "queue", "approval", "artifact", "event_subscription", "activity"]),
		adapter("model_provider", ["turn"]),
		adapter("session_reader", ["session", "queue", "event_subscription"]),
		adapter("session_writer", ["session", "turn", "queue", "shutdown"]),
		adapter("workspace", ["session", "turn", "shutdown"]),
		adapter("capability_gateway", ["session", "turn", "approval", "artifact", "shutdown"]),
		adapter("approval", ["approval", "turn", "shutdown"]),
		adapter("sandbox", ["session", "turn", "shutdown"]),
		adapter("artifact", ["session", "turn", "artifact", "shutdown"]),
		adapter("artifact_key_provider", ["turn", "artifact", "shutdown"]),
		adapter("resource_catalog", ["turn"]),
		adapter("resource_invoker", ["turn", "shutdown"]),
		adapter("verifier_registry", ["session", "turn", "shutdown"]),
		adapter("event_delivery", ["event_subscription", "consumer_checkpoint"]),
		adapter("activity", ["activity"]),
	];
}

function policyRef(revision = 3): ManagedPolicyCompositionRef {
	return {
		policyId: "organization-production-policy",
		revision,
		receiptId: createRuntimeId("receipt", `managed-policy-${revision}`),
		snapshotDigest: canonicalDigest({ revision, kind: "snapshot" }),
		effectivePolicyDigest: canonicalDigest({ revision, kind: "effective" }),
	};
}

describe("production composition receipt", () => {
	it("keeps read-only session inspection while refusing every mutation without the full minimum adapter set", () => {
		const created = receipt([
			adapter("daemon_core", ["health"]),
			adapter("event_store", ["session"]),
			adapter("session_reader", ["session"]),
		]);
		expect(created.ok).toBe(true);
		if (!created.ok) return;
		const validated = validate(created.value);
		expect(validated).toMatchObject({
			ok: true,
			value: {
				features: ["session", "health"],
				queryTypes: ["session:inspect", "health"],
				sessionMutationReady: false,
			},
		});
		if (!validated.ok) return;
		expect(validated.value.commandTypes).toEqual([]);
	});

	it("derives the complete core command/query surface only from the frozen minimum matrix", () => {
		const created = receipt(turnAdapters());
		expect(created.ok).toBe(true);
		if (!created.ok) return;
		expect(created.value.protocolMinimumMatrixDigest).toBe(PRODUCTION_FEATURE_REQUIREMENTS_V1_DIGEST);
		const validated = validate(created.value);
		expect(validated.ok).toBe(true);
		if (!validated.ok) return;
		expect(validated.value.sessionMutationReady).toBe(true);
		expect(validated.value.commandTypes).toContain("turn:start");
		expect(validated.value.commandTypes).toContain("approval:resolve");
		expect(validated.value.commandTypes).toContain("shutdown");
		expect(validated.value.queryTypes).toContain("artifact:read");
		expect(validated.value.eventSubscription).toBe(true);
		expect(validated.value.features).not.toContain("change_proposal");
		expect(validated.value.features).not.toContain("human_gate");
	});

	it("advertises ChangeProposal and HumanGate only with enterprise owners and every minimum supporter", () => {
		const enterprise = [
			adapter("event_store", ["change_proposal", "human_gate"]),
			adapter("capability_gateway", ["change_proposal"]),
			adapter("artifact", ["change_proposal"]),
			adapter("artifact_key_provider", ["change_proposal"]),
			adapter("verifier_registry", ["change_proposal"]),
			adapter("change_proposal", ["change_proposal", "human_gate"]),
			adapter("credential_broker", ["change_proposal"]),
			adapter("forge_provider", ["change_proposal"]),
			adapter("human_gate", ["human_gate"]),
			adapter("managed_policy", ["human_gate"]),
		];
		const withoutPolicy = receipt(enterprise.filter((evidence) => evidence.kind !== "managed_policy"));
		if (!withoutPolicy.ok) throw new Error(withoutPolicy.error.message);
		expect(validate(withoutPolicy.value)).toMatchObject({
			ok: true,
			value: { features: ["change_proposal"] },
		});

		const complete = receipt(enterprise);
		if (!complete.ok) throw new Error(complete.error.message);
		const validated = validate(complete.value);
		expect(validated).toMatchObject({
			ok: true,
			value: { features: ["change_proposal", "human_gate"] },
		});
	});

	it("advertises multi_agent only with the frozen Supervisor and child-runtime evidence set", () => {
		const withoutChildFactory = receipt([
			...turnAdapters(),
			adapter("agent_supervisor", ["multi_agent"]),
		]);
		if (!withoutChildFactory.ok) throw new Error(withoutChildFactory.error.message);
		expect(validate(withoutChildFactory.value)).toMatchObject({
			ok: true,
			value: { features: expect.not.arrayContaining(["multi_agent"]) },
		});

		const complete = receipt([
			...turnAdapters(),
			adapter("agent_supervisor", ["multi_agent"]),
			adapter("child_runtime_factory", ["multi_agent"]),
		]);
		if (!complete.ok) throw new Error(complete.error.message);
		expect(validate(complete.value)).toMatchObject({
			ok: true,
			value: { features: expect.arrayContaining(["multi_agent"]) },
		});
	});

	it("rejects fake identities, expired trust, and caller-tampered advertisement or signature", () => {
		const fake = createProductionCompositionReceipt({
			...scope,
			issuerId: "runledger.test.composer",
			runtimeGeneration: scope.runtimeGeneration,
			issuedAt: ISSUED_AT,
			expiresAt: EXPIRES_AT,
			adapters: [adapter("daemon_core", ["health"])],
		});
		expect(fake).toMatchObject({ ok: false, error: { code: "adapter_contract_violation" } });

		const created = receipt([adapter("daemon_core", ["health"])]);
		if (!created.ok) throw new Error(created.error.message);
		expect(validate({ ...created.value, advertisedFeatures: ["health", "shutdown"] })).toMatchObject({
			ok: false,
			error: { code: "adapter_contract_violation" },
		});
		expect(validate({
			...created.value,
			signature: {
				...created.value.signature,
				value: created.value.signature.value.replace(/^./u, (value) => value === "A" ? "B" : "A"),
			},
		})).toMatchObject({ ok: false, error: { code: "adapter_contract_violation" } });
		expect(validate(created.value, scope)).toMatchObject({ ok: true });
		expect(validateProductionCompositionReceipt(created.value, scope, {
			at: new Date(EXPIRES_AT),
		})).toMatchObject({ ok: false, error: { code: "adapter_contract_violation" } });
	});
});

describe("production composition downgrade fixtures", () => {
	it("rejects old or unknown matrix versions and a forged protocol-minimum digest", () => {
		const created = receipt(turnAdapters());
		if (!created.ok) throw new Error(created.error.message);
		for (const featureMatrixVersion of [0, 2]) {
			expect(validate({ ...created.value, featureMatrixVersion })).toMatchObject({
				ok: false,
				error: { code: "adapter_contract_violation" },
			});
		}
		expect(validate({ ...created.value, protocolMinimumMatrixDigest: canonicalDigest("forged-minimum") })).toMatchObject({
			ok: false,
			error: { code: "adapter_contract_violation" },
		});
	});

	it("rejects a managed policy that removes a protocol-minimum adapter", () => {
		const weakened = defaultEffectiveProductionRequirements().map((row) => row.feature === "turn"
			? { ...row, requiredAdapters: row.requiredAdapters.filter((kind) => kind !== "artifact_key_provider") }
			: row);
		const created = createProductionCompositionReceipt({
			...scope,
			issuerId: "runledger.production.composer",
			runtimeGeneration: scope.runtimeGeneration,
			issuedAt: ISSUED_AT,
			expiresAt: EXPIRES_AT,
			managedPolicyRef: policyRef(),
			effectiveRequirements: weakened,
			adapters: turnAdapters(),
		});
		expect(created).toMatchObject({ ok: false, error: { code: "adapter_contract_violation" } });
	});

	it("rejects a stale managed-policy ref even when the signed receipt is otherwise valid", () => {
		const currentPolicy = policyRef(4);
		const created = receipt(turnAdapters(), { managedPolicyRef: currentPolicy });
		if (!created.ok) throw new Error(created.error.message);
		expect(validate(created.value, { ...scope, managedPolicyRef: policyRef(5) })).toMatchObject({
			ok: false,
			error: { code: "adapter_contract_violation" },
		});
		expect(validate(created.value, { ...scope, managedPolicyRef: currentPolicy })).toMatchObject({ ok: true });
	});

	it("rejects changing only a self-reported effective row even when its digest is recomputed", () => {
		const currentPolicy = policyRef();
		const created = receipt(turnAdapters(), { managedPolicyRef: currentPolicy });
		if (!created.ok) throw new Error(created.error.message);
		const changedRows = created.value.featureRequirements.map((row) => row.feature === "activity"
			? { ...row, enabled: false }
			: row);
		const tampered = {
			...created.value,
			featureRequirements: changedRows,
			effectiveRequirementsDigest: productionEffectiveRequirementsDigest(changedRows),
		};
		expect(validate(tampered, { ...scope, managedPolicyRef: currentPolicy })).toMatchObject({
			ok: false,
			error: { code: "adapter_contract_violation" },
		});
	});
});
