import { describe, expect, it } from "vitest";
import { createLocalIdentityContext } from "../../../src/runtime/identity/local-principal.ts";
import { canonicalDigest } from "../../../src/runtime/protocol/v3/canonical-json.ts";
import { createIdempotencyKey } from "../../../src/runtime/protocol/v3/coordination.ts";
import { createAuthorityTenantEventStreamRef } from "../../../src/runtime/protocol/v3/events.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/v3/ids.ts";
import {
	RuntimeGenerationRepository,
	type RuntimeGenerationEventContext,
} from "../../../src/runtime/control-plane/runtime-generation-repository.ts";
import { AuthorityLifecycleRepository } from "../../../src/runtime/session/authority-lifecycle-repository.ts";
import { EventWriter } from "../../../src/runtime/session/event-writer.ts";
import { MemoryEventStore } from "../../../src/runtime/session/memory-event-store.ts";
import type { SessionResult, WriterFence } from "../../../src/runtime/session/types.ts";

const NOW = new Date("2026-07-22T12:00:00.000Z");
const DIGEST = "a".repeat(64);

function sessionValue<T>(result: SessionResult<T>): T {
	if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
	return result.value;
}

async function fixture(seed: string) {
	const identity = createLocalIdentityContext(NOW);
	const stream = createAuthorityTenantEventStreamRef(identity);
	const fence: WriterFence = {
		authorityId: identity.authorityId,
		tenantId: identity.tenantId,
		stream,
		leaseId: createRuntimeId("lease", `${seed}-authority`),
		ownerRuntimeId: createRuntimeId("runtime", `${seed}-owner`),
		writerEpoch: 1,
		fencingToken: `fencing-token-${seed}-0123456789abcdef`,
	};
	const store = new MemoryEventStore({
		authorityId: identity.authorityId,
		tenantId: identity.tenantId,
		stream,
		validateFence: (candidate) => candidate.fencingToken === fence.fencingToken,
		clock: () => NOW,
	});
	const writer = new EventWriter({
		authorityId: identity.authorityId,
		tenantId: identity.tenantId,
		stream,
		store,
		fence,
		clock: () => NOW,
	});
	const authority = sessionValue(await AuthorityLifecycleRepository.open({
		authorityId: identity.authorityId,
		tenantId: identity.tenantId,
		store,
		writer,
	}));
	return { identity, store, repository: new RuntimeGenerationRepository(authority) };
}

function context(
	principalId: ReturnType<typeof createLocalIdentityContext>["principalId"],
	seed: string,
): RuntimeGenerationEventContext<"runtime.replacement_prepared"> {
	return {
		principalId,
		traceId: createRuntimeId("trace", seed),
		timestamp: NOW.toISOString(),
	};
}

function preparedPayload(seed: string, previous?: { runtimeId: string; generation: number }) {
	return {
		replacementId: createRuntimeId("command", `replacement-${seed}`),
		idempotencyKey: createIdempotencyKey(`replacement-key-${seed.padEnd(16, "0")}`),
		...(previous ? { previousRuntimeId: createRuntimeId("runtime", previous.runtimeId) } : {}),
		previousGeneration: previous?.generation ?? 0,
		candidateRuntimeId: createRuntimeId("runtime", `candidate-${seed}`),
		candidateGeneration: (previous?.generation ?? 0) + 1,
		compositionReceiptId: createRuntimeId("compositionReceipt", `composition-${seed}`),
		compositionDigest: canonicalDigest({ seed, kind: "composition" }),
		fencingIntentDigest: canonicalDigest({ seed, kind: "fencing-intent" }),
	};
}

describe("RuntimeGenerationRepository", () => {
	it("durably prepares and activates once, then replays exact retries", async () => {
		const test = await fixture("activate");
		const payload = preparedPayload("activate");
		const prepared = await test.repository.prepare(context(test.identity.principalId, "prepare"), payload);
		expect(prepared).toMatchObject({ ok: true, value: { disposition: "committed" } });
		const repeated = await test.repository.prepare(context(test.identity.principalId, "prepare-retry"), payload);
		expect(repeated).toMatchObject({ ok: true, value: { disposition: "replayed" } });

		const activation = {
			replacementId: payload.replacementId,
			activeRuntimeId: payload.candidateRuntimeId,
			activeGeneration: payload.candidateGeneration,
			compositionReceiptId: payload.compositionReceiptId,
			compositionDigest: payload.compositionDigest,
			fencingReceiptId: createRuntimeId("receipt", "activate-fence"),
			fencingReceiptDigest: canonicalDigest({ fence: "activate" }),
		};
		const activated = await test.repository.activate(
			{ ...context(test.identity.principalId, "activate") },
			activation,
		);
		expect(activated).toMatchObject({
			ok: true,
			value: {
				disposition: "committed",
				projection: { active: { runtimeId: payload.candidateRuntimeId, generation: 1, status: "active" } },
			},
		});
		expect(await test.repository.activate(
			{ ...context(test.identity.principalId, "activate-retry") },
			activation,
		)).toMatchObject({ ok: true, value: { disposition: "replayed" } });

		const page = await test.store.readPage(test.store.streamRef(), { limit: 100 });
		expect(page).toMatchObject({ ok: true, value: { events: [{ type: "runtime.replacement_prepared" }, { type: "runtime.generation_activated" }] } });
	});

	it("rejects conflicting retries without appending another event", async () => {
		const test = await fixture("conflict");
		const payload = preparedPayload("conflict");
		expect((await test.repository.prepare(context(test.identity.principalId, "prepare"), payload)).ok).toBe(true);
		expect(await test.repository.prepare(context(test.identity.principalId, "changed"), {
			...payload,
			compositionDigest: DIGEST,
		})).toMatchObject({ ok: false, error: { code: "idempotency_conflict" }, effect: "none" });
		const replay = await test.repository.replay();
		expect(replay).toMatchObject({ ok: true, value: { events: [{ type: "runtime.replacement_prepared" }] } });
	});

	it("keeps an uncertain failure closed until the same candidate activates", async () => {
		const test = await fixture("reconcile");
		const payload = preparedPayload("reconcile");
		expect((await test.repository.prepare(context(test.identity.principalId, "prepare"), payload)).ok).toBe(true);
		expect(await test.repository.fail({ ...context(test.identity.principalId, "fail") }, {
			replacementId: payload.replacementId,
			candidateRuntimeId: payload.candidateRuntimeId,
			candidateGeneration: payload.candidateGeneration,
			error: { code: "fencing_receipt_lost", messageDigest: DIGEST, retryable: false },
			outcomeCertain: false,
		})).toMatchObject({ ok: true, value: { projection: { reconciliationRequired: true } } });

		const next = preparedPayload("blocked");
		expect(await test.repository.prepare(context(test.identity.principalId, "blocked"), next)).toMatchObject({
			ok: false,
			error: { code: "recovery_required" },
		});
		expect(await test.repository.activate({ ...context(test.identity.principalId, "reconcile") }, {
			replacementId: payload.replacementId,
			activeRuntimeId: payload.candidateRuntimeId,
			activeGeneration: payload.candidateGeneration,
			compositionReceiptId: payload.compositionReceiptId,
			compositionDigest: payload.compositionDigest,
			fencingReceiptId: createRuntimeId("receipt", "reconciled-fence"),
			fencingReceiptDigest: canonicalDigest({ fence: "reconciled" }),
		})).toMatchObject({ ok: true, value: { projection: { reconciliationRequired: false } } });
	});
});
