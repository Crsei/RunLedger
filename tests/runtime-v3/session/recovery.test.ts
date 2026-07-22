import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalDigest } from "../../../src/runtime/protocol/v3/canonical-json.ts";
import { createSessionEventStreamRef } from "../../../src/runtime/protocol/v3/events.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/v3/ids.ts";
import { EventWriter } from "../../../src/runtime/session/event-writer.ts";
import { MemoryEventStore } from "../../../src/runtime/session/memory-event-store.ts";
import { recoverSession } from "../../../src/runtime/session/recovery.ts";
import { reduceSessionEvents } from "../../../src/runtime/session/reducer.ts";
import {
	createSessionSnapshot,
	readAllRuntimeEvents,
	writeSessionSnapshot,
} from "../../../src/runtime/session/snapshot.ts";
import { writeStopTombstone } from "../../../src/runtime/session/stop-tombstone.ts";
import type { SessionResult, WriterFence } from "../../../src/runtime/session/types.ts";

const DIGEST = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const roots: string[] = [];

afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

function valueOf<T>(result: SessionResult<T>): T {
	expect(result.ok).toBe(true);
	if (!result.ok) throw new Error(result.error.message);
	return result.value;
}

async function setup(seed: string) {
	const authorityId = createRuntimeId("authority", seed);
	const tenantId = createRuntimeId("tenant", seed);
	const principalId = createRuntimeId("principal", seed);
	const sessionId = createRuntimeId("session", seed);
	const stream = createSessionEventStreamRef({ authorityId, tenantId }, sessionId);
	const runtimeId = createRuntimeId("runtime", seed);
	const fence: WriterFence = {
		authorityId,
		tenantId,
		stream,
		leaseId: createRuntimeId("lease", seed),
		ownerRuntimeId: runtimeId,
		writerEpoch: 1,
		fencingToken: `${seed}-fence`,
	};
	const store = new MemoryEventStore({ authorityId, tenantId, stream, validateFence: () => true });
	const writer = new EventWriter({
		authorityId,
		tenantId,
		stream,
		store,
		fence,
		clock: () => new Date("2026-07-22T00:00:00.000Z"),
	});
	valueOf(
		await writer.append({
			type: "session.created",
			principalId,
			traceId: createRuntimeId("trace", `${seed}-genesis`),
			payload: {
				origin: "test",
				runtimeId,
				featureDigest: DIGEST,
				initialGoalId: createRuntimeId("goal", `${seed}-root`),
				rootAgentId: createRuntimeId("agent", `${seed}-root`),
			},
		}),
	);
	const sessionDirectory = await mkdtemp(join(tmpdir(), "runledger-recovery-"));
	roots.push(sessionDirectory);
	return { authorityId, tenantId, principalId, sessionId, stream, runtimeId, store, writer, sessionDirectory };
}

function options(context: Awaited<ReturnType<typeof setup>>, snapshotFilePath?: string) {
	return {
		store: context.store,
		sessionDirectory: context.sessionDirectory,
		authorityId: context.authorityId,
		tenantId: context.tenantId,
		sessionId: context.sessionId,
		...(snapshotFilePath ? { snapshotFilePath } : {}),
	};
}

describe("startup recovery decisions", () => {
	it("resumes a stable chain after proving a snapshot and its Event Store prefix", async () => {
		const context = await setup("resume");
		const events = valueOf(await readAllRuntimeEvents(context.store));
		const projection = valueOf(reduceSessionEvents(events));
		const snapshot = valueOf(
			createSessionSnapshot(events, {
				snapshotId: createRuntimeId("snapshot", "recovery"),
				activeLeafId: projection.activeLeafId,
				writtenAt: "2026-07-22T00:00:01.000Z",
			}),
		);
		const snapshotPath = join(context.sessionDirectory, "session.snapshot.json");
		valueOf(await writeSessionSnapshot(snapshotPath, snapshot));
		const decision = await recoverSession(options(context, snapshotPath));
		expect(decision).toMatchObject({
			kind: "resume",
			cursor: { sequence: 0 },
			snapshotSource: "snapshot",
		});
	});

	it("pauses instead of repeating a pending approval or uncertain side effect", async () => {
		const context = await setup("pause");
		valueOf(
			await context.writer.append({
				type: "permission.requested",
				principalId: context.principalId,
				traceId: createRuntimeId("trace", "pause-permission"),
				payload: {
					approvalId: createRuntimeId("approval", "pause"),
					requestId: createRuntimeId("command", "pause-request"),
					sessionId: context.sessionId,
					runtimeId: context.runtimeId,
					runtimeGeneration: 1,
					turnId: createRuntimeId("turn", "pause"),
					toolCallId: createRuntimeId("toolCall", "pause"),
					capability: "process",
					resourceKind: "process",
					requestDigest: DIGEST,
					policyDigest: DIGEST,
					workspaceEnvelopeDigest: DIGEST,
					ticketDigest: DIGEST,
					scope: "once",
					requestedAt: "2026-07-22T00:00:00.000Z",
					attemptId: createRuntimeId("command", "pause-attempt"),
					serverScope: "tool_server",
					resourceScopeDigest: DIGEST,
					commandScopeDigest: DIGEST,
					evidenceComplete: true,
					evidenceTruncated: false,
					originalInputDigest: DIGEST,
					summary: {
						operation: "execute",
						toolIdentityDigest: DIGEST,
						targetDigest: DIGEST,
						environmentKeyDigests: [],
					},
				},
			}),
		);
		const decision = await recoverSession(options(context));
		expect(decision).toMatchObject({
			kind: "pause_for_approval",
			reasons: ["pending_permission"],
			snapshotSource: "full",
		});
	});

	it("honors a valid durable stop tombstone before allowing any resume", async () => {
		const context = await setup("stopped");
		const head = context.writer.currentHead();
		if (!head) throw new Error("missing fixture cursor");
		const stopped = valueOf(
			await context.writer.append({
				type: "session.stop_requested",
				principalId: context.principalId,
				traceId: createRuntimeId("trace", "stopped-request"),
				payload: {
					reason: "operator stop",
					requestedBy: context.principalId,
					expectedRevision: {
						stream: head.stream,
						sequence: head.sequence,
						eventHash: head.eventHash,
					},
				},
			}),
		);
		valueOf(
			await writeStopTombstone(context.sessionDirectory, {
				authorityId: context.authorityId,
				tenantId: context.tenantId,
				sessionId: context.sessionId,
				requestedBy: context.principalId,
				stopCursor: {
					stream: stopped.cursor.stream,
					sequence: stopped.cursor.sequence,
					eventId: stopped.cursor.eventId,
					eventHash: stopped.cursor.eventHash,
				},
				reasonDigest: canonicalDigest("operator stop"),
				writtenAt: "2026-07-22T00:00:01.000Z",
			}),
		);
		const decision = await recoverSession(options(context));
		expect(decision).toMatchObject({ kind: "stopped", reason: "stop_tombstone" });
	});

	it("treats a corrupt tombstone or mismatched stop cursor as corrupted", async () => {
		const context = await setup("corrupted");
		await writeFile(join(context.sessionDirectory, "stop.tombstone.json"), "{\"broken\":true}\n", "utf8");
		const decision = await recoverSession(options(context));
		expect(decision).toMatchObject({
			kind: "corrupted",
			error: { code: "corrupted_log", retryable: false },
		});
		expect(JSON.stringify(decision)).not.toContain("broken");
	});

	it("never resumes after a durable stop request even if the tombstone write crashed", async () => {
		const context = await setup("stop-request");
		const head = context.writer.currentHead();
		if (!head) throw new Error("missing fixture cursor");
		valueOf(
			await context.writer.append({
				type: "session.stop_requested",
				principalId: context.principalId,
				traceId: createRuntimeId("trace", "stop-request"),
				payload: {
					reason: "operator stop",
					requestedBy: context.principalId,
					expectedRevision: {
						stream: head.stream,
						sequence: head.sequence,
						eventHash: head.eventHash,
					},
				},
			}),
		);
		const decision = await recoverSession(options(context));
		expect(decision).toMatchObject({ kind: "stopped", reason: "durable_stop_requested" });
	});
});
