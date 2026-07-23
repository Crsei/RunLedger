import { Check } from "typebox/value";
import { describe, expect, it } from "vitest";
import {
	createCanonicalReferenceGraphSnapshot,
	type CanonicalArtifactGcState,
	type CanonicalGcScope,
	type CanonicalReferenceGraphBody,
	type CanonicalReferenceGraphPort,
	type CanonicalReferenceGraphSnapshot,
	type CanonicalSessionGcState,
} from "../../../src/runtime/lifecycle/canonical-references.ts";
import {
	ExternalCleanupReceiptRefSchema,
	RuntimeGcCoordinator,
	RuntimeGcRequestSchema,
	createRuntimeGcTransitionReceipt,
	type RuntimeGcCommandClaim,
	type RuntimeGcCommandClaimResult,
	type RuntimeGcJournalPort,
	type RuntimeGcMutationPort,
	type RuntimeGcMutationReceipt,
	type RuntimeGcMutationRequest,
	type RuntimeGcReceipt,
	type RuntimeGcRequest,
	type RuntimeGcTransitionReceipt,
} from "../../../src/runtime/lifecycle/gc.ts";
import { LIFECYCLE_SCHEMA_VERSION, type LifecycleResult } from "../../../src/runtime/lifecycle/recovery.ts";
import { createRuntimeId, type ArtifactId, type AuthorityId, type SessionId, type TenantId } from "../../../src/runtime/protocol/v3/ids.ts";

const D = "a".repeat(64);
const EXPIRED = "2026-07-21T00:00:00.000Z";
const NOW = "2026-07-22T00:00:01.000Z";
const authorityId = createRuntimeId("authority", "gc");
const tenantId = createRuntimeId("tenant", "gc");

function success<T>(value: T): LifecycleResult<T> {
	return { ok: true, value };
}

function valueOf<T>(result: LifecycleResult<T>): T {
	if (!result.ok) throw new Error(result.error.message);
	return result.value;
}

function session(
	seed: string,
	overrides: Partial<Omit<CanonicalSessionGcState, "authorityId" | "tenantId" | "sessionId">> = {},
): CanonicalSessionGcState {
	return {
		authorityId,
		tenantId,
		sessionId: createRuntimeId("session", seed),
		expiresAt: EXPIRED,
		pins: [],
		writerState: "inactive",
		leaseState: "inactive",
		archiveState: "archived",
		tombstoneState: "live",
		...overrides,
	};
}

function artifact(
	seed: string,
	overrides: Partial<Omit<CanonicalArtifactGcState, "authorityId" | "tenantId" | "artifactId">> = {},
): CanonicalArtifactGcState {
	return {
		authorityId,
		tenantId,
		artifactId: createRuntimeId("artifact", seed),
		expiresAt: EXPIRED,
		pins: [],
		readerState: "inactive",
		archiveState: "archived",
		tombstoneState: "live",
		...overrides,
	};
}

function graph(
	overrides: Partial<Omit<CanonicalReferenceGraphBody, "schemaVersion" | "authorityId" | "tenantId" | "revision" | "completeness" | "observedAt">> = {},
	scope: CanonicalGcScope = { authorityId, tenantId },
): CanonicalReferenceGraphSnapshot {
	return valueOf(createCanonicalReferenceGraphSnapshot({
		schemaVersion: LIFECYCLE_SCHEMA_VERSION,
		...scope,
		revision: 7,
		completeness: "complete",
		observedAt: NOW,
		sessions: [],
		artifacts: [],
		forks: [],
		handoffs: [],
		checkpoints: [],
		episodes: [],
		artifactReferences: [],
		legalHolds: [],
		...overrides,
	}));
}

class Graphs implements CanonicalReferenceGraphPort {
	public calls = 0;
	public readonly snapshot: CanonicalReferenceGraphSnapshot;
	public constructor(snapshot: CanonicalReferenceGraphSnapshot) {
		this.snapshot = snapshot;
	}
	public async loadGraph(): Promise<LifecycleResult<CanonicalReferenceGraphSnapshot>> {
		this.calls += 1;
		return success(this.snapshot);
	}
}

class Mutations implements RuntimeGcMutationPort {
	public calls: RuntimeGcMutationRequest[] = [];
	public commits = 0;
	public throwAfterFirstCommit = false;
	readonly #receipts = new Map<string, RuntimeGcTransitionReceipt>();

	public async deleteSessionRef(
		_authorityId: AuthorityId,
		_tenantId: TenantId,
		_sessionId: SessionId,
	): Promise<LifecycleResult<RuntimeGcMutationReceipt>> {
		return { ok: false, error: { code: "mutation_failed", message: "legacy delete must not be called", retryable: false } };
	}

	public async deleteArtifactRef(
		_authorityId: AuthorityId,
		_tenantId: TenantId,
		_artifactId: ArtifactId,
	): Promise<LifecycleResult<RuntimeGcMutationReceipt>> {
		return { ok: false, error: { code: "mutation_failed", message: "legacy delete must not be called", retryable: false } };
	}

	public async applyGcMutation(request: RuntimeGcMutationRequest): Promise<LifecycleResult<RuntimeGcTransitionReceipt>> {
		this.calls.push(request);
		const existing = this.#receipts.get(request.idempotencyKey);
		if (existing) return success(existing);
		const receipt = valueOf(createRuntimeGcTransitionReceipt({ ...request, committedAt: NOW }));
		this.#receipts.set(request.idempotencyKey, receipt);
		this.commits += 1;
		if (this.throwAfterFirstCommit) {
			this.throwAfterFirstCommit = false;
			throw new Error("response lost after commit");
		}
		return success(receipt);
	}

	public async readGcMutation(
		request: RuntimeGcMutationRequest,
	): Promise<LifecycleResult<RuntimeGcTransitionReceipt | undefined>> {
		return success(this.#receipts.get(request.idempotencyKey));
	}
}

class Journal implements RuntimeGcJournalPort {
	readonly #claims = new Map<string, { requestDigest: string; receipt?: RuntimeGcReceipt }>();
	public completeCalls = 0;

	public async claim(claim: RuntimeGcCommandClaim): Promise<LifecycleResult<RuntimeGcCommandClaimResult>> {
		const existing = this.#claims.get(claim.requestId);
		if (existing && existing.requestDigest !== claim.requestDigest) {
			return { ok: false, error: { code: "invalid_request", message: "requestId conflict", retryable: false } };
		}
		if (existing?.receipt) return success({ state: "completed", receipt: existing.receipt });
		this.#claims.set(claim.requestId, { requestDigest: claim.requestDigest });
		return success({ state: "claimed" });
	}

	public async complete(
		claim: RuntimeGcCommandClaim,
		receipt: RuntimeGcReceipt,
	): Promise<LifecycleResult<RuntimeGcReceipt>> {
		this.completeCalls += 1;
		this.#claims.set(claim.requestId, { requestDigest: claim.requestDigest, receipt });
		return success(receipt);
	}
}

function request(snapshot: CanonicalReferenceGraphSnapshot, options: {
	dryRun?: boolean;
	operation?: RuntimeGcRequest["operation"];
	targets?: RuntimeGcRequest["targets"];
	requestSeed?: string;
} = {}): RuntimeGcRequest {
	return {
		schemaVersion: LIFECYCLE_SCHEMA_VERSION,
		authorityId,
		tenantId,
		requestId: createRuntimeId("command", options.requestSeed ?? "gc"),
		dryRun: options.dryRun ?? false,
		operation: options.operation ?? "tombstone",
		requestedAt: "2026-07-22T00:00:00.000Z",
		expectedGraphRevision: snapshot.revision,
		expectedGraphDigest: snapshot.graphDigest,
		targets: options.targets ?? [],
	};
}

function coordinator(snapshot: CanonicalReferenceGraphSnapshot, mutations = new Mutations(), journal = new Journal()) {
	return {
		gc: new RuntimeGcCoordinator(mutations, new Graphs(snapshot), journal, () => new Date(NOW)),
		mutations,
		journal,
	};
}

describe("tenant-scoped reference-aware Runtime GC", () => {
	it("derives dry-run decisions from the canonical graph and rejects caller-authored safety facts", async () => {
		const candidate = session("dry-run", { archiveState: "live" });
		const pinned = artifact("pinned", { archiveState: "live", pins: ["evidence"] });
		const snapshot = graph({ sessions: [candidate], artifacts: [pinned] });
		const { gc, mutations } = coordinator(snapshot);
		const plan = request(snapshot, { dryRun: true, operation: "archive" });
		expect(Check(RuntimeGcRequestSchema, plan)).toBe(true);
		expect(await gc.collect(plan)).toMatchObject({
			ok: true,
			value: {
				dryRun: true,
				entries: [
					{ targetKind: "artifact_ref", action: "retained", reason: "pinned" },
					{ targetKind: "session_ref", action: "would_archive", reason: "eligible" },
				],
			},
		});
		expect(mutations.calls).toEqual([]);
		const spoofed = {
			...plan,
			targets: [{ kind: "session_ref", sessionId: candidate.sessionId, referenceCount: 0, legalHold: false }],
		};
		expect(Check(RuntimeGcRequestSchema, spoofed)).toBe(false);
		expect(await gc.collect(spoofed)).toMatchObject({ ok: false, error: { code: "invalid_request" } });
	});

	it("requires archive before tombstone and tombstone before purge", async () => {
		const live = session("stage-live", { archiveState: "live" });
		const archived = session("stage-archived");
		const tombstoned = session("stage-tombstoned", { tombstoneState: "tombstoned" });
		const snapshot = graph({ sessions: [live, archived, tombstoned] });
		const targets = [live, archived, tombstoned].map((state) => ({ kind: "session_ref" as const, sessionId: state.sessionId }));
		const archiveResult = await coordinator(snapshot).gc.collect(request(snapshot, {
			operation: "archive",
			targets: [{ kind: "session_ref", sessionId: live.sessionId }],
			requestSeed: "archive",
		}));
		expect(archiveResult).toMatchObject({ ok: true, value: { entries: [{ action: "archived" }] } });
		const tombstoneResult = await coordinator(snapshot).gc.collect(request(snapshot, { operation: "tombstone", targets }));
		expect(tombstoneResult).toMatchObject({
			ok: true,
			value: { entries: [
				{ targetId: archived.sessionId, action: "tombstoned" },
				{ targetId: live.sessionId, action: "retained", reason: "archive_required" },
				{ targetId: tombstoned.sessionId, action: "retained", reason: "already_tombstoned" },
			] },
		});
		const purgeResult = await coordinator(snapshot).gc.collect(request(snapshot, { operation: "purge", targets, requestSeed: "purge" }));
		expect(purgeResult).toMatchObject({
			ok: true,
			value: { entries: [
				{ targetId: archived.sessionId, action: "retained", reason: "tombstone_required" },
				{ targetId: live.sessionId, action: "retained", reason: "tombstone_required" },
				{ targetId: tombstoned.sessionId, action: "purged" },
			] },
		});
	});

	it("refuses descendants, unconfirmed handoffs, active writers or leases, evidence refs and legal holds", async () => {
		const descendantParent = session("parent");
		const descendant = session("child");
		const handoffSource = session("handoff-source");
		const handoffDestination = session("handoff-destination");
		const activeWriter = session("active-writer", { writerState: "active" });
		const activeLease = session("active-lease", { leaseState: "active" });
		const checkpointSession = session("checkpoint-session");
		const episodeSession = session("episode-session");
		const heldSession = session("held-session");
		const handoffArtifact = artifact("handoff-artifact");
		const checkpointArtifact = artifact("checkpoint-artifact");
		const episodeArtifact = artifact("episode-artifact");
		const sourceArtifact = artifact("source-artifact");
		const referencedArtifact = artifact("referenced-artifact");
		const activeReader = artifact("active-reader", { readerState: "active" });
		const snapshot = graph({
			sessions: [descendantParent, descendant, handoffSource, handoffDestination, activeWriter, activeLease, checkpointSession, episodeSession, heldSession],
			artifacts: [handoffArtifact, checkpointArtifact, episodeArtifact, sourceArtifact, referencedArtifact, activeReader],
			forks: [{ parent: sessionReference(descendantParent), descendant: sessionReference(descendant) }],
			handoffs: [{
				handoffId: createRuntimeId("command", "handoff"),
				sourceSession: sessionReference(handoffSource),
				destinationSession: sessionReference(handoffDestination),
				artifacts: [artifactReference(handoffArtifact)],
				confirmation: "unconfirmed",
			}],
			checkpoints: [{
				checkpointId: createRuntimeId("checkpoint", "gc"),
				session: sessionReference(checkpointSession),
				artifacts: [artifactReference(checkpointArtifact)],
				completeness: "complete",
			}],
			episodes: [{
				session: sessionReference(episodeSession),
				artifacts: [artifactReference(episodeArtifact)],
				manifestDigest: D,
				manifestState: "present",
				sealState: "confirmed",
				completeness: "complete",
			}],
			artifactReferences: [{ source: artifactReference(sourceArtifact), target: artifactReference(referencedArtifact) }],
			legalHolds: [{ holdId: "legal-hold", subject: sessionReference(heldSession), status: "active" }],
		});
		const result = await coordinator(snapshot).gc.collect(request(snapshot));
		if (!result.ok) throw new Error(result.error.message);
		const reasonByTarget = new Map(result.value.entries.map((entry) => [entry.targetId, entry.reason]));
		expect(reasonByTarget.get(descendantParent.sessionId)).toBe("descendant");
		expect(reasonByTarget.get(handoffSource.sessionId)).toBe("unconfirmed_handoff");
		expect(reasonByTarget.get(handoffDestination.sessionId)).toBe("unconfirmed_handoff");
		expect(reasonByTarget.get(activeWriter.sessionId)).toBe("active_writer");
		expect(reasonByTarget.get(activeLease.sessionId)).toBe("active_lease");
		expect(reasonByTarget.get(checkpointSession.sessionId)).toBe("checkpoint_reference");
		expect(reasonByTarget.get(episodeSession.sessionId)).toBe("episode_reference");
		expect(reasonByTarget.get(heldSession.sessionId)).toBe("legal_hold");
		expect(reasonByTarget.get(handoffArtifact.artifactId)).toBe("unconfirmed_handoff");
		expect(reasonByTarget.get(checkpointArtifact.artifactId)).toBe("checkpoint_reference");
		expect(reasonByTarget.get(episodeArtifact.artifactId)).toBe("episode_reference");
		expect(reasonByTarget.get(referencedArtifact.artifactId)).toBe("artifact_reference");
		expect(reasonByTarget.get(activeReader.artifactId)).toBe("active_reader");
	});

	it("replays the same command idempotently after a committed mutation response is lost", async () => {
		const candidate = session("replay");
		const snapshot = graph({ sessions: [candidate] });
		const mutations = new Mutations();
		mutations.throwAfterFirstCommit = true;
		const journal = new Journal();
		const gc = new RuntimeGcCoordinator(mutations, new Graphs(snapshot), journal, () => new Date(NOW));
		const command = request(snapshot, { targets: [{ kind: "session_ref", sessionId: candidate.sessionId }] });
		const replayed = await gc.collect(command);
		expect(replayed).toMatchObject({ ok: true, value: { entries: [{ action: "tombstoned" }] } });
		const cached = await gc.collect(command);
		expect(cached).toEqual(replayed);
		expect(mutations.calls).toHaveLength(1);
		expect(mutations.commits).toBe(1);
		expect(journal.completeCalls).toBe(1);
	});

	it("fails closed for incomplete graphs, tenant mismatches and cross-tenant graph references", async () => {
		const candidate = session("tenant");
		const incomplete = graph({ sessions: [candidate] });
		const incompleteSnapshot = valueOf(createCanonicalReferenceGraphSnapshot({
			...graphBody(incomplete), completeness: "unknown",
		}));
		expect(await coordinator(incompleteSnapshot).gc.collect(request(incompleteSnapshot))).toMatchObject({
			ok: true,
			value: { entries: [{ action: "retained", reason: "graph_incomplete" }] },
		});
		const otherTenantId = createRuntimeId("tenant", "other");
		const otherGraph = graph({ sessions: [{ ...candidate, tenantId: otherTenantId }] }, { authorityId, tenantId: otherTenantId });
		const mismatch = new RuntimeGcCoordinator(new Mutations(), new Graphs(otherGraph), new Journal(), () => new Date(NOW));
		expect(await mismatch.collect(request(incomplete))).toMatchObject({ ok: false, error: { code: "integrity_failed" } });
		const crossTenantReference = createCanonicalReferenceGraphSnapshot({
			...graphBody(incomplete),
			forks: [{ parent: sessionReference(candidate), descendant: { ...sessionReference(candidate), tenantId: otherTenantId, sessionId: createRuntimeId("session", "other") } }],
		});
		expect(crossTenantReference).toMatchObject({ ok: false, error: { code: "invalid_request" } });
	});

	it("keeps external cleanup as typed specialty receipts", () => {
		const receipt = {
			schemaVersion: LIFECYCLE_SCHEMA_VERSION,
			authorityId,
			tenantId,
			receiptId: createRuntimeId("receipt", "external-cleanup"),
			kind: "orphan_process",
			subjectId: "process-receipt-subject",
			outcome: "cleaned",
			cleanedAt: "2026-07-22T00:00:00.000Z",
			receiptDigest: D,
		};
		expect(Check(ExternalCleanupReceiptRefSchema, receipt)).toBe(true);
		expect(Check(ExternalCleanupReceiptRefSchema, { ...receipt, processHandle: 123 })).toBe(false);
	});

	it("does not fall back to legacy delete calls when canonical graph or durable ports are missing", async () => {
		const candidate = session("no-fallback");
		const snapshot = graph({ sessions: [candidate] });
		const mutations = new Mutations();
		const withoutGraph = new RuntimeGcCoordinator(mutations, () => new Date(NOW));
		expect(await withoutGraph.collect(request(snapshot))).toMatchObject({
			ok: false,
			error: { code: "external_unavailable" },
		});
		const withoutJournal = new RuntimeGcCoordinator(mutations, new Graphs(snapshot), undefined, () => new Date(NOW));
		expect(await withoutJournal.collect(request(snapshot))).toMatchObject({
			ok: false,
			error: { code: "external_unavailable" },
		});
		expect(mutations.calls).toEqual([]);
	});
});

function sessionReference(state: CanonicalSessionGcState) {
	return { authorityId: state.authorityId, tenantId: state.tenantId, sessionId: state.sessionId };
}

function artifactReference(state: CanonicalArtifactGcState) {
	return { authorityId: state.authorityId, tenantId: state.tenantId, artifactId: state.artifactId };
}

function graphBody(snapshot: CanonicalReferenceGraphSnapshot): CanonicalReferenceGraphBody {
	const { graphDigest: _graphDigest, ...body } = snapshot;
	return body;
}
