import { createHash } from "node:crypto";
import { access, chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { SandboxExecutorRequest } from "../../../src/runtime/protocol/v3/capability.ts";
import { canonicalDigest } from "../../../src/runtime/protocol/v3/canonical-json.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/v3/ids.ts";
import type { WorkspaceExecutionEnvelope } from "../../../src/runtime/protocol/v3/workspace.ts";
import {
	ProductionVerificationArtifactEvidenceAdapter,
	type TrustedArtifactSchemaValidatorPort,
} from "../../../src/runtime/verification/integration/production-artifact-evidence.ts";
import {
	MemoryVerificationExecutionRecordStore,
	ProductionVerificationSandboxExecutorAdapter,
	type TrustedVerificationExecutionContext,
} from "../../../src/runtime/verification/integration/production-execution-adapter.ts";
import { createVerificationInvocation } from "../../../src/runtime/verification/runner.ts";
import { createVerificationResult } from "../../../src/runtime/verification/evidence.ts";
import type {
	GateManifest,
	TrustedBaselineReceipt,
	VerificationArtifactEvidenceRequest,
	VerificationInvocation,
	VerificationRunnerIdentity,
} from "../../../src/runtime/verification/types.ts";
import type { RuntimeSandboxContextPort } from "../../../src/security/integration/runtime-sandbox-adapter.ts";
import { LinuxBwrapBackend } from "../../../src/security/sandbox/linux-bwrap.ts";
import type {
	SandboxBackend,
	SandboxBackendCapability,
	SandboxLaunchPlan,
	SandboxPrepareRequest,
} from "../../../src/security/sandbox/types.ts";
import type { SecuritySnapshot } from "../../../src/security/types.ts";
import { NodeSandboxCommandProbe, NodeSandboxProcessPort } from "../../../src/storage/production-tool-gateway.ts";
import { createArtifactHarness } from "../artifacts/helpers.ts";
import {
	AUTHORITY_ID,
	FINISHED,
	PRINCIPAL_ID,
	RUNNER_ID,
	TENANT_ID,
	VERIFICATION_ID,
	admissionBundle,
	baselineReceipt,
	candidate,
	candidateEnvelope,
	dependencyPolicy,
	digest,
	gateManifest,
} from "./helpers.ts";

const CLOCK = FINISHED;
const TRUSTED_PATH = "/usr/local/bin:/usr/bin:/bin";

function rawDigest(content: string | Uint8Array): string {
	return createHash("sha256").update(content).digest("hex");
}

function runnerIdentity(): VerificationRunnerIdentity {
	const body = { issuerId: "production-verifier", runnerId: RUNNER_ID, version: "1.0.0" };
	return { ...body, identityDigest: canonicalDigest(body) };
}

function baselineAt(root: string): TrustedBaselineReceipt {
	const current = baselineReceipt();
	const { receiptDigest: _receiptDigest, ...body } = current;
	const updated = { ...body, protectedRoot: root };
	return { ...updated, receiptDigest: canonicalDigest(updated) };
}

class AttestedShellBackend implements SandboxBackend {
	readonly #processes = new NodeSandboxProcessPort();

	public probe(): Promise<SandboxBackendCapability> {
		return Promise.resolve({
			backendId: "attested-test-shell",
			platform: "external",
			status: "available",
			supportsFilesystemIsolation: true,
			supportsNetworkDeny: true,
			supportsChildIsolation: true,
		});
	}

	public prepare(request: SandboxPrepareRequest) {
		return Promise.resolve({
			ok: true as const,
			value: {
				backendId: "attested-test-shell",
				requested: request.requested,
				resolved: request.requested,
				effectiveEnforcement: "enforced" as const,
				policyDigest: request.policyDigest,
				program: "/bin/sh",
				arguments: ["-lc", request.command],
				cwd: request.cwd,
				environment: request.environment,
				timeoutMs: request.timeoutMs,
			},
		});
	}

	public spawn(plan: SandboxLaunchPlan, signal?: AbortSignal) {
		return this.#processes.spawn(plan, signal);
	}
}

class JsonSchemaValidator implements TrustedArtifactSchemaValidatorPort {
	public readonly validatorId = RUNNER_ID;
	readonly #expectedDigest: string;
	readonly #status: "valid" | "invalid";

	public constructor(expectedDigest: string, status: "valid" | "invalid" = "valid") {
		this.#expectedDigest = expectedDigest;
		this.#status = status;
	}

	public preflight() {
		return Promise.resolve({ ok: true as const, value: undefined });
	}

	public validate(request: Parameters<TrustedArtifactSchemaValidatorPort["validate"]>[0]) {
		if (request.schemaDigest !== this.#expectedDigest) {
			return Promise.resolve({
				ok: false as const,
				error: { code: "artifact_invalid" as const, message: "unknown schema", retryable: false },
			});
		}
		return Promise.resolve({ ok: true as const, value: this.#status });
	}
}

interface ExecutionFixture {
	root: string;
	baselineRoot: string;
	candidateRoot: string;
	outputRoot: string;
	executablePath: string;
	configurationPath: string;
	markerPath: string;
	manifest: GateManifest;
	baseline: TrustedBaselineReceipt;
	invocation: VerificationInvocation;
	envelope: WorkspaceExecutionEnvelope;
	context: TrustedVerificationExecutionContext;
	request: SandboxExecutorRequest;
	records: MemoryVerificationExecutionRecordStore;
	execute(backend?: SandboxBackend, invocation?: VerificationInvocation): ReturnType<ProductionVerificationSandboxExecutorAdapter["execute"]>;
	cleanup(): Promise<void>;
}

async function executionFixture(options: { exitCode?: number; invalidJson?: boolean } = {}): Promise<ExecutionFixture> {
	const root = await mkdtemp(join(tmpdir(), "runledger-verification-adapter-"));
	const baselineRoot = join(root, "baseline");
	const candidateRoot = join(root, "candidate");
	const outputRoot = join(root, "outputs");
	await Promise.all([
		mkdir(join(baselineRoot, "ci"), { recursive: true }),
		mkdir(candidateRoot, { recursive: true }),
		mkdir(outputRoot, { recursive: true }),
	]);
	const executablePath = join(baselineRoot, "ci", "verify.sh");
	const configurationPath = join(baselineRoot, "ci", "config.json");
	const markerPath = join(root, "injection-marker");
	const reportCommand = options.invalidJson
		? "printf 'not-json\\n' > \"$2\""
		: "printf '{\"ok\":true,\"argument\":\"%s\"}\\n' \"$1\" > \"$2\"";
	const executable = [
		"#!/bin/sh",
		reportCommand,
		"printf 'PASS from raw stdout\\n'",
		`exit ${options.exitCode ?? 0}`,
		"",
	].join("\n");
	const configuration = "{\"runner\":\"trusted\"}\n";
	await Promise.all([
		writeFile(executablePath, executable, { mode: 0o755 }),
		writeFile(configurationPath, configuration, { mode: 0o600 }),
	]);
	await chmod(executablePath, 0o755);
	const schemaDigest = digest("production-adapter-test-schema");
	const manifest = gateManifest({
		executable: {
			source: "trusted_baseline",
			path: "ci/verify.sh",
			digest: rawDigest(executable),
		},
		arguments: [
			{ kind: "literal", value: `; touch ${markerPath};` },
			{ kind: "artifact_output", name: "test-report" },
		],
		baseConfiguration: [{ path: "ci/config.json", digest: rawDigest(configuration) }],
		dependencyPolicy: dependencyPolicy({ installMode: "none", lockfileSource: "none" }),
		environment: {
			inherit: false,
			allowlist: ["PATH"],
			values: [{ name: "PATH", source: "trusted_runner" }],
		},
		sandbox: { profile: "strict", policyDigest: digest("production-adapter-sandbox"), requireEnforced: true },
		network: { mode: "deny", hosts: [] },
		timeoutMs: 10_000,
		expectedExitCodes: [0],
		expectedArtifacts: [{
			name: "test-report",
			kind: "test_report",
			mediaType: "application/json",
			schemaDigest,
			required: true,
			maxBytes: 16_384,
		}],
	});
	const baseline = baselineAt(baselineRoot);
	const selectedCandidate = candidate();
	const envelope: WorkspaceExecutionEnvelope = {
		...candidateEnvelope(),
		worktreePath: candidateRoot,
		cwd: candidateRoot,
	};
	const created = createVerificationInvocation(
		{
			manifest,
			baseline,
			candidate: selectedCandidate,
			candidateEnvelope: envelope,
			verificationId: VERIFICATION_ID,
			requestId: createRuntimeId("command", `production-adapter-${rawDigest(root).slice(0, 24)}`),
		},
		{ PATH: TRUSTED_PATH },
	);
	if (!created.ok) throw new Error(created.error.message);
	const invocation = created.value;
	const context: TrustedVerificationExecutionContext = {
		manifest,
		baseline,
		candidate: selectedCandidate,
		candidateEnvelope: envelope,
		baselineRoot,
		artifactOutputRoot: outputRoot,
		trustedEnvironment: { PATH: TRUSTED_PATH },
	};
	const request: SandboxExecutorRequest = {
		authorityId: AUTHORITY_ID,
		tenantId: TENANT_ID,
		principalId: PRINCIPAL_ID,
		requestId: invocation.requestId,
		profile: {
			authorityId: AUTHORITY_ID,
			tenantId: TENANT_ID,
			profileId: createRuntimeId("resource", "production-adapter-sandbox"),
			requested: "strict",
			policyDigest: manifest.sandbox.policyDigest,
		},
		invocationDigest: invocation.invocationDigest,
		resolutionDigest: digest("production-adapter-resolution"),
		idempotencyKey: invocation.requestId,
		opaqueInvocation: invocation,
	};
	const snapshot: SecuritySnapshot = {
		profile: {
			name: "workspace-write",
			approvalPolicy: "never",
			filesystemMode: "workspace-write",
			network: { mode: "deny", allowedHosts: [] },
			sandbox: "strict",
		},
		filesystem: {
			readRoots: [baselineRoot, candidateRoot, outputRoot],
			writeRoots: [candidateRoot, outputRoot],
			denyRead: [],
			denyWrite: [],
			protectedPaths: [baselineRoot],
		},
		rules: [],
		sources: ["builtin"],
		workspaceRoot: candidateRoot,
		tempRoot: outputRoot,
		policyDigest: manifest.sandbox.policyDigest,
		createdAt: CLOCK,
	};
	const sandboxContext: RuntimeSandboxContextPort = {
		resolveEnvelope: async () => envelope,
		resolveSnapshot: async () => snapshot,
	};
	const records = new MemoryVerificationExecutionRecordStore();
	return {
		root,
		baselineRoot,
		candidateRoot,
		outputRoot,
		executablePath,
		configurationPath,
		markerPath,
		manifest,
		baseline,
		invocation,
		envelope,
		context,
		request,
		records,
		execute: (backend = new AttestedShellBackend(), selectedInvocation = invocation) => {
			const adapter = new ProductionVerificationSandboxExecutorAdapter({
				backend,
				sandboxContext,
				resolver: { resolve: async () => ({ ok: true, value: context }) },
				records,
				clock: () => new Date(CLOCK),
			});
			return adapter.execute({
				...request,
				requestId: selectedInvocation.requestId,
				invocationDigest: selectedInvocation.invocationDigest,
				idempotencyKey: selectedInvocation.requestId,
				opaqueInvocation: selectedInvocation,
			});
		},
		cleanup: () => rm(root, { recursive: true, force: true }),
	};
}

function evidenceRequest(fixture: ExecutionFixture, sandboxReceipt: Awaited<ReturnType<ExecutionFixture["execute"]>>["executionReceipt"]): VerificationArtifactEvidenceRequest {
	return {
		authorityId: AUTHORITY_ID,
		tenantId: TENANT_ID,
		requestId: fixture.invocation.requestId,
		verificationId: fixture.invocation.verificationId,
		invocationDigest: fixture.invocation.invocationDigest,
		candidate: fixture.invocation.candidate,
		expectedArtifacts: fixture.invocation.expectedArtifacts,
		sandboxReceipt,
	};
}

describe("production verification execution adapter", () => {
	it("quotes every typed argv, captures the real process result, and keeps stdout outside declared evidence", async () => {
		const fixture = await executionFixture({ exitCode: 7 });
		const artifacts = await createArtifactHarness();
		try {
			const sandbox = await fixture.execute();
			expect(sandbox.executionReceipt.effectiveEnforcement).toBe("enforced");
			await expect(access(fixture.markerPath)).rejects.toThrow();
			const record = await fixture.records.resolveExecution(
				fixture.invocation.requestId,
				fixture.invocation.invocationDigest,
			);
			expect(record.ok && record.value?.processResult).toMatchObject({
				stdout: "PASS from raw stdout\n",
				exitCode: 7,
				signaled: false,
			});
			if (!record.ok || !record.value) throw new Error("missing execution record");
			const output = record.value.expectedOutputPaths[0];
			expect(output).toBeDefined();
			expect(await readFile(output!.path, "utf8")).toContain(`; touch ${fixture.markerPath};`);

			const evidenceAdapter = new ProductionVerificationArtifactEvidenceAdapter({
				runnerIdentity: runnerIdentity(),
				adapterId: "production-verification-artifact-v1",
				records: fixture.records,
				artifacts: artifacts.repository,
				validator: new JsonSchemaValidator(fixture.manifest.expectedArtifacts[0]!.schemaDigest),
			});
			const evidence = await evidenceAdapter.resolveExecutionEvidence(evidenceRequest(fixture, sandbox.executionReceipt));
			expect(evidence.ok).toBe(true);
			if (!evidence.ok) return;
			expect(evidence.value.artifacts).toHaveLength(1);
			expect(evidence.value.artifacts[0]).toMatchObject({
				outputName: "test-report",
				validation: "valid",
				lineageStatus: "verified",
				taintUpperBound: ["candidate_controlled"],
			});
			expect(evidence.value.exit.code).toBe(7);
			const result = createVerificationResult(
				fixture.baseline,
				fixture.invocation,
				evidence.value,
				admissionBundle(fixture.invocation),
			);
			expect(result.ok && result.value.outcome).toBe("failed");
			if (result.ok) expect(result.value.reasonCodes).toContain("unexpected_exit");

			const capture = await fixture.records.resolveEvidence(
				fixture.invocation.requestId,
				fixture.invocation.invocationDigest,
			);
			expect(capture.ok && capture.value).toMatchObject({
				stdoutArtifact: { kind: "log" },
				stderrArtifact: { kind: "log" },
			});
			expect(evidence.value.artifacts.map((entry) => entry.artifact.artifactId)).not.toContain(
				capture.ok && capture.value ? capture.value.stdoutArtifact.artifactId : "missing",
			);
			const metadata = await artifacts.metadata.readCommitted(
				AUTHORITY_ID,
				TENANT_ID,
				evidence.value.artifacts[0]!.artifact.artifactId,
			);
			expect(metadata.ok && metadata.value.lineage).toMatchObject({
				origin: "candidate",
				status: "verified",
				taintUpperBound: ["candidate_controlled"],
			});
		} finally {
			await Promise.all([fixture.cleanup(), artifacts.cleanup()]);
		}
	});

	it("rejects executable digest drift, baseline symlinks, and trusted environment substitution before spawn", async () => {
		const digestFixture = await executionFixture();
		try {
			await writeFile(digestFixture.executablePath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
			const result = await digestFixture.execute();
			expect(result.executionReceipt.effectiveEnforcement).toBe("unavailable");
			expect((await digestFixture.records.resolveExecution(
				digestFixture.invocation.requestId,
				digestFixture.invocation.invocationDigest,
			)).value).toBeUndefined();
		} finally {
			await digestFixture.cleanup();
		}

		const symlinkFixture = await executionFixture();
		try {
			const outside = join(symlinkFixture.root, "outside-config.json");
			await writeFile(outside, "{}\n");
			await rm(symlinkFixture.configurationPath);
			await symlink(outside, symlinkFixture.configurationPath);
			const result = await symlinkFixture.execute();
			expect(result.executionReceipt.effectiveEnforcement).toBe("unavailable");
		} finally {
			await symlinkFixture.cleanup();
		}

		const environmentFixture = await executionFixture();
		try {
			const { invocationDigest: _invocationDigest, ...body } = environmentFixture.invocation;
			const forgedBody = { ...body, environment: [{ name: "PATH", value: environmentFixture.candidateRoot }] };
			const forged: VerificationInvocation = { ...forgedBody, invocationDigest: canonicalDigest(forgedBody) };
			const result = await environmentFixture.execute(new AttestedShellBackend(), forged);
			expect(result.executionReceipt.effectiveEnforcement).toBe("unavailable");
		} finally {
			await environmentFixture.cleanup();
		}
	});

	it("marks malformed JSON invalid and rejects missing, symlinked, or cross-candidate output evidence", async () => {
		const invalidFixture = await executionFixture({ invalidJson: true });
		const invalidArtifacts = await createArtifactHarness();
		try {
			const sandbox = await invalidFixture.execute();
			const adapter = new ProductionVerificationArtifactEvidenceAdapter({
				runnerIdentity: runnerIdentity(),
				adapterId: "production-verification-artifact-v1",
				records: invalidFixture.records,
				artifacts: invalidArtifacts.repository,
				validator: new JsonSchemaValidator(invalidFixture.manifest.expectedArtifacts[0]!.schemaDigest),
			});
			const evidence = await adapter.resolveExecutionEvidence(evidenceRequest(invalidFixture, sandbox.executionReceipt));
			expect(evidence.ok && evidence.value.artifacts[0]?.validation).toBe("invalid");
		} finally {
			await Promise.all([invalidFixture.cleanup(), invalidArtifacts.cleanup()]);
		}

		const missingFixture = await executionFixture();
		const missingArtifacts = await createArtifactHarness();
		try {
			const sandbox = await missingFixture.execute();
			const record = await missingFixture.records.resolveExecution(
				missingFixture.invocation.requestId,
				missingFixture.invocation.invocationDigest,
			);
			if (!record.ok || !record.value) throw new Error("missing execution record");
			await rm(record.value.expectedOutputPaths[0]!.path);
			const adapter = new ProductionVerificationArtifactEvidenceAdapter({
				runnerIdentity: runnerIdentity(),
				adapterId: "production-verification-artifact-v1",
				records: missingFixture.records,
				artifacts: missingArtifacts.repository,
				validator: new JsonSchemaValidator(missingFixture.manifest.expectedArtifacts[0]!.schemaDigest),
			});
			const missing = await adapter.resolveExecutionEvidence(evidenceRequest(missingFixture, sandbox.executionReceipt));
			expect(missing).toMatchObject({ ok: false, error: { code: "artifact_invalid" } });
		} finally {
			await Promise.all([missingFixture.cleanup(), missingArtifacts.cleanup()]);
		}

		const symlinkFixture = await executionFixture();
		const symlinkArtifacts = await createArtifactHarness();
		try {
			const sandbox = await symlinkFixture.execute();
			const record = await symlinkFixture.records.resolveExecution(
				symlinkFixture.invocation.requestId,
				symlinkFixture.invocation.invocationDigest,
			);
			if (!record.ok || !record.value) throw new Error("missing execution record");
			const outside = join(symlinkFixture.root, "candidate-controlled-report.json");
			await writeFile(outside, "{\"forged\":true}\n");
			await rm(record.value.expectedOutputPaths[0]!.path);
			await symlink(outside, record.value.expectedOutputPaths[0]!.path);
			const adapter = new ProductionVerificationArtifactEvidenceAdapter({
				runnerIdentity: runnerIdentity(),
				adapterId: "production-verification-artifact-v1",
				records: symlinkFixture.records,
				artifacts: symlinkArtifacts.repository,
				validator: new JsonSchemaValidator(symlinkFixture.manifest.expectedArtifacts[0]!.schemaDigest),
			});
			const linked = await adapter.resolveExecutionEvidence(evidenceRequest(symlinkFixture, sandbox.executionReceipt));
			expect(linked).toMatchObject({ ok: false, error: { code: "artifact_invalid" } });
		} finally {
			await Promise.all([symlinkFixture.cleanup(), symlinkArtifacts.cleanup()]);
		}

		const oversizedFixture = await executionFixture();
		const oversizedArtifacts = await createArtifactHarness();
		try {
			const sandbox = await oversizedFixture.execute();
			const record = await oversizedFixture.records.resolveExecution(
				oversizedFixture.invocation.requestId,
				oversizedFixture.invocation.invocationDigest,
			);
			if (!record.ok || !record.value) throw new Error("missing execution record");
			await writeFile(record.value.expectedOutputPaths[0]!.path, "x".repeat(20_000));
			const adapter = new ProductionVerificationArtifactEvidenceAdapter({
				runnerIdentity: runnerIdentity(),
				adapterId: "production-verification-artifact-v1",
				records: oversizedFixture.records,
				artifacts: oversizedArtifacts.repository,
				validator: new JsonSchemaValidator(oversizedFixture.manifest.expectedArtifacts[0]!.schemaDigest),
			});
			const oversized = await adapter.resolveExecutionEvidence(evidenceRequest(oversizedFixture, sandbox.executionReceipt));
			expect(oversized).toMatchObject({ ok: false, error: { code: "artifact_invalid" } });
		} finally {
			await Promise.all([oversizedFixture.cleanup(), oversizedArtifacts.cleanup()]);
		}

		const crossFixture = await executionFixture();
		const crossArtifacts = await createArtifactHarness();
		try {
			const sandbox = await crossFixture.execute();
			const adapter = new ProductionVerificationArtifactEvidenceAdapter({
				runnerIdentity: runnerIdentity(),
				adapterId: "production-verification-artifact-v1",
				records: crossFixture.records,
				artifacts: crossArtifacts.repository,
				validator: new JsonSchemaValidator(crossFixture.manifest.expectedArtifacts[0]!.schemaDigest),
			});
			const request = evidenceRequest(crossFixture, sandbox.executionReceipt);
			const crossed = await adapter.resolveExecutionEvidence({
				...request,
				candidate: { ...request.candidate, candidateCommit: "f".repeat(40) },
			});
			expect(crossed).toMatchObject({ ok: false, error: { code: "scope_mismatch" } });
		} finally {
			await Promise.all([crossFixture.cleanup(), crossArtifacts.cleanup()]);
		}
	});

	it("records unavailable schema validation instead of treating an unknown schema digest as valid", async () => {
		const fixture = await executionFixture();
		const artifacts = await createArtifactHarness();
		try {
			const sandbox = await fixture.execute();
			const adapter = new ProductionVerificationArtifactEvidenceAdapter({
				runnerIdentity: runnerIdentity(),
				adapterId: "production-verification-artifact-v1",
				records: fixture.records,
				artifacts: artifacts.repository,
				validator: new JsonSchemaValidator(digest("unknown-schema")),
			});
			const evidence = await adapter.resolveExecutionEvidence(evidenceRequest(fixture, sandbox.executionReceipt));
			expect(evidence.ok && evidence.value.artifacts[0]?.validation).toBe("unavailable");
			if (evidence.ok) {
				const result = createVerificationResult(
					fixture.baseline,
					fixture.invocation,
					evidence.value,
					admissionBundle(fixture.invocation),
				);
				expect(result.ok && result.value.outcome).toBe("inconclusive");
			}
		} finally {
			await Promise.all([fixture.cleanup(), artifacts.cleanup()]);
		}
	});

	it("reports real Linux bwrap enforcement when runnable and explicit unavailable otherwise", async () => {
		const fixture = await executionFixture();
		try {
			const backend = new LinuxBwrapBackend(
				new NodeSandboxCommandProbe(TRUSTED_PATH),
				new NodeSandboxProcessPort(),
			);
			const result = await fixture.execute(backend);
			expect(["enforced", "unavailable"]).toContain(result.executionReceipt.effectiveEnforcement);
			expect(result.executionReceipt.effectiveEnforcement).not.toBe("degraded");
			expect(result.executionReceipt.effectiveEnforcement).not.toBe("off");
			const record = await fixture.records.resolveExecution(
				fixture.invocation.requestId,
				fixture.invocation.invocationDigest,
			);
			if (result.executionReceipt.effectiveEnforcement === "enforced") {
				expect(record.ok && record.value?.status).toBe("completed");
			} else {
				expect(record.ok && record.value).toBeUndefined();
				expect(result.executionReceipt).toHaveProperty("reasonDigest");
			}
		} finally {
			await fixture.cleanup();
		}
	});
});
