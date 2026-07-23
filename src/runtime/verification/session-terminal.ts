/** EpisodeManifestBody -> manifest commit -> signed seal -> seal record 的 durable writer。 */

import { canonicalDigest, canonicalJson } from "../protocol/v3/canonical-json.ts";
import type { ArtifactRef } from "../protocol/v3/capability.ts";
import {
	createSessionEventStreamRef,
	sameRuntimeEventStream,
	type EventCursor,
	type RuntimeEventV3,
} from "../protocol/v3/events.ts";
import {
	createRuntimeId,
	type AuthorityId,
	type PrincipalId,
	type ReceiptId,
	type SessionId,
	type TenantId,
	type TraceId,
} from "../protocol/v3/ids.ts";
import { isEpisodeManifest, isEpisodeSeal } from "../artifacts/episode-manifest.ts";
import type { EpisodeManifest, EpisodeSeal } from "../artifacts/types.ts";
import { verifyRuntimeEventChain } from "../session/chain-verification.ts";
import type { RuntimeEventStore } from "../session/event-store.ts";
import type { EventWriter } from "../session/event-writer.ts";
import { readAllRuntimeEvents } from "../session/snapshot.ts";
import {
	episodeSealRecordDigest,
	isEpisodeManifestCommitReceipt,
	isEpisodeSealRecordReceipt,
	type DurableEpisodeSealResolverPort,
	type EpisodeLifecycleWriterPort,
	type EpisodeManifestCommitReceipt,
	type EpisodeManifestCommitRequest,
	type EpisodeManifestStorePort,
	type EpisodeSealRecordReceipt,
	type EpisodeSealRecordRequest,
} from "./report.ts";
import { EPISODE_MANIFEST_BODY_MEDIA_TYPE } from "./manifest-store.ts";
import type { VerificationCoreResult } from "./types.ts";

export type SessionEpisodeLifecyclePhase =
	| "after_manifest_committed_before_return"
	| "after_seal_recorded_before_return";

export interface SessionEpisodeLifecycleWriterOptions {
	authorityId: AuthorityId;
	tenantId: TenantId;
	sessionId: SessionId;
	principalId: PrincipalId;
	writer: EventWriter;
	store: RuntimeEventStore;
	manifestStore: EpisodeManifestStorePort;
	traceIdFactory?: () => TraceId;
	onPhase?: (phase: SessionEpisodeLifecyclePhase) => Promise<void> | void;
}

type EpisodeManifestCommittedEvent = Extract<RuntimeEventV3, { type: "episode.manifest_committed" }>;
type EpisodeSealRecordedEvent = Extract<RuntimeEventV3, { type: "episode.seal_recorded" }>;

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
	code: "invalid_schema" | "invalid_digest" | "scope_mismatch" | "terminal_not_ready" | "lifecycle_paused",
	message: string,
	retryable = false,
): VerificationCoreResult<T> {
	return { ok: false, error: { code, message, retryable } };
}

function cursorFor(event: RuntimeEventV3): EventCursor {
	return {
		stream: event.stream,
		sequence: event.sequence,
		eventId: event.eventId,
		eventHash: event.currentEventHash,
	};
}

function sameCursor(left: EventCursor, right: EventCursor): boolean {
	return (
		sameRuntimeEventStream(left.stream, right.stream) &&
		left.sequence === right.sequence &&
		left.eventId === right.eventId &&
		left.eventHash === right.eventHash
	);
}

function sameArtifact(left: ArtifactRef, right: ArtifactRef): boolean {
	return canonicalDigest(left) === canonicalDigest(right);
}

function manifestReceiptId(manifest: EpisodeManifest, artifact: ArtifactRef): ReceiptId {
	return createRuntimeId("receipt", `episode-manifest-${canonicalDigest({
		manifestBodyDigest: manifest.manifestDigest,
		evidenceHead: manifest.evidenceHead,
		artifact,
	}).slice(0, 48)}`);
}

function sealReceiptId(seal: EpisodeSeal): ReceiptId {
	return createRuntimeId("receipt", `episode-seal-${canonicalDigest({
		sealId: seal.sealId,
		sealDigest: seal.sealDigest,
		manifestCommitCursor: seal.manifestCommitCursor,
	}).slice(0, 48)}`);
}

function manifestReceiptFromEvent(event: EpisodeManifestCommittedEvent): EpisodeManifestCommitReceipt {
	const body = {
		receiptId: event.payload.receiptId as ReceiptId,
		manifestBodyDigest: event.payload.manifestBodyDigest,
		manifestArtifact: event.payload.manifestArtifact as unknown as ArtifactRef,
		evidenceHead: event.payload.evidenceHead as EventCursor,
		manifestCommitCursor: cursorFor(event),
		committedAt: event.timestamp,
	};
	return { ...body, receiptDigest: canonicalDigest(body) };
}

function sealReceiptFromEvent(event: EpisodeSealRecordedEvent): EpisodeSealRecordReceipt {
	const body = {
		receiptId: event.payload.receiptId as ReceiptId,
		sealId: event.payload.sealId as EpisodeSeal["sealId"],
		sealDigest: event.payload.sealDigest,
		manifestCommitCursor: event.payload.manifestCommitCursor as EventCursor,
		sealEventCursor: cursorFor(event),
		recordedAt: event.timestamp,
	};
	return { ...body, receiptDigest: canonicalDigest(body) };
}

function parseSealEvent(event: EpisodeSealRecordedEvent): VerificationCoreResult<EpisodeSeal> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(event.payload.sealJson) as unknown;
	} catch {
		return failure("invalid_schema", "durable EpisodeSeal is not JSON");
	}
	if (!isEpisodeSeal(parsed) || canonicalJson(parsed) !== event.payload.sealJson) {
		return failure("invalid_digest", "durable EpisodeSeal is not canonical or valid");
	}
	if (
		parsed.sealId !== event.payload.sealId ||
		parsed.sealDigest !== event.payload.sealDigest ||
		parsed.manifestBodyDigest !== event.payload.manifestBodyDigest ||
		!sameCursor(parsed.manifestCommitCursor, event.payload.manifestCommitCursor as EventCursor) ||
		parsed.referenceClosureDigest !== event.payload.referenceClosureDigest ||
		canonicalDigest(parsed.verificationReceiptDigests) !== canonicalDigest(event.payload.verificationReceiptDigests)
	) return failure("invalid_digest", "EpisodeSeal does not match its durable event projection");
	return { ok: true, value: parsed };
}

export class SessionEpisodeLifecycleWriter implements EpisodeLifecycleWriterPort, DurableEpisodeSealResolverPort {
	readonly #authorityId: AuthorityId;
	readonly #tenantId: TenantId;
	readonly #sessionId: SessionId;
	readonly #principalId: PrincipalId;
	readonly #writer: EventWriter;
	readonly #store: RuntimeEventStore;
	readonly #manifestStore: EpisodeManifestStorePort;
	readonly #traceIdFactory: () => TraceId;
	readonly #onPhase: SessionEpisodeLifecycleWriterOptions["onPhase"];

	public constructor(options: SessionEpisodeLifecycleWriterOptions) {
		this.#authorityId = options.authorityId;
		this.#tenantId = options.tenantId;
		this.#sessionId = options.sessionId;
		this.#principalId = options.principalId;
		this.#writer = options.writer;
		this.#store = options.store;
		this.#manifestStore = options.manifestStore;
		this.#traceIdFactory = options.traceIdFactory ?? (() => createRuntimeId("trace"));
		this.#onPhase = options.onPhase;
	}

	async #events(): Promise<VerificationCoreResult<readonly RuntimeEventV3[]>> {
		let verified: Awaited<ReturnType<RuntimeEventStore["verify"]>>;
		try {
			verified = await this.#store.verify(this.#store.streamRef());
		} catch {
			return failure("terminal_not_ready", "episode event store is unavailable", true);
		}
		if (!verified.ok) return failure("terminal_not_ready", "episode event store verification failed", verified.error.retryable);
		if (
			verified.value.integrity !== "valid" ||
			verified.value.authorityId !== this.#authorityId ||
			verified.value.tenantId !== this.#tenantId ||
			!sameRuntimeEventStream(
				verified.value.stream,
				createSessionEventStreamRef({ authorityId: this.#authorityId, tenantId: this.#tenantId }, this.#sessionId),
			)
		) return failure("invalid_digest", "episode event store scope or integrity is invalid");
		const replay = await readAllRuntimeEvents(this.#store);
		if (!replay.ok) return failure("terminal_not_ready", "episode event replay failed", replay.error.retryable);
		if (replay.value.length === 0) return { ok: true, value: [] };
		const chain = verifyRuntimeEventChain(replay.value, {
			authorityId: this.#authorityId,
			tenantId: this.#tenantId,
			stream: verified.value.stream,
		});
		return chain.integrity === "valid"
			? { ok: true, value: replay.value }
			: failure("invalid_digest", "episode event chain failed canonical validation");
	}

	#manifestEvents(events: readonly RuntimeEventV3[]): readonly EpisodeManifestCommittedEvent[] {
		return events.filter((event): event is EpisodeManifestCommittedEvent => event.type === "episode.manifest_committed");
	}

	#sealEvents(events: readonly RuntimeEventV3[]): readonly EpisodeSealRecordedEvent[] {
		return events.filter((event): event is EpisodeSealRecordedEvent => event.type === "episode.seal_recorded");
	}

	async #resolveCommittedManifest(
		event: EpisodeManifestCommittedEvent,
		expected?: EpisodeManifest,
	): Promise<VerificationCoreResult<{ manifest: EpisodeManifest; receipt: EpisodeManifestCommitReceipt }>> {
		const receipt = manifestReceiptFromEvent(event);
		if (!isEpisodeManifestCommitReceipt(receipt)) {
			return failure("invalid_digest", "durable manifest commit receipt is invalid");
		}
		let resolved: Awaited<ReturnType<EpisodeManifestStorePort["resolve"]>>;
		try {
			resolved = await this.#manifestStore.resolve(receipt.manifestArtifact);
		} catch {
			return failure("lifecycle_paused", "manifest body store is unavailable", false);
		}
		if (!resolved.ok) return resolved;
		if (
			!isEpisodeManifest(resolved.value) ||
			resolved.value.manifestDigest !== receipt.manifestBodyDigest ||
			!sameCursor(resolved.value.evidenceHead, receipt.evidenceHead) ||
			(expected !== undefined && canonicalDigest(resolved.value) !== canonicalDigest(expected))
		) return failure("invalid_digest", "stored manifest body does not match its commit event");
		return { ok: true, value: { manifest: resolved.value, receipt } };
	}

	async #commitManifestSafely(
		request: EpisodeManifestCommitRequest,
	): Promise<VerificationCoreResult<EpisodeManifestCommitReceipt>> {
		const manifest = request.manifest;
		if (
			!isEpisodeManifest(manifest) ||
			manifest.authorityId !== this.#authorityId ||
			manifest.tenantId !== this.#tenantId ||
			manifest.sessionId !== this.#sessionId
		) return failure("scope_mismatch", "Episode Manifest is invalid or outside the session scope");

		let events = await this.#events();
		if (!events.ok) return events;
		let manifests = this.#manifestEvents(events.value);
		const seals = this.#sealEvents(events.value);
		if (manifests.length > 1 || seals.length > 1) return failure("invalid_digest", "episode lifecycle contains duplicate records");
		if (seals.length > 0 && manifests.length !== 1) return failure("invalid_digest", "EpisodeSeal exists without one Manifest commit");
		if (manifests.length === 1) {
			const resolved = await this.#resolveCommittedManifest(manifests[0]!, manifest);
			return resolved.ok ? { ok: true, value: resolved.value.receipt } : resolved;
		}
		const head = events.value.at(-1);
		if (!head || !sameCursor(cursorFor(head), manifest.evidenceHead)) {
			return failure("terminal_not_ready", "Episode Manifest evidence head is stale", true);
		}

		let stored: Awaited<ReturnType<EpisodeManifestStorePort["commit"]>>;
		try {
			stored = await this.#manifestStore.commit(manifest);
		} catch {
			return failure("lifecycle_paused", "Manifest body commit outcome is uncertain", false);
		}
		if (!stored.ok) return stored;
		const artifact = stored.value;
		if (
			artifact.authorityId !== manifest.authorityId ||
			artifact.tenantId !== manifest.tenantId ||
			artifact.workspaceId !== manifest.workspace.workspaceId ||
			artifact.kind !== "episode_manifest" ||
			artifact.storedDigest !== manifest.manifestDigest ||
			artifact.mediaType !== EPISODE_MANIFEST_BODY_MEDIA_TYPE
		) return failure("invalid_digest", "Manifest body Artifact is not correlated with the Episode");

		// body store 可以异步；再次读取 chain，防止在此期间把 commit 绑定到错误 head。
		events = await this.#events();
		if (!events.ok) return events;
		manifests = this.#manifestEvents(events.value);
		if (manifests.length === 1) {
			const resolved = await this.#resolveCommittedManifest(manifests[0]!, manifest);
			return resolved.ok ? { ok: true, value: resolved.value.receipt } : resolved;
		}
		if (manifests.length > 1 || this.#sealEvents(events.value).length > 0) {
			return failure("invalid_digest", "episode lifecycle changed concurrently");
		}
		const refreshedHead = events.value.at(-1);
		if (!refreshedHead || !sameCursor(cursorFor(refreshedHead), manifest.evidenceHead)) {
			return failure("lifecycle_paused", "event head changed while committing Manifest body", false);
		}
		const receiptId = manifestReceiptId(manifest, artifact);
		const appended = await this.#writer.append({
			type: "episode.manifest_committed",
			principalId: this.#principalId,
			traceId: this.#traceIdFactory(),
			payload: {
				receiptId,
				manifestBodyDigest: manifest.manifestDigest,
				manifestArtifact: artifact,
				evidenceHead: manifest.evidenceHead,
			},
		});
		if (!appended.ok) return failure("lifecycle_paused", "Manifest commit append outcome is uncertain", false);
		const event = appended.value.event;
		if (event.type !== "episode.manifest_committed") return failure("invalid_digest", "Manifest commit event type changed");
		const receipt = manifestReceiptFromEvent(event);
		if (!isEpisodeManifestCommitReceipt(receipt)) return failure("invalid_digest", "Manifest commit receipt is invalid");
		try {
			await this.#onPhase?.("after_manifest_committed_before_return");
		} catch {
			return failure("lifecycle_paused", "Manifest commit is durable but acknowledgement is uncertain", false);
		}
		return { ok: true, value: receipt };
	}

	public commitManifest(
		request: EpisodeManifestCommitRequest,
	): Promise<VerificationCoreResult<EpisodeManifestCommitReceipt>> {
		return serializeWriter(this.#writer, () => this.#commitManifestSafely(request));
	}

	async #recordSealSafely(
		request: EpisodeSealRecordRequest,
	): Promise<VerificationCoreResult<EpisodeSealRecordReceipt>> {
		const seal = request.seal;
		if (
			!isEpisodeSeal(seal) ||
			seal.authorityId !== this.#authorityId ||
			seal.tenantId !== this.#tenantId ||
			seal.sessionId !== this.#sessionId
		) return failure("scope_mismatch", "EpisodeSeal is invalid or outside the session scope");
		const events = await this.#events();
		if (!events.ok) return events;
		const manifests = this.#manifestEvents(events.value);
		const seals = this.#sealEvents(events.value);
		if (manifests.length !== 1 || seals.length > 1) return failure("invalid_digest", "EpisodeSeal requires exactly one Manifest commit");
		const committed = await this.#resolveCommittedManifest(manifests[0]!);
		if (!committed.ok) return committed;
		if (
			committed.value.manifest.manifestDigest !== seal.manifestBodyDigest ||
			!sameCursor(committed.value.receipt.manifestCommitCursor, seal.manifestCommitCursor)
		) return failure("invalid_digest", "EpisodeSeal does not bind the durable Manifest commit");
		if (seals.length === 1) {
			const parsed = parseSealEvent(seals[0]!);
			if (!parsed.ok) return parsed;
			if (canonicalDigest(parsed.value) !== canonicalDigest(seal)) {
				return failure("invalid_digest", "EpisodeSeal conflicts with the durable seal record");
			}
			const receipt = sealReceiptFromEvent(seals[0]!);
			return isEpisodeSealRecordReceipt(receipt)
				? { ok: true, value: receipt }
				: failure("invalid_digest", "durable seal record receipt is invalid");
		}
		const head = events.value.at(-1);
		if (!head || !sameCursor(cursorFor(head), seal.manifestCommitCursor)) {
			return failure("lifecycle_paused", "Manifest commit is no longer the canonical head", false);
		}
		const appended = await this.#writer.append({
			type: "episode.seal_recorded",
			principalId: this.#principalId,
			traceId: this.#traceIdFactory(),
			payload: {
				receiptId: sealReceiptId(seal),
				sealId: seal.sealId,
				sealDigest: seal.sealDigest,
				manifestBodyDigest: seal.manifestBodyDigest,
				manifestCommitCursor: seal.manifestCommitCursor,
				referenceClosureDigest: seal.referenceClosureDigest,
				verificationReceiptDigests: [...seal.verificationReceiptDigests],
				sealJson: canonicalJson(seal),
			},
		});
		if (!appended.ok) return failure("lifecycle_paused", "EpisodeSeal append outcome is uncertain", false);
		const event = appended.value.event;
		if (event.type !== "episode.seal_recorded") return failure("invalid_digest", "EpisodeSeal event type changed");
		const receipt = sealReceiptFromEvent(event);
		if (!isEpisodeSealRecordReceipt(receipt)) return failure("invalid_digest", "EpisodeSeal record receipt is invalid");
		try {
			await this.#onPhase?.("after_seal_recorded_before_return");
		} catch {
			return failure("lifecycle_paused", "EpisodeSeal is durable but acknowledgement is uncertain", false);
		}
		return { ok: true, value: receipt };
	}

	public recordSeal(
		request: EpisodeSealRecordRequest,
	): Promise<VerificationCoreResult<EpisodeSealRecordReceipt>> {
		return serializeWriter(this.#writer, () => this.#recordSealSafely(request));
	}

	public async resolveBySealDigest(
		sealDigest: string,
	): Promise<VerificationCoreResult<{ seal: EpisodeSeal; record: EpisodeSealRecordReceipt }>> {
		if (!/^[a-f0-9]{64}$/.test(sealDigest)) return failure("invalid_schema", "EpisodeSeal digest is invalid");
		const events = await this.#events();
		if (!events.ok) return events;
		const matches = this.#sealEvents(events.value).filter((event) => event.payload.sealDigest === sealDigest);
		if (matches.length !== 1) return failure("terminal_not_ready", "durable EpisodeSeal record is missing or ambiguous");
		const parsed = parseSealEvent(matches[0]!);
		if (!parsed.ok) return parsed;
		const record = sealReceiptFromEvent(matches[0]!);
		if (!isEpisodeSealRecordReceipt(record) || episodeSealRecordDigest(parsed.value, record) === undefined) {
			return failure("invalid_digest", "durable EpisodeSeal record is invalid");
		}
		return { ok: true, value: { seal: parsed.value, record } };
	}
}
