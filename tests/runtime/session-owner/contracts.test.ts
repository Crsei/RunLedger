/**
 * R0 冻结的 Session Owner 唯一 public owner contract fixtures。
 *
 * 覆盖:SessionOwnerRecord / OwnerFence / OwnerEndpoint、claim/heartbeat CAS
 * 结果、owner/driver/recovery 事件 payload、command intent + attempt receipt、
 * checkpoint cache descriptor、typed error codes 与 authToken 禁止项。
 */

import { describe, expect, it } from "vitest";
import { Value } from "typebox/value";
import { createRuntimeId } from "../../../src/runtime/protocol/ids.ts";
import type { RuntimeDigest } from "../../../src/runtime/protocol/foundation.ts";
import {
	COMMAND_ATTEMPT_OUTCOMES,
	COMMAND_EFFECT_CLASSES,
	OWNER_RELEASE_REASONS,
	SESSION_CHECKPOINT_BOUNDARIES,
	SESSION_OWNER_AUTH_TOKEN_BYTES,
	SESSION_OWNER_ERROR_CODES,
	SESSION_OWNER_EVENT_TYPES,
	SESSION_OWNER_HEARTBEAT_PARAMS,
	SESSION_OWNER_PROTOCOL_VERSION,
	SESSION_OWNER_STATES,
	SESSION_STORE_SCHEMA_CURRENT,
	SESSION_STORE_SCHEMA_MAX,
	SESSION_STORE_SCHEMA_MIN,
} from "../../../src/runtime/session-owner/types.ts";
import {
	CommandAttemptReceiptSchema,
	CommandIntentSchema,
	OwnerClaimResultSchema,
	OwnerEndpointSchema,
	OwnerHeartbeatResultSchema,
	OwnerFenceSchema,
	SessionCheckpointDescriptorSchema,
	SessionOwnerEventPayloadSchema,
	SessionOwnerRecordSchema,
	isCommandAttemptReceipt,
} from "../../../src/runtime/session-owner/schemas.ts";

const digest = (seed: string): RuntimeDigest => ({
	algorithm: "sha256",
	digest: seed.repeat(64).slice(0, 64) as RuntimeDigest["digest"],
});

const sessionId = () => createRuntimeId("session", "fixture");
const runtimeId = () => createRuntimeId("runtime", "fixture");

describe("R0 Session Owner exact contracts", () => {
	it("freezes protocol version, bounded params and typed error codes", () => {
		expect(SESSION_OWNER_PROTOCOL_VERSION).toBe(1);
		expect(SESSION_OWNER_AUTH_TOKEN_BYTES).toBe(32);
		expect(SESSION_OWNER_STATES).toEqual(["unowned", "starting", "recovery_required", "running", "stopping"]);
		expect(SESSION_OWNER_HEARTBEAT_PARAMS).toMatchObject({
			heartbeatIntervalMs: 3_000,
			staleThresholdMs: 20_000,
			connectTimeoutMs: 1_000,
			startupGraceMs: 20_000,
			takeoverProbes: 3,
			probeSpacingMinMs: 250,
		});
		expect(SESSION_OWNER_ERROR_CODES).toContain("owner_fenced");
		expect(SESSION_OWNER_ERROR_CODES).toContain("owner_store_busy");
		expect(SESSION_OWNER_ERROR_CODES).toContain("store_schema_too_new");
		expect(SESSION_OWNER_ERROR_CODES).toContain("upgrade_requires_sessions_closed");
		expect(SESSION_OWNER_ERROR_CODES).toContain("session_owner_incompatible");
		expect(SESSION_OWNER_ERROR_CODES).toContain("legacy_host_active");
		expect(SESSION_OWNER_ERROR_CODES).toContain("recovery_barrier_active");
		expect(SESSION_STORE_SCHEMA_MIN).toBe(1);
		expect(SESSION_STORE_SCHEMA_MAX).toBe(SESSION_STORE_SCHEMA_CURRENT);
	});

	it("validates a canonical running owner record and rejects forbidden fields", () => {
		const record = {
			sessionId: sessionId(),
			runtimeId: runtimeId(),
			generation: 3,
			state: "running",
			endpoint: { host: "127.0.0.1", port: 45783 },
			heartbeatAtMs: 1_752_000_000_000,
			ownerStartedAtMs: 1_751_999_000_000,
			updatedAtMs: 1_752_000_000_000,
		};
		expect(Value.Check(SessionOwnerRecordSchema, record)).toBe(true);
		expect(Value.Check(SessionOwnerRecordSchema, { ...record, generation: 0 })).toBe(false);
		expect(Value.Check(SessionOwnerRecordSchema, { ...record, state: "running_extra" })).toBe(false);
		expect(Value.Check(SessionOwnerRecordSchema, { ...record, authToken: "a".repeat(64) })).toBe(false);
		expect(Value.Check(SessionOwnerRecordSchema, { ...record, endpoint: { host: "0.0.0.0", port: 45783 } })).toBe(false);
		expect(Value.Check(SessionOwnerRecordSchema, { ...record, endpoint: { host: "127.0.0.1", port: 0 } })).toBe(false);
		expect(Value.Check(SessionOwnerRecordSchema, { ...record, endpoint: { host: "127.0.0.1", port: 65_536 } })).toBe(false);
	});

	it("validates OwnerFence and rejects cross-session or stale generation fences", () => {
		const fence = { sessionId: sessionId(), runtimeId: runtimeId(), generation: 2 };
		expect(Value.Check(OwnerFenceSchema, fence)).toBe(true);
		expect(Value.Check(OwnerFenceSchema, { ...fence, sessionId: createRuntimeId("session", "other") })).toBe(true);
		expect(Value.Check(OwnerFenceSchema, { ...fence, generation: 1.5 })).toBe(false);
		expect(Value.Check(OwnerFenceSchema, { ...fence, generation: 0 })).toBe(false);
		expect(Value.Check(OwnerFenceSchema, { ...fence, runtimeId: createRuntimeId("workspace", "wrong-kind") })).toBe(false);
	});

	it("freezes the loopback-only endpoint contract", () => {
		expect(Value.Check(OwnerEndpointSchema, { host: "127.0.0.1", port: 1 })).toBe(true);
		expect(Value.Check(OwnerEndpointSchema, { host: "127.0.0.1", port: 65_535 })).toBe(true);
		expect(Value.Check(OwnerEndpointSchema, { host: "127.0.0.1", port: 0 })).toBe(false);
		expect(Value.Check(OwnerEndpointSchema, { host: "localhost", port: 4000 })).toBe(false);
		expect(Value.Check(OwnerEndpointSchema, { host: "127.0.0.1", port: 40_000, pid: 42 })).toBe(false);
	});

	it("validates claim and heartbeat CAS results with typed failures", () => {
		const claimed = {
			ok: true,
			outcome: "claimed",
			fence: { sessionId: sessionId(), runtimeId: runtimeId(), generation: 1 },
			endpoint: { host: "127.0.0.1", port: 40_000 },
		};
		expect(Value.Check(OwnerClaimResultSchema, claimed)).toBe(true);
		expect(Value.Check(OwnerClaimResultSchema, { ok: false, code: "owner_store_busy", retryable: true })).toBe(true);
		expect(Value.Check(OwnerClaimResultSchema, { ok: false, code: "owner_fenced", retryable: true })).toBe(true);
		expect(Value.Check(OwnerClaimResultSchema, { ok: false, code: "unknown_code", retryable: false })).toBe(false);

		const heartbeatOk = { ok: true, heartbeatAtMs: 1_752_000_000_000 };
		expect(Value.Check(OwnerHeartbeatResultSchema, heartbeatOk)).toBe(true);
		expect(Value.Check(OwnerHeartbeatResultSchema, { ok: false, code: "owner_fenced" })).toBe(true);
		expect(Value.Check(OwnerHeartbeatResultSchema, { ok: false, code: "store_schema_too_new" })).toBe(false);
	});

	it("freezes the owner/driver/recovery event catalog with bounded payloads", () => {
		expect(SESSION_OWNER_EVENT_TYPES).toContain("owner.claimed");
		expect(SESSION_OWNER_EVENT_TYPES).toContain("owner.taken_over");
		expect(SESSION_OWNER_EVENT_TYPES).toContain("owner.released");
		expect(SESSION_OWNER_EVENT_TYPES).toContain("owner.fenced");
		expect(SESSION_OWNER_EVENT_TYPES).toContain("driver.claimed");
		expect(SESSION_OWNER_EVENT_TYPES).toContain("driver.released");
		expect(SESSION_OWNER_EVENT_TYPES).toContain("driver.reset_on_takeover");
		expect(SESSION_OWNER_EVENT_TYPES).toContain("recovery.verified_clean");
		expect(SESSION_OWNER_EVENT_TYPES).toContain("recovery.verify");
		expect(SESSION_OWNER_EVENT_TYPES).toContain("recovery.abort");
		expect(SESSION_OWNER_EVENT_TYPES).toContain("recovery.resume_despite_uncertainty");
		expect(OWNER_RELEASE_REASONS).toEqual(["paused", "detached", "error", "fenced"]);
	});

	it("validates representative owner event payloads and rejects secrets", () => {
		const claimed = {
			eventId: createRuntimeId("event", "claimed"),
			sessionId: sessionId(),
			runtimeId: runtimeId(),
			generation: 1,
			port: 40_000,
			ownerStartedAtMs: 1_751_999_000_000,
		};
		expect(Value.Check(SessionOwnerEventPayloadSchema, claimed)).toBe(true);
		expect(Value.Check(SessionOwnerEventPayloadSchema, { ...claimed, authToken: "a".repeat(64) })).toBe(false);

		const takenOver = {
			eventId: createRuntimeId("event", "takeover"),
			sessionId: sessionId(),
			runtimeId: runtimeId(),
			priorGeneration: 1,
			generation: 2,
			port: 40_001,
		};
		expect(Value.Check(SessionOwnerEventPayloadSchema, takenOver)).toBe(true);

		const resume = {
			eventId: createRuntimeId("event", "resume"),
			sessionId: sessionId(),
			runtimeId: runtimeId(),
			generation: 2,
			principalId: createRuntimeId("principal", "operator"),
			reasonCode: "user-accepted-uncertainty",
			originGeneration: 1,
			settledGeneration: 2,
			evidenceDigest: digest("cafe"),
		};
		expect(Value.Check(SessionOwnerEventPayloadSchema, resume)).toBe(true);

		const driver = {
			eventId: createRuntimeId("event", "driver"),
			sessionId: sessionId(),
			runtimeId: runtimeId(),
			generation: 2,
			connectionId: createRuntimeId("connection", "a"),
			driverRevision: 4,
		};
		expect(Value.Check(SessionOwnerEventPayloadSchema, driver)).toBe(true);
		expect(Value.Check(SessionOwnerEventPayloadSchema, { ...driver, driverRevision: -1 })).toBe(false);
	});

	it("freezes command intent and append-only attempt receipts with origin/settled generations", () => {
		const intent = {
			sessionId: sessionId(),
			commandId: createRuntimeId("command", "fixture"),
			requestDigest: digest("abcd"),
			originGeneration: 2,
			createdAtMs: 1_752_000_000_000,
		};
		expect(Value.Check(CommandIntentSchema, intent)).toBe(true);
		expect(Value.Check(CommandIntentSchema, { ...intent, originGeneration: 0 })).toBe(false);

		expect(COMMAND_ATTEMPT_OUTCOMES).toEqual(["started", "committed", "rejected", "interrupted", "uncertain", "verified"]);
		expect(COMMAND_EFFECT_CLASSES).toContain("readonly");
		expect(COMMAND_EFFECT_CLASSES).toContain("external_mutation");

		const receipt = {
			receiptId: createRuntimeId("receipt", "fixture"),
			sessionId: sessionId(),
			commandId: createRuntimeId("command", "fixture"),
			attemptId: createRuntimeId("attempt", "fixture"),
			originGeneration: 2,
			settledGeneration: 3,
			effectClass: "workspace_mutation",
			outcome: "uncertain",
			resultDigest: digest("beef"),
			evidenceDigest: digest("cafe"),
			createdAtMs: 1_752_000_000_000,
		};
		expect(Value.Check(CommandAttemptReceiptSchema, receipt)).toBe(true);
		expect(Value.Check(CommandAttemptReceiptSchema, { ...receipt, outcome: "guessed" })).toBe(false);
		expect(isCommandAttemptReceipt(receipt)).toBe(true);
		expect(isCommandAttemptReceipt({ ...receipt, outcome: "committed", settledGeneration: 1 })).toBe(false);
	});

	it("freezes checkpoint cache boundaries and digest binding", () => {
		expect(SESSION_CHECKPOINT_BOUNDARIES).toEqual([
			"before_model",
			"after_model",
			"before_tool",
			"after_tool",
			"turn_completed",
			"paused",
		]);
		const checkpoint = {
			checkpointId: createRuntimeId("snapshot", "fixture"),
			sessionId: sessionId(),
			ownerGeneration: 3,
			boundary: "turn_completed",
			sourceSequence: 41,
			snapshotDigest: digest("1a2b"),
			createdAtMs: 1_752_000_000_000,
		};
		expect(Value.Check(SessionCheckpointDescriptorSchema, checkpoint)).toBe(true);
		expect(Value.Check(SessionCheckpointDescriptorSchema, { ...checkpoint, boundary: "before_process" })).toBe(false);
		expect(Value.Check(SessionCheckpointDescriptorSchema, { ...checkpoint, snapshotJson: "{}" })).toBe(false);
	});
});
