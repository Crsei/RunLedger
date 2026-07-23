import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { computeRuntimeEventHash, computeRuntimeEventPayloadDigest } from "../../../src/runtime/protocol/v3/event-hash.ts";
import {
	createSessionEventStreamRef,
	RUNTIME_SCHEMA_VERSION,
	type RuntimeEventEnvelopeV3,
} from "../../../src/runtime/protocol/v3/events.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/v3/ids.ts";
import { EventWriter } from "../../../src/runtime/session/event-writer.ts";
import {
	failLegacyMigrationTarget,
	inspectSessionVersionFence,
	LEGACY_IMPORTER_VERSION,
	LEGACY_MIGRATION_SCHEMA,
	migrateLegacySessionToV3,
	type LegacyMigrationMode,
} from "../../../src/runtime/session/legacy-migration.ts";
import { MemoryEventStore } from "../../../src/runtime/session/memory-event-store.ts";
import type { WriterFence } from "../../../src/runtime/session/types.ts";

const DIGEST = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const cleanup: string[] = [];

afterEach(async () => {
	await Promise.all(cleanup.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function fixture(name: "v1-basic.jsonl" | "v2-basic.jsonl"): string {
	return fileURLToPath(new URL(`../../fixtures/runtime-v3/legacy/${name}`, import.meta.url));
}

async function temporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "runledger-legacy-migration-"));
	cleanup.push(directory);
	return directory;
}

async function copyFixture(name: "v1-basic.jsonl" | "v2-basic.jsonl"): Promise<string> {
	const directory = await temporaryDirectory();
	const target = join(directory, name);
	await writeFile(target, await readFile(fixture(name)));
	return target;
}

function sha256(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function setupTarget(seed: string) {
	const authorityId = createRuntimeId("authority", seed);
	const tenantId = createRuntimeId("tenant", seed);
	const principalId = createRuntimeId("principal", seed);
	const targetSessionId = createRuntimeId("session", seed);
	const stream = createSessionEventStreamRef({ authorityId, tenantId }, targetSessionId);
	const fence: WriterFence = {
		authorityId,
		tenantId,
		stream,
		leaseId: createRuntimeId("lease", seed),
		ownerRuntimeId: createRuntimeId("runtime", seed),
		writerEpoch: 1,
		fencingToken: `fence-${seed}`,
	};
	const store = new MemoryEventStore({
		authorityId,
		tenantId,
		stream,
		validateFence: (candidate) =>
			candidate.writerEpoch === fence.writerEpoch && candidate.fencingToken === fence.fencingToken,
	});
	const writer = new EventWriter({
		authorityId,
		tenantId,
		stream,
		store,
		fence,
		clock: () => new Date("2026-07-22T00:00:00.000Z"),
	});
	return { authorityId, tenantId, principalId, targetSessionId, stream, fence, store, writer };
}

function migrationOptions(
	sourcePath: string,
	mode: LegacyMigrationMode,
	target: ReturnType<typeof setupTarget>,
) {
	return {
		sourcePath,
		mode,
		targetSessionId: target.targetSessionId,
		writer: target.writer,
		eventStore: target.store,
		principalId: target.principalId,
		traceId: createRuntimeId("trace", `migration-${mode}`),
		idempotencyKey: createRuntimeId("command", `migration-${mode}`),
	} as const;
}

describe("legacy v1/v2 to Runtime v3 migration core", () => {
	it("migrates v2 canonical messages and runtime config into a new, auditable v3 chain", async () => {
		const sourcePath = await copyFixture("v2-basic.jsonl");
		const before = await readFile(sourcePath);
		const target = setupTarget("v2-success");
		const result = await migrateLegacySessionToV3(migrationOptions(sourcePath, "migrate", target));

		expect(result.status).toBe("migrated");
		if (result.status !== "migrated") return;
		const headerEnd = before.indexOf(0x0a);
		expect(result.source).toEqual({
			sourceVersion: 2,
			sourceDigest: sha256(before),
			sourceSize: before.byteLength,
			headerDigest: sha256(before.subarray(0, headerEnd)),
			sourceSessionId: "legacy-v2-session",
		});
		expect(result.targetSessionId).toBe(target.targetSessionId);
		expect(result.targetSchemaVersion).toBe(RUNTIME_SCHEMA_VERSION);
		expect(result.importerVersion).toBe(LEGACY_IMPORTER_VERSION);
		expect(result.importSchema).toBe(LEGACY_MIGRATION_SCHEMA);
		expect(result.importedMessages).toHaveLength(3);
		expect(result.importedMessages[1]).toMatchObject({
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "reason", thinkingSignature: "signature" },
				{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "README.md" } },
			],
		});
		expect(result.configuration).toEqual({
			value: { provider: "fixture", model: "fixture-1", thinkingLevel: "high" },
			recoveredFields: ["runtimeConfig.model", "runtimeConfig.provider", "runtimeConfig.thinkingLevel"],
			lostFields: [],
		});
		expect(result.receipts).toHaveLength(3);
		expect(result.receipts.every((receipt) => receipt.disposition === "recovered")).toBe(true);
		expect(result.receipts[1]?.recoveredFields).toEqual(
			expect.arrayContaining(["schema", "content[].arguments", "content[].thinkingSignature"]),
		);
		expect(result.receipts.every((receipt) => receipt.lostFields.length === 0)).toBe(true);
		expect(result.omittedEntries).toEqual([
			expect.objectContaining({
				sourceEntryId: "v2-config",
				entryType: "custom",
				recoveredFields: ["runtimeConfig.model", "runtimeConfig.provider", "runtimeConfig.thinkingLevel"],
				lostFields: [],
			}),
		]);

		const page = await target.store.readPage(target.stream, { limit: 100 });
		expect(page.ok).toBe(true);
		if (!page.ok) return;
		expect(page.value.events.map((event) => event.type)).toEqual([
			"session.migration_started",
			"session.legacy_message_imported",
			"session.legacy_message_imported",
			"session.legacy_message_imported",
			"session.legacy_message_imported",
			"session.migration_committed",
		]);
		expect(page.value.events[0]).toMatchObject({
			schemaVersion: 3,
			stream: { scope: "session", sessionId: target.targetSessionId },
			payload: {
				sourceVersion: 2,
				sourceDigest: result.source.sourceDigest,
				sourceSize: result.source.sourceSize,
				headerDigest: result.source.headerDigest,
				importerVersion: LEGACY_IMPORTER_VERSION,
				importSchema: LEGACY_MIGRATION_SCHEMA,
				configurationJson: JSON.stringify({ model: "fixture-1", provider: "fixture", thinkingLevel: "high" }),
				configurationDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
				recoveredFields: expect.arrayContaining([
					"runtimeConfig.model",
					"runtimeConfig.provider",
					"runtimeConfig.thinkingLevel",
				]),
				expectedRecordCount: 4,
				manifestDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
			},
		});
		expect(page.value.events.at(-1)).toMatchObject({
			type: "session.migration_committed",
			payload: { importedRecordCount: 4, expectedRecordCount: 4 },
		});
		expect(
			page.value.events
				.filter((event) => event.type === "session.legacy_message_imported")
				.every((event) =>
					/^[a-f0-9]{64}$/.test(event.payload.sourceRecordDigest) &&
					event.payload.sourceEntryId.length > 0
				),
		).toBe(true);
		expect(page.value.events[4]).toMatchObject({
			type: "session.legacy_message_imported",
			payload: {
				sourceEntryId: "v2-config",
				entryType: "custom",
				messageKind: "non_message",
				disposition: "omitted",
			},
		});
		expect(await readFile(sourcePath)).toEqual(before);
	});

	it("fork-to-v3 recovers only safe v1 text and records omitted tool audit fields", async () => {
		const sourcePath = await copyFixture("v1-basic.jsonl");
		const before = await readFile(sourcePath);
		const target = setupTarget("v1-success");
		const result = await migrateLegacySessionToV3(migrationOptions(sourcePath, "fork-to-v3", target));

		expect(result.status).toBe("migrated");
		if (result.status !== "migrated") return;
		expect(result.mode).toBe("fork-to-v3");
		expect(result.importedMessages).toEqual([
			{ role: "user", content: [{ type: "text", text: "legacy text" }] },
			{ role: "assistant", content: [{ type: "text", text: "legacy assistant" }], stopReason: "toolUse" },
		]);
		expect(result.configuration.value).toEqual({});
		expect(result.receipts).toHaveLength(3);
		expect(result.receipts[1]).toMatchObject({
			messageKind: "assistant",
			disposition: "recovered",
			lostFields: ["content[].arguments", "content[].thinkingSignature", "schema"],
		});
		expect(result.receipts[2]).toMatchObject({
			messageKind: "toolResult",
			disposition: "omitted",
			recoveredFields: [],
			lostFields: ["content", "toolCallId", "toolName"],
		});
		expect(JSON.stringify(result.importedMessages)).not.toContain("unverifiable");
		expect(JSON.stringify(result.importedMessages)).not.toContain("must stay audit-only");
		expect(await readFile(sourcePath)).toEqual(before);
	});

	it("commits an empty but fully declared legacy source without inventing import records", async () => {
		const sourcePath = await copyFixture("v2-basic.jsonl");
		const header = (await readFile(sourcePath, "utf8")).split("\n")[0];
		if (!header) throw new Error("fixture header is missing");
		await writeFile(sourcePath, `${header}\n`, "utf8");
		const target = setupTarget("empty-import-set");

		const result = await migrateLegacySessionToV3(migrationOptions(sourcePath, "migrate", target));

		expect(result).toMatchObject({ status: "migrated", receipts: [], importedMessages: [] });
		const page = await target.store.readPage(target.stream, { limit: 100 });
		expect(page).toMatchObject({
			ok: true,
			value: {
				events: [
					{ type: "session.migration_started", payload: { expectedRecordCount: 0 } },
					{ type: "session.migration_committed", payload: { importedRecordCount: 0 } },
				],
			},
		});
	});

	it("fails closed on a malformed middle line before creating any target event", async () => {
		const sourcePath = await copyFixture("v2-basic.jsonl");
		const original = (await readFile(sourcePath, "utf8")).trimEnd().split("\n");
		original[2] = '{"broken":';
		await writeFile(sourcePath, `${original.join("\n")}\n`, "utf8");
		const before = await readFile(sourcePath);
		const target = setupTarget("middle-corruption");

		const result = await migrateLegacySessionToV3(migrationOptions(sourcePath, "migrate", target));

		expect(result).toMatchObject({
			status: "rejected",
			targetCreated: false,
			error: { code: "corrupted_log", line: 2 },
		});
		expect(target.writer.currentHead()).toBeUndefined();
		expect(await readFile(sourcePath)).toEqual(before);

		const malformedAndTorn = before.subarray(0, before.byteLength - 1);
		await writeFile(sourcePath, malformedAndTorn);
		const secondTarget = setupTarget("middle-corruption-torn-tail");
		const second = await migrateLegacySessionToV3(migrationOptions(sourcePath, "migrate", secondTarget));
		expect(second).toMatchObject({ status: "rejected", error: { code: "corrupted_log", line: 2 } });
		expect(secondTarget.writer.currentHead()).toBeUndefined();
	});

	it("returns an explicit forensic result for a torn tail and never truncates or imports it", async () => {
		const sourcePath = await copyFixture("v1-basic.jsonl");
		const complete = await readFile(sourcePath);
		const torn = complete.subarray(0, complete.byteLength - 1);
		await writeFile(sourcePath, torn);
		const target = setupTarget("torn-tail");

		const result = await migrateLegacySessionToV3(migrationOptions(sourcePath, "migrate", target));

		expect(result).toMatchObject({
			status: "forensic_required",
			targetCreated: false,
			report: {
				issue: "torn_tail",
				sourceDigest: sha256(torn),
				sourceSize: torn.byteLength,
				completeLineCount: 3,
				sourceVersion: 1,
			},
		});
		expect(target.writer.currentHead()).toBeUndefined();
		expect(await readFile(sourcePath)).toEqual(torn);
	});

	it("rejects a non-empty target before it reads or appends migration history", async () => {
		const sourcePath = await copyFixture("v1-basic.jsonl");
		const target = setupTarget("non-empty-target");
		const existing = await target.writer.append({
			type: "session.created",
			principalId: target.principalId,
			traceId: createRuntimeId("trace", "existing-target"),
			payload: {
				origin: "test",
				runtimeId: target.fence.ownerRuntimeId,
				featureDigest: DIGEST,
				initialGoalId: createRuntimeId("goal", "existing-target"),
				rootAgentId: createRuntimeId("agent", "existing-target"),
			},
		});
		expect(existing.ok).toBe(true);

		const result = await migrateLegacySessionToV3(migrationOptions(sourcePath, "migrate", target));

		expect(result).toMatchObject({ status: "partial", error: { code: "target_not_new" } });
		const page = await target.store.readPage(target.stream, { limit: 100 });
		expect(page).toMatchObject({ ok: true, value: { events: [{ type: "session.created" }] } });
	});

	it("reports a durable partial target when an import receipt append fails", async () => {
		const sourcePath = await copyFixture("v2-basic.jsonl");
		const originalSource = await readFile(sourcePath);
		const target = setupTarget("partial-target");
		const append = target.store.append.bind(target.store);
		let appendCount = 0;
		vi.spyOn(target.store, "append").mockImplementation((stream, event, expected, fence) => {
			appendCount += 1;
			if (appendCount === 2) {
				return Promise.resolve({
					ok: false,
					error: { code: "durable_write_failed", message: "injected receipt failure", retryable: false },
				});
			}
			return append(stream, event, expected, fence);
		});

		const result = await migrateLegacySessionToV3(migrationOptions(sourcePath, "migrate", target));

		expect(result).toMatchObject({
			status: "partial",
			targetSessionId: target.targetSessionId,
			head: { sequence: 0 },
			durableReceiptCount: 0,
			error: { code: "event_append_failed", cause: { code: "durable_write_failed" } },
		});
		const page = await target.store.readPage(target.stream, { limit: 100 });
		expect(page).toMatchObject({ ok: true, value: { events: [{ type: "session.migration_started" }] } });
		if (!page.ok) throw new Error(page.error.message);
		const partialPath = join(await temporaryDirectory(), "partial-v3.jsonl");
		await writeFile(partialPath, `${page.value.events.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");
		expect(await inspectSessionVersionFence(partialPath, "inspect")).toMatchObject({
			status: "allowed",
			format: "v3",
			readOnly: true,
		});
		expect(await inspectSessionVersionFence(partialPath, "append")).toMatchObject({
			status: "blocked",
			format: "v3",
			error: { code: "version_fenced" },
		});

		const resumedWriter = new EventWriter({
			authorityId: target.authorityId,
			tenantId: target.tenantId,
			stream: target.stream,
			store: target.store,
			fence: target.fence,
			initialHead: result.status === "partial" ? result.head : undefined,
			clock: () => new Date("2026-07-22T00:00:01.000Z"),
		});
		const wrongManifest = await migrateLegacySessionToV3({
			...migrationOptions(sourcePath, "fork-to-v3", target),
			writer: resumedWriter,
		});
		expect(wrongManifest).toMatchObject({
			status: "partial",
			head: { sequence: 0 },
			error: { code: "migration_manifest_conflict" },
		});
		await writeFile(
			sourcePath,
			originalSource.toString("utf8").replace("canonical user", "changed user"),
			"utf8",
		);
		const changedSource = await migrateLegacySessionToV3({
			...migrationOptions(sourcePath, "migrate", target),
			writer: resumedWriter,
		});
		expect(changedSource).toMatchObject({
			status: "partial",
			head: { sequence: 0 },
			error: { code: "migration_manifest_conflict" },
		});
		await writeFile(sourcePath, originalSource);
		const resumed = await migrateLegacySessionToV3({
			...migrationOptions(sourcePath, "migrate", target),
			writer: resumedWriter,
			idempotencyKey: createRuntimeId("command", "migration-resume"),
		});
		expect(resumed).toMatchObject({ status: "migrated", head: { sequence: 5 } });
		const completed = await target.store.readPage(target.stream, { limit: 100 });
		if (!completed.ok) throw new Error(completed.error.message);
		expect(completed.value.events.map((event) => event.type)).toEqual([
			"session.migration_started",
			"session.legacy_message_imported",
			"session.legacy_message_imported",
			"session.legacy_message_imported",
			"session.legacy_message_imported",
			"session.migration_committed",
		]);

		const retried = await migrateLegacySessionToV3({
			...migrationOptions(sourcePath, "migrate", target),
			writer: resumedWriter,
			idempotencyKey: createRuntimeId("command", "migration-retry-after-commit"),
		});
		expect(retried).toEqual(resumed);
		const unchanged = await target.store.readPage(target.stream, { limit: 100 });
		if (!unchanged.ok) throw new Error(unchanged.error.message);
		expect(unchanged.value.events).toHaveLength(6);
	});

	it("recovers an already durable commit after its flush acknowledgement is lost", async () => {
		const sourcePath = await copyFixture("v2-basic.jsonl");
		const target = setupTarget("commit-flush-uncertain");
		const flushThrough = target.store.flushThrough.bind(target.store);
		const flushSpy = vi.spyOn(target.store, "flushThrough").mockImplementationOnce(() => Promise.resolve({
			ok: false,
			error: { code: "durable_write_failed", message: "injected terminal flush failure", retryable: false },
		}));

		const uncertain = await migrateLegacySessionToV3(migrationOptions(sourcePath, "migrate", target));

		expect(uncertain).toMatchObject({
			status: "partial",
			// terminal append 已接受但 durable receipt 未返回，必须保留 uncertain terminal cursor。
			head: { sequence: 5 },
			durableReceiptCount: 4,
			error: { code: "event_append_failed", cause: { code: "durable_write_failed" } },
		});
		flushSpy.mockRestore();
		const uncertainHead = target.writer.currentHead();
		if (!uncertainHead) throw new Error("uncertain migration head is missing");
		await flushThrough(
			target.stream,
			{ ...uncertainHead, writerEpoch: target.fence.writerEpoch },
			target.fence,
		);
		const durable = await target.store.readPage(target.stream, { limit: 100 });
		if (!durable.ok) throw new Error(durable.error.message);
		const terminal = durable.value.events.at(-1);
		expect(terminal).toMatchObject({ type: "session.migration_committed", sequence: 5 });
		if (!terminal) throw new Error("durable migration terminal is missing");
		const reopenedWriter = new EventWriter({
			authorityId: target.authorityId,
			tenantId: target.tenantId,
			stream: target.stream,
			store: target.store,
			fence: target.fence,
			initialHead: {
				stream: terminal.stream,
				sequence: terminal.sequence,
				eventId: terminal.eventId,
				eventHash: terminal.currentEventHash,
			},
		});
		const recovered = await migrateLegacySessionToV3({
			...migrationOptions(sourcePath, "migrate", target),
			writer: reopenedWriter,
		});
		expect(recovered).toMatchObject({ status: "migrated", head: { sequence: 5 } });
		const unchanged = await target.store.readPage(target.stream, { limit: 100 });
		if (!unchanged.ok) throw new Error(unchanged.error.message);
		expect(unchanged.value.events).toHaveLength(6);
	});

	it("allows an explicit durable failure terminal and never resumes that target", async () => {
		const sourcePath = await copyFixture("v2-basic.jsonl");
		const target = setupTarget("failed-target");
		const append = target.store.append.bind(target.store);
		let appendCount = 0;
		const spy = vi.spyOn(target.store, "append").mockImplementation((stream, event, expected, fence) => {
			appendCount += 1;
			if (appendCount === 2) {
				return Promise.resolve({
					ok: false,
					error: { code: "durable_write_failed", message: "injected interruption", retryable: false },
				});
			}
			return append(stream, event, expected, fence);
		});
		const partial = await migrateLegacySessionToV3(migrationOptions(sourcePath, "migrate", target));
		expect(partial.status).toBe("partial");
		if (partial.status !== "partial") return;
		spy.mockRestore();

		const resumedWriter = new EventWriter({
			authorityId: target.authorityId,
			tenantId: target.tenantId,
			stream: target.stream,
			store: target.store,
			fence: target.fence,
			initialHead: partial.head,
		});
		const failureOptions = {
			writer: resumedWriter,
			eventStore: target.store,
			principalId: target.principalId,
			traceId: createRuntimeId("trace", "explicit-migration-failure"),
			reasonCode: "operator_abandoned",
			reason: "operator chose a new target",
		} as const;
		const flushSpy = vi.spyOn(target.store, "flushThrough").mockImplementationOnce(() => Promise.resolve({
			ok: false,
			error: { code: "durable_write_failed", message: "injected failure-terminal flush failure", retryable: false },
		}));
		const uncertainFailure = await failLegacyMigrationTarget(failureOptions);
		expect(uncertainFailure).toMatchObject({ ok: false, error: { code: "durable_write_failed" } });
		flushSpy.mockRestore();
		const durableFailure = await target.store.readPage(target.stream, { limit: 100 });
		if (!durableFailure.ok) throw new Error(durableFailure.error.message);
		const terminal = durableFailure.value.events.at(-1);
		expect(terminal).toMatchObject({ type: "session.migration_failed", sequence: 1 });
		if (!terminal) throw new Error("durable migration failure terminal is missing");
		const terminalWriter = new EventWriter({
			authorityId: target.authorityId,
			tenantId: target.tenantId,
			stream: target.stream,
			store: target.store,
			fence: target.fence,
			initialHead: {
				stream: terminal.stream,
				sequence: terminal.sequence,
				eventId: terminal.eventId,
				eventHash: terminal.currentEventHash,
			},
		});
		const failed = await failLegacyMigrationTarget({
			...failureOptions,
			writer: terminalWriter,
			traceId: createRuntimeId("trace", "explicit-migration-failure-recovery"),
		});
		expect(failed).toMatchObject({ ok: true, value: { head: { sequence: 1 }, importedRecordCount: 0 } });
		const repeatedFailure = await failLegacyMigrationTarget({
			...failureOptions,
			writer: terminalWriter,
			traceId: createRuntimeId("trace", "explicit-migration-failure-retry"),
		});
		expect(repeatedFailure).toEqual(failed);
		const conflictingFailure = await failLegacyMigrationTarget({
			...failureOptions,
			writer: terminalWriter,
			traceId: createRuntimeId("trace", "explicit-migration-failure-conflict"),
			reason: "different operator decision",
		});
		expect(conflictingFailure).toMatchObject({ ok: false, error: { code: "stopped" } });

		const retried = await migrateLegacySessionToV3({
			...migrationOptions(sourcePath, "migrate", target),
			writer: terminalWriter,
		});
		expect(retried).toMatchObject({
			status: "failed",
			head: { sequence: 1 },
			error: { code: "migration_already_failed" },
		});
		const page = await target.store.readPage(target.stream, { limit: 100 });
		expect(page).toMatchObject({
			ok: true,
			value: { events: [{ type: "session.migration_started" }, { type: "session.migration_failed" }] },
		});
	});
});

describe("legacy/v3 version fence", () => {
	it("allows legacy inspect/export/migration but blocks append and continue", async () => {
		const sourcePath = await copyFixture("v2-basic.jsonl");

		expect(await inspectSessionVersionFence(sourcePath, "inspect")).toMatchObject({
			status: "allowed",
			format: "legacy",
			sourceVersion: 2,
			readOnly: true,
		});
		expect(await inspectSessionVersionFence(sourcePath, "migrate")).toMatchObject({
			status: "allowed",
			format: "legacy",
			readOnly: true,
		});
		expect(await inspectSessionVersionFence(sourcePath, "continue")).toMatchObject({
			status: "blocked",
			format: "legacy",
			error: { code: "version_fenced" },
		});
		expect(await inspectSessionVersionFence(sourcePath, "append")).toMatchObject({
			status: "blocked",
			format: "legacy",
			error: { code: "version_fenced" },
		});
	});

	it("accepts current v3 for normal access, routes v3 forks elsewhere, and blocks unknown versions", async () => {
		const directory = await temporaryDirectory();
		const v3Path = join(directory, "events.jsonl");
		const authorityId = createRuntimeId("authority", "version-fence");
		const tenantId = createRuntimeId("tenant", "version-fence");
		const sessionId = createRuntimeId("session", "version-fence");
		const payload = {
			origin: "test" as const,
			runtimeId: createRuntimeId("runtime", "version-fence"),
			featureDigest: DIGEST,
			initialGoalId: createRuntimeId("goal", "version-fence"),
			rootAgentId: createRuntimeId("agent", "version-fence"),
		};
		const eventWithoutHash = {
			schemaVersion: RUNTIME_SCHEMA_VERSION,
			authorityId,
			tenantId,
			principalId: createRuntimeId("principal", "version-fence"),
			eventId: createRuntimeId("event", "version-fence"),
			stream: createSessionEventStreamRef({ authorityId, tenantId }, sessionId),
			sequence: 0,
			timestamp: "2026-07-22T00:00:00.000Z",
			type: "session.created" as const,
			previousEventHash: null,
			payloadDigest: computeRuntimeEventPayloadDigest(payload),
			traceId: createRuntimeId("trace", "version-fence"),
		};
		const event: RuntimeEventEnvelopeV3<"session.created"> = {
			...eventWithoutHash,
			currentEventHash: computeRuntimeEventHash(eventWithoutHash),
			payload,
		};
		await writeFile(v3Path, `${JSON.stringify(event)}\n`, "utf8");

		expect(await inspectSessionVersionFence(v3Path, "append")).toMatchObject({
			status: "allowed",
			format: "v3",
			schemaVersion: 3,
			readOnly: false,
		});
		expect(await inspectSessionVersionFence(v3Path, "fork-to-v3")).toMatchObject({
			status: "blocked",
			format: "v3",
			error: { code: "version_fenced" },
		});

		const futurePath = join(directory, "future.jsonl");
		await writeFile(
			futurePath,
			`${JSON.stringify({ type: "ledger", version: 4, id: "future", createdAt: 1, sessionId: "future" })}\n`,
			"utf8",
		);
		expect(await inspectSessionVersionFence(futurePath, "inspect")).toMatchObject({
			status: "blocked",
			format: "unknown",
			error: { code: "unsupported_version", observedVersion: 4 },
		});
	});
});
