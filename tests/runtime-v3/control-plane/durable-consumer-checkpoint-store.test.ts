import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileDurableProjectionCheckpointStore } from "../../../src/daemon/durable-consumer-checkpoint-store.ts";
import {
	DurableProjectionPump,
	type EventSubscriptionSourcePort,
} from "../../../src/runtime/control-plane/subscriptions.ts";
import type { RuntimeEventV3 } from "../../../src/runtime/protocol/v3/events.ts";
import { readAllRuntimeEvents } from "../../../src/runtime/session/snapshot.ts";
import { DEFAULT_RUNTIME_FEATURES } from "../../../src/runtime/runtime-features.ts";
import { V3SessionManager } from "../../../src/storage/v3-session-manager.ts";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function source(events: () => readonly RuntimeEventV3[], redeliverCursor: boolean): EventSubscriptionSourcePort {
	return {
		subscribe: async function* (_sessionId, afterSequence) {
			for (const event of events()) {
				if (redeliverCursor ? event.sequence >= afterSequence : event.sequence > afterSequence) {
					yield { event, origin: "replay" as const };
				}
			}
		},
	};
}

describe("filesystem durable projection checkpoints", () => {
	it("atomically resumes a projection pump after restart and deduplicates cursor redelivery", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-consumer-checkpoint-"));
		roots.push(root);
		const manager = await V3SessionManager.create({
			cwd: root,
			sessionDir: join(root, "sessions"),
			features: DEFAULT_RUNTIME_FEATURES,
		});
		await manager.sessionEvents().recordMessage({ role: "user", content: [{ type: "text", text: "one" }] });
		await manager.sessionEvents().recordMessage({ role: "user", content: [{ type: "text", text: "two" }] });
		const initialFlush = await manager.writer().flush();
		if (!initialFlush.ok) throw new Error(initialFlush.error.message);
		const replayed = await readAllRuntimeEvents(manager.eventStore());
		if (!replayed.ok) throw new Error(replayed.error.message);
		let events = [...replayed.value];
		const checkpointRoot = join(root, "checkpoints");
		const firstStore = await FileDurableProjectionCheckpointStore.open<{ count: number }>({
			rootDirectory: checkpointRoot,
			initial: () => ({ count: 0 }),
		});
		if (!firstStore.ok) throw new Error(firstStore.error.message);
		const firstPump = new DurableProjectionPump({
			consumerId: "activity-projection",
			sessionId: manager.sessionId(),
			store: firstStore.value,
			source: source(() => events, false),
			project: (state) => ({ count: state.count + 1 }),
		});
		await expect(firstPump.run()).resolves.toMatchObject({
			ok: true,
			value: { applied: events.length, duplicates: 0, cursor: { sequence: events.length - 1 } },
		});

		await manager.sessionEvents().recordMessage({ role: "user", content: [{ type: "text", text: "after restart" }] });
		const restartFlush = await manager.writer().flush();
		if (!restartFlush.ok) throw new Error(restartFlush.error.message);
		const afterRestart = await readAllRuntimeEvents(manager.eventStore());
		if (!afterRestart.ok) throw new Error(afterRestart.error.message);
		events = [...afterRestart.value];
		const reopened = await FileDurableProjectionCheckpointStore.open<{ count: number }>({
			rootDirectory: checkpointRoot,
			initial: () => ({ count: 0 }),
		});
		if (!reopened.ok) throw new Error(reopened.error.message);
		const resumedPump = new DurableProjectionPump({
			consumerId: "activity-projection",
			sessionId: manager.sessionId(),
			store: reopened.value,
			source: source(() => events, true),
			project: (state) => ({ count: state.count + 1 }),
		});
		await expect(resumedPump.run()).resolves.toMatchObject({
			ok: true,
			value: { applied: 1, duplicates: 1, cursor: { sequence: events.length - 1 } },
		});
		await expect(reopened.value.load("activity-projection", manager.sessionId())).resolves.toMatchObject({
			ok: true,
			value: { revision: events.length, projection: { count: events.length } },
		});
		expect((await stat(checkpointRoot)).mode & 0o077).toBe(0);
		await manager.closeAll();
	});
});
