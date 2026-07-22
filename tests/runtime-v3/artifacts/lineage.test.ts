import { describe, expect, it } from "vitest";
import { canonicalDigest } from "../../../src/runtime/protocol/v3/canonical-json.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/v3/ids.ts";
import type {
	DeclassificationReceiptRef,
	InputSourceRef,
} from "../../../src/runtime/protocol/v3/taint.ts";
import {
	artifactLineageAllowsSink,
	createArtifactLineage,
	mergeArtifactLineage,
} from "../../../src/runtime/artifacts/lineage.ts";
import { createArtifactHarness, NOW, valueOf } from "./helpers.ts";

function source(authorityId: InputSourceRef["authorityId"], tenantId: InputSourceRef["tenantId"]): InputSourceRef {
	return {
		schemaVersion: 1,
		authorityId,
		tenantId,
		sourceId: createRuntimeId("inputSource", "candidate-artifact"),
		kind: "candidate_config",
		sourceDigest: canonicalDigest("candidate-input"),
		trust: "tainted",
		taintLabels: ["candidate_controlled"],
		observedAt: NOW,
	};
}

function declassification(input: InputSourceRef): DeclassificationReceiptRef {
	const body: Omit<DeclassificationReceiptRef, "receiptDigest"> = {
		schemaVersion: 1,
		authorityId: input.authorityId,
		tenantId: input.tenantId,
		receiptId: createRuntimeId("declassification", "candidate-shell"),
		sourceId: input.sourceId,
		sourceDigest: input.sourceDigest,
		allowedSink: "shell",
		policyDigest: canonicalDigest("declassification-policy"),
		approverPrincipalId: createRuntimeId("principal", "independent-approver"),
		decisionRevision: 1,
		issuedAt: NOW,
		expiresAt: "2026-07-23T00:00:00.000Z",
	};
	return { ...body, receiptDigest: canonicalDigest(body) };
}

describe("Artifact lineage", () => {
	it("quarantines missing external lineage and never treats a summary as declassification", async () => {
		const harness = await createArtifactHarness();
		try {
			const written = valueOf(await harness.repository.write(harness.request("lineage-missing")));
			expect(written.metadata.lineage).toMatchObject({
				origin: "external",
				status: "quarantined",
				taintUpperBound: ["external_untrusted"],
			});
			expect(artifactLineageAllowsSink(written.metadata.lineage, "context", [], new Date(NOW))).toBe(true);
			expect(artifactLineageAllowsSink(written.metadata.lineage, "shell", [], new Date(NOW))).toBe(false);
		} finally {
			await harness.cleanup();
		}
	});

	it("preserves candidate taint and requires an exact sink-bound receipt", async () => {
		const harness = await createArtifactHarness();
		try {
			const request = harness.request("lineage-candidate");
			const input = source(request.authorityId, request.tenantId);
			const written = valueOf(await harness.repository.write({
				...request,
				lineage: { origin: "candidate", inputSources: [input], declassificationReceipts: [] },
			}));
			expect(written.metadata.lineage).toMatchObject({
				status: "verified",
				taintUpperBound: ["candidate_controlled"],
			});
			expect(artifactLineageAllowsSink(written.metadata.lineage, "shell", [], new Date(NOW))).toBe(false);
			expect(
				artifactLineageAllowsSink(written.metadata.lineage, "shell", [declassification(input)], new Date(NOW)),
			).toBe(true);
			expect(
				artifactLineageAllowsSink(written.metadata.lineage, "network", [declassification(input)], new Date(NOW)),
			).toBe(false);
		} finally {
			await harness.cleanup();
		}
	});

	it("propagates quarantine and taint upper bounds through derived merge", () => {
		const scope = {
			authorityId: createRuntimeId("authority", "artifact-lineage"),
			tenantId: createRuntimeId("tenant", "artifact-lineage"),
		};
		const candidateSource = source(scope.authorityId, scope.tenantId);
		const verified = valueOf(createArtifactLineage(scope, {
			origin: "candidate",
			inputSources: [candidateSource],
			declassificationReceipts: [],
		}));
		const quarantined = valueOf(createArtifactLineage(scope, undefined));
		const merged = valueOf(mergeArtifactLineage(scope, "model_derived", [verified, quarantined]));
		expect(merged.status).toBe("quarantined");
		expect(merged.taintUpperBound).toEqual(["external_untrusted", "candidate_controlled"]);
		expect(merged.inputSources).toEqual([candidateSource]);
	});
});
