import { describe, expect, it } from "vitest";
import {
	createCanonicalReferenceGraphContribution,
	ProductionCanonicalReferenceGraphAggregator,
	type CanonicalReferenceGraphContribution,
	type CanonicalReferenceGraphSourcePort,
	type CanonicalReferenceSourceKind,
} from "../../../src/runtime/lifecycle/canonical-reference-aggregator.ts";
import type { CanonicalSessionGcState } from "../../../src/runtime/lifecycle/canonical-references.ts";
import { LIFECYCLE_SCHEMA_VERSION, type LifecycleResult } from "../../../src/runtime/lifecycle/recovery.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/v3/ids.ts";

const authorityId = createRuntimeId("authority", "reference-aggregator");
const tenantId = createRuntimeId("tenant", "reference-aggregator");
const now = "2026-07-24T00:00:00.000Z";

function session(seed: string): CanonicalSessionGcState {
	return {
		authorityId,
		tenantId,
		sessionId: createRuntimeId("session", seed),
		expiresAt: "2026-07-23T00:00:00.000Z",
		pins: [],
		writerState: "inactive",
		leaseState: "inactive",
		archiveState: "archived",
		tombstoneState: "live",
	};
}

function contribution(
	source: CanonicalReferenceSourceKind,
	sessions: readonly CanonicalSessionGcState[] = [],
): CanonicalReferenceGraphContribution {
	const created = createCanonicalReferenceGraphContribution({
		schemaVersion: LIFECYCLE_SCHEMA_VERSION,
		source,
		authorityId,
		tenantId,
		revision: source === "session" ? 3 : 5,
		completeness: "complete",
		observedAt: now,
		sessions,
		artifacts: [],
		forks: [],
		handoffs: [],
		checkpoints: [],
		episodes: [],
		artifactReferences: [],
		legalHolds: [],
	});
	if (!created.ok) throw new Error(created.error.message);
	return created.value;
}

function source(value: CanonicalReferenceGraphContribution): CanonicalReferenceGraphSourcePort {
	return {
		source: value.source,
		loadContribution: async (): Promise<LifecycleResult<CanonicalReferenceGraphContribution>> => ({
			ok: true,
			value,
		}),
	};
}

describe("production canonical reference graph aggregator", () => {
	it("joins required canonical sources into one complete deterministic snapshot", async () => {
		const candidate = session("reference-aggregator");
		const aggregator = new ProductionCanonicalReferenceGraphAggregator({
			requiredSources: ["session", "writer_lease"],
			sources: [
				source(contribution("session", [candidate])),
				source(contribution("writer_lease", [candidate])),
			],
			clock: () => new Date(now),
		});
		expect(await aggregator.loadGraph({ authorityId, tenantId })).toMatchObject({
			ok: true,
			value: {
				revision: 5,
				completeness: "complete",
				sessions: [{ sessionId: candidate.sessionId, writerState: "inactive", leaseState: "inactive" }],
			},
		});
	});

	it("returns an unknown graph when any required production source is absent or unavailable", async () => {
		const candidate = session("reference-missing");
		const aggregator = new ProductionCanonicalReferenceGraphAggregator({
			requiredSources: ["session", "legal_hold"],
			sources: [source(contribution("session", [candidate]))],
			clock: () => new Date(now),
		});
		expect(await aggregator.loadGraph({ authorityId, tenantId })).toMatchObject({
			ok: true,
			value: { completeness: "unknown", sessions: [{ sessionId: candidate.sessionId }] },
		});
	});

	it("fails closed on cross-source conflicts or tenant replay", async () => {
		const candidate = session("reference-conflict");
		const conflicting = contribution("writer_lease", [{ ...candidate, writerState: "active" }]);
		const conflict = new ProductionCanonicalReferenceGraphAggregator({
			requiredSources: ["session", "writer_lease"],
			sources: [source(contribution("session", [candidate])), source(conflicting)],
			clock: () => new Date(now),
		});
		expect(await conflict.loadGraph({ authorityId, tenantId }))
			.toMatchObject({ ok: false, error: { code: "integrity_failed" } });

		const replayed = { ...contribution("session", [candidate]), tenantId: createRuntimeId("tenant", "foreign") };
		const replay = new ProductionCanonicalReferenceGraphAggregator({
			requiredSources: ["session"],
			sources: [source(replayed)],
			clock: () => new Date(now),
		});
		expect(await replay.loadGraph({ authorityId, tenantId }))
			.toMatchObject({ ok: false, error: { code: "integrity_failed" } });
	});
});
