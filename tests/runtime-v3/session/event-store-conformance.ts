/** 所有 canonical Event Store backend 必须复用的最小 conformance/fault suite。 */

import { describe, expect, it } from "vitest";
import { canonicalDigest } from "../../../src/runtime/protocol/v3/canonical-json.ts";
import { createSessionEventStreamRef } from "../../../src/runtime/protocol/v3/events.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/v3/ids.ts";
import type {
	AuthorityId,
	PrincipalId,
	RuntimeInstanceId,
	SessionId,
	TenantId,
} from "../../../src/runtime/protocol/v3/ids.ts";
import { EventWriter } from "../../../src/runtime/session/event-writer.ts";
import type { RuntimeEventStore } from "../../../src/runtime/session/event-store.ts";
import type { SessionResult, WriterFence } from "../../../src/runtime/session/types.ts";

export interface EventStoreConformanceHarness {
	authorityId: AuthorityId;
	tenantId: TenantId;
	principalId: PrincipalId;
	sessionId: SessionId;
	runtimeId: RuntimeInstanceId;
	store: RuntimeEventStore;
	writer: EventWriter;
	fence: WriterFence;
	revokeFence(): void;
}

export type EventStoreConformanceFactory = (
	seed: string,
) => Promise<EventStoreConformanceHarness>;

function valueOf<T>(result: SessionResult<T>): T {
	expect(result.ok).toBe(true);
	if (!result.ok) throw new Error(result.error.message);
	return result.value;
}

async function appendGenesis(harness: EventStoreConformanceHarness) {
	return harness.writer.append({
		type: "session.created",
		principalId: harness.principalId,
		traceId: createRuntimeId("trace", `conformance-${harness.sessionId}`),
		payload: {
			origin: "test",
			runtimeId: harness.runtimeId,
			featureDigest: canonicalDigest({ backend: harness.sessionId }),
			initialGoalId: createRuntimeId("goal", `conformance-${harness.sessionId}`),
			rootAgentId: createRuntimeId("agent", `conformance-${harness.sessionId}`),
		},
	});
}

export function defineRuntimeEventStoreConformanceSuite(
	backend: string,
	factory: EventStoreConformanceFactory,
): void {
	describe(`${backend} RuntimeEventStore conformance`, () => {
		it("separates accepted cursor, durable receipt, and subscriber settlement", async () => {
			const harness = await factory(`${backend}-durability`);
			const iterator = harness.store.subscribe(harness.store.streamRef())[Symbol.asyncIterator]();
			let settled = false;
			const next = iterator.next().then((value) => {
				settled = true;
				return value;
			});
			const accepted = valueOf(await appendGenesis(harness));
			await Promise.resolve();
			expect(settled).toBe(false);
			expect(accepted.durableReceipt).toBeUndefined();

			const receipt = valueOf(await harness.writer.flush());
			expect(receipt).toMatchObject({
				streamScope: "session",
				streamId: harness.store.streamRef().streamId,
				cursor: {
					stream: accepted.cursor.stream,
					sequence: accepted.cursor.sequence,
					eventId: accepted.cursor.eventId,
					eventHash: accepted.cursor.eventHash,
				},
				writerEpoch: harness.fence.writerEpoch,
			});
			expect((await next).value?.eventId).toBe(accepted.event.eventId);
			await iterator.return?.();
			valueOf(await harness.store.close());
		});

		it("serializes sequence allocation and permanently fences later mutation", async () => {
			const harness = await factory(`${backend}-sequence`);
			valueOf(await appendGenesis(harness));
			const results = await Promise.all(
				Array.from({ length: 3 }, (_, index) =>
					harness.writer.append({
						type: "conversation.message_recorded",
						principalId: harness.principalId,
						traceId: createRuntimeId("trace", `${backend}-sequence-${index}`),
						payload: {
							role: "user",
							messageJson: JSON.stringify({
								role: "user",
								content: [{ type: "text", text: String(index) }],
							}),
							contentDigest: canonicalDigest(String(index)),
						},
					}),
				),
			);
			expect(results.map((result) => result.ok ? result.value.cursor.sequence : -1)).toEqual([1, 2, 3]);
			harness.revokeFence();
			expect(await harness.writer.append({
				type: "session.stop_requested",
				principalId: harness.principalId,
				traceId: createRuntimeId("trace", `${backend}-fenced`),
				payload: {
					reason: "fenced",
					requestedBy: harness.principalId,
					expectedRevision: {
						stream: harness.store.streamRef(),
						sequence: 3,
						eventHash: results[2]?.ok ? results[2].value.cursor.eventHash : "0".repeat(64),
					},
				},
			})).toMatchObject({ ok: false, error: { code: "writer_fenced" } });
			await harness.store.close();
		});

		it("rejects cross-stream cursor replay and hash corruption", async () => {
			const harness = await factory(`${backend}-cross-stream`);
			const accepted = valueOf(await appendGenesis(harness));
			const otherStream = createSessionEventStreamRef(
				{ authorityId: harness.authorityId, tenantId: harness.tenantId },
				createRuntimeId("session", `${backend}-other-stream`),
			);
			expect(await harness.store.flushThrough(
				harness.store.streamRef(),
				{ ...accepted.cursor, stream: otherStream },
				harness.fence,
			)).toMatchObject({ ok: false, error: { code: "writer_fenced" } });
			valueOf(await harness.writer.flush());
			valueOf(await harness.store.close());

			const corruptSeed = `${backend}-corrupt-target`;
			const corrupt = await factory(corruptSeed);
			const draft = valueOf(await appendGenesis(corrupt));
			await corrupt.store.close();
			const target = await factory(corruptSeed);
			const tampered = {
				...draft.event,
				stream: target.store.streamRef(),
				payload: {
					...draft.event.payload,
					featureDigest: "f".repeat(64),
				},
			};
			expect(await target.store.append(
				target.store.streamRef(),
				tampered,
				null,
				target.fence,
			)).toMatchObject({
				ok: false,
				error: { code: "hash_mismatch" },
			});
			valueOf(await target.store.close());
		});

		it("keeps parent and child stream sequence/receipts independently scoped", async () => {
			const parent = await factory(`${backend}-parent`);
			const child = await factory(`${backend}-child`);
			const parentGenesis = valueOf(await appendGenesis(parent));
			const childGenesis = valueOf(await appendGenesis(child));
			const parentReceipt = valueOf(await parent.writer.flush());
			const childReceipt = valueOf(await child.writer.flush());
			expect(parentGenesis.cursor.sequence).toBe(0);
			expect(childGenesis.cursor.sequence).toBe(0);
			expect(parentReceipt?.streamId).not.toBe(childReceipt?.streamId);
			expect(parentReceipt?.cursor.stream).not.toEqual(childReceipt?.cursor.stream);
			valueOf(await parent.store.close());
			valueOf(await child.store.close());
		});
	});
}
