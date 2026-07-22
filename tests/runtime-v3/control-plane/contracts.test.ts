import { describe, expect, it } from "vitest";
import { canonicalDigest } from "../../../src/runtime/protocol/v3/canonical-json.ts";
import { createIdempotencyKey } from "../../../src/runtime/protocol/v3/coordination.ts";
import { createSessionEventStreamRef } from "../../../src/runtime/protocol/v3/events.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/v3/ids.ts";
import { negotiateControlPlaneHandshake } from "../../../src/runtime/control-plane/handshake.ts";
import { StrictJsonlFrameParser, parseJsonlDocument } from "../../../src/runtime/control-plane/jsonl-transport.ts";
import { LocalPeerIdentityResolver } from "../../../src/runtime/control-plane/local-peer.ts";
import { SseAdapterContract, validateLocalSseBindTarget } from "../../../src/runtime/control-plane/sse-transport.ts";
import {
	validateControlPlaneCommand,
	validateControlPlaneHello,
	type ControlPlaneClientHello,
	type TurnStartCommand,
} from "../../../src/runtime/control-plane/types.ts";

const AUTHORITY_ID = createRuntimeId("authority", "control-plane");
const TENANT_ID = createRuntimeId("tenant", "control-plane");
const PRINCIPAL_ID = createRuntimeId("principal", "control-plane");
const SESSION_ID = createRuntimeId("session", "control-plane");
const TURN_ID = createRuntimeId("turn", "control-plane");
const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);
const STREAM = createSessionEventStreamRef({ authorityId: AUTHORITY_ID, tenantId: TENANT_ID }, SESSION_ID);

function hello(overrides: Partial<ControlPlaneClientHello> = {}): ControlPlaneClientHello {
	return {
		kind: "handshake",
		requestId: "hello-1",
		clientName: "contract-test",
		clientVersion: "1.0.0",
		protocol: { major: 1, minMinor: 0, maxMinor: 0 },
		controlPlaneSchemaVersions: [1],
		runtimeSchemaVersions: [3],
		requestedFeatures: ["session", "turn", "health"],
		requiredFeatures: ["session"],
		transport: "jsonl",
		...overrides,
	};
}

function turnStart(): TurnStartCommand {
	const text = "do the bounded thing";
	return {
		kind: "command",
		type: "turn:start",
		commandId: createRuntimeId("command", "turn-start"),
		idempotencyKey: createIdempotencyKey("turn-start-key-0001"),
		authorityId: AUTHORITY_ID,
		tenantId: TENANT_ID,
		principalId: PRINCIPAL_ID,
		expectedSessionRevision: { stream: STREAM, sequence: 3, eventHash: DIGEST_A },
		expectedTurnId: null,
		sessionHandle: { handleId: "handle_0123456789abcdef", sessionId: SESSION_ID, generation: 1 },
		payload: {
			sessionId: SESSION_ID,
			prompt: { storage: "bounded_text", text, contentDigest: canonicalDigest({ storage: "bounded_text", text }) },
		},
	};
}

describe("Control Plane exact contracts and handshake", () => {
	it("rejects unknown command fields and mismatched prompt/revision semantics", () => {
		const command = turnStart();
		expect(validateControlPlaneCommand(command).ok).toBe(true);
		expect(validateControlPlaneCommand({ ...command, policy: "allow-all" })).toMatchObject({ ok: false });
		expect(
			validateControlPlaneCommand({
				...command,
				payload: { ...command.payload, prompt: { ...command.payload.prompt, contentDigest: DIGEST_B } },
			}),
		).toMatchObject({ ok: false, error: { code: "invalid_request" } });
		expect(validateControlPlaneCommand({ ...command, expectedTurnId: TURN_ID })).toMatchObject({
			ok: false,
			error: { code: "invalid_request" },
		});
	});

	it("negotiates the highest overlapping protocol/schema/features and returns typed incompatibility", () => {
		expect(validateControlPlaneHello(hello()).ok).toBe(true);
		const negotiated = negotiateControlPlaneHandshake(hello(), {
			serverInstanceId: createRuntimeId("runtime", "daemon"),
			features: ["session", "health"],
		});
		expect(negotiated).toMatchObject({
			ok: true,
			value: { protocol: { major: 1, minor: 0 }, controlPlaneSchemaVersion: 1, runtimeSchemaVersion: 3, features: ["session", "health"] },
		});
		expect(
			negotiateControlPlaneHandshake(hello({ protocol: { major: 2, minMinor: 0, maxMinor: 0 } }), {
				serverInstanceId: createRuntimeId("runtime", "daemon"),
			}),
		).toMatchObject({ ok: false, error: { code: "unsupported_protocol" } });
		expect(
			negotiateControlPlaneHandshake(hello({ runtimeSchemaVersions: [4] }), {
				serverInstanceId: createRuntimeId("runtime", "daemon"),
			}),
		).toMatchObject({ ok: false, error: { code: "unsupported_schema" } });
		expect(
			negotiateControlPlaneHandshake(hello({ controlPlaneSchemaVersions: [2] }), {
				serverInstanceId: createRuntimeId("runtime", "daemon"),
			}),
		).toMatchObject({ ok: false, error: { code: "unsupported_schema" } });
	});
});

describe("strict local transports", () => {
	it("accepts LF, CRLF, chunking and a final unterminated line", () => {
		const parser = new StrictJsonlFrameParser();
		expect(parser.push('{"one":1}\r\n{"tw')).toMatchObject({ ok: true, value: [{ one: 1 }] });
		expect(parser.push('o":2}\n{"three":3}')).toMatchObject({ ok: true, value: [{ two: 2 }] });
		expect(parser.finish()).toMatchObject({ ok: true, value: [{ three: 3 }] });
		expect(parseJsonlDocument('{"one":1}\n\n')).toMatchObject({ ok: false, error: { code: "malformed_frame" } });
		expect(parseJsonlDocument("not-json")).toMatchObject({ ok: false, error: { code: "malformed_frame" } });
	});

	it("enforces frame bounds and loopback/local peer identity", async () => {
		expect(parseJsonlDocument('{"long":"123456"}', 4)).toMatchObject({ ok: false, error: { code: "frame_too_large" } });
		expect(validateLocalSseBindTarget({ kind: "tcp", host: "0.0.0.0", port: 3000 })).toMatchObject({
			ok: false,
			error: { code: "remote_disabled" },
		});
		const resolver = new LocalPeerIdentityResolver(PRINCIPAL_ID);
		expect(
			await resolver.resolve({ transport: "sse", remoteAddress: "10.0.0.5", pid: 10, peerCredentialsVerified: true }),
		).toMatchObject({ ok: false, error: { code: "remote_disabled" } });
			expect(
				await resolver.resolve({ transport: "sse", remoteAddress: "127.0.0.1", pid: 10, peerCredentialsVerified: true }),
			).toMatchObject({ ok: true, value: { kind: "local", authenticatedVia: "loopback_process" } });
			expect(
				await resolver.resolve({ transport: "local_socket", pid: 10, uid: 1000, peerCredentialsVerified: true }),
			).toMatchObject({ ok: false, error: { code: "unsupported_feature" } });
			expect(
				await resolver.resolve({ transport: "named_pipe", pid: 10, peerCredentialsVerified: true }),
			).toMatchObject({ ok: false, error: { code: "unsupported_feature" } });
			expect(validateLocalSseBindTarget({ kind: "unix_socket", path: "/tmp/runledger.sock", mode: 0o600 })).toMatchObject({
				ok: false,
				error: { code: "unsupported_feature" },
			});
			expect(validateLocalSseBindTarget({ kind: "named_pipe", path: "\\\\.\\pipe\\runledger" })).toMatchObject({
				ok: false,
				error: { code: "unsupported_feature" },
			});

		const adapter = SseAdapterContract.create({
			target: { kind: "tcp", host: "127.0.0.1", port: 0 },
			dispatcher: {
				dispatch: async () => ({
					kind: "error",
					requestId: null,
					error: { code: "invalid_request", message: "fixture", retryable: false },
				}),
			},
		});
		expect(adapter.ok).toBe(true);
	});
});
