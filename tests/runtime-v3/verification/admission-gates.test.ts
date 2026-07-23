import { describe, expect, it } from "vitest";
import {
	dependencyAdmissionInputDigest,
	dependencyObservationDigest,
	evaluateDependencyAdmission,
} from "../../../src/runtime/verification/dependency-admission.ts";
import {
	SecretScanGate,
	secretScanContentDigest,
	secretScanCoverageDigest,
	secretScanInventoryDigest,
	secretScanItemDigest,
} from "../../../src/runtime/verification/secret-scan.ts";
import type {
	DependencyAdmissionInput,
	DependencyAdmissionPolicy,
	DependencyObservation,
	SecretScanContent,
	SecretScanCoverage,
	SecretScanInput,
	SecretScanPolicy,
	SecretScanScope,
} from "../../../src/runtime/verification/types.ts";
import {
	AUTHORITY_ID,
	CANDIDATE_COMMIT,
	FINISHED,
	NOW,
	REQUEST_ID,
	TENANT_ID,
	VERIFICATION_ID,
	dependencyPolicy,
	digest,
	secretScanPolicy,
} from "./helpers.ts";

const COLLECTOR_ID = "trusted-admission-collector";
const COLLECTOR_IDENTITY_DIGEST = digest("trusted-admission-collector-identity");
const GATE_DIGEST = digest("admission-gate");

function observation(
	overrides: Partial<Omit<DependencyObservation, "observationDigest">> = {},
): DependencyObservation {
	const body: Omit<DependencyObservation, "observationDigest"> = {
		packageName: "trusted-package",
		version: "1.2.3",
		registryId: "npmjs",
		source: "https://registry.npmjs.org/",
		registryIdentityDigest: digest("registry-npmjs"),
		integrityDigest: digest("trusted-package-integrity"),
		lockfileIntegrityDigest: digest("trusted-package-integrity"),
		lockfileEntryDigest: digest("trusted-package-lock-entry"),
		publishedAt: "2026-06-01T00:00:00.000Z",
		lifecycleScripts: [],
		...overrides,
	};
	return { ...body, observationDigest: dependencyObservationDigest(body) };
}

function dependencyInput(
	policy: DependencyAdmissionPolicy,
	dependencies: readonly DependencyObservation[],
	overrides: Partial<Omit<DependencyAdmissionInput, "evidenceDigest" | "dependencies" | "policyDigest" | "lockfile">> = {},
): DependencyAdmissionInput {
	const body: Omit<DependencyAdmissionInput, "evidenceDigest"> = {
		schemaVersion: 1,
		authorityId: AUTHORITY_ID,
		tenantId: TENANT_ID,
		requestId: REQUEST_ID,
		verificationId: VERIFICATION_ID,
		gateDigest: GATE_DIGEST,
		candidateCommit: CANDIDATE_COMMIT,
		policyDigest: policy.policyDigest,
		collectorId: COLLECTOR_ID,
		collectorIdentityDigest: COLLECTOR_IDENTITY_DIGEST,
		lockfile: policy.lockfileSource === "none"
			? { entryCount: dependencies.length, complete: true }
			: {
				path: policy.lockfilePath,
				observedDigest: policy.lockfileDigest,
				entryCount: dependencies.length,
				complete: true,
			},
		manifestInventoryDigest: digest("dependency-manifest-inventory"),
		manifestCount: 1,
		dependencies,
		truncated: false,
		collectedAt: NOW,
		...overrides,
	};
	return { ...body, evidenceDigest: dependencyAdmissionInputDigest(body) };
}

function secretItem(scope: SecretScanScope, content: string): SecretScanContent {
	return {
		scope,
		path: `${scope}/fixture.txt`,
		content,
		contentDigest: secretScanContentDigest(content),
	};
}

function secretInput(
	policy: SecretScanPolicy,
	items: readonly SecretScanContent[] = [],
	coveredScopes: readonly SecretScanScope[] = policy.requiredScopes,
	overrides: Partial<Omit<SecretScanInput, "coverage" | "items" | "inventoryDigest">> = {},
): SecretScanInput {
	const coverage: SecretScanCoverage[] = coveredScopes.map((scope) => {
		const itemDigests = items.filter((item) => item.scope === scope).map(secretScanItemDigest);
		const body: Omit<SecretScanCoverage, "inventoryDigest"> = {
			scope,
			complete: true,
			itemCount: itemDigests.length,
			itemDigests,
		};
		return { ...body, inventoryDigest: secretScanCoverageDigest(body) };
	});
	return {
		schemaVersion: 1,
		authorityId: AUTHORITY_ID,
		tenantId: TENANT_ID,
		requestId: REQUEST_ID,
		verificationId: VERIFICATION_ID,
		gateDigest: GATE_DIGEST,
		candidateCommit: CANDIDATE_COMMIT,
		policyDigest: policy.policyDigest,
		scannerId: COLLECTOR_ID,
		scannerIdentityDigest: COLLECTOR_IDENTITY_DIGEST,
		coverage,
		items,
		truncated: false,
		collectedAt: NOW,
		inventoryDigest: secretScanInventoryDigest(coverage),
		...overrides,
	};
}

describe("DependencyAdmissionPolicy", () => {
	it("treats observed dependencies under installMode none as a policy mismatch", () => {
		const policy = dependencyPolicy({
			installMode: "none",
			lockfileSource: "none",
			requireLockfileEntry: false,
			requireIntegrityDigest: false,
		});
		const result = evaluateDependencyAdmission(
			policy,
			dependencyInput(policy, [observation()]),
			{ clock: () => new Date(FINISHED) },
		);

		expect(result.ok && result.value.outcome).toBe("inconclusive");
		if (result.ok) expect(result.value.findings.map((finding) => finding.code)).toContain("policy_mismatch");
	});

	it("blocks lifecycle scripts instead of allowing them through dependency exceptions", () => {
		const policy = dependencyPolicy();
		const result = evaluateDependencyAdmission(
			policy,
			dependencyInput(policy, [observation({ lifecycleScripts: ["postinstall"] })]),
			{ clock: () => new Date(FINISHED) },
		);

		expect(result.ok && result.value.outcome).toBe("blocked");
		if (result.ok) expect(result.value.findings.map((finding) => finding.code)).toContain("lifecycle_script_present");
	});

	it("does not pass evidence from a different collector identity", () => {
		const policy = dependencyPolicy();
		const result = evaluateDependencyAdmission(
			policy,
			dependencyInput(policy, [observation()]),
			{
				clock: () => new Date(FINISHED),
				expectedCollectorId: COLLECTOR_ID,
				expectedCollectorIdentityDigest: digest("different-collector"),
			},
		);

		expect(result.ok && result.value.outcome).toBe("inconclusive");
		if (result.ok) expect(result.value.findings.map((finding) => finding.code)).toContain("policy_mismatch");
	});
});

describe("SecretScanGate", () => {
	it("does not pass tracked-workspace-only coverage", () => {
		const policy = secretScanPolicy();
		const result = new SecretScanGate({ clock: () => new Date(FINISHED) }).evaluate(
			policy,
			secretInput(policy, [], ["tracked_workspace"]),
		);

		expect(result.ok && result.value.outcome).toBe("inconclusive");
		if (result.ok) expect(result.value.reasonCodes).toContain("coverage_incomplete");
	});

	it("does not pass input bound to a different policy or scanner identity", () => {
		const policy = secretScanPolicy();
		const input = secretInput(policy);
		const changedPolicy = secretScanPolicy({ policyRevision: policy.policyRevision + 1 });
		const gate = new SecretScanGate({ clock: () => new Date(FINISHED) });

		const policyResult = gate.evaluate(changedPolicy, input);
		const scannerResult = gate.evaluate(policy, input, {
			expectedScannerId: COLLECTOR_ID,
			expectedScannerIdentityDigest: digest("different-scanner"),
		});

		expect(policyResult.ok && policyResult.value.outcome).toBe("inconclusive");
		expect(scannerResult.ok && scannerResult.value.outcome).toBe("inconclusive");
		if (policyResult.ok) expect(policyResult.value.reasonCodes).toContain("policy_mismatch");
		if (scannerResult.ok) expect(scannerResult.value.reasonCodes).toContain("policy_mismatch");
	});

	it.each(["untracked_workspace", "pending_artifact", "generated_config"] as const)(
		"blocks a secret found in %s without serializing the raw match",
		(scope) => {
			const policy = secretScanPolicy();
			const rawSecret = "api_key=THIS_IS_A_RAW_SECRET_12345";
			const result = new SecretScanGate({ clock: () => new Date(FINISHED) }).evaluate(
				policy,
				secretInput(policy, [secretItem(scope, rawSecret)]),
			);

			expect(result.ok && result.value.outcome).toBe("blocked");
			if (!result.ok) return;
			expect(result.value.reasonCodes).toContain("secret_detected");
			expect(JSON.stringify(result.value)).not.toContain(rawSecret);
			expect(JSON.stringify(result.value)).not.toContain("THIS_IS_A_RAW_SECRET_12345");
		},
	);

	it("classifies truncated evidence as inconclusive and never scans it into a pass", () => {
		const policy = secretScanPolicy();
		const result = new SecretScanGate({ clock: () => new Date(FINISHED) }).evaluate(
			policy,
			secretInput(policy, [], policy.requiredScopes, { truncated: true }),
		);

		expect(result.ok && result.value.outcome).toBe("inconclusive");
		if (result.ok) expect(result.value.reasonCodes).toContain("evidence_truncated");
	});
});
