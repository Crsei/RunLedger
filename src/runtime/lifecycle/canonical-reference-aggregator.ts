/** Production GC 的 canonical reference graph 聚合边界。 */

import { canonicalDigest } from "../protocol/v3/canonical-json.ts";
import type { AuthorityId, TenantId } from "../protocol/v3/ids.ts";
import {
	createCanonicalReferenceGraphSnapshot,
	type CanonicalArtifactGcState,
	type CanonicalArtifactTransitiveReference,
	type CanonicalCheckpointReference,
	type CanonicalEpisodeReference,
	type CanonicalForkReference,
	type CanonicalGcScope,
	type CanonicalAgentHandoffReference,
	type CanonicalLegalHoldReference,
	type CanonicalReferenceGraphBody,
	type CanonicalReferenceGraphPort,
	type CanonicalReferenceGraphSnapshot,
	type CanonicalSessionGcState,
} from "./canonical-references.ts";
import { LIFECYCLE_SCHEMA_VERSION, type LifecycleResult } from "./recovery.ts";

export const CANONICAL_REFERENCE_SOURCE_KINDS = [
	"session",
	"fork",
	"handoff",
	"checkpoint",
	"episode",
	"artifact",
	"legal_hold",
	"writer_lease",
] as const;
export type CanonicalReferenceSourceKind = (typeof CANONICAL_REFERENCE_SOURCE_KINDS)[number];

export interface CanonicalReferenceGraphContributionBody {
	schemaVersion: typeof LIFECYCLE_SCHEMA_VERSION;
	source: CanonicalReferenceSourceKind;
	authorityId: AuthorityId;
	tenantId: TenantId;
	revision: number;
	completeness: "complete" | "unknown";
	observedAt: string;
	sessions: readonly CanonicalSessionGcState[];
	artifacts: readonly CanonicalArtifactGcState[];
	forks: readonly CanonicalForkReference[];
	handoffs: readonly CanonicalAgentHandoffReference[];
	checkpoints: readonly CanonicalCheckpointReference[];
	episodes: readonly CanonicalEpisodeReference[];
	artifactReferences: readonly CanonicalArtifactTransitiveReference[];
	legalHolds: readonly CanonicalLegalHoldReference[];
}

export interface CanonicalReferenceGraphContribution extends CanonicalReferenceGraphContributionBody {
	contributionDigest: string;
}

export interface CanonicalReferenceGraphSourcePort {
	readonly source: CanonicalReferenceSourceKind;
	loadContribution(
		scope: CanonicalGcScope,
		signal?: AbortSignal,
	): Promise<LifecycleResult<CanonicalReferenceGraphContribution>>;
}

function failure(
	code: "invalid_request" | "integrity_failed" | "external_unavailable",
	message: string,
	retryable = false,
): LifecycleResult<never> {
	return { ok: false, error: { code, message, retryable } };
}

function contributionBody(
	contribution: CanonicalReferenceGraphContribution,
): CanonicalReferenceGraphContributionBody {
	const { contributionDigest: _contributionDigest, ...body } = contribution;
	return body;
}

export function createCanonicalReferenceGraphContribution(
	body: CanonicalReferenceGraphContributionBody,
): LifecycleResult<CanonicalReferenceGraphContribution> {
	if (
		!CANONICAL_REFERENCE_SOURCE_KINDS.includes(body.source) ||
		!Number.isSafeInteger(body.revision) ||
		body.revision < 0
	) return failure("invalid_request", "canonical reference contribution identity is invalid");
	const validation = createCanonicalReferenceGraphSnapshot({
		schemaVersion: body.schemaVersion,
		authorityId: body.authorityId,
		tenantId: body.tenantId,
		revision: body.revision,
		// 单个 source 允许引用由另一 source 提供的节点；只有 aggregate 才能声明 complete。
		completeness: "unknown",
		observedAt: body.observedAt,
		sessions: body.sessions,
		artifacts: body.artifacts,
		forks: body.forks,
		handoffs: body.handoffs,
		checkpoints: body.checkpoints,
		episodes: body.episodes,
		artifactReferences: body.artifactReferences,
		legalHolds: body.legalHolds,
	});
	if (!validation.ok) return failure("invalid_request", "canonical reference contribution is invalid");
	return {
		ok: true,
		value: {
			...body,
			contributionDigest: canonicalDigest(body),
		},
	};
}

function validContribution(
	value: CanonicalReferenceGraphContribution,
	scope: CanonicalGcScope,
	source: CanonicalReferenceSourceKind,
): boolean {
	const recreated = createCanonicalReferenceGraphContribution(contributionBody(value));
	return recreated.ok &&
		value.source === source &&
		value.authorityId === scope.authorityId &&
		value.tenantId === scope.tenantId &&
		value.contributionDigest === recreated.value.contributionDigest;
}

function mergeUnique<T>(
	target: Map<string, T>,
	values: readonly T[],
	key: (value: T) => string,
): boolean {
	for (const value of values) {
		const id = key(value);
		const existing = target.get(id);
		if (existing && canonicalDigest(existing) !== canonicalDigest(value)) return false;
		if (!existing) target.set(id, structuredClone(value));
	}
	return true;
}

function sessionKey(value: CanonicalSessionGcState): string {
	return value.sessionId;
}

function artifactKey(value: CanonicalArtifactGcState): string {
	return value.artifactId;
}

function forkKey(value: CanonicalForkReference): string {
	return `${value.parent.sessionId}\u0000${value.descendant.sessionId}`;
}

function checkpointKey(value: CanonicalCheckpointReference): string {
	return value.checkpointId;
}

function episodeKey(value: CanonicalEpisodeReference): string {
	return `${value.session.sessionId}\u0000${value.manifestDigest}`;
}

function artifactReferenceKey(value: CanonicalArtifactTransitiveReference): string {
	return `${value.source.artifactId}\u0000${value.target.artifactId}`;
}

function legalHoldKey(value: CanonicalLegalHoldReference): string {
	return value.holdId;
}

function emptyGraph(
	scope: CanonicalGcScope,
	observedAt: string,
): LifecycleResult<CanonicalReferenceGraphSnapshot> {
	return createCanonicalReferenceGraphSnapshot({
		schemaVersion: LIFECYCLE_SCHEMA_VERSION,
		...scope,
		revision: 0,
		completeness: "unknown",
		observedAt,
		sessions: [],
		artifacts: [],
		forks: [],
		handoffs: [],
		checkpoints: [],
		episodes: [],
		artifactReferences: [],
		legalHolds: [],
	});
}

/**
 * requiredSources 是 deployment contract；缺 port、timeout、unknown contribution 均产出
 * completeness=unknown 的合法图，使 GC 对所有 mutation fail closed。
 */
export class ProductionCanonicalReferenceGraphAggregator implements CanonicalReferenceGraphPort {
	readonly #sources: ReadonlyMap<CanonicalReferenceSourceKind, CanonicalReferenceGraphSourcePort>;
	readonly #requiredSources: readonly CanonicalReferenceSourceKind[];
	readonly #clock: () => Date;

	public constructor(options: {
		sources: readonly CanonicalReferenceGraphSourcePort[];
		requiredSources?: readonly CanonicalReferenceSourceKind[];
		clock?: () => Date;
	}) {
		const sources = new Map<CanonicalReferenceSourceKind, CanonicalReferenceGraphSourcePort>();
		for (const source of options.sources) {
			if (sources.has(source.source)) throw new TypeError(`duplicate canonical reference source: ${source.source}`);
			sources.set(source.source, source);
		}
		this.#sources = sources;
		this.#requiredSources = Object.freeze([
			...new Set(options.requiredSources ?? CANONICAL_REFERENCE_SOURCE_KINDS),
		]);
		this.#clock = options.clock ?? (() => new Date());
	}

	public async loadGraph(
		scope: CanonicalGcScope,
		signal?: AbortSignal,
	): Promise<LifecycleResult<CanonicalReferenceGraphSnapshot>> {
		const observedAt = this.#clock().toISOString();
		if (signal?.aborted) return emptyGraph(scope, observedAt);
		const contributions: CanonicalReferenceGraphContribution[] = [];
		let complete = true;
		for (const kind of this.#requiredSources) {
			const source = this.#sources.get(kind);
			if (!source) {
				complete = false;
				continue;
			}
			let loaded: LifecycleResult<CanonicalReferenceGraphContribution>;
			try {
				loaded = await source.loadContribution(scope, signal);
			} catch {
				complete = false;
				continue;
			}
			if (!loaded.ok) {
				complete = false;
				continue;
			}
			if (!validContribution(loaded.value, scope, kind)) {
				return failure("integrity_failed", `canonical reference source ${kind} returned invalid evidence`);
			}
			if (loaded.value.completeness !== "complete") complete = false;
			contributions.push(loaded.value);
		}
		const sessions = new Map<string, CanonicalSessionGcState>();
		const artifacts = new Map<string, CanonicalArtifactGcState>();
		const forks = new Map<string, CanonicalForkReference>();
		const handoffs = new Map<string, CanonicalAgentHandoffReference>();
		const checkpoints = new Map<string, CanonicalCheckpointReference>();
		const episodes = new Map<string, CanonicalEpisodeReference>();
		const artifactReferences = new Map<string, CanonicalArtifactTransitiveReference>();
		const legalHolds = new Map<string, CanonicalLegalHoldReference>();
		for (const contribution of contributions) {
			const merged =
				mergeUnique(sessions, contribution.sessions, sessionKey) &&
				mergeUnique(artifacts, contribution.artifacts, artifactKey) &&
				mergeUnique(forks, contribution.forks, forkKey) &&
				mergeUnique(handoffs, contribution.handoffs, (value) => value.handoffId) &&
				mergeUnique(checkpoints, contribution.checkpoints, checkpointKey) &&
				mergeUnique(episodes, contribution.episodes, episodeKey) &&
				mergeUnique(artifactReferences, contribution.artifactReferences, artifactReferenceKey) &&
				mergeUnique(legalHolds, contribution.legalHolds, legalHoldKey);
			if (!merged) return failure("integrity_failed", "canonical reference sources conflict");
		}
		const body: CanonicalReferenceGraphBody = {
			schemaVersion: LIFECYCLE_SCHEMA_VERSION,
			...scope,
			revision: contributions.reduce((maximum, value) => Math.max(maximum, value.revision), 0),
			completeness: complete ? "complete" : "unknown",
			observedAt: contributions.reduce(
				(latest, value) => Date.parse(value.observedAt) > Date.parse(latest) ? value.observedAt : latest,
				observedAt,
			),
			sessions: [...sessions.values()].sort((left, right) => left.sessionId.localeCompare(right.sessionId)),
			artifacts: [...artifacts.values()].sort((left, right) => left.artifactId.localeCompare(right.artifactId)),
			forks: [...forks.values()].sort((left, right) => forkKey(left).localeCompare(forkKey(right))),
			handoffs: [...handoffs.values()].sort((left, right) => left.handoffId.localeCompare(right.handoffId)),
			checkpoints: [...checkpoints.values()].sort((left, right) => left.checkpointId.localeCompare(right.checkpointId)),
			episodes: [...episodes.values()].sort((left, right) => episodeKey(left).localeCompare(episodeKey(right))),
			artifactReferences: [...artifactReferences.values()].sort((left, right) =>
				artifactReferenceKey(left).localeCompare(artifactReferenceKey(right))
			),
			legalHolds: [...legalHolds.values()].sort((left, right) => left.holdId.localeCompare(right.holdId)),
		};
		const snapshot = createCanonicalReferenceGraphSnapshot(body);
		return snapshot.ok
			? snapshot
			: failure("integrity_failed", "aggregated canonical reference graph is invalid");
	}
}
