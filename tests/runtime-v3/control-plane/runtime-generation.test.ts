import { describe, expect, it } from "vitest";
import { canonicalDigest } from "../../../src/runtime/protocol/v3/canonical-json.ts";
import type { RuntimeEventPayloadMap } from "../../../src/runtime/protocol/v3/event-payloads.ts";
import type { RuntimeEventType } from "../../../src/runtime/protocol/v3/event-catalog.ts";
import {
	createAuthorityTenantEventStreamRef,
	RUNTIME_SCHEMA_VERSION,
	type RuntimeEventEnvelopeV3,
	type RuntimeEventV3,
} from "../../../src/runtime/protocol/v3/events.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/v3/ids.ts";
import { reduceRuntimeGenerationEvents } from "../../../src/runtime/control-plane/runtime-generation.ts";

const authorityId = createRuntimeId("authority", "runtime-generation");
const tenantId = createRuntimeId("tenant", "runtime-generation");
const principalId = createRuntimeId("principal", "runtime-generation");
const stream = createAuthorityTenantEventStreamRef({ authorityId, tenantId });
const D = "d".repeat(64);

function hashFor(sequence: number): string {
	return sequence.toString(16).padStart(64, "0");
}

function event<TType extends RuntimeEventType>(
	type: TType,
	sequence: number,
	payload: RuntimeEventPayloadMap[TType],
): RuntimeEventEnvelopeV3<TType> {
	return {
		schemaVersion: RUNTIME_SCHEMA_VERSION,
		authorityId,
		tenantId,
		principalId,
		eventId: createRuntimeId("event", `runtime-generation-${sequence}`),
		stream,
		sequence,
		timestamp: `2026-07-22T00:00:${sequence.toString().padStart(2, "0")}.000Z`,
		type,
		previousEventHash: sequence === 0 ? null : hashFor(sequence - 1),
		payloadDigest: canonicalDigest(payload),
		currentEventHash: hashFor(sequence),
		traceId: createRuntimeId("trace", `runtime-generation-${sequence}`),
		payload,
	};
}

function prepared(
	sequence: number,
	suffix: string,
	previous: { runtimeId: ReturnType<typeof createRuntimeId<"runtime">>; generation: number } | null,
) {
	return event("runtime.replacement_prepared", sequence, {
		replacementId: createRuntimeId("command", `replacement-${suffix}`),
		idempotencyKey: createRuntimeId("command", `replacement-key-${suffix}`),
		...(previous ? { previousRuntimeId: previous.runtimeId } : {}),
		previousGeneration: previous?.generation ?? 0,
		candidateRuntimeId: createRuntimeId("runtime", `candidate-${suffix}`),
		candidateGeneration: (previous?.generation ?? 0) + 1,
		compositionReceiptId: createRuntimeId("compositionReceipt", `composition-${suffix}`),
		compositionDigest: canonicalDigest({ composition: suffix }),
		fencingIntentDigest: canonicalDigest({ fence: suffix }),
	});
}

function activated(sequence: number, candidate: ReturnType<typeof prepared>) {
	return event("runtime.generation_activated", sequence, {
		replacementId: candidate.payload.replacementId,
		activeRuntimeId: candidate.payload.candidateRuntimeId,
		activeGeneration: candidate.payload.candidateGeneration,
		compositionReceiptId: candidate.payload.compositionReceiptId,
		compositionDigest: candidate.payload.compositionDigest,
		fencingReceiptId: createRuntimeId("receipt", `fencing-${sequence}`),
		fencingReceiptDigest: canonicalDigest({ fencing: sequence }),
	});
}

function failed(
	sequence: number,
	candidate: ReturnType<typeof prepared>,
	outcomeCertain: boolean,
) {
	return event("runtime.replacement_failed", sequence, {
		replacementId: candidate.payload.replacementId,
		candidateRuntimeId: candidate.payload.candidateRuntimeId,
		candidateGeneration: candidate.payload.candidateGeneration,
		error: { code: "health_probe_failed", messageDigest: D, retryable: false },
		outcomeCertain,
	});
}

function value(events: readonly RuntimeEventV3[]) {
	const result = reduceRuntimeGenerationEvents(events);
	expect(result.ok).toBe(true);
	if (!result.ok || !result.value) throw new Error("expected a runtime generation projection");
	return result.value;
}

describe("RuntimeGenerationProjection", () => {
	it("activates only a matching prepared generation and preserves a failed pre-commit predecessor", () => {
		const first = prepared(0, "one", null);
		const firstActivated = activated(1, first);
		const second = prepared(2, "two", {
			runtimeId: first.payload.candidateRuntimeId,
			generation: first.payload.candidateGeneration,
		});
		const projection = value([first, firstActivated, second, failed(3, second, true)]);

		expect(projection.active).toMatchObject({
			runtimeId: first.payload.candidateRuntimeId,
			generation: 1,
			status: "active",
		});
		expect(projection.replacements.map((replacement) => replacement.status)).toEqual([
			"activated",
			"failed_before_activation",
		]);
		expect(projection.reconciliationRequired).toBe(false);
	});

	it("keeps an uncertain prepared candidate fenced until the same replacement reconciles", () => {
		const candidate = prepared(0, "uncertain", null);
		const uncertain = failed(1, candidate, false);
		const blocked = prepared(2, "blocked", null);
		const rejected = reduceRuntimeGenerationEvents([candidate, uncertain, blocked]);
		expect(rejected).toMatchObject({ ok: false, error: { code: "recovery_required" } });

		const reconciled = value([candidate, uncertain, activated(2, candidate)]);
		expect(reconciled.reconciliationRequired).toBe(false);
		expect(reconciled.active).toMatchObject({ runtimeId: candidate.payload.candidateRuntimeId, status: "active" });
	});

	it("never revives the old generation when a post-activation failure occurs", () => {
		const candidate = prepared(0, "post-commit", null);
		const projection = value([candidate, activated(1, candidate), failed(2, candidate, true)]);
		expect(projection.active).toMatchObject({
			runtimeId: candidate.payload.candidateRuntimeId,
			generation: candidate.payload.candidateGeneration,
			status: "paused",
		});
		expect(projection.replacements[0]?.status).toBe("failed_after_activation");
	});

	it("rejects generation skips, candidate aliasing, and cross-stream prefixes", () => {
		const candidate = prepared(0, "invalid", null);
		const skipped = {
			...candidate,
			payload: { ...candidate.payload, candidateGeneration: 2 },
		};
		expect(reduceRuntimeGenerationEvents([skipped])).toMatchObject({
			ok: false,
			error: { code: "recovery_required" },
		});

		const activatedCandidate = activated(1, candidate);
		const aliased = prepared(2, "alias", {
			runtimeId: candidate.payload.candidateRuntimeId,
			generation: 1,
		});
		const aliasEvent = {
			...aliased,
			payload: { ...aliased.payload, candidateRuntimeId: candidate.payload.candidateRuntimeId },
		};
		expect(reduceRuntimeGenerationEvents([candidate, activatedCandidate, aliasEvent])).toMatchObject({ ok: false });

		const otherStreamEvent = {
			...activatedCandidate,
			stream: createAuthorityTenantEventStreamRef({
				authorityId,
				tenantId: createRuntimeId("tenant", "other"),
			}),
		};
		expect(reduceRuntimeGenerationEvents([candidate, otherStreamEvent])).toMatchObject({ ok: false });
	});

	it("produces a stable digest over a mixed authority lifecycle stream", () => {
		const policy = event("policy.effective_recorded", 0, {
			policyId: createRuntimeId("resource", "policy"),
			policyRevision: 1,
			policyDigest: D,
			sourceReceiptId: createRuntimeId("receipt", "policy"),
			sourceReceiptDigest: D,
			effectiveAt: "2026-07-22T00:00:00.000Z",
		});
		const candidate = prepared(1, "mixed", null);
		const events = [policy, candidate, activated(2, candidate)];
		expect(value(events).projectionDigest).toBe(value(structuredClone(events)).projectionDigest);
	});
});
