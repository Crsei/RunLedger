import { runtimeDigest, type RuntimeDigest } from "../../protocol/foundation.ts";
import { isRuntimeId, type GoalId, type WorkspaceId } from "../../protocol/ids.ts";
import { isValidPlanArtifactRef } from "./reducer.ts";
import { planFailure, type PlanResult } from "./errors.ts";
import type { PlanArtifactRef } from "./types.ts";

export interface PlanArtifactWriteInput {
	readonly goalId: GoalId;
	readonly workspaceId: WorkspaceId;
	readonly content: string;
	readonly expectedRevision: number | null;
	readonly mediaType?: string;
}

export interface PlanArtifactStoreRevision {
	readonly ref: PlanArtifactRef;
	readonly content: string;
}

export interface PlanArtifactStoreSnapshot {
	readonly version: 1;
	readonly revisions: readonly PlanArtifactStoreRevision[];
	readonly working: readonly PlanArtifactRef[];
}

function key(goalId: GoalId, workspaceId: WorkspaceId): string {
	return `${goalId}\u0000${workspaceId}`;
}

function sameDigest(left: RuntimeDigest, right: RuntimeDigest): boolean {
	return left.algorithm === right.algorithm && left.digest === right.digest;
}

function sameRef(left: PlanArtifactRef, right: PlanArtifactRef): boolean {
	return (
		left.goalId === right.goalId &&
		left.workspaceId === right.workspaceId &&
		left.revision === right.revision &&
		sameDigest(left.digest, right.digest) &&
		left.artifactRef.subjectKind === right.artifactRef.subjectKind &&
		sameDigest(left.artifactRef.digest, right.artifactRef.digest) &&
		left.artifactRef.mediaType === right.artifactRef.mediaType &&
		left.artifactRef.size === right.artifactRef.size
	);
}

function validRevision(value: number): boolean {
	return Number.isSafeInteger(value) && value >= 0;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
	const actual = Object.keys(value).sort();
	return actual.length === keys.length && actual.every((item, index) => item === keys[index]);
}

function validEntry(value: unknown): value is PlanArtifactStoreRevision {
	if (!isObject(value) || !exactKeys(value, ["content", "ref"]) || typeof value.content !== "string" || !isValidPlanArtifactRef(value.ref)) return false;
	const digest = runtimeDigest(value.content);
	return (
		sameDigest(value.ref.digest, digest) &&
		value.ref.artifactRef.size === Buffer.byteLength(value.content, "utf8")
	);
}

function validPointer(value: unknown): value is PlanArtifactRef {
	return isValidPlanArtifactRef(value);
}

/** 只接受当前 exact snapshot；校验失败时不触碰现有 store。 */
export function isPlanArtifactStoreSnapshot(value: unknown): value is PlanArtifactStoreSnapshot {
	if (!isObject(value) || !exactKeys(value, ["revisions", "version", "working"]) || value.version !== 1) return false;
	if (!Array.isArray(value.revisions) || !value.revisions.every(validEntry) || !Array.isArray(value.working) || !value.working.every(validPointer)) return false;

	const revisions = value.revisions as readonly PlanArtifactStoreRevision[];
	const pointers = value.working as readonly PlanArtifactRef[];
	const byScope = new Map<string, PlanArtifactStoreRevision[]>();
	const seenRevision = new Set<string>();
	for (const entry of revisions) {
		const scopeKey = key(entry.ref.goalId, entry.ref.workspaceId);
		const revisionKey = `${scopeKey}\u0000${entry.ref.revision}`;
		if (seenRevision.has(revisionKey)) return false;
		seenRevision.add(revisionKey);
		const list = byScope.get(scopeKey) ?? [];
		list.push(entry);
		byScope.set(scopeKey, list);
	}
	for (const list of byScope.values()) {
		list.sort((left, right) => left.ref.revision - right.ref.revision);
		for (let index = 0; index < list.length; index += 1) {
			if (list[index]!.ref.revision !== index) return false;
		}
	}
	if (pointers.length !== byScope.size) return false;
	const seenPointers = new Set<string>();
	for (const pointer of pointers) {
		const scopeKey = key(pointer.goalId, pointer.workspaceId);
		if (seenPointers.has(scopeKey)) return false;
		seenPointers.add(scopeKey);
		const list = byScope.get(scopeKey);
		const latest = list?.[list.length - 1];
		if (latest === undefined || !sameRef(pointer, latest.ref)) return false;
	}
	return seenPointers.size === byScope.size;
}

export class PlanArtifactStore {
	readonly #revisions = new Map<string, PlanArtifactStoreRevision[]>();
	readonly #working = new Map<string, PlanArtifactRef>();

	public put(input: PlanArtifactWriteInput): PlanResult<PlanArtifactRef> {
		if (
			!isRuntimeId(input.goalId, "goal") ||
			!isRuntimeId(input.workspaceId, "workspace") ||
			typeof input.content !== "string" ||
			(input.expectedRevision !== null && !validRevision(input.expectedRevision)) ||
			(input.mediaType !== undefined && (input.mediaType.length === 0 || input.mediaType.length > 128))
		) return planFailure("invalid_artifact", "plan artifact write input is invalid");

		const scopeKey = key(input.goalId, input.workspaceId);
		const current = this.#working.get(scopeKey);
		let revision: number;
		if (current === undefined) {
			if (input.expectedRevision !== null) return planFailure("stale_expected_plan_revision", "initial plan artifact requires a null expected revision", { retryable: true, actualRevision: 0 });
			revision = 0;
		} else {
			if (input.expectedRevision === null || input.expectedRevision !== current.revision) {
				return planFailure("stale_expected_plan_revision", "plan artifact working revision changed before write", {
					retryable: true,
					expectedRevision: input.expectedRevision === null ? undefined : input.expectedRevision,
					actualRevision: current.revision,
				});
			}
			revision = current.revision + 1;
		}

		const digest = runtimeDigest(input.content);
		const artifactRef: PlanArtifactRef = {
			goalId: input.goalId,
			workspaceId: input.workspaceId,
			revision,
			digest,
			artifactRef: {
				subjectKind: "artifact",
				digest,
				mediaType: input.mediaType ?? "text/markdown",
				size: Buffer.byteLength(input.content, "utf8"),
			},
		};
		if (!isValidPlanArtifactRef(artifactRef)) return planFailure("invalid_artifact", "plan artifact write produced an invalid reference");
		const entry: PlanArtifactStoreRevision = { ref: artifactRef, content: input.content };
		const nextRevisions = [...(this.#revisions.get(scopeKey) ?? []), entry];
		this.#revisions.set(scopeKey, nextRevisions);
		this.#working.set(scopeKey, artifactRef);
		return { ok: true, value: artifactRef };
	}

	public read(ref: PlanArtifactRef): PlanResult<string> {
		if (!isValidPlanArtifactRef(ref)) return planFailure("invalid_artifact", "plan artifact reference failed exact validation");
		const entry = this.#revisions.get(key(ref.goalId, ref.workspaceId))?.[ref.revision];
		if (entry === undefined) return planFailure("artifact_not_found", "plan artifact revision was not found");
		if (!sameRef(entry.ref, ref) || !sameDigest(runtimeDigest(entry.content), ref.digest)) return planFailure("invalid_artifact", "stored plan artifact does not match its reference");
		return { ok: true, value: entry.content };
	}

	public verify(ref: PlanArtifactRef, observedContent: string): PlanResult<void> {
		const stored = this.read(ref);
		if (!stored.ok) return stored;
		if (typeof observedContent !== "string") return planFailure("invalid_artifact", "observed plan content is not text");
		const observedDigest = runtimeDigest(observedContent);
		return sameDigest(ref.digest, observedDigest)
			? { ok: true, value: undefined }
			: planFailure("artifact_digest_drift", "observed plan content does not match the pinned artifact digest", {
				expectedDigest: ref.digest,
				actualDigest: observedDigest,
			});
	}

	public working(goalId: GoalId, workspaceId: WorkspaceId): PlanResult<PlanArtifactRef | undefined> {
		if (!isRuntimeId(goalId, "goal") || !isRuntimeId(workspaceId, "workspace")) return planFailure("invalid_artifact", "plan artifact scope is invalid");
		return { ok: true, value: this.#working.get(key(goalId, workspaceId)) };
	}

	public revisions(goalId: GoalId, workspaceId: WorkspaceId): PlanResult<readonly PlanArtifactRef[]> {
		if (!isRuntimeId(goalId, "goal") || !isRuntimeId(workspaceId, "workspace")) return planFailure("invalid_artifact", "plan artifact scope is invalid");
		return { ok: true, value: (this.#revisions.get(key(goalId, workspaceId)) ?? []).map((entry) => entry.ref) };
	}

	public snapshot(): PlanArtifactStoreSnapshot {
		const revisions = [...this.#revisions.values()]
			.flat()
			.map((entry) => ({ ref: { ...entry.ref, digest: { ...entry.ref.digest }, artifactRef: { ...entry.ref.artifactRef, digest: { ...entry.ref.artifactRef.digest } } }, content: entry.content }))
			.sort((left, right) => left.ref.goalId.localeCompare(right.ref.goalId) || left.ref.workspaceId.localeCompare(right.ref.workspaceId) || left.ref.revision - right.ref.revision);
		const working = [...this.#working.values()]
			.map((ref) => ({ ...ref, digest: { ...ref.digest }, artifactRef: { ...ref.artifactRef, digest: { ...ref.artifactRef.digest } } }))
			.sort((left, right) => left.goalId.localeCompare(right.goalId) || left.workspaceId.localeCompare(right.workspaceId));
		return { version: 1, revisions, working };
	}

	public restore(snapshot: unknown): PlanResult<void> {
		if (!isPlanArtifactStoreSnapshot(snapshot)) return planFailure("invalid_snapshot", "plan artifact store snapshot failed exact validation");
		const nextRevisions = new Map<string, PlanArtifactStoreRevision[]>();
		for (const entry of snapshot.revisions) {
			const scopeKey = key(entry.ref.goalId, entry.ref.workspaceId);
			const list = nextRevisions.get(scopeKey) ?? [];
			list.push({ ref: { ...entry.ref, digest: { ...entry.ref.digest }, artifactRef: { ...entry.ref.artifactRef, digest: { ...entry.ref.artifactRef.digest } } }, content: entry.content });
			nextRevisions.set(scopeKey, list);
		}
		const nextWorking = new Map<string, PlanArtifactRef>();
		for (const ref of snapshot.working) {
			nextWorking.set(key(ref.goalId, ref.workspaceId), { ...ref, digest: { ...ref.digest }, artifactRef: { ...ref.artifactRef, digest: { ...ref.artifactRef.digest } } });
		}
		this.#revisions.clear();
		for (const [scopeKey, entries] of nextRevisions) this.#revisions.set(scopeKey, entries);
		this.#working.clear();
		for (const [scopeKey, ref] of nextWorking) this.#working.set(scopeKey, ref);
		return { ok: true, value: undefined };
	}
}
