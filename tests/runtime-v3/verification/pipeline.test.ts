import { describe, expect, it } from "vitest";
import { canonicalDigest } from "../../../src/runtime/protocol/v3/canonical-json.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/v3/ids.ts";
import { createWorktreeId, type WorkspaceServicePort, type WorkspaceServiceRequest } from "../../../src/runtime/protocol/v3/workspace.ts";
import { TrustedBaselineCoordinator } from "../../../src/runtime/verification/baseline.ts";
import { VerificationPipeline } from "../../../src/runtime/verification/pipeline.ts";
import { createVerificationInvocation } from "../../../src/runtime/verification/runner.ts";
import type {
	TrustedGateSourcePort,
	TrustedVerificationPolicyPort,
	VerificationPipelineJournalPort,
	VerificationRunnerAttempt,
	VerificationRunnerPort,
	VerificationRunnerRequest,
	VerificationReport,
} from "../../../src/runtime/verification/types.ts";
import {
	AGENT_ID,
	AUTHORITY_ID,
	BASE_COMMIT,
	BASE_WORKSPACE_ID,
	CANDIDATE_COMMIT,
	FakeIssuer,
	NOW,
	PRINCIPAL_ID,
	REPOSITORY_ID,
	REQUEST_ID,
	RUNTIME_ID,
	SESSION_ID,
	TENANT_ID,
	TRACE_ID,
	VERIFICATION_ID,
	artifactReceipt,
	candidate,
	candidateEnvelope,
	digest,
	executionEvidence,
	gateManifest,
	policy,
	passingAdmissionPort,
	registry,
} from "./helpers.ts";

class BaselineWorkspace implements WorkspaceServicePort {
	readonly requests: WorkspaceServiceRequest[] = [];

	public async request(request: WorkspaceServiceRequest) {
		this.requests.push(request);
		if (request.kind !== "bind") throw new Error("unexpected workspace request");
		return {
			schemaVersion: 1 as const,
			requestId: request.requestId,
			kind: "bound" as const,
			receiptId: createRuntimeId("receipt", "pipeline-baseline"),
			binding: {
				authorityId: request.authorityId,
				tenantId: request.tenantId,
				workspaceId: BASE_WORKSPACE_ID,
				repositoryId: request.repositoryId,
				bindingKind: "readonly_checkout" as const,
				canonicalCwd: "/trusted/base",
				effectiveCwd: "/trusted/base",
				branch: request.branch,
				baseCommit: request.baseCommit,
				headCommit: request.baseCommit,
				worktreeId: createWorktreeId("pipeline-base"),
			},
			lease: {
				authorityId: request.authorityId,
				tenantId: request.tenantId,
				principalId: request.principalId,
				leaseId: createRuntimeId("lease", "pipeline-base"),
				workspaceId: BASE_WORKSPACE_ID,
				ownerRuntimeId: request.ownerRuntimeId,
				leaseRevision: 1,
				fencingTokenDigest: digest("pipeline-fence"),
				state: "active" as const,
			},
		};
	}
}

class FakeRunner implements VerificationRunnerPort {
	readonly requests: VerificationRunnerRequest[] = [];
	mode: "pass" | "deny" | "inconclusive" | "cross_commit" = "pass";

	public async run(request: VerificationRunnerRequest) {
		this.requests.push(request);
		const invocation = createVerificationInvocation(request, { PATH: "/trusted/bin" });
		if (!invocation.ok) return invocation;
		if (this.mode === "deny") {
			const attempt: VerificationRunnerAttempt = { invocation: invocation.value, status: "denied", reasonCodes: ["denied"] };
			return { ok: true as const, value: attempt };
		}
		const artifact = artifactReceipt({
			requestId: request.requestId,
			verificationId: request.verificationId,
			candidateCommit: this.mode === "cross_commit" ? "0".repeat(40) : request.candidate.candidateCommit,
		});
		const attempt: VerificationRunnerAttempt = {
			invocation: invocation.value,
			evidence: executionEvidence({
				invocationDigest: invocation.value.invocationDigest,
				requestId: request.requestId,
				verificationId: request.verificationId,
				enforcement: this.mode === "inconclusive" ? "degraded" : "enforced",
				artifacts: [artifact],
			}),
			status: "executed",
			reasonCodes: [],
		};
		return { ok: true as const, value: attempt };
	}
}

class FakePipelineJournal implements VerificationPipelineJournalPort {
	readonly calls: string[] = [];
	report: VerificationReport | undefined;

	public async resolveExisting() {
		this.calls.push("resolve");
		return { ok: true as const, value: this.report };
	}

	public async recordStarted() {
		this.calls.push("started");
		return { ok: true as const, value: undefined };
	}

	public async recordFinished(_request: ReturnType<typeof request>, report: VerificationReport) {
		this.calls.push("finished");
		this.report = report;
		return { ok: true as const, value: undefined };
	}
}

function harness(journal?: VerificationPipelineJournalPort) {
	const manifest = gateManifest();
	const trustedPolicy = policy(manifest);
	const policyPort: TrustedVerificationPolicyPort = {
		resolve: async () => ({ ok: true, value: trustedPolicy }),
	};
	const baselineWorkspace = new BaselineWorkspace();
	const baseline = new TrustedBaselineCoordinator({
		policy: policyPort,
		workspace: baselineWorkspace,
		clock: () => new Date(NOW),
	});
	const gateSource: TrustedGateSourcePort = {
		read: async ({ baseline: receipt, protectedPath }) => ({
			ok: true,
			value: {
				baselineReceiptDigest: receipt.receiptDigest,
				sourceCommit: BASE_COMMIT,
				protectedPath,
				document: manifest,
				documentDigest: canonicalDigest(manifest),
			},
		}),
	};
	const runner = new FakeRunner();
	const pipeline = new VerificationPipeline({
		baseline,
		gateSource,
		runner,
		admission: passingAdmissionPort(),
		issuer: new FakeIssuer(),
		issuerRegistry: registry(),
		...(journal ? { journal } : {}),
	});
	return { pipeline, runner, baselineWorkspace, manifest };
}

function request() {
	return {
		requestId: createRuntimeId("command", "pipeline-baseline-request"),
		authorityId: AUTHORITY_ID,
		tenantId: TENANT_ID,
		principalId: PRINCIPAL_ID,
		sessionId: SESSION_ID,
		agentId: AGENT_ID,
		traceId: TRACE_ID,
		repositoryId: REPOSITORY_ID,
		gateKey: "test",
		ownerRuntimeId: RUNTIME_ID,
		verificationId: VERIFICATION_ID,
		runnerRequestId: REQUEST_ID,
		candidate: candidate(),
		candidateEnvelope: candidateEnvelope(),
	};
}

describe("verification pipeline", () => {
	it("produces a trusted passed report from the protected base gate", async () => {
		const service = harness();
		const result = await service.pipeline.verify(request());
		expect(result.ok && result.value.result.outcome).toBe("passed");
		if (!result.ok) return;
		expect(result.value.result.gateDigest).toBe(service.manifest.manifestDigest);
		expect(result.value.result.candidate.candidateCommit).toBe(CANDIDATE_COMMIT);
		expect(service.runner.requests[0]?.manifest.executable.path).toBe("ci/trusted-gates/run-tests");
		expect(service.baselineWorkspace.requests[0]).toMatchObject({ bindingKind: "readonly_checkout", baseCommit: BASE_COMMIT });
	});

	it("returns authorization denial without issuing a report", async () => {
		const service = harness();
		service.runner.mode = "deny";
		const result = await service.pipeline.verify(request());
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("authorization_denied");
	});

	it("persists sandbox degradation as inconclusive rather than pass", async () => {
		const service = harness();
		service.runner.mode = "inconclusive";
		const result = await service.pipeline.verify(request());
		expect(result.ok && result.value.result.outcome).toBe("inconclusive");
	});

	it("rejects a runner that reuses Artifact evidence from another commit", async () => {
		const service = harness();
		service.runner.mode = "cross_commit";
		const result = await service.pipeline.verify(request());
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("cross_commit_evidence");
	});

	it("commits journal start/report/finish and resumes the durable report without rerunning", async () => {
		const journal = new FakePipelineJournal();
		const service = harness(journal);
		const first = await service.pipeline.verify(request());
		expect(first.ok).toBe(true);
		expect(journal.calls).toEqual(["resolve", "started", "finished"]);
		expect(service.runner.requests).toHaveLength(1);

		const resumed = await service.pipeline.verify(request());
		expect(resumed.ok && resumed.value.reportDigest).toBe(first.ok ? first.value.reportDigest : undefined);
		expect(journal.calls).toEqual(["resolve", "started", "finished", "resolve"]);
		expect(service.runner.requests).toHaveLength(1);
	});
});
