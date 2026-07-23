/** Verification report 与 Session Kernel v3 / Artifact CAS 的 durable production adapter。 */

import { canonicalDigest, canonicalJson } from "../protocol/v3/canonical-json.ts";
import {
	createSessionEventStreamRef,
	sameRuntimeEventStream,
	type RuntimeEventV3,
} from "../protocol/v3/events.ts";
import {
	createRuntimeId,
	parseRuntimeId,
	type ArtifactId,
	type AuthorityId,
	type CommandId,
	type PrincipalId,
	type SessionId,
	type TenantId,
	type TraceId,
	type VerificationId,
} from "../protocol/v3/ids.ts";
import { verifyRuntimeEventChain } from "../session/chain-verification.ts";
import type { RuntimeEventStore } from "../session/event-store.ts";
import type { EventWriter } from "../session/event-writer.ts";
import { readAllRuntimeEvents } from "../session/snapshot.ts";
import type { ArtifactCasStore, ArtifactRepository } from "../artifacts/cas-store.ts";
import type { ArtifactMetadataStore } from "../artifacts/metadata-store.ts";
import type { ArtifactMetadata } from "../artifacts/types.ts";
import type { Phase7VerificationReportResolverPort } from "./report.ts";
import { isVerificationReport } from "./security.ts";
import type {
	GateManifest,
	TrustedBaselineReceipt,
	VerificationCoreResult,
	VerificationPipelineJournalPort,
	VerificationPipelineRequest,
	VerificationReport,
} from "./types.ts";

export const VERIFICATION_REPORT_MEDIA_TYPE = "application/vnd.runledger.verification-report+json";

export type VerificationSessionRuntimePhase = "after_report_committed_before_finished";

export interface VerificationSessionRuntimeOptions {
	authorityId: AuthorityId;
	tenantId: TenantId;
	sessionId: SessionId;
	principalId: PrincipalId;
	writer: EventWriter;
	store: RuntimeEventStore;
	artifacts: ArtifactRepository;
	metadata: ArtifactMetadataStore;
	cas: ArtifactCasStore;
	traceIdFactory?: () => TraceId;
	onPhase?: (phase: VerificationSessionRuntimePhase) => Promise<void> | void;
}

export interface VerificationReportArtifactIdentity {
	artifactId: ArtifactId;
	intentId: CommandId;
}

type VerificationStartedEvent = Extract<RuntimeEventV3, { type: "verification.started" }>;
type VerificationFinishedEvent = Extract<RuntimeEventV3, { type: "verification.finished" }>;

const WRITER_QUEUES = new WeakMap<EventWriter, Promise<void>>();

function serializeWriter<T>(writer: EventWriter, operation: () => Promise<T>): Promise<T> {
	const previous = WRITER_QUEUES.get(writer) ?? Promise.resolve();
	const result = previous.then(operation, operation);
	WRITER_QUEUES.set(
		writer,
		result.then(
			() => undefined,
			() => undefined,
		),
	);
	return result;
}

function failure<T>(
	code: "invalid_schema" | "invalid_digest" | "scope_mismatch" | "evidence_unavailable",
	message: string,
	retryable = false,
): VerificationCoreResult<T> {
	return { ok: false, error: { code, message, retryable } };
}

function reportArtifactId(
	authorityId: AuthorityId,
	tenantId: TenantId,
	sessionId: SessionId,
	verificationId: VerificationId,
): ArtifactId {
	const digest = canonicalDigest({
		kind: "verification_report",
		authorityId,
		tenantId,
		sessionId,
		verificationId,
	});
	return createRuntimeId("artifact", `verification-report-${digest.slice(0, 48)}`);
}

export function verificationReportArtifactIdentity(
	request: Pick<VerificationPipelineRequest, "authorityId" | "tenantId" | "sessionId" | "verificationId">,
	report: VerificationReport,
): VerificationReportArtifactIdentity {
	const intentDigest = canonicalDigest({
		kind: "verification_report_intent",
		authorityId: request.authorityId,
		tenantId: request.tenantId,
		sessionId: request.sessionId,
		verificationId: request.verificationId,
		reportDigest: report.reportDigest,
	});
	return {
		artifactId: reportArtifactId(
			request.authorityId,
			request.tenantId,
			request.sessionId,
			request.verificationId,
		),
		intentId: createRuntimeId("command", `verification-report-${intentDigest.slice(0, 48)}`),
	};
}

function startedEvents(
	events: readonly RuntimeEventV3[],
	verificationId: VerificationId,
): readonly VerificationStartedEvent[] {
	return events.filter(
		(event): event is VerificationStartedEvent =>
			event.type === "verification.started" && event.payload.verificationId === verificationId,
	);
}

function finishedEvents(
	events: readonly RuntimeEventV3[],
	verificationId: VerificationId,
): readonly VerificationFinishedEvent[] {
	return events.filter(
		(event): event is VerificationFinishedEvent =>
			event.type === "verification.finished" && event.payload.verificationId === verificationId,
	);
}

function reportMatchesRequest(report: VerificationReport, request: VerificationPipelineRequest): boolean {
	return (
		report.result.verificationId === request.verificationId &&
		report.result.authorityId === request.authorityId &&
		report.result.tenantId === request.tenantId &&
		report.result.command.requestId === request.runnerRequestId &&
		report.result.candidate.authorityId === request.authorityId &&
		report.result.candidate.tenantId === request.tenantId &&
		report.result.candidate.repositoryId === request.repositoryId &&
		report.result.candidate.workspaceId === request.candidate.workspaceId &&
		report.result.candidate.baseCommit === request.candidate.baseCommit &&
		report.result.candidate.candidateCommit === request.candidate.candidateCommit &&
		report.result.candidate.bindingDigest === request.candidate.bindingDigest
	);
}

function reportMatchesStarted(report: VerificationReport, started: VerificationStartedEvent): boolean {
	return (
		started.payload.gateDigest === report.result.gateDigest &&
		started.payload.candidateDigest === canonicalDigest(report.result.candidate)
	);
}

function reportMatchesFinished(report: VerificationReport, finished: VerificationFinishedEvent): boolean {
	return (
		finished.payload.verificationId === report.result.verificationId &&
		finished.payload.outcome === report.result.outcome &&
		finished.payload.issuerReceiptId === report.receipt.receiptId
	);
}

function validateReportMetadata(metadata: ArtifactMetadata, report: VerificationReport, sessionId: SessionId): boolean {
	const canonical = canonicalJson(report);
	return (
		metadata.state === "committed" &&
		metadata.kind === "test_report" &&
		metadata.mediaType === VERIFICATION_REPORT_MEDIA_TYPE &&
		metadata.compression === "none" &&
		metadata.evidenceStatus === "verified_transform" &&
		metadata.redaction === "redacted" &&
		metadata.transformReceipt.redaction === "redacted" &&
		metadata.transformReceipt.replacementCount === 0 &&
		metadata.transformReceipt.keyState === "available" &&
		metadata.sourceReceipt.status === "protected" &&
		metadata.source.sessionId === sessionId &&
		metadata.source.workspaceId === report.result.candidate.workspaceId &&
		metadata.storedDigest === canonicalDigest(report) &&
		metadata.originalSize === Buffer.byteLength(canonical, "utf8") &&
		metadata.storedSize === Buffer.byteLength(canonical, "utf8")
	);
}

export class VerificationSessionRuntime
	implements VerificationPipelineJournalPort, Phase7VerificationReportResolverPort
{
	readonly #authorityId: AuthorityId;
	readonly #tenantId: TenantId;
	readonly #sessionId: SessionId;
	readonly #principalId: PrincipalId;
	readonly #writer: EventWriter;
	readonly #store: RuntimeEventStore;
	readonly #artifacts: ArtifactRepository;
	readonly #metadata: ArtifactMetadataStore;
	readonly #cas: ArtifactCasStore;
	readonly #traceIdFactory: () => TraceId;
	readonly #onPhase: VerificationSessionRuntimeOptions["onPhase"];

	public constructor(options: VerificationSessionRuntimeOptions) {
		this.#authorityId = options.authorityId;
		this.#tenantId = options.tenantId;
		this.#sessionId = options.sessionId;
		this.#principalId = options.principalId;
		this.#writer = options.writer;
		this.#store = options.store;
		this.#artifacts = options.artifacts;
		this.#metadata = options.metadata;
		this.#cas = options.cas;
		this.#traceIdFactory = options.traceIdFactory ?? (() => createRuntimeId("trace"));
		this.#onPhase = options.onPhase;
	}

	#requestInScope(request: VerificationPipelineRequest): boolean {
		return (
			request.authorityId === this.#authorityId &&
			request.tenantId === this.#tenantId &&
			request.sessionId === this.#sessionId &&
			request.candidate.authorityId === this.#authorityId &&
			request.candidate.tenantId === this.#tenantId
		);
	}

	async #verifiedEvents(): Promise<VerificationCoreResult<readonly RuntimeEventV3[]>> {
		let verified: Awaited<ReturnType<RuntimeEventStore["verify"]>>;
		try {
			verified = await this.#store.verify(this.#store.streamRef());
		} catch {
			return failure("evidence_unavailable", "verification event store is unavailable", true);
		}
		if (!verified.ok) {
			return failure("evidence_unavailable", "verification event store could not be verified", verified.error.retryable);
		}
		if (
			verified.value.integrity !== "valid" ||
			verified.value.authorityId !== this.#authorityId ||
			verified.value.tenantId !== this.#tenantId ||
			!sameRuntimeEventStream(
				verified.value.stream,
				createSessionEventStreamRef({ authorityId: this.#authorityId, tenantId: this.#tenantId }, this.#sessionId),
			)
		) return failure("invalid_digest", "verification event chain scope or integrity is invalid");
		const replay = await readAllRuntimeEvents(this.#store);
		if (!replay.ok) {
			return failure("evidence_unavailable", "verification event replay failed", replay.error.retryable);
		}
		if (replay.value.length === 0) return { ok: true, value: [] };
		const chain = verifyRuntimeEventChain(replay.value, {
			authorityId: this.#authorityId,
			tenantId: this.#tenantId,
			stream: verified.value.stream,
		});
		return chain.integrity === "valid"
			? { ok: true, value: replay.value }
			: failure("invalid_digest", "verification event chain failed canonical validation");
	}

	async #loadArtifact(artifactId: ArtifactId): Promise<VerificationCoreResult<VerificationReport | undefined>> {
		const reconciled = await this.#artifacts.reconcile({
			authorityId: this.#authorityId,
			tenantId: this.#tenantId,
		});
		if (!reconciled.ok) {
			return failure("evidence_unavailable", "verification Artifact reconciliation failed", reconciled.error.retryable);
		}
		const metadata = await this.#metadata.readCommitted(this.#authorityId, this.#tenantId, artifactId);
		if (!metadata.ok) {
			return metadata.error.code === "not_found"
				? { ok: true, value: undefined }
				: failure("invalid_digest", "verification report metadata is invalid");
		}
		if (
			metadata.value.artifactId !== artifactId ||
			metadata.value.authorityId !== this.#authorityId ||
			metadata.value.tenantId !== this.#tenantId
		) return failure("scope_mismatch", "verification report Artifact scope mismatch");
		const stored = await this.#cas.read(metadata.value.storedDigest);
		if (!stored.ok) return failure("invalid_digest", "verification report Artifact content is unavailable");
		let text: string;
		let parsed: unknown;
		try {
			text = new TextDecoder("utf-8", { fatal: true }).decode(stored.value);
			parsed = JSON.parse(text) as unknown;
		} catch {
			return failure("invalid_schema", "verification report Artifact is not canonical UTF-8 JSON");
		}
		if (!isVerificationReport(parsed)) {
			return failure("invalid_schema", "verification report Artifact failed schema and digest validation");
		}
		if (canonicalJson(parsed) !== text || !validateReportMetadata(metadata.value, parsed, this.#sessionId)) {
			return failure("invalid_digest", "verification report Artifact metadata does not match canonical content");
		}
		return { ok: true, value: parsed };
	}

	async #reportForFinished(
		events: readonly RuntimeEventV3[],
		finished: VerificationFinishedEvent,
	): Promise<VerificationCoreResult<VerificationReport>> {
		const verificationId = parseRuntimeId("verification", finished.payload.verificationId);
		const artifactId = parseRuntimeId("artifact", finished.payload.resultArtifactId);
		if (!verificationId || !artifactId) {
			return failure("invalid_schema", "verification terminal event identity is invalid");
		}
		const relatedStarted = startedEvents(events, verificationId);
		if (relatedStarted.length !== 1) {
			return failure("invalid_digest", "verification terminal event does not have one durable start");
		}
		const report = await this.#loadArtifact(artifactId);
		if (!report.ok) return report;
		if (!report.value) return failure("invalid_digest", "verification terminal event references a missing report Artifact");
		if (!reportMatchesStarted(report.value, relatedStarted[0]!) || !reportMatchesFinished(report.value, finished)) {
			return failure("invalid_digest", "verification report does not match its canonical events");
		}
		return { ok: true, value: report.value };
	}

	async #appendFinished(
		request: VerificationPipelineRequest,
		report: VerificationReport,
		artifactId: ArtifactId,
	): Promise<VerificationCoreResult<void>> {
		const events = await this.#verifiedEvents();
		if (!events.ok) return events;
		const terminals = finishedEvents(events.value, request.verificationId);
		if (terminals.length > 1) return failure("invalid_digest", "verification has duplicate terminal events");
		if (terminals.length === 1) {
			const existing = await this.#reportForFinished(events.value, terminals[0]!);
			if (!existing.ok) return existing;
			return existing.value.reportDigest === report.reportDigest && terminals[0]!.payload.resultArtifactId === artifactId
				? { ok: true, value: undefined }
				: failure("invalid_digest", "verification terminal event conflicts with the report");
		}
		const appended = await this.#writer.append({
			type: "verification.finished",
			principalId: this.#principalId,
			traceId: this.#traceIdFactory(),
			payload: {
				verificationId: request.verificationId,
				outcome: report.result.outcome,
				resultArtifactId: artifactId,
				issuerReceiptId: report.receipt.receiptId,
			},
		});
		return appended.ok
			? { ok: true, value: undefined }
			: failure("evidence_unavailable", "verification terminal event append failed", appended.error.retryable);
	}

	async #resolveExistingSafely(
		request: VerificationPipelineRequest,
	): Promise<VerificationCoreResult<VerificationReport | undefined>> {
		if (!this.#requestInScope(request)) return failure("scope_mismatch", "verification request is outside the session scope");
		const events = await this.#verifiedEvents();
		if (!events.ok) return events;
		const starts = startedEvents(events.value, request.verificationId);
		const terminals = finishedEvents(events.value, request.verificationId);
		if (starts.length > 1 || terminals.length > 1) {
			return failure("invalid_digest", "verification contains duplicate start or terminal events");
		}
		if (terminals.length === 1) {
			const resolved = await this.#reportForFinished(events.value, terminals[0]!);
			if (!resolved.ok) return resolved;
			return reportMatchesRequest(resolved.value, request)
				? resolved
				: failure("scope_mismatch", "durable verification report does not match the request");
		}
		if (starts.length === 0) return { ok: true, value: undefined };
		const started = starts[0]!;
		if (
			started.payload.idempotencyKey !== request.runnerRequestId ||
			started.payload.candidateDigest !== canonicalDigest(request.candidate)
		) return failure("invalid_digest", "verification start conflicts with the request");
		const artifactId = reportArtifactId(
			request.authorityId,
			request.tenantId,
			request.sessionId,
			request.verificationId,
		);
		const report = await this.#loadArtifact(artifactId);
		if (!report.ok || !report.value) return report;
		if (!reportMatchesRequest(report.value, request) || !reportMatchesStarted(report.value, started)) {
			return failure("invalid_digest", "committed verification report does not match its durable start");
		}
		const finished = await this.#appendFinished(request, report.value, artifactId);
		return finished.ok ? { ok: true, value: report.value } : finished;
	}

	public resolveExisting(
		request: VerificationPipelineRequest,
	): Promise<VerificationCoreResult<VerificationReport | undefined>> {
		return serializeWriter(this.#writer, () => this.#resolveExistingSafely(request));
	}

	public recordStarted(
		request: VerificationPipelineRequest,
		manifest: GateManifest,
		baseline: TrustedBaselineReceipt,
	): Promise<VerificationCoreResult<void>> {
		return serializeWriter(this.#writer, async () => {
			if (!this.#requestInScope(request)) return failure("scope_mismatch", "verification request is outside the session scope");
			if (
				baseline.authorityId !== request.authorityId ||
				baseline.tenantId !== request.tenantId ||
				baseline.repositoryId !== request.repositoryId ||
				baseline.baseCommit !== request.candidate.baseCommit ||
				!/^[a-f0-9]{64}$/.test(manifest.manifestDigest)
			) return failure("scope_mismatch", "verification gate or baseline scope is invalid");
			const events = await this.#verifiedEvents();
			if (!events.ok) return events;
			const starts = startedEvents(events.value, request.verificationId);
			if (starts.length > 1) return failure("invalid_digest", "verification has duplicate start events");
			const payload = {
				verificationId: request.verificationId,
				gateDigest: manifest.manifestDigest,
				candidateDigest: canonicalDigest(request.candidate),
				idempotencyKey: request.runnerRequestId,
			};
			if (starts.length === 1) {
				return canonicalDigest(starts[0]!.payload) === canonicalDigest(payload)
					? { ok: true, value: undefined }
					: failure("invalid_digest", "verification start idempotency collision");
			}
			if (finishedEvents(events.value, request.verificationId).length > 0) {
				return failure("invalid_digest", "verification terminal event exists without its start");
			}
			const appended = await this.#writer.append({
				type: "verification.started",
				principalId: this.#principalId,
				traceId: this.#traceIdFactory(),
				payload,
			});
			return appended.ok
				? { ok: true, value: undefined }
				: failure("evidence_unavailable", "verification start event append failed", appended.error.retryable);
		});
	}

	public recordFinished(
		request: VerificationPipelineRequest,
		report: VerificationReport,
	): Promise<VerificationCoreResult<void>> {
		return serializeWriter(this.#writer, async () => {
			if (!isVerificationReport(report)) return failure("invalid_schema", "verification report is invalid");
			if (!this.#requestInScope(request) || !reportMatchesRequest(report, request)) {
				return failure("scope_mismatch", "verification report is outside the request scope");
			}
			const events = await this.#verifiedEvents();
			if (!events.ok) return events;
			const starts = startedEvents(events.value, request.verificationId);
			if (starts.length !== 1 || !reportMatchesStarted(report, starts[0]!)) {
				return failure("invalid_digest", "verification report does not have a matching durable start");
			}
			const identity = verificationReportArtifactIdentity(request, report);
			const content = canonicalJson(report);
			const references = [...new Set(report.result.artifacts.map((entry) => entry.artifact.artifactId))].sort();
			let written = await this.#artifacts.write({
				authorityId: request.authorityId,
				tenantId: request.tenantId,
				artifactId: identity.artifactId,
				intentId: identity.intentId,
				principalId: request.principalId,
				source: {
					sessionId: request.sessionId,
					workspaceId: request.candidate.workspaceId,
					producerId: request.principalId,
				},
				kind: "test_report",
				mediaType: VERIFICATION_REPORT_MEDIA_TYPE,
				content,
				references,
				retention: { pins: [`verification:${request.verificationId}`] },
				createdAt: report.result.finishedAt,
			});
			if (written.ok && written.value.state === "pending") {
				const reconciled = await this.#artifacts.reconcile(request);
				if (!reconciled.ok) {
					return failure("evidence_unavailable", "verification report Artifact reconciliation failed", reconciled.error.retryable);
				}
				written = await this.#artifacts.write({
					authorityId: request.authorityId,
					tenantId: request.tenantId,
					artifactId: identity.artifactId,
					intentId: identity.intentId,
					principalId: request.principalId,
					source: {
						sessionId: request.sessionId,
						workspaceId: request.candidate.workspaceId,
						producerId: request.principalId,
					},
					kind: "test_report",
					mediaType: VERIFICATION_REPORT_MEDIA_TYPE,
					content,
					references,
					retention: { pins: [`verification:${request.verificationId}`] },
					createdAt: report.result.finishedAt,
				});
			}
			if (!written.ok || written.value.state !== "committed" || !written.value.reference) {
				return failure(
					"evidence_unavailable",
					"verification report Artifact is not durably committed",
					!written.ok ? written.error.retryable : true,
				);
			}
			if (!validateReportMetadata(written.value.metadata, report, request.sessionId)) {
				return failure("invalid_digest", "verification report Artifact was transformed or stored without source protection");
			}
			try {
				await this.#onPhase?.("after_report_committed_before_finished");
			} catch {
				return failure("evidence_unavailable", "verification report committed before terminal event", true);
			}
			return this.#appendFinished(request, report, identity.artifactId);
		});
	}

	public resolveVerification(
		verificationId: VerificationId,
	): Promise<VerificationCoreResult<VerificationReport>> {
		return serializeWriter(this.#writer, async () => {
			const events = await this.#verifiedEvents();
			if (!events.ok) return events;
			const terminals = finishedEvents(events.value, verificationId);
			if (terminals.length !== 1) {
				return failure("evidence_unavailable", "verification terminal report is unavailable", terminals.length === 0);
			}
			return this.#reportForFinished(events.value, terminals[0]!);
		});
	}

	public resolveByReceiptDigest(receiptDigest: string): Promise<VerificationCoreResult<VerificationReport>> {
		return serializeWriter(this.#writer, async () => {
			if (!/^[a-f0-9]{64}$/.test(receiptDigest)) {
				return failure("invalid_digest", "verification receipt digest is invalid");
			}
			const events = await this.#verifiedEvents();
			if (!events.ok) return events;
			const matches: VerificationReport[] = [];
			for (const event of events.value) {
				if (event.type !== "verification.finished") continue;
				const report = await this.#reportForFinished(events.value, event);
				if (!report.ok) return report;
				if (report.value.receipt.receiptDigest === receiptDigest) matches.push(report.value);
			}
			if (matches.length !== 1) {
				return failure(
					matches.length === 0 ? "evidence_unavailable" : "invalid_digest",
					matches.length === 0 ? "verification receipt was not found" : "verification receipt is duplicated",
					matches.length === 0,
				);
			}
			return { ok: true, value: matches[0]! };
		});
	}
}
