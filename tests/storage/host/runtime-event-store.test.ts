import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildRunledgerLayout } from "../../../src/runtime/contracts/storage-layout.ts";
import { createRuntimeId, runtimeDigest, validateRuntimeEvent, type RuntimeEventPayloadFor } from "../../../src/runtime/contracts/public.ts";
import { JsonlRuntimeEventStore } from "../../../src/storage/host/runtime-event-store.ts";

describe("JsonlRuntimeEventStore", () => {
	it("writes a current-format hash chain and idempotently replays an event", async () => {
		const home = await mkdtemp(join(tmpdir(), "runledger-runtime-events-"));
		try {
			const layout = buildRunledgerLayout(home, "posix");
			const store = new JsonlRuntimeEventStore({
				layout,
				workspaceStorageKey: `ws-${"b".repeat(64)}`,
			});
			const sessionId = createRuntimeId("session", "event-store");
			const traceId = createRuntimeId("trace", "event-store");
			const approvalId = createRuntimeId("approval", "event-store");
			const payload: RuntimeEventPayloadFor<"permission.requested"> = {
				subject: { kind: "approval", id: approvalId },
				correlationId: traceId,
				effect: "none",
				idempotencyKey: "approval-event-store",
				transition: { revision: 0, previousStatus: null, nextStatus: "pending" },
				bindings: [{ role: "session", subjectId: sessionId }],
				refs: [{ subjectKind: "receipt", digest: runtimeDigest("request") }],
			};
			const input = {
				authorityId: createRuntimeId("authority", "event-store"),
				tenantId: createRuntimeId("tenant", "event-store"),
				principalId: createRuntimeId("principal", "event-store"),
				sessionId,
				traceId,
				type: "permission.requested" as const,
				payload,
			};
			const first = await store.append(input);
			const second = await store.append(input);
			expect(second.event.eventId).toBe(first.event.eventId);
			expect(second.receipt).toEqual(first.receipt);
			expect(validateRuntimeEvent(first.event)).toMatchObject({ ok: true });
			expect(await store.read(sessionId)).toEqual([first.event]);
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});
});
