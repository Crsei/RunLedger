import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalJson } from "../../../src/runtime/protocol/v3/canonical-json.ts";
import { createSessionEventStreamRef } from "../../../src/runtime/protocol/v3/events.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/v3/ids.ts";
import { EventWriter } from "../../../src/runtime/session/event-writer.ts";
import { MemoryEventStore } from "../../../src/runtime/session/memory-event-store.ts";
import { reduceSessionEvents } from "../../../src/runtime/session/reducer.ts";
import {
	createForensicSalvageForkPlan,
	inspectEventLogForSalvage,
	validateForensicSalvageReport,
} from "../../../src/runtime/session/salvage.ts";
import { readAllRuntimeEvents } from "../../../src/runtime/session/snapshot.ts";
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

async function fixture(seed: string) {
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
	const committed = valueOf(
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
	const root = await mkdtemp(join(tmpdir(), "runledger-salvage-"));
	roots.push(root);
	const filePath = join(root, "events.jsonl");
	return { authorityId, tenantId, principalId, sessionId, stream, runtimeId, committed, filePath };
}

describe("forensic salvage", () => {
	it("reads a trusted prefix without changing the source and writes repair events only to a distinct child session", async () => {
		const source = await fixture("salvage");
		await writeFile(source.filePath, `${canonicalJson(source.committed.event)}\n{\"partial\"`, { mode: 0o600 });
		const before = await readFile(source.filePath);
		const inspection = valueOf(
			await inspectEventLogForSalvage({
				filePath: source.filePath,
				scope: {
					authorityId: source.authorityId,
					tenantId: source.tenantId,
					stream: source.stream,
				},
				reportArtifactId: createRuntimeId("artifact", "salvage-report"),
				generatedAt: "2026-07-22T00:00:01.000Z",
			}),
		);
		expect(inspection.report).toMatchObject({
			outcome: "verified_prefix_available",
			verifiedPrefixCount: 1,
			failure: { code: "torn_tail", line: 1, tornTail: true },
			readOnly: true,
		});
		expect(validateForensicSalvageReport(inspection.report)).toBe(true);

		const newSessionId = createRuntimeId("session", "salvaged-child");
		const sourceProjection = valueOf(reduceSessionEvents(inspection.verifiedPrefix));
		const plan = valueOf(
			createForensicSalvageForkPlan(inspection, {
				newSessionId,
				parentLeafId: sourceProjection.activeLeafId,
				goalMode: "continue_existing_goal",
				initialGoalId: sourceProjection.genesis.initialGoalId,
				rootAgentId: createRuntimeId("agent", "salvaged-child"),
				idempotencyKey: createRuntimeId("command", "salvage"),
				principalId: source.principalId,
				forkTraceId: createRuntimeId("trace", "salvage-fork"),
				repairTraceId: createRuntimeId("trace", "salvage-report"),
			}),
		);
		expect(plan).toMatchObject({
			sourceSessionId: source.sessionId,
			newSessionId,
			sourceWasModified: false,
			genesisDraft: { type: "session.forked" },
			repairDraft: { type: "session.repair_reported", payload: { outcome: "salvaged" } },
		});

		const childFence: WriterFence = {
			authorityId: source.authorityId,
			tenantId: source.tenantId,
			stream: createSessionEventStreamRef(
				{ authorityId: source.authorityId, tenantId: source.tenantId },
				newSessionId,
			),
			leaseId: createRuntimeId("lease", "salvaged-child"),
			ownerRuntimeId: source.runtimeId,
			writerEpoch: 1,
			fencingToken: "salvaged-child-fence",
		};
		const childStore = new MemoryEventStore({
			authorityId: source.authorityId,
			tenantId: source.tenantId,
			stream: childFence.stream,
			validateFence: () => true,
		});
		const childWriter = new EventWriter({
			authorityId: source.authorityId,
			tenantId: source.tenantId,
			stream: childFence.stream,
			store: childStore,
			fence: childFence,
			clock: () => new Date("2026-07-22T00:00:02.000Z"),
		});
		valueOf(await childWriter.append(plan.genesisDraft));
		valueOf(await childWriter.append(plan.repairDraft));
		expect(valueOf(await readAllRuntimeEvents(childStore)).map((event) => event.type)).toEqual([
			"session.forked",
			"session.repair_reported",
		]);
		expect(await readFile(source.filePath)).toEqual(before);
	});

	it("locates middle corruption but never skips it", async () => {
		const source = await fixture("middle");
		const firstLine = `${canonicalJson(source.committed.event)}\n`;
		await writeFile(source.filePath, `${firstLine}{\"broken\":}\n${firstLine}`, { mode: 0o600 });
		const inspection = valueOf(
			await inspectEventLogForSalvage({
				filePath: source.filePath,
				scope: {
					authorityId: source.authorityId,
					tenantId: source.tenantId,
					stream: source.stream,
				},
				reportArtifactId: createRuntimeId("artifact", "middle-report"),
				generatedAt: "2026-07-22T00:00:01.000Z",
			}),
		);
		expect(inspection.verifiedPrefix).toHaveLength(1);
		expect(inspection.report.failure).toMatchObject({
			code: "corrupted_log",
			line: 1,
			byteOffset: Buffer.byteLength(firstLine),
		});
	});

	it("marks a source with no verified event as unrecoverable and refuses an in-place repair plan", async () => {
		const source = await fixture("unrecoverable");
		await writeFile(source.filePath, "{\"partial\"", { mode: 0o600 });
		const inspection = valueOf(
			await inspectEventLogForSalvage({
				filePath: source.filePath,
				scope: {
					authorityId: source.authorityId,
					tenantId: source.tenantId,
					stream: source.stream,
				},
				reportArtifactId: createRuntimeId("artifact", "unrecoverable-report"),
				generatedAt: "2026-07-22T00:00:01.000Z",
			}),
		);
		expect(inspection.report.outcome).toBe("unrecoverable");
		expect(
			createForensicSalvageForkPlan(inspection, {
				newSessionId: createRuntimeId("session", "unrecoverable-child"),
				parentLeafId: createRuntimeId("leaf", "unrecoverable"),
				goalMode: "create_child_goal",
				initialGoalId: createRuntimeId("goal", "unrecoverable-child"),
				rootAgentId: createRuntimeId("agent", "unrecoverable-child"),
				idempotencyKey: createRuntimeId("command", "unrecoverable"),
				principalId: source.principalId,
				forkTraceId: createRuntimeId("trace", "unrecoverable-fork"),
				repairTraceId: createRuntimeId("trace", "unrecoverable-report"),
			}),
		).toMatchObject({ ok: false, error: { code: "corrupted_log" } });
	});

	it("reports a fully valid source as requiring no repair", async () => {
		const source = await fixture("valid");
		await writeFile(source.filePath, `${canonicalJson(source.committed.event)}\n`, { mode: 0o600 });
		const inspection = valueOf(
			await inspectEventLogForSalvage({
				filePath: source.filePath,
				scope: {
					authorityId: source.authorityId,
					tenantId: source.tenantId,
					stream: source.stream,
				},
				reportArtifactId: createRuntimeId("artifact", "valid-report"),
				generatedAt: "2026-07-22T00:00:01.000Z",
			}),
		);
		expect(inspection.report).toMatchObject({
			outcome: "no_repair_needed",
			verifiedPrefixCount: 1,
			failure: null,
		});
	});
});
