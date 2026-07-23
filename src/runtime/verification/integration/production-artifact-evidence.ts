/** Production Verification 的进程日志、声明输出与 Artifact evidence 捕获。 */

import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import type { ArtifactRef } from "../../protocol/v3/capability.ts";
import { isSandboxExecutionReceiptRef } from "../../protocol/v3/capability.ts";
import { canonicalDigest } from "../../protocol/v3/canonical-json.ts";
import { createRuntimeId, isRuntimeId, type PrincipalId } from "../../protocol/v3/ids.ts";
import type { InputSourceRef } from "../../protocol/v3/taint.ts";
import type { ArtifactRepository } from "../../artifacts/cas-store.ts";
import type { ArtifactWriteOutcome } from "../../artifacts/types.ts";
import {
	artifactEvidenceReceiptDigest,
	executionEvidenceDigest,
	isVerificationExecutionEvidence,
	validateExecutionEvidence,
} from "../evidence.ts";
import type {
	ArtifactEvidenceReceipt,
	CandidateIdentity,
	GateExpectedArtifact,
	VerificationArtifactEvidenceRequest,
	VerificationCoreResult,
	VerificationExecutionEvidence,
	VerificationRunnerIdentity,
} from "../types.ts";
import {
	productionVerificationArtifactAdapterIdentity,
	type ProductionVerificationArtifactPort,
} from "./production-composition.ts";
import { pathWithin } from "../../../security/policy-filesystem.ts";
import type {
	VerificationEvidenceCaptureRecord,
	VerificationExecutionRecord,
	VerificationExecutionRecordStorePort,
} from "./production-execution-adapter.ts";

function failure<T>(
	code: "invalid_schema" | "scope_mismatch" | "evidence_unavailable" | "artifact_invalid" | "cross_commit_evidence",
	message: string,
	retryable = false,
): VerificationCoreResult<T> {
	return { ok: false, error: { code, message, retryable } };
}

function errorCode(cause: unknown): string | undefined {
	return cause instanceof Error && "code" in cause ? String(cause.code) : undefined;
}

function sameCanonical(left: unknown, right: unknown): boolean {
	try {
		return canonicalDigest(left) === canonicalDigest(right);
	} catch {
		return false;
	}
}

function sha256(content: Uint8Array): string {
	return createHash("sha256").update(content).digest("hex");
}

function validRunnerIdentity(identity: VerificationRunnerIdentity): boolean {
	return (
		isRuntimeId(identity.runnerId, "principal") &&
		identity.issuerId.length > 0 &&
		identity.issuerId.length <= 512 &&
		identity.version.length > 0 &&
		identity.version.length <= 512 &&
		identity.identityDigest === canonicalDigest({
			issuerId: identity.issuerId,
			runnerId: identity.runnerId,
			version: identity.version,
		})
	);
}

export interface TrustedArtifactSchemaValidationRequest {
	authorityId: VerificationArtifactEvidenceRequest["authorityId"];
	tenantId: VerificationArtifactEvidenceRequest["tenantId"];
	requestId: VerificationArtifactEvidenceRequest["requestId"];
	verificationId: VerificationArtifactEvidenceRequest["verificationId"];
	candidate: CandidateIdentity;
	outputName: string;
	mediaType: string;
	schemaDigest: string;
	content: Uint8Array;
}

/** schemaDigest 的解释只能来自受信 registry/validator，不能由 candidate 自报。 */
export interface TrustedArtifactSchemaValidatorPort {
	readonly validatorId: PrincipalId;
	preflight(): Promise<VerificationCoreResult<void>>;
	validate(
		request: TrustedArtifactSchemaValidationRequest,
		signal?: AbortSignal,
	): Promise<VerificationCoreResult<"valid" | "invalid">>;
}

export interface ProductionVerificationArtifactEvidenceOptions {
	runnerIdentity: VerificationRunnerIdentity;
	adapterId: string;
	records: VerificationExecutionRecordStorePort;
	artifacts: ArtifactRepository;
	validator: TrustedArtifactSchemaValidatorPort;
}

interface CapturedFile {
	content: Uint8Array;
	size: number;
}

function outputPathFor(record: VerificationExecutionRecord, outputName: string): string | undefined {
	return record.expectedOutputPaths.find((entry) => entry.name === outputName)?.path;
}

async function readCapturedFile(
	record: VerificationExecutionRecord,
	expected: GateExpectedArtifact,
): Promise<VerificationCoreResult<CapturedFile | undefined>> {
	const path = outputPathFor(record, expected.name);
	if (!path) {
		return expected.required
			? failure("artifact_invalid", `required Artifact has no reserved output path: ${expected.name}`)
			: { ok: true, value: undefined };
	}
	if (resolve(path) !== path || !pathWithin(record.artifactOutputRoot, path)) {
		return failure("scope_mismatch", `Artifact output escaped its runtime-owned root: ${expected.name}`);
	}
	let canonical: string;
	let pathStats: Awaited<ReturnType<typeof lstat>>;
	try {
		[canonical, pathStats] = await Promise.all([realpath(path), lstat(path)]);
	} catch (cause) {
		if (errorCode(cause) === "ENOENT" && !expected.required) return { ok: true, value: undefined };
		return failure("artifact_invalid", `required Artifact output is unavailable: ${expected.name}`);
	}
	if (
		resolve(canonical) !== path ||
		!pathWithin(record.artifactOutputRoot, canonical) ||
		pathStats.isSymbolicLink() ||
		!pathStats.isFile() ||
		pathStats.size > expected.maxBytes
	) return failure("artifact_invalid", `Artifact output is not a bounded regular file: ${expected.name}`);

	let handle: Awaited<ReturnType<typeof open>> | undefined;
	try {
		handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
		const before = await handle.stat();
		if (!before.isFile() || before.size !== pathStats.size || before.size > expected.maxBytes) {
			return failure("artifact_invalid", `Artifact output changed before capture: ${expected.name}`);
		}
		const content = await handle.readFile();
		const after = await handle.stat();
		if (
			content.byteLength !== before.size ||
			after.size !== before.size ||
			after.mtimeMs !== before.mtimeMs ||
			after.ino !== before.ino ||
			after.dev !== before.dev
		) return failure("evidence_unavailable", `Artifact output changed during capture: ${expected.name}`, true);
		return { ok: true, value: { content: Uint8Array.from(content), size: content.byteLength } };
	} catch {
		return failure("evidence_unavailable", `Artifact output could not be captured safely: ${expected.name}`, true);
	} finally {
		await handle?.close().catch(() => undefined);
	}
}

function isJsonMediaType(mediaType: string): boolean {
	const essence = mediaType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
	return essence === "application/json" || essence.endsWith("+json");
}

function jsonIsStructurallyValid(content: Uint8Array): boolean {
	try {
		const text = new TextDecoder("utf-8", { fatal: true }).decode(content);
		JSON.parse(text);
		return true;
	} catch {
		return false;
	}
}

function artifactIdentity(
	kind: "stdout" | "stderr" | "output",
	request: VerificationArtifactEvidenceRequest,
	name: string,
): { artifactId: ReturnType<typeof createRuntimeId<"artifact">>; intentId: ReturnType<typeof createRuntimeId<"command">> } {
	const digest = canonicalDigest({
		contract: "runledger.production-verification-artifact-capture",
		kind,
		requestId: request.requestId,
		invocationDigest: request.invocationDigest,
		name,
	});
	return {
		artifactId: createRuntimeId("artifact", `verification-${digest.slice(0, 48)}`),
		intentId: createRuntimeId("command", `verification-artifact-${digest.slice(0, 48)}`),
	};
}

function candidateSource(
	request: VerificationArtifactEvidenceRequest,
	record: VerificationExecutionRecord,
	name: string,
	content: Uint8Array,
): InputSourceRef {
	const sourceDigest = canonicalDigest({
		candidateCommit: request.candidate.candidateCommit,
		outputName: name,
		contentDigest: sha256(content),
	});
	return {
		schemaVersion: 1,
		authorityId: request.authorityId,
		tenantId: request.tenantId,
		sourceId: createRuntimeId("inputSource", `verification-${sourceDigest.slice(0, 48)}`),
		kind: "candidate_config",
		sourceDigest,
		trust: "tainted",
		taintLabels: ["candidate_controlled"],
		observedAt: record.finishedAt,
	};
}

async function committedArtifact(
	repository: ArtifactRepository,
	request: Parameters<ArtifactRepository["write"]>[0],
): Promise<VerificationCoreResult<ArtifactWriteOutcome & { reference: ArtifactRef }>> {
	let written = await repository.write(request);
	if (written.ok && written.value.state === "pending") {
		const reconciled = await repository.reconcile(request);
		if (!reconciled.ok) {
			return failure("evidence_unavailable", "verification Artifact reconciliation failed", reconciled.error.retryable);
		}
		written = await repository.write(request);
	}
	if (!written.ok || written.value.state !== "committed" || !written.value.reference) {
		return failure(
			"evidence_unavailable",
			"verification Artifact was not durably committed",
			!written.ok ? written.error.retryable : true,
		);
	}
	return { ok: true, value: { ...written.value, reference: written.value.reference } };
}

function recordMatchesRequest(
	record: VerificationExecutionRecord,
	request: VerificationArtifactEvidenceRequest,
): boolean {
	return (
		record.status === "completed" &&
		record.requestId === request.requestId &&
		record.invocationDigest === request.invocationDigest &&
		record.invocation.invocationDigest === request.invocationDigest &&
		record.invocation.verificationId === request.verificationId &&
		sameCanonical(record.invocation.candidate, request.candidate) &&
		sameCanonical(record.invocation.expectedArtifacts, request.expectedArtifacts) &&
		sameCanonical(record.manifest.expectedArtifacts, request.expectedArtifacts) &&
		sameCanonical(record.sandboxReceipt, request.sandboxReceipt) &&
		record.sandboxReceipt.invocationDigest === request.invocationDigest &&
		record.processResult !== undefined &&
		!record.processResult.signaled &&
		!record.processResult.denied &&
		record.candidateEnvelope.workspaceId === request.candidate.workspaceId &&
		record.candidateEnvelope.repositoryId === request.candidate.repositoryId &&
		record.candidateEnvelope.baseCommit === request.candidate.baseCommit
	);
}

export class ProductionVerificationArtifactEvidenceAdapter implements ProductionVerificationArtifactPort {
	public readonly environment = "production" as const;
	public readonly runnerIdentity: VerificationRunnerIdentity;
	public readonly adapterId: string;
	public readonly adapterIdentityDigest: string;
	readonly #records: VerificationExecutionRecordStorePort;
	readonly #artifacts: ArtifactRepository;
	readonly #validator: TrustedArtifactSchemaValidatorPort;

	public constructor(options: ProductionVerificationArtifactEvidenceOptions) {
		this.runnerIdentity = options.runnerIdentity;
		this.adapterId = options.adapterId;
		this.adapterIdentityDigest = productionVerificationArtifactAdapterIdentity(
			options.runnerIdentity,
			options.adapterId,
		);
		this.#records = options.records;
		this.#artifacts = options.artifacts;
		this.#validator = options.validator;
	}

	public async preflight(): Promise<VerificationCoreResult<void>> {
		if (
			!validRunnerIdentity(this.runnerIdentity) ||
			!this.adapterId ||
			this.adapterId.length > 512 ||
			!isRuntimeId(this.#validator.validatorId, "principal") ||
			this.adapterIdentityDigest !== productionVerificationArtifactAdapterIdentity(
				this.runnerIdentity,
				this.adapterId,
			)
		) return failure("invalid_schema", "production verification Artifact adapter identity is invalid");
		let records: VerificationCoreResult<void>;
		let validator: VerificationCoreResult<void>;
		try {
			[records, validator] = await Promise.all([this.#records.preflight(), this.#validator.preflight()]);
		} catch {
			return failure("evidence_unavailable", "production verification Artifact dependencies are unavailable", true);
		}
		if (!records.ok) return records;
		if (!validator.ok) return validator;
		return { ok: true, value: undefined };
	}

	async #writeLog(
		request: VerificationArtifactEvidenceRequest,
		record: VerificationExecutionRecord,
		stream: "stdout" | "stderr",
		content: string,
	): Promise<VerificationCoreResult<ArtifactRef>> {
		const bytes = Buffer.from(content, "utf8");
		const identity = artifactIdentity(stream, request, stream);
		const written = await committedArtifact(this.#artifacts, {
			authorityId: request.authorityId,
			tenantId: request.tenantId,
			artifactId: identity.artifactId,
			intentId: identity.intentId,
			principalId: this.runnerIdentity.runnerId,
			source: {
				sessionId: record.candidateEnvelope.sessionId,
				workspaceId: request.candidate.workspaceId,
				producerId: this.runnerIdentity.runnerId,
			},
			kind: "log",
			mediaType: "text/plain; charset=utf-8",
			content: bytes,
			lineage: {
				origin: "candidate",
				inputSources: [candidateSource(request, record, stream, bytes)],
				declassificationReceipts: [],
			},
			retention: { pins: [`verification:${request.verificationId}`] },
			createdAt: record.finishedAt,
		});
		return written.ok ? { ok: true, value: written.value.reference } : written;
	}

	async #captureExpectedArtifact(
		request: VerificationArtifactEvidenceRequest,
		record: VerificationExecutionRecord,
		expected: GateExpectedArtifact,
		signal?: AbortSignal,
	): Promise<VerificationCoreResult<ArtifactEvidenceReceipt | undefined>> {
		const captured = await readCapturedFile(record, expected);
		if (!captured.ok) return captured;
		if (captured.value === undefined) return { ok: true, value: undefined };
		if (signal?.aborted) return failure("evidence_unavailable", "verification Artifact capture was cancelled", true);
		let validation: ArtifactEvidenceReceipt["validation"];
		if (isJsonMediaType(expected.mediaType) && !jsonIsStructurallyValid(captured.value.content)) {
			validation = "invalid";
		} else {
			try {
				const validated = await this.#validator.validate(
					{
						authorityId: request.authorityId,
						tenantId: request.tenantId,
						requestId: request.requestId,
						verificationId: request.verificationId,
						candidate: request.candidate,
						outputName: expected.name,
						mediaType: expected.mediaType,
						schemaDigest: expected.schemaDigest,
						content: captured.value.content,
					},
					signal,
				);
				validation = validated.ok ? validated.value : "unavailable";
			} catch {
				validation = "unavailable";
			}
		}
		const identity = artifactIdentity("output", request, expected.name);
		const written = await committedArtifact(this.#artifacts, {
			authorityId: request.authorityId,
			tenantId: request.tenantId,
			artifactId: identity.artifactId,
			intentId: identity.intentId,
			principalId: this.runnerIdentity.runnerId,
			source: {
				sessionId: record.candidateEnvelope.sessionId,
				workspaceId: request.candidate.workspaceId,
				producerId: this.runnerIdentity.runnerId,
			},
			kind: expected.kind,
			mediaType: expected.mediaType,
			content: captured.value.content,
			lineage: {
				origin: "candidate",
				inputSources: [candidateSource(request, record, expected.name, captured.value.content)],
				declassificationReceipts: [],
			},
			retention: { pins: [`verification:${request.verificationId}`] },
			createdAt: record.finishedAt,
		});
		if (!written.ok) return written;
		if (written.value.reference.storedSize > expected.maxBytes) {
			return failure("artifact_invalid", `stored Artifact exceeds the trusted maximum: ${expected.name}`);
		}
		const body: Omit<ArtifactEvidenceReceipt, "receiptDigest"> = {
			authorityId: request.authorityId,
			tenantId: request.tenantId,
			receiptId: createRuntimeId(
				"receipt",
				`verification-evidence-${canonicalDigest({ requestId: request.requestId, outputName: expected.name, artifact: written.value.reference }).slice(0, 48)}`,
			),
			requestId: request.requestId,
			verificationId: request.verificationId,
			outputName: expected.name,
			artifact: written.value.reference,
			candidateCommit: request.candidate.candidateCommit,
			schemaDigest: expected.schemaDigest,
			validation,
			lineageStatus: written.value.metadata.lineage.status,
			lineageDigest: written.value.metadata.lineage.lineageDigest,
			taintUpperBound: written.value.metadata.lineage.taintUpperBound,
			validatorId: this.#validator.validatorId,
			validatedAt: record.finishedAt,
		};
		return { ok: true, value: { ...body, receiptDigest: artifactEvidenceReceiptDigest(body) } };
	}

	public async resolveExecutionEvidence(
		request: VerificationArtifactEvidenceRequest,
		signal?: AbortSignal,
	): Promise<VerificationCoreResult<VerificationExecutionEvidence>> {
		const preflight = await this.preflight();
		if (!preflight.ok) return preflight;
		if (!isSandboxExecutionReceiptRef(request.sandboxReceipt)) {
			return failure("invalid_schema", "verification evidence request contains an invalid sandbox receipt");
		}
		let recordResult: VerificationCoreResult<VerificationExecutionRecord | undefined>;
		try {
			recordResult = await this.#records.resolveExecution(request.requestId, request.invocationDigest);
		} catch {
			return failure("evidence_unavailable", "verification execution record is unavailable", true);
		}
		if (!recordResult.ok) return recordResult;
		const record = recordResult.value;
		if (!record) return failure("evidence_unavailable", "verification execution record was not found", true);
		if (!recordMatchesRequest(record, request)) {
			return failure("scope_mismatch", "verification execution record is not correlated with the evidence request");
		}
		let cached: VerificationCoreResult<VerificationEvidenceCaptureRecord | undefined>;
		try {
			cached = await this.#records.resolveEvidence(request.requestId, request.invocationDigest);
		} catch {
			return failure("evidence_unavailable", "verification evidence capture store is unavailable", true);
		}
		if (!cached.ok) return cached;
		if (cached.value) {
			const validated = validateExecutionEvidence(cached.value.evidence, record.invocation);
			return validated.ok
				? { ok: true, value: cached.value.evidence }
				: failure("evidence_unavailable", "cached verification evidence is invalid");
		}
		if (signal?.aborted) return failure("evidence_unavailable", "verification evidence capture was cancelled", true);
		const processResult = record.processResult;
		if (!processResult) return failure("evidence_unavailable", "verification process result was not captured", true);
		const stdout = await this.#writeLog(request, record, "stdout", processResult.stdout);
		if (!stdout.ok) return stdout;
		const stderr = await this.#writeLog(request, record, "stderr", processResult.stderr);
		if (!stderr.ok) return stderr;
		const receipts: ArtifactEvidenceReceipt[] = [];
		for (const expected of request.expectedArtifacts) {
			const captured = await this.#captureExpectedArtifact(request, record, expected, signal);
			if (!captured.ok) return captured;
			if (captured.value) receipts.push(captured.value);
		}
		const body: Omit<VerificationExecutionEvidence, "evidenceDigest"> = {
			authorityId: request.authorityId,
			tenantId: request.tenantId,
			requestId: request.requestId,
			verificationId: request.verificationId,
			invocationDigest: request.invocationDigest,
			sandboxReceipt: record.sandboxReceipt,
			exit: { code: processResult.exitCode, signal: null, timedOut: false },
			artifacts: receipts,
			startedAt: record.startedAt,
			finishedAt: record.finishedAt,
			runner: this.runnerIdentity,
		};
		const evidence: VerificationExecutionEvidence = { ...body, evidenceDigest: executionEvidenceDigest(body) };
		const validated = validateExecutionEvidence(evidence, record.invocation);
		if (!isVerificationExecutionEvidence(evidence) || !validated.ok) {
			return failure("evidence_unavailable", "captured verification evidence failed its exact contract");
		}
		const capture: VerificationEvidenceCaptureRecord = {
			requestId: request.requestId,
			invocationDigest: request.invocationDigest,
			stdoutArtifact: stdout.value,
			stderrArtifact: stderr.value,
			artifacts: receipts,
			evidence,
		};
		let recorded: VerificationCoreResult<void>;
		try {
			recorded = await this.#records.recordEvidence(capture);
		} catch {
			return failure("evidence_unavailable", "verification evidence capture could not be recorded", true);
		}
		if (!recorded.ok) return recorded;
		return { ok: true, value: evidence };
	}
}
