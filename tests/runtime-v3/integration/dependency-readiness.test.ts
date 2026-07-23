import { describe, expect, it } from "vitest";
import { canonicalDigest } from "../../../src/runtime/protocol/v3/canonical-json.ts";
import {
	createRuntimeDependencyReadinessEntry,
	createRuntimeDependencyReadinessReceipt,
	createUnavailableRuntimeReadiness,
	isRuntimeDependencyReadinessReceipt,
	runtimeFeatureReadiness,
	RUNTIME_DEPENDENCY_SCOPES,
} from "../../../src/runtime/integration/dependency-readiness.ts";

describe("production dependency readiness", () => {
	it("requires exact adapter, generation, recovery evidence and closes no feature over an external gap", () => {
		const unavailable = createUnavailableRuntimeReadiness(
			"fixture-composition",
			"2026-07-24T00:00:00.000Z",
		);
		expect(isRuntimeDependencyReadinessReceipt(unavailable)).toBe(true);
		expect(unavailable.entries.map((entry) => entry.scope)).toEqual(RUNTIME_DEPENDENCY_SCOPES);
		expect(runtimeFeatureReadiness(unavailable, "completion")).toBe("external_gap");

		const entries = unavailable.entries.map((entry) =>
			createRuntimeDependencyReadinessEntry({
				scope: entry.scope,
				status: "ready",
				contractId: entry.contractId,
				schemaVersion: entry.schemaVersion,
				contractDigest: entry.contractDigest,
				adapterId: `${entry.scope}-adapter`,
				adapterIdentityDigest: canonicalDigest(`${entry.scope}-adapter`),
				adapterGeneration: 1,
				adapterGenerationDigest: canonicalDigest(`${entry.scope}-generation`),
				recovery: "recoverable",
				recoveryEvidenceDigest: canonicalDigest(`${entry.scope}-recovery`),
				requiredFor: entry.requiredFor,
			}),
		);
		const ready = createRuntimeDependencyReadinessReceipt({
			compositionId: "fixture-composition",
			generatedAt: "2026-07-24T00:00:00.000Z",
			entries,
		});
		expect(runtimeFeatureReadiness(ready, "completion")).toBe("ready");
		expect(isRuntimeDependencyReadinessReceipt({
			...ready,
			entries: ready.entries.map((entry, index) =>
				index === 0 ? { ...entry, adapterGeneration: 2 } : entry),
		})).toBe(false);
	});
});
