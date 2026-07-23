import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalDigest } from "../../../src/runtime/protocol/v3/canonical-json.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/v3/ids.ts";
import {
	DurableTelemetryDeliveryService,
	FileTelemetrySpoolRepository,
	MemoryTelemetrySpoolRepository,
	telemetrySinkAckReceiptDigest,
	type TelemetryDeliveryCanonicalEventPort,
	type TelemetryDeliveryRecord,
	type TelemetryDeliveryRequest,
	type TelemetrySinkAckPort,
	type TelemetrySinkAckReceipt,
} from "../../../src/runtime/telemetry/durable-delivery.ts";
import {
	createTelemetryManifest,
	TELEMETRY_REQUIRED_EVENT_FIELDS,
	type TelemetryManifestExpectation,
} from "../../../src/runtime/telemetry/manifest.ts";
import { sanitizeTelemetryObservation } from "../../../src/runtime/telemetry/redaction.ts";

const roots: string[] = [];
const authorityId = createRuntimeId("authority", "durable-delivery");
const tenantId = createRuntimeId("tenant", "durable-delivery");
const sinkId = createRuntimeId("resource", "durable-sink");
const exporterId = createRuntimeId("resource", "durable-exporter");
const sinkIdentityDigest = canonicalDigest("durable-sink-identity");
const exporterIdentityDigest = canonicalDigest("durable-exporter-identity");
const redactionPolicyDigest = canonicalDigest("runledger-telemetry-metadata-v1");
const streamId = createRuntimeId("eventStream", "durable-delivery");
const eventHash = canonicalDigest("durable-delivery-event");
const now = new Date("2026-07-22T00:30:00.000Z");

function manifestFixture() {
	const fields = [
		...TELEMETRY_REQUIRED_EVENT_FIELDS,
		"event.sequence" as const,
		"event.hash" as const,
		"attribute.event.type" as const,
	];
	const created = createTelemetryManifest({
		authorityId,
		tenantId,
		runtimeGeneration: 2,
		redactionPolicyDigest,
		managedPolicyRef: null,
		eventFields: fields,
		activityFields: [],
		costFields: [],
		sinks: [{
			sinkId,
			channel: "siem",
			exporterIdentityDigest,
			fields,
			sampling: { kind: "always", numerator: 1, denominator: 1 },
			retentionDays: 7,
		}],
		metadataRetentionDays: 7,
		forensic: { enabled: false },
		issuedAt: "2026-07-22T00:00:00.000Z",
		expiresAt: "2026-07-22T01:00:00.000Z",
	});
	if (!created.ok) throw new Error(created.error.message);
	const expectation: TelemetryManifestExpectation = {
		authorityId,
		tenantId,
		runtimeGeneration: 2,
		redactionPolicyDigest,
		managedPolicyRef: null,
		exporterIdentities: [{ sinkId, channel: "siem", exporterIdentityDigest }],
	};
	return { manifest: created.value, expectation };
}

function request(): TelemetryDeliveryRequest {
	const { manifest, expectation } = manifestFixture();
	const sanitized = sanitizeTelemetryObservation({
		schemaVersion: 1,
		authorityId,
		tenantId,
		principalId: createRuntimeId("principal", "durable-delivery"),
		sessionId: createRuntimeId("session", "durable-delivery"),
		traceId: createRuntimeId("trace", "durable-delivery"),
		name: "runtime.turn.finished",
		severity: "info",
		observedAt: now.toISOString(),
		eventSequence: 4,
		eventHash,
		attributes: { "event.type": "turn.finished", prompt: "must-not-spool" },
	});
	if (!sanitized.ok) throw new Error(sanitized.error.message);
	return {
		schemaVersion: 2,
		authorityId,
		tenantId,
		deliveryId: createRuntimeId("receipt", "durable-delivery"),
		idempotencyKey: createRuntimeId("command", "durable-delivery"),
		manifest,
		manifestExpectation: expectation,
		sinkId,
		sinkIdentityDigest,
		exporterId,
		exporterIdentityDigest,
		eventRange: {
			streamId,
			fromSequence: 4,
			fromEventHash: eventHash,
			throughSequence: 4,
			throughEventHash: eventHash,
		},
		samples: [sanitized.value],
		enqueuedAt: now.toISOString(),
	};
}

function ack(record: TelemetryDeliveryRecord): TelemetrySinkAckReceipt {
	const body = {
		schemaVersion: 2 as const,
		authorityId: record.authorityId,
		tenantId: record.tenantId,
		deliveryId: record.deliveryId,
		receiptId: createRuntimeId("receipt", "durable-sink-ack"),
		idempotencyKey: record.idempotencyKey,
		manifestDigest: record.manifestDigest,
		batchDigest: record.batchDigest,
		eventRange: record.eventRange,
		sinkId: record.sinkId,
		sinkIdentityDigest: record.sinkIdentityDigest,
		exporterId: record.exporterId,
		exporterIdentityDigest: record.exporterIdentityDigest,
		attempt: record.attempt,
		acknowledgedAt: now.toISOString(),
	};
	return {
		...body,
		receiptDigest: telemetrySinkAckReceiptDigest(body),
	};
}

class Events implements TelemetryDeliveryCanonicalEventPort {
	public calls = 0;
	public failOnce = false;

	public async recordDelivery() {
		this.calls += 1;
		if (this.failOnce) {
			this.failOnce = false;
			return {
				ok: false as const,
				error: {
					code: "durable_write_failed" as const,
					message: "event ack lost",
					retryable: true,
				},
			};
		}
		return { ok: true as const, value: { eventDigest: canonicalDigest("delivery-event") } };
	}
}

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("durable telemetry delivery", () => {
	it("spools metadata before sink effect and accepts only a fully correlated terminal ack", async () => {
		const repository = new MemoryTelemetrySpoolRepository();
		const events = new Events();
		let calls = 0;
		const sink: TelemetrySinkAckPort = {
			idempotency: "supported",
			deliver: async (record) => {
				calls += 1;
				expect(await repository.load(record.authorityId, record.tenantId, record.deliveryId))
					.toMatchObject({ ok: true, value: { state: "delivery_pending", attempt: 1 } });
				expect(JSON.stringify(record.samples)).not.toContain("must-not-spool");
				return { ok: true, value: ack(record) };
			},
		};
		const service = new DurableTelemetryDeliveryService({
			repository,
			sink,
			events,
			clock: () => now,
		});
		const value = request();
		expect(await service.enqueue(value)).toMatchObject({ ok: true, value: { state: "spooled" } });
		expect(await service.deliver(authorityId, tenantId, value.deliveryId)).toMatchObject({
			ok: true,
			value: { state: "sink_acknowledged", canonicalEventDigest: canonicalDigest("delivery-event") },
		});
		expect(calls).toBe(1);
	});

	it("repairs canonical event ack loss without invoking the sink twice", async () => {
		const repository = new MemoryTelemetrySpoolRepository();
		const events = new Events();
		events.failOnce = true;
		let calls = 0;
		const sink: TelemetrySinkAckPort = {
			idempotency: "supported",
			deliver: async (record) => {
				calls += 1;
				return { ok: true, value: ack(record) };
			},
		};
		const service = new DurableTelemetryDeliveryService({ repository, sink, events, clock: () => now });
		const value = request();
		await service.enqueue(value);
		expect(await service.deliver(authorityId, tenantId, value.deliveryId))
			.toMatchObject({ ok: false, error: { code: "durable_write_failed" } });
		expect(await repository.load(authorityId, tenantId, value.deliveryId))
			.toMatchObject({ ok: true, value: { state: "sink_acknowledged", terminalReceipt: { attempt: 1 } } });
		expect(await service.deliver(authorityId, tenantId, value.deliveryId))
			.toMatchObject({ ok: true, value: { canonicalEventDigest: canonicalDigest("delivery-event") } });
		expect(calls).toBe(1);
		expect(events.calls).toBe(2);
	});

	it("quarantines unknown non-idempotent outcomes and rejects cross-tenant replay", async () => {
		const repository = new MemoryTelemetrySpoolRepository();
		const events = new Events();
		const sink: TelemetrySinkAckPort = {
			idempotency: "unsupported",
			deliver: async () => {
				throw new Error("ack lost");
			},
		};
		const service = new DurableTelemetryDeliveryService({ repository, sink, events, clock: () => now });
		const value = request();
		await service.enqueue(value);
		expect(await service.deliver(authorityId, tenantId, value.deliveryId))
			.toMatchObject({ ok: false, error: { code: "reconciliation_required" } });
		expect(await repository.load(authorityId, tenantId, value.deliveryId))
			.toMatchObject({ ok: true, value: { state: "reconciliation_required" } });
		expect(await service.deliver(authorityId, createRuntimeId("tenant", "foreign"), value.deliveryId))
			.toMatchObject({ ok: false });
	});

	it("replays a 0600 file spool and bounds item/byte capacity", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-telemetry-spool-"));
		roots.push(root);
		const repository = new FileTelemetrySpoolRepository(root, {
			maxItems: 1,
			maxBatchItems: 4,
			maxTotalBytes: 1024 * 1024,
		});
		const events = new Events();
		const sink: TelemetrySinkAckPort = {
			idempotency: "supported",
			deliver: async (record) => ({ ok: true, value: ack(record) }),
		};
		const service = new DurableTelemetryDeliveryService({ repository, sink, events, clock: () => now });
		const value = request();
		expect(await service.enqueue(value)).toMatchObject({ ok: true, value: { state: "spooled" } });
		const reopened = new FileTelemetrySpoolRepository(root, {
			maxItems: 1,
			maxBatchItems: 4,
			maxTotalBytes: 1024 * 1024,
		});
		expect(await reopened.load(authorityId, tenantId, value.deliveryId))
			.toMatchObject({ ok: true, value: { state: "spooled" } });
		const directories = await readdir(root);
		const files = (await readdir(join(root, directories[0]!))).map((file) => join(root, directories[0]!, file));
		expect(files).toHaveLength(1);
		expect((await stat(files[0]!)).mode & 0o777).toBe(0o600);

		const second = { ...request(), deliveryId: createRuntimeId("receipt", "durable-delivery-second") };
		const restarted = new DurableTelemetryDeliveryService({
			repository: reopened,
			sink,
			events,
			clock: () => now,
		});
		expect(await restarted.enqueue(second)).toMatchObject({ ok: false, error: { code: "spool_full" } });
		const original = await readFile(files[0]!, "utf8");
		await writeFile(files[0]!, `${original.slice(0, -1)}x`, { mode: 0o600 });
		expect(await reopened.load(authorityId, tenantId, value.deliveryId))
			.toMatchObject({ ok: false, error: { code: "corrupt_record" } });
	});
});
