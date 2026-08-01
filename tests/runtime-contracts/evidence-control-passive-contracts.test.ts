import { describe, expect, it } from "vitest";
import {
	isCostRecord,
	isLifecycleRef,
	isManagedPolicyRef,
	isProductionCompositionReceipt,
	isRemoteInvocationRef,
	isRuntimeActivity,
	isTelemetryManifest,
} from "../../src/runtime/contracts/control-telemetry-schemas.ts";
import {
	isArtifactCommitReceipt,
	isArtifactIntent,
	isChangeProposal,
	isCompositeCheckpoint,
	isEpisodeManifestBody,
	isEpisodeSeal,
	isFindingRecord,
	isProjectionCheckpoint,
	isVerificationRequest,
	isVerificationResult,
} from "../../src/runtime/contracts/evidence-schemas.ts";
import { createRuntimeId } from "../../src/runtime/protocol/ids.ts";

const digest = { algorithm: "sha256", digest: "9".repeat(64) } as const;
const sessionId = createRuntimeId("session", "evidence");
const sourceHead = { streamId: sessionId, sequence: 12, eventHash: digest } as const;
const sourceRange = {
	stream: { scope: "session", streamId: sessionId, sessionId },
	startSequence: 0,
	endSequence: 12,
	head: sourceHead,
	rangeDigest: digest,
	complete: true,
} as const;
const receiptRef = { subjectKind: "receipt", digest } as const;
const artifactRef = {
	artifactId: createRuntimeId("artifact", "evidence"),
	authorityId: createRuntimeId("authority", "evidence"),
	tenantId: createRuntimeId("tenant", "evidence"),
	storedDigest: digest,
	kind: "test_report",
	originalSize: 512,
	storedSize: 256,
	mediaType: "application/json",
	redaction: "redacted",
	transformReceiptRef: receiptRef,
} as const;

describe("Artifact, evidence, control, and telemetry passive contracts", () => {
	it("separates artifact intent from durable commit receipt", () => {
		const intent = {
			intentId: createRuntimeId("command", "artifact-intent"),
			subjectId: sessionId,
			sourceDigest: digest,
			targetKind: "test_report",
			retentionPolicyDigest: digest,
			accessPolicyDigest: digest,
			idempotencyKey: "artifact-intent-1",
			traceId: createRuntimeId("trace", "artifact-intent"),
		};
		const commit = {
			receiptId: createRuntimeId("receipt", "artifact-commit"),
			intentId: intent.intentId,
			artifact: artifactRef,
			contentVerification: "verified",
			keyAccessRef: receiptRef,
			outcome: "durable",
			committedAt: "2026-08-02T00:00:00.000Z",
		};

		expect(isArtifactIntent(intent)).toBe(true);
		expect(isArtifactIntent({ ...intent, content: "raw report" })).toBe(false);
		expect(isArtifactCommitReceipt(commit)).toBe(true);
		expect(isArtifactCommitReceipt({ ...commit, storagePath: "/tmp/artifact" })).toBe(false);
	});

	it("binds projection, composite checkpoint, manifest, and seal to exact evidence refs", () => {
		const projection = {
			snapshotId: createRuntimeId("snapshot", "projection"),
			sourceRange,
			projectionKind: "session",
			projectionDigest: digest,
			artifactRef: { subjectKind: "projection", digest },
			builtAt: "2026-08-02T00:00:00.000Z",
			completeness: "complete",
		};
		const workspaceCheckpoint = {
			workspaceId: createRuntimeId("workspace", "evidence"),
			eventHead: sourceHead,
			baseCommit: "0".repeat(40),
			headCommit: "1".repeat(40),
			statusDigest: digest,
			completeness: "metadata_only",
		};
		const composite = {
			snapshotId: createRuntimeId("snapshot", "composite"),
			eventHead: sourceHead,
			workspaceCheckpoint,
			artifacts: [artifactRef],
			workspaceStatusDigest: digest,
			dirtyCount: 1,
			untrackedCount: 0,
			conflictCount: 0,
			builtAt: "2026-08-02T00:00:01.000Z",
			completeness: "partial",
		};
		const manifest = {
			sessionId,
			eventHeads: [sourceHead],
			workspaceCheckpoints: [workspaceCheckpoint],
			artifacts: [artifactRef],
			permissionRefs: [receiptRef],
			costRefs: [receiptRef],
			verificationRefs: [receiptRef],
			retentionGraphDigest: digest,
			createdAt: "2026-08-02T00:00:02.000Z",
		};
		const seal = {
			receiptId: createRuntimeId("receipt", "episode-seal"),
			manifestDigest: digest,
			terminalEventRef: receiptRef,
			signerAttestationRef: { subjectKind: "attestation", digest },
			verificationOutcome: "verified",
			sealedAt: "2026-08-02T00:00:03.000Z",
		};

		expect(isProjectionCheckpoint(projection)).toBe(true);
		expect(isCompositeCheckpoint(composite)).toBe(true);
		expect(isCompositeCheckpoint({ ...composite, grantsCapability: true })).toBe(false);
		expect(isEpisodeManifestBody(manifest)).toBe(true);
		expect(isEpisodeManifestBody({ ...manifest, seal })).toBe(false);
		expect(isEpisodeSeal(seal)).toBe(true);
	});

	it("records verification, findings, and proposals without embedding diffs or runner state", () => {
		const request = {
			requestId: createRuntimeId("command", "verification"),
			sessionId,
			candidateDigest: digest,
			baselineDigest: digest,
			gateManifestRef: { subjectKind: "manifest", digest },
			runnerRequirementDigest: digest,
			traceId: createRuntimeId("trace", "verification"),
		};
		const finding = {
			findingId: createRuntimeId("finding", "verification"),
			severity: "high",
			status: "open",
			revision: 1,
			locationRef: { subjectKind: "details", digest },
			evidenceRefs: [receiptRef],
			findingDigest: digest,
		};
		const result = {
			receiptId: createRuntimeId("receipt", "verification"),
			requestId: request.requestId,
			outcome: "fail",
			runner: { adapterId: "verification-runner", generation: 2, configDigest: digest },
			evidenceRefs: [receiptRef],
			findingIds: [finding.findingId],
			resultDigest: digest,
			finishedAt: "2026-08-02T00:01:00.000Z",
		};
		const proposal = {
			proposalId: createRuntimeId("proposal", "change"),
			sessionId,
			baseDigest: digest,
			candidateDigest: digest,
			diffRef: { subjectKind: "artifact", digest },
			verificationSummaryRef: receiptRef,
			requestedAction: "draft_pr",
			proposalDigest: digest,
			createdAt: "2026-08-02T00:02:00.000Z",
		};

		expect(isVerificationRequest(request)).toBe(true);
		expect(isVerificationResult(result)).toBe(true);
		expect(isVerificationResult({ ...result, runnerProcess: { pid: 7 } })).toBe(false);
		expect(isFindingRecord(finding)).toBe(true);
		expect(isChangeProposal(proposal)).toBe(true);
		expect(isChangeProposal({ ...proposal, diff: "unbounded patch" })).toBe(false);
	});

	it("keeps activity, composition, cost, telemetry, and lifecycle metadata bounded", () => {
		const adapter = {
			adapterId: "event-store",
			generation: 3,
			configDigest: digest,
			trustRef: receiptRef,
			healthRef: receiptRef,
		};
		const activity = {
			sessionId,
			state: "running",
			sourceHead,
			lastDurableProgressAt: "2026-08-02T00:00:00.000Z",
			costSummaryRef: receiptRef,
			exporterHealthRef: receiptRef,
		};
		const composition = {
			receiptId: createRuntimeId("receipt", "composition"),
			runtimeId: createRuntimeId("runtime", "composition"),
			generation: 4,
			featureRequirementsDigest: digest,
			adapters: [adapter],
			effectiveFeatures: ["event_store", "telemetry"],
			compositionDigest: digest,
			issuedAt: "2026-08-02T00:00:00.000Z",
			expiresAt: "2026-08-02T01:00:00.000Z",
		};
		const cost = {
			receiptId: createRuntimeId("receipt", "cost"),
			sessionId,
			providerId: "deepseek",
			modelId: "deepseek-v4",
			operation: "model_call",
			inputUnits: 100,
			outputUnits: 20,
			cacheUnits: 0,
			toolUnits: 1,
			currency: "USD",
			estimatedMicrounits: 1000,
			finalMicrounits: 900,
			reconciliationRef: receiptRef,
			recordedAt: "2026-08-02T00:01:00.000Z",
		};
		const manifest = {
			manifestId: createRuntimeId("receipt", "telemetry-manifest"),
			allowedFieldsDigest: digest,
			sinksDigest: digest,
			samplingPermille: 100,
			redactionPolicyDigest: digest,
			retentionDays: 30,
			tenantId: createRuntimeId("tenant", "evidence"),
			exporter: adapter,
			manifestDigest: digest,
		};
		const policy = {
			policyId: createRuntimeId("receipt", "managed-policy"),
			sourceDigests: [digest],
			winnerDigest: digest,
			loserDigests: [],
			denyUnionDigest: digest,
			normalizationReasonCode: "managed_deny_union",
			effectiveDigest: digest,
			receiptRef,
		};
		const remote = {
			receiptId: createRuntimeId("receipt", "remote-invocation"),
			authorityId: createRuntimeId("authority", "evidence"),
			tenantId: createRuntimeId("tenant", "evidence"),
			workloadId: "verification-worker",
			workspaceRef: receiptRef,
			capabilityRef: receiptRef,
			credentialGrantRef: receiptRef,
			requestDigest: digest,
			executorAttestationRef: { subjectKind: "attestation", digest },
			resultReceiptRef: receiptRef,
		};
		const lifecycle = {
			subjectKind: "session",
			subjectId: sessionId,
			authorityHead: { ...sourceHead, streamId: createRuntimeId("authority", "evidence") },
			legalHoldRef: receiptRef,
			referenceGraphDigest: digest,
			tombstoneRef: receiptRef,
		};

		expect(isRuntimeActivity(activity)).toBe(true);
		expect(isProductionCompositionReceipt(composition)).toBe(true);
		expect(isProductionCompositionReceipt({ ...composition, adapters: [{ ...adapter, client: {} }] })).toBe(false);
		expect(isCostRecord(cost)).toBe(true);
		expect(isTelemetryManifest(manifest)).toBe(true);
		expect(isTelemetryManifest({ ...manifest, environment: process.env })).toBe(false);
		expect(isManagedPolicyRef(policy)).toBe(true);
		expect(isRemoteInvocationRef(remote)).toBe(true);
		expect(isRemoteInvocationRef({ ...remote, credential: "raw-secret" })).toBe(false);
		expect(isLifecycleRef(lifecycle)).toBe(true);
	});
});
