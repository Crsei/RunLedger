/** finding.transitioned + immutable Artifact snapshot 的 durable Finding repository。 */

import type { ArtifactRef } from "../protocol/v3/capability.ts";
import { canonicalDigest } from "../protocol/v3/canonical-json.ts";
import {
	sameRuntimeEventStream,
	type ExpectedRevision,
	type RuntimeEventV3,
} from "../protocol/v3/events.ts";
import {
	createRuntimeId,
	parseRuntimeId,
	type ArtifactId,
	type PrincipalId,
	type TraceId,
} from "../protocol/v3/ids.ts";
import type { RuntimeEventStore } from "../session/event-store.ts";
import type { EventWriter } from "../session/event-writer.ts";
import { readAllRuntimeEvents } from "../session/snapshot.ts";
import type { RuntimeEventDraft } from "../session/types.ts";
import type {
	FindingState,
	VerificationCoreResult,
	VerificationFinding,
} from "./types.ts";

export interface FindingSnapshotArtifactPort {
	write(finding: VerificationFinding): Promise<VerificationCoreResult<ArtifactRef>>;
	read(artifactId: ArtifactId): Promise<VerificationCoreResult<VerificationFinding | undefined>>;
}

export interface SessionFindingRepositoryOptions {
	writer: EventWriter;
	store: RuntimeEventStore;
	principalId: PrincipalId;
	snapshots: FindingSnapshotArtifactPort;
	traceIdFactory?: () => TraceId;
	clock?: () => Date;
}

type FindingEvent = Extract<RuntimeEventV3, { type: "finding.transitioned" }>;

const STATES: ReadonlySet<string> = new Set<FindingState>([
	"detected",
	"drafted",
	"verified",
	"published",
	"addressed",
	"reverified",
	"closed",
]);

function failure<T>(
	code: "invalid_schema" | "invalid_transition" | "invalid_digest" | "evidence_unavailable",
	message: string,
	retryable = false,
): VerificationCoreResult<T> {
	return { ok: false, error: { code, message, retryable } };
}

function cursor(event: RuntimeEventV3): ExpectedRevision {
	return {
		stream: event.stream,
		sequence: event.sequence,
		eventHash: event.currentEventHash,
	};
}

function sameRevision(left: ExpectedRevision, right: ExpectedRevision): boolean {
	return sameRuntimeEventStream(left.stream, right.stream) &&
		left.sequence === right.sequence &&
		left.eventHash === right.eventHash;
}

function findingEvents(events: readonly RuntimeEventV3[]): readonly FindingEvent[] {
	return events.filter(
		(event): event is FindingEvent => event.type === "finding.transitioned",
	);
}

function findingIsValid(finding: VerificationFinding): boolean {
	return (
		STATES.has(finding.state) &&
		Number.isSafeInteger(finding.revision) &&
		finding.revision >= 0 &&
		/^[a-f0-9]{64}$/u.test(finding.gateDigest) &&
		/^[a-f0-9]{64}$/u.test(finding.summaryDigest) &&
		finding.evidenceArtifactIds.length > 0 &&
		new Set(finding.evidenceArtifactIds).size === finding.evidenceArtifactIds.length
	);
}

export class SessionFindingRepository {
	readonly #writer: EventWriter;
	readonly #store: RuntimeEventStore;
	readonly #principalId: PrincipalId;
	readonly #snapshots: FindingSnapshotArtifactPort;
	readonly #traceIdFactory: () => TraceId;
	readonly #clock: () => Date;
	#serial: Promise<void> = Promise.resolve();

	public constructor(options: SessionFindingRepositoryOptions) {
		this.#writer = options.writer;
		this.#store = options.store;
		this.#principalId = options.principalId;
		this.#snapshots = options.snapshots;
		this.#traceIdFactory = options.traceIdFactory ?? (() => createRuntimeId("trace"));
		this.#clock = options.clock ?? (() => new Date());
	}

	#exclusive<T>(operation: () => Promise<VerificationCoreResult<T>>): Promise<VerificationCoreResult<T>> {
		const result = this.#serial.then(operation);
		this.#serial = result.then(() => undefined, () => undefined);
		return result;
	}

	async #events(): Promise<VerificationCoreResult<readonly RuntimeEventV3[]>> {
		let verified: Awaited<ReturnType<RuntimeEventStore["verify"]>>;
		try {
			verified = await this.#store.verify(this.#store.streamRef());
		} catch {
			return failure("evidence_unavailable", "Finding event store is unavailable", true);
		}
		if (!verified.ok || verified.value.integrity !== "valid") {
			return failure("invalid_digest", "Finding event chain is not valid");
		}
		const replay = await readAllRuntimeEvents(this.#store);
		return replay.ok
			? { ok: true, value: replay.value }
			: failure("evidence_unavailable", "Finding event replay is unavailable", replay.error.retryable);
	}

	public async load(): Promise<VerificationCoreResult<readonly VerificationFinding[]>> {
		const replay = await this.#events();
		if (!replay.ok) return replay;
		const byId = new Map<string, VerificationFinding>();
		for (const event of findingEvents(replay.value)) {
			const artifactId = event.payload.evidenceArtifactId;
			if (!artifactId) return failure("invalid_schema", "Finding event has no immutable snapshot Artifact");
			const eventIndex = replay.value.findIndex((candidate) => candidate.eventId === event.eventId);
			const previousEvent = eventIndex > 0 ? replay.value[eventIndex - 1] : undefined;
			if (!previousEvent ||
				canonicalDigest(event.payload.expectedRevision) !== canonicalDigest(cursor(previousEvent))) {
				return failure("invalid_digest", "Finding event expectedRevision does not bind the prior event head");
			}
			const parsedArtifactId = parseRuntimeId("artifact", artifactId);
			if (!parsedArtifactId) return failure("invalid_schema", "Finding snapshot Artifact identity is invalid");
			const snapshot = await this.#snapshots.read(parsedArtifactId);
			if (!snapshot.ok) return snapshot;
			if (
				!snapshot.value ||
				!findingIsValid(snapshot.value) ||
				snapshot.value.findingId !== event.payload.findingId ||
				createRuntimeId("artifact", `finding-${canonicalDigest(snapshot.value).slice(0, 48)}`) !== parsedArtifactId
			) {
				return failure("invalid_schema", "Finding snapshot Artifact is missing or invalid");
			}
			const current = byId.get(event.payload.findingId);
			if (!current) {
				if (
					event.payload.from !== "none" ||
					event.payload.to !== "detected" ||
					snapshot.value.state !== "detected" ||
					snapshot.value.revision !== 0
				) return failure("invalid_transition", "Finding genesis event is invalid");
			} else if (
				event.payload.from !== current.state ||
				event.payload.to !== snapshot.value.state ||
				snapshot.value.revision !== current.revision + 1
			) {
				return failure("invalid_transition", "Finding transition event diverges from its snapshots");
			}
			byId.set(event.payload.findingId, structuredClone(snapshot.value));
		}
		return {
			ok: true,
			value: [...byId.values()].sort((left, right) => left.findingId.localeCompare(right.findingId)),
		};
	}

	public record(
		finding: VerificationFinding,
		expectedRevision: ExpectedRevision,
	): Promise<VerificationCoreResult<VerificationFinding>> {
		return this.#exclusive(async () => {
			if (!findingIsValid(finding)) return failure("invalid_schema", "Finding snapshot is invalid");
			const loaded = await this.load();
			if (!loaded.ok) return loaded;
			const current = loaded.value.find((candidate) => candidate.findingId === finding.findingId);
			if (current && canonicalDigest(current) === canonicalDigest(finding)) {
				return { ok: true, value: structuredClone(current) };
			}
			if (
				(!current && (finding.state !== "detected" || finding.revision !== 0)) ||
				(current && finding.revision !== current.revision + 1)
			) return failure("invalid_transition", "Finding snapshot revision is not the next durable state");
			const head = this.#writer.currentHead();
			const exactExpected: ExpectedRevision = {
				stream: expectedRevision.stream,
				sequence: expectedRevision.sequence,
				eventHash: expectedRevision.eventHash,
			};
			if (!head || !sameRevision(exactExpected, head)) {
				return failure("invalid_transition", "Finding write expectedRevision is stale", true);
			}
			const artifact = await this.#snapshots.write(finding);
			if (!artifact.ok) return artifact;
			if (
				artifact.value.artifactId !==
					createRuntimeId("artifact", `finding-${canonicalDigest(finding).slice(0, 48)}`)
			) return failure("invalid_digest", "Finding snapshot Artifact identity is not content-addressed");
			const transitionHead = this.#writer.currentHead();
			if (!transitionHead) {
				return failure("evidence_unavailable", "Finding snapshot commit lost the session event head", true);
			}
			const transitionExpected: ExpectedRevision = {
				stream: transitionHead.stream,
				sequence: transitionHead.sequence,
				eventHash: transitionHead.eventHash,
			};
			const draft: RuntimeEventDraft<"finding.transitioned"> = {
				type: "finding.transitioned",
				principalId: this.#principalId,
				traceId: this.#traceIdFactory(),
				timestamp: this.#clock().toISOString(),
				payload: {
					findingId: finding.findingId,
					from: current?.state ?? "none",
					to: finding.state,
					evidenceArtifactId: artifact.value.artifactId,
					expectedRevision: transitionExpected,
				},
			};
			const appended = await this.#writer.append(draft);
			if (!appended.ok) {
				return failure(
					"evidence_unavailable",
					`Finding transition append failed: ${appended.error.code}: ${appended.error.message}`,
					appended.error.retryable,
				);
			}
			const flushed = await this.#writer.flush();
			if (!flushed.ok || !flushed.value ||
				flushed.value.eventHash !== appended.value.cursor.eventHash) {
				return failure("evidence_unavailable", "Finding transition durable barrier is uncertain", true);
			}
			const recovered = await this.load();
			if (!recovered.ok) return recovered;
			const recorded = recovered.value.find((candidate) => candidate.findingId === finding.findingId);
			return recorded && canonicalDigest(recorded) === canonicalDigest(finding)
				? { ok: true, value: recorded }
				: failure("invalid_digest", "Finding transition was not uniquely recoverable");
		});
	}
}
