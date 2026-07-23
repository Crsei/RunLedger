/** Artifact intent/commit 与 Session Kernel v3 事件链之间的 durable adapter。 */

import { canonicalDigest } from "../protocol/v3/canonical-json.ts";
import { createRuntimeId, parseRuntimeId, type CommandId, type PrincipalId, type TraceId } from "../protocol/v3/ids.ts";
import type { RuntimeEventV3 } from "../protocol/v3/events.ts";
import type { RuntimeEventStore } from "../session/event-store.ts";
import type { EventWriter } from "../session/event-writer.ts";
import { readAllRuntimeEvents } from "../session/snapshot.ts";
import type {
	ArtifactAbortRecord,
	ArtifactCommitRecord,
	ArtifactError,
	ArtifactEventJournalPort,
	ArtifactIntentRecord,
	ArtifactJournalState,
	ArtifactResult,
	ArtifactScope,
} from "./types.ts";

export interface SessionArtifactJournalOptions {
	writer: EventWriter;
	store: RuntimeEventStore;
	principalId: PrincipalId;
	traceIdFactory?: () => TraceId;
}

function abortFromEvent(event: Extract<RuntimeEventV3, { type: "artifact.aborted" }>): ArtifactResult<ArtifactAbortRecord> {
	const intentId = parseRuntimeId("command", event.payload.operationId);
	const artifactId = parseRuntimeId("artifact", event.payload.artifactId);
	if (!intentId || !artifactId) return failure("corrupted_metadata", "artifact abort identity is invalid");
	return {
		ok: true,
		value: {
			authorityId: event.authorityId,
			tenantId: event.tenantId,
			intentId,
			artifactId,
			reason: event.payload.reason,
			reasonDigest: event.payload.reasonDigest,
			abortedAt: event.timestamp,
		},
	};
}

function failure<T>(code: ArtifactError["code"], message: string, retryable = false): ArtifactResult<T> {
	return { ok: false, error: { code, message, retryable } };
}

function artifactEvents(events: readonly RuntimeEventV3[]): readonly RuntimeEventV3[] {
	return events.filter((event) => event.type.startsWith("artifact."));
}

function intentFromEvent(event: Extract<RuntimeEventV3, { type: "artifact.intent_recorded" }>): ArtifactResult<ArtifactIntentRecord> {
	const intentId = parseRuntimeId("command", event.payload.operationId);
	const artifactId = parseRuntimeId("artifact", event.payload.artifactId);
	const sessionId = parseRuntimeId("session", event.payload.sourceSessionId);
	const workspaceId = event.payload.workspaceId ? parseRuntimeId("workspace", event.payload.workspaceId) : undefined;
	const producerId = parseRuntimeId("agent", event.payload.producerId) ?? parseRuntimeId("principal", event.payload.producerId);
	if (!intentId || !artifactId || !sessionId || (event.payload.workspaceId && !workspaceId) || !producerId) {
		return failure("corrupted_metadata", "artifact intent identity is invalid");
	}
	const intent: ArtifactIntentRecord = {
		authorityId: event.authorityId,
		tenantId: event.tenantId,
		intentId,
		artifactId,
		sessionId,
		...(workspaceId ? { workspaceId } : {}),
		producerId,
		kind: event.payload.kind,
		mediaType: event.payload.mediaType,
		lineageDigest: event.payload.lineageDigest,
		createdAt: event.payload.createdAt,
	};
	if (canonicalDigest(intent) !== event.payload.metadataDigest) {
		return failure("corrupted_metadata", "artifact intent digest is not reproducible");
	}
	return { ok: true, value: intent };
}

function commitFromEvent(event: Extract<RuntimeEventV3, { type: "artifact.committed" }>): ArtifactResult<ArtifactCommitRecord> {
	const intentId = parseRuntimeId("command", event.payload.operationId);
	const artifactId = parseRuntimeId("artifact", event.payload.artifactId);
	const transformReceiptId = parseRuntimeId("receipt", event.payload.receiptId);
	if (!intentId || !artifactId || !transformReceiptId) {
		return failure("corrupted_metadata", "artifact commit identity is invalid");
	}
	return {
		ok: true,
		value: {
			authorityId: event.authorityId,
			tenantId: event.tenantId,
			intentId,
			artifactId,
			storedDigest: event.payload.storedDigest,
			storedSize: event.payload.storedSize,
			metadataDigest: event.payload.metadataDigest,
			transformReceiptId,
			committedAt: event.timestamp,
		},
	};
}

function sameIntent(left: ArtifactIntentRecord, right: ArtifactIntentRecord): boolean {
	return canonicalDigest(left) === canonicalDigest(right);
}

function sameCommit(left: ArtifactCommitRecord, right: ArtifactCommitRecord): boolean {
	return canonicalDigest(left) === canonicalDigest(right);
}

function sameAbort(left: ArtifactAbortRecord, right: ArtifactAbortRecord): boolean {
	return canonicalDigest(left) === canonicalDigest(right);
}

function stateFromEvents(
	events: readonly RuntimeEventV3[],
	intentId: CommandId,
): ArtifactResult<ArtifactJournalState> {
	const intentEvents = events.filter(
		(event): event is Extract<RuntimeEventV3, { type: "artifact.intent_recorded" }> =>
			event.type === "artifact.intent_recorded" && event.payload.operationId === intentId,
	);
	if (intentEvents.length === 0) return { ok: true, value: { state: "absent" } };
	if (intentEvents.length !== 1) return failure("corrupted_metadata", "artifact intent has duplicate durable records");
	const intent = intentFromEvent(intentEvents[0]!);
	if (!intent.ok) return intent;
	const commitEvents = events.filter(
		(event): event is Extract<RuntimeEventV3, { type: "artifact.committed" }> =>
			event.type === "artifact.committed" && event.payload.operationId === intentId,
	);
	const abortEvents = events.filter(
		(event): event is Extract<RuntimeEventV3, { type: "artifact.aborted" }> =>
			event.type === "artifact.aborted" && event.payload.operationId === intentId,
	);
	if (commitEvents.length > 1 || abortEvents.length > 1) {
		return failure("corrupted_metadata", "artifact intent has duplicate terminal records");
	}
	const commitEvent = commitEvents[0];
	const abortEvent = abortEvents[0];
	if (commitEvent && abortEvent) return failure("corrupted_metadata", "artifact intent has both commit and abort events");
	if (abortEvent) {
		const abort = abortFromEvent(abortEvent);
		if (!abort.ok) return abort;
		if (
			abort.value.artifactId !== intent.value.artifactId ||
			abort.value.authorityId !== intent.value.authorityId ||
			abort.value.tenantId !== intent.value.tenantId
		) return failure("corrupted_metadata", "artifact abort does not match its durable intent");
		return { ok: true, value: { state: "aborted", intent: intent.value, abort: abort.value } };
	}
	if (!commitEvent) return { ok: true, value: { state: "intent_recorded", intent: intent.value } };
	const commit = commitFromEvent(commitEvent);
	if (!commit.ok) return commit;
	if (
		commit.value.artifactId !== intent.value.artifactId ||
		commit.value.authorityId !== intent.value.authorityId ||
		commit.value.tenantId !== intent.value.tenantId
	) return failure("corrupted_metadata", "artifact commit does not match its durable intent");
	return { ok: true, value: { state: "committed", intent: intent.value, commit: commit.value } };
}

export class SessionArtifactJournal implements ArtifactEventJournalPort {
	readonly #writer: EventWriter;
	readonly #store: RuntimeEventStore;
	readonly #principalId: PrincipalId;
	readonly #traceIdFactory: () => TraceId;

	public constructor(options: SessionArtifactJournalOptions) {
		this.#writer = options.writer;
		this.#store = options.store;
		this.#principalId = options.principalId;
		this.#traceIdFactory = options.traceIdFactory ?? (() => createRuntimeId("trace"));
	}

	async #readEvents(): Promise<ArtifactResult<readonly RuntimeEventV3[]>> {
		const events = await readAllRuntimeEvents(this.#store);
		return events.ok
			? { ok: true, value: artifactEvents(events.value) }
			: failure("durable_write_failed", "artifact journal event replay failed", events.error.retryable);
	}

	public async recordIntent(intent: ArtifactIntentRecord): Promise<ArtifactResult<void>> {
		const current = await this.stateForIntent(intent.intentId);
		if (!current.ok) return current;
		if (current.value.state === "intent_recorded") {
			return sameIntent(current.value.intent, intent)
				? { ok: true, value: undefined }
				: failure("invalid_request", "artifact intent id is already bound to different metadata");
		}
		if (current.value.state === "committed") {
			return failure("invalid_request", "a committed artifact intent cannot be started again");
		}
		if (current.value.state === "aborted") {
			return failure("invalid_request", "an aborted artifact intent cannot be started again");
		}
		const appended = await this.#writer.append({
			type: "artifact.intent_recorded",
			principalId: this.#principalId,
			traceId: this.#traceIdFactory(),
			timestamp: intent.createdAt,
			payload: {
				artifactId: intent.artifactId,
				operationId: intent.intentId,
				metadataDigest: canonicalDigest(intent),
				idempotencyKey: intent.intentId,
				sourceSessionId: intent.sessionId,
				...(intent.workspaceId ? { workspaceId: intent.workspaceId } : {}),
				producerId: intent.producerId,
				kind: intent.kind,
				mediaType: intent.mediaType,
				lineageDigest: intent.lineageDigest,
				createdAt: intent.createdAt,
			},
		});
		if (!appended.ok) {
			return failure("durable_write_failed", "artifact intent event append failed", appended.error.retryable);
		}
		const flushed = await this.#writer.flush();
		return flushed.ok
			? { ok: true, value: undefined }
			: failure("durable_write_failed", "artifact intent event flush failed", flushed.error.retryable);
	}

	public async recordCommit(commit: ArtifactCommitRecord): Promise<ArtifactResult<void>> {
		const current = await this.stateForIntent(commit.intentId);
		if (!current.ok) return current;
		if (current.value.state === "absent") {
			return failure("invalid_request", "artifact commit has no durable intent");
		}
		if (current.value.state === "committed") {
			return sameCommit(current.value.commit, commit)
				? { ok: true, value: undefined }
				: failure("invalid_request", "artifact intent is already committed with different metadata");
		}
		if (current.value.state === "aborted") {
			return failure("invalid_request", "an aborted artifact intent cannot be committed");
		}

		const events = await this.#readEvents();
		if (!events.ok) return events;
		const created = events.value.some(
			(event) => event.type === "artifact.created" && event.payload.operationId === commit.intentId,
		);
		if (!created) {
			const createdEvent = await this.#writer.append({
				type: "artifact.created",
				principalId: this.#principalId,
				traceId: this.#traceIdFactory(),
				timestamp: commit.committedAt,
				payload: {
					artifactId: commit.artifactId,
					operationId: commit.intentId,
					storedDigest: commit.storedDigest,
					storedSize: commit.storedSize,
					metadataDigest: commit.metadataDigest,
				},
			});
			if (!createdEvent.ok) {
				return failure("durable_write_failed", "artifact created event append failed", createdEvent.error.retryable);
			}
		}
		const committed = await this.#writer.append({
			type: "artifact.committed",
			principalId: this.#principalId,
			traceId: this.#traceIdFactory(),
			timestamp: commit.committedAt,
			payload: {
				artifactId: commit.artifactId,
				operationId: commit.intentId,
				storedDigest: commit.storedDigest,
				storedSize: commit.storedSize,
				metadataDigest: commit.metadataDigest,
				receiptId: commit.transformReceiptId,
			},
		});
		return committed.ok
			? { ok: true, value: undefined }
			: failure("durable_write_failed", "artifact committed event append failed", committed.error.retryable);
	}

	public async recordAbort(abort: ArtifactAbortRecord): Promise<ArtifactResult<void>> {
		const current = await this.stateForIntent(abort.intentId);
		if (!current.ok) return current;
		if (current.value.state === "absent") return failure("invalid_request", "artifact abort has no durable intent");
		if (current.value.state === "committed") return failure("invalid_request", "a committed artifact intent cannot be aborted");
		if (current.value.state === "aborted") {
			return sameAbort(current.value.abort, abort)
				? { ok: true, value: undefined }
				: failure("invalid_request", "artifact intent is already aborted with different metadata");
		}
		if (
			abort.artifactId !== current.value.intent.artifactId ||
			abort.authorityId !== current.value.intent.authorityId ||
			abort.tenantId !== current.value.intent.tenantId ||
			!/^[a-f0-9]{64}$/.test(abort.reasonDigest)
		) return failure("invalid_request", "artifact abort does not match its durable intent");
		const appended = await this.#writer.append({
			type: "artifact.aborted",
			principalId: this.#principalId,
			traceId: this.#traceIdFactory(),
			timestamp: abort.abortedAt,
			payload: {
				artifactId: abort.artifactId,
				operationId: abort.intentId,
				reason: abort.reason,
				reasonDigest: abort.reasonDigest,
			},
		});
		return appended.ok
			? { ok: true, value: undefined }
			: failure("durable_write_failed", "artifact abort event append failed", appended.error.retryable);
	}

	public async stateForIntent(intentId: CommandId): Promise<ArtifactResult<ArtifactJournalState>> {
		const events = await this.#readEvents();
		if (!events.ok) return events;
		return stateFromEvents(events.value, intentId);
	}

	public async listOpenIntents(scope: ArtifactScope): Promise<ArtifactResult<readonly ArtifactIntentRecord[]>> {
		const events = await this.#readEvents();
		if (!events.ok) return events;
		const intentIds = [...new Set(events.value.flatMap((event) =>
			event.type === "artifact.intent_recorded" ? [event.payload.operationId] : [],
		))];
		const open: ArtifactIntentRecord[] = [];
		for (const rawIntentId of intentIds) {
			const intentId = parseRuntimeId("command", rawIntentId);
			if (!intentId) return failure("corrupted_metadata", "artifact intent identity is invalid");
			const state = stateFromEvents(events.value, intentId);
			if (!state.ok) return state;
			if (
				state.value.state === "intent_recorded" &&
				state.value.intent.authorityId === scope.authorityId &&
				state.value.intent.tenantId === scope.tenantId
			) open.push(state.value.intent);
		}
		return { ok: true, value: open };
	}
}
