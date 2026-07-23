import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";
import { createSessionEventStreamRef } from "../../../src/runtime/protocol/v3/events.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/v3/ids.ts";
import { EventWriter } from "../../../src/runtime/session/event-writer.ts";
import { JsonlV3EventStore } from "../../../src/runtime/session/jsonl-v3-store.ts";
import { MemoryEventStore } from "../../../src/runtime/session/memory-event-store.ts";
import type { RuntimeEventStore } from "../../../src/runtime/session/event-store.ts";
import type { WriterFence } from "../../../src/runtime/session/types.ts";
import {
	defineRuntimeEventStoreConformanceSuite,
	type EventStoreConformanceHarness,
} from "./event-store-conformance.ts";

const roots: string[] = [];

afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function createHarness(
	seed: string,
	backend: "memory" | "jsonl",
): Promise<EventStoreConformanceHarness> {
	const authorityId = createRuntimeId("authority", seed);
	const tenantId = createRuntimeId("tenant", seed);
	const principalId = createRuntimeId("principal", seed);
	const sessionId = createRuntimeId("session", seed);
	const runtimeId = createRuntimeId("runtime", seed);
	const stream = createSessionEventStreamRef({ authorityId, tenantId }, sessionId);
	const fence: WriterFence = {
		authorityId,
		tenantId,
		stream,
		leaseId: createRuntimeId("lease", seed),
		ownerRuntimeId: runtimeId,
		writerEpoch: 1,
		fencingToken: `${seed}-fencing-token`,
	};
	let current = true;
	let store: RuntimeEventStore;
	if (backend === "memory") {
		store = new MemoryEventStore({
			authorityId,
			tenantId,
			stream,
			validateFence: () => current,
			clock: () => new Date("2026-07-23T00:00:00.000Z"),
		});
	} else {
		const root = await mkdtemp(join(tmpdir(), "runledger-store-conformance-"));
		roots.push(root);
		const created = await JsonlV3EventStore.create({
			filePath: join(root, "events.jsonl"),
			authorityId,
			tenantId,
			stream,
			validateFence: () => current,
		});
		if (!created.ok) throw new Error(created.error.message);
		store = created.value;
	}
	const writer = new EventWriter({
		authorityId,
		tenantId,
		stream,
		store,
		fence,
		clock: () => new Date("2026-07-23T00:00:00.000Z"),
	});
	return {
		authorityId,
		tenantId,
		principalId,
		sessionId,
		runtimeId,
		store,
		writer,
		fence,
		revokeFence: () => {
			current = false;
		},
	};
}

defineRuntimeEventStoreConformanceSuite(
	"memory",
	(seed) => createHarness(seed, "memory"),
);
defineRuntimeEventStoreConformanceSuite(
	"jsonl",
	(seed) => createHarness(seed, "jsonl"),
);
