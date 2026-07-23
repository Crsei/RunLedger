import { describe, expect, it } from "vitest";
import { canonicalDigest } from "../../../src/runtime/protocol/v3/canonical-json.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/v3/ids.ts";
import {
	GovernedSalvageArtifactAdapter,
	isGovernedSalvageAuthorizationRequest,
	isGovernedSalvageReceipt,
	type GovernedSalvageAuthorizationDecision,
	type GovernedSalvageAuthorizationPort,
	type GovernedSalvageAuthorizationRequest,
} from "../../../src/runtime/artifacts/salvage-adapter.ts";
import {
	FORENSIC_SALVAGE_REPORT_VERSION,
	validateForensicSalvageReport,
	type ForensicSalvageReport,
	type ForensicSalvageReportBody,
} from "../../../src/runtime/session/salvage.ts";
import fixture from "./fixtures/salvage-artifact-v1.json" with { type: "json" };
import { createArtifactHarness, DIGEST, valueOf } from "./helpers.ts";

function report(
	authorityId: ForensicSalvageReport["authorityId"],
	tenantId: ForensicSalvageReport["tenantId"],
	sourceSessionId: ForensicSalvageReport["sourceSessionId"],
): ForensicSalvageReport {
	const body: ForensicSalvageReportBody = {
		reportVersion: FORENSIC_SALVAGE_REPORT_VERSION,
		reportArtifactId: createRuntimeId("artifact", "governed-salvage"),
		authorityId,
		tenantId,
		sourceSessionId,
		sourceDigest: DIGEST,
		sourceByteLength: 42,
		generatedAt: "2026-07-22T00:00:00.000Z",
		outcome: "unrecoverable",
		verifiedPrefixCount: 0,
		verifiedPrefixCursor: null,
		failure: {
			code: "corrupted_log",
			line: 0,
			byteOffset: 0,
			tornTail: false,
		},
		readOnly: true,
		attestation: "unattested",
	};
	return { ...body, reportDigest: canonicalDigest(body) };
}

class Authorization implements GovernedSalvageAuthorizationPort {
	public decision: GovernedSalvageAuthorizationDecision["decision"] = "allow";
	public scopeOverride: Partial<Pick<GovernedSalvageAuthorizationDecision, "authorityId" | "tenantId">> = {};
	public requests: GovernedSalvageAuthorizationRequest[] = [];

	public async authorize(
		request: GovernedSalvageAuthorizationRequest,
	): Promise<GovernedSalvageAuthorizationDecision> {
		this.requests.push(request);
		const scope = {
			schemaVersion: 1 as const,
			authorityId: this.scopeOverride.authorityId ?? request.authorityId,
			tenantId: this.scopeOverride.tenantId ?? request.tenantId,
		};
		return this.decision === "allow"
			? {
					...scope,
					decision: "allow",
					receiptId: createRuntimeId("receipt", "salvage-allow"),
					receiptDigest: DIGEST,
				}
			: { ...scope, decision: this.decision };
	}
}

describe("governed salvage Artifact adapter", () => {
	it("commits an authorized unattested report and binds source, retention, and authorization evidence", async () => {
		const harness = await createArtifactHarness();
		try {
			const base = harness.request("salvage-base");
			const salvageReport = report(
				base.authorityId,
				base.tenantId,
				base.source.sessionId,
			);
			expect(validateForensicSalvageReport(salvageReport)).toBe(true);
			const authorization = new Authorization();
			const adapter = new GovernedSalvageArtifactAdapter({
				repository: harness.repository,
				authorization,
			});
			const receipt = valueOf(await adapter.store({
				report: salvageReport,
				principalId: base.principalId,
				producerId: base.principalId,
				intentId: createRuntimeId("command", "governed-salvage"),
				retention: {
					expiresAt: "2026-08-22T00:00:00.000Z",
					pins: ["forensic-review"],
					referenceCount: 1,
				},
			}));

			expect(authorization.requests).toHaveLength(1);
			expect(isGovernedSalvageAuthorizationRequest(authorization.requests[0])).toBe(true);
			expect(isGovernedSalvageReceipt(receipt)).toBe(true);
			expect(receipt).toMatchObject({
				sourceDigest: salvageReport.sourceDigest,
				reportDigest: salvageReport.reportDigest,
				readOnly: true,
				attestation: "unattested",
				artifact: {
					artifactId: salvageReport.reportArtifactId,
					kind: "session_report",
				},
			});
			const metadata = valueOf(await harness.metadata.readCommitted(
				base.authorityId,
				base.tenantId,
				salvageReport.reportArtifactId,
			));
			expect(metadata.source.sessionId).toBe(salvageReport.sourceSessionId);
			expect(metadata.pins).toEqual(["forensic-review"]);
			expect(metadata.referenceCount).toBe(1);
			expect(metadata.lineage.status).toBe("quarantined");
		} finally {
			await harness.cleanup();
		}
	});

	it("fails closed before CAS writes for ask, deny, unavailable, or cross-scope authorization", async () => {
		for (const decision of ["ask", "deny", "unavailable"] as const) {
			const harness = await createArtifactHarness();
			try {
				const base = harness.request(`salvage-${decision}`);
				const authorization = new Authorization();
				authorization.decision = decision;
				const result = await new GovernedSalvageArtifactAdapter({
					repository: harness.repository,
					authorization,
				}).store({
					report: report(base.authorityId, base.tenantId, base.source.sessionId),
					principalId: base.principalId,
					producerId: base.principalId,
					intentId: createRuntimeId("command", `salvage-${decision}`),
					retention: { pins: ["offline-report"] },
				});
				expect(result).toMatchObject({
					ok: false,
					error: {
						code: decision === "unavailable" ? "authorization_unavailable" : "authorization_denied",
					},
				});
				expect(harness.journal.intents.size).toBe(0);
			} finally {
				await harness.cleanup();
			}
		}

		const harness = await createArtifactHarness();
		try {
			const base = harness.request("salvage-cross-scope");
			const authorization = new Authorization();
			authorization.scopeOverride = { tenantId: createRuntimeId("tenant", "other") };
			const result = await new GovernedSalvageArtifactAdapter({
				repository: harness.repository,
				authorization,
			}).store({
				report: report(base.authorityId, base.tenantId, base.source.sessionId),
				principalId: base.principalId,
				producerId: base.principalId,
				intentId: createRuntimeId("command", "salvage-cross-scope"),
				retention: { pins: ["offline-report"] },
			});
			expect(result).toMatchObject({ ok: false, error: { code: "authorization_denied" } });
			expect(harness.journal.intents.size).toBe(0);
		} finally {
			await harness.cleanup();
		}
	});

	it("does not expose a reference when the CAS transaction remains pending", async () => {
		const harness = await createArtifactHarness();
		try {
			const base = harness.request("salvage-pending");
			const salvageReport = report(base.authorityId, base.tenantId, base.source.sessionId);
			harness.journal.failCommit = true;
			const result = await new GovernedSalvageArtifactAdapter({
				repository: harness.repository,
				authorization: new Authorization(),
			}).store({
				report: salvageReport,
				principalId: base.principalId,
				producerId: base.principalId,
				intentId: createRuntimeId("command", "salvage-pending"),
				retention: { pins: ["offline-report"] },
			});
			expect(result).toMatchObject({
				ok: false,
				error: { code: "durable_write_failed", retryable: true },
			});
			expect(validateForensicSalvageReport(salvageReport)).toBe(true);
		} finally {
			await harness.cleanup();
		}
	});

	it("keeps the exact v1 governed receipt fixture stable", () => {
		expect(isGovernedSalvageReceipt(fixture)).toBe(true);
	});
});
