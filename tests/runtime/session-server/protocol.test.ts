/**
 * R0 冻结的 session-scoped TCP protocol fixtures(替代 Host platform IPC)。
 *
 * 覆盖:protocol bounds、handshake request/response 的 typed fail-closed、
 * frame kinds/envelope、auth token 格式与 client identity。
 */

import { describe, expect, it } from "vitest";
import { Value } from "typebox/value";
import { createRuntimeId } from "../../../src/runtime/protocol/ids.ts";
import {
	SESSION_PROTOCOL_BOUNDS,
	SESSION_PROTOCOL_CAPABILITIES,
	SESSION_PROTOCOL_VERSION,
	SESSION_CORE_PROTOCOL_MANIFEST,
	SESSION_STATUSES,
	SessionFrameEnvelopeSchema,
	SessionHandshakeRequestSchema,
	SessionHandshakeResponseSchema,
	frameByteLength,
	handshakeMatchesFence,
} from "../../../src/runtime/session-server/protocol.ts";

const sessionId = () => createRuntimeId("session", "fixture");
const runtimeId = () => createRuntimeId("runtime", "fixture");

describe("R0 session-scoped protocol contracts", () => {
	it("freezes session-scoped bounds without host-wide capacity", () => {
		expect(SESSION_PROTOCOL_VERSION).toBe(3);
		expect(SESSION_PROTOCOL_CAPABILITIES).toContain("session.run-timing");
		expect(SESSION_CORE_PROTOCOL_MANIFEST.protocolCapabilities).toContain("session.run-timing");
		expect(SESSION_PROTOCOL_BOUNDS.maxFrameBytes).toBe(256 * 1024);
		expect(SESSION_PROTOCOL_BOUNDS.maxAckWindow).toBe(256);
		expect(SESSION_PROTOCOL_BOUNDS.maxSubscriptionReplay).toBe(2_048);
		expect(SESSION_PROTOCOL_BOUNDS.maxProcessesPerSession).toBe(32);
		expect("maxProcessesPerHost" in SESSION_PROTOCOL_BOUNDS).toBe(false);
		expect(SESSION_STATUSES).toEqual([
			"active",
			"recovery_required",
			"paused",
			"completed",
			"failed",
			"archived",
		]);
	});

	it("validates the handshake request and rejects wrong session/runtime/token shapes", () => {
		const request = {
			protocolVersion: SESSION_PROTOCOL_VERSION,
			sessionId: sessionId(),
			expectedRuntimeId: runtimeId(),
			expectedGeneration: 3,
			authToken: "a".repeat(64),
			clientId: "client_ui-a",
			clientCapabilities: ["snapshot", "subscription"],
		};
		expect(Value.Check(SessionHandshakeRequestSchema, request)).toBe(true);
		expect(Value.Check(SessionHandshakeRequestSchema, { ...request, expectedGeneration: 0 })).toBe(false);
		expect(Value.Check(SessionHandshakeRequestSchema, { ...request, authToken: "a".repeat(63) })).toBe(false);
		expect(Value.Check(SessionHandshakeRequestSchema, { ...request, authToken: "A".repeat(64) })).toBe(false);
		expect(Value.Check(SessionHandshakeRequestSchema, { ...request, authToken: "a".repeat(65) })).toBe(false);
		expect(Value.Check(SessionHandshakeRequestSchema, { ...request, pid: 42 })).toBe(false);
	});

	it("rejects a handshake whose session/runtime/generation does not match the owner fence", () => {
		const fence = { sessionId: sessionId(), runtimeId: runtimeId(), generation: 3 };
		const request = {
			protocolVersion: SESSION_PROTOCOL_VERSION,
			sessionId: sessionId(),
			expectedRuntimeId: runtimeId(),
			expectedGeneration: 3,
			authToken: "a".repeat(64),
			clientId: "client_ui-a",
			clientCapabilities: [],
		};
		expect(handshakeMatchesFence(request, fence)).toEqual({ ok: true });
		expect(handshakeMatchesFence({ ...request, sessionId: createRuntimeId("session", "other") }, fence)).toEqual({
			ok: false,
			code: "handshake_identity_mismatch",
		});
		expect(handshakeMatchesFence({ ...request, expectedRuntimeId: createRuntimeId("runtime", "other") }, fence)).toEqual({
			ok: false,
			code: "handshake_identity_mismatch",
		});
		expect(handshakeMatchesFence({ ...request, expectedGeneration: 2 }, fence)).toEqual({
			ok: false,
			code: "handshake_identity_mismatch",
		});
	});

	it("validates accepted handshake response and typed rejection codes", () => {
		const accepted = {
			accepted: true,
			runtimeId: runtimeId(),
			generation: 3,
			protocolCapabilities: ["session.core", "session.security.inspect"],
			operationManifest: [
				{ operation: "session.snapshot", capability: "session.core", access: "read" },
				{ operation: "security.inspect", capability: "session.security.inspect", access: "read" },
			],
			snapshotCursor: 41,
			driverRevision: 0,
			sessionStatus: "active",
		};
		expect(Value.Check(SessionHandshakeResponseSchema, accepted)).toBe(true);
		expect(Value.Check(SessionHandshakeResponseSchema, {
			...accepted,
			protocolCapabilities: ["session.core", "made-up-capability"],
		})).toBe(false);
		expect(Value.Check(SessionHandshakeResponseSchema, {
			...accepted,
			operationManifest: [{ operation: "security.inspect", capability: "session.security.inspect", access: "execute" }],
		})).toBe(false);
		expect(Value.Check(SessionHandshakeResponseSchema, { accepted: false, code: "handshake_token_mismatch" })).toBe(true);
		expect(Value.Check(SessionHandshakeResponseSchema, { accepted: false, code: "owner_starting" })).toBe(true);
		expect(Value.Check(SessionHandshakeResponseSchema, { accepted: false, code: "session_owner_incompatible" })).toBe(true);
		expect(Value.Check(SessionHandshakeResponseSchema, { accepted: false, code: "unknown" })).toBe(false);
		expect(Value.Check(SessionHandshakeResponseSchema, { accepted: true, runtimeId: runtimeId(), generation: 3, driverRevision: 0, sessionStatus: "paused" })).toBe(false);
	});

	it("freezes frame kinds and rejects unknown or oversized frames", () => {
		const envelope = {
			frameId: "frame-fixture",
			kind: "initialize_request",
			protocolVersion: SESSION_PROTOCOL_VERSION,
			body: {},
		};
		expect(Value.Check(SessionFrameEnvelopeSchema, envelope)).toBe(true);
		expect(Value.Check(SessionFrameEnvelopeSchema, { ...envelope, kind: "machine_election" })).toBe(false);
		expect(frameByteLength({ ...envelope, body: { payload: "x".repeat(SESSION_PROTOCOL_BOUNDS.maxFrameBytes + 1) } }))
			.toBeGreaterThan(SESSION_PROTOCOL_BOUNDS.maxFrameBytes);
		expect(frameByteLength(envelope)).toBeLessThanOrEqual(SESSION_PROTOCOL_BOUNDS.maxInitializeFrameBytes);
	});
});
