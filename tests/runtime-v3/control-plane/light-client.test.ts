import { describe, expect, it } from "vitest";
import { SchemaNegotiatedControlPlaneClient } from "../../../src/runtime/control-plane/light-client.ts";
import { createIdempotencyKey } from "../../../src/runtime/protocol/v3/coordination.ts";
import { createSessionEventStreamRef } from "../../../src/runtime/protocol/v3/events.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/v3/ids.ts";
import type {
	AgentCancelCommandV2,
	AgentInspectQueryV2,
} from "../../../src/runtime/control-plane/multi-agent-contracts.ts";
import type { ControlPlaneResponse } from "../../../src/runtime/control-plane/types.ts";

const AUTHORITY_ID = createRuntimeId("authority", "light-client");
const TENANT_ID = createRuntimeId("tenant", "light-client");
const PRINCIPAL_ID = createRuntimeId("principal", "light-client");
const SESSION_ID = createRuntimeId("session", "light-client");
const AGENT_ID = createRuntimeId("agent", "light-client");
const DIGEST = "a".repeat(64);
const CURSOR = {
	stream: createSessionEventStreamRef(
		{ authorityId: AUTHORITY_ID, tenantId: TENANT_ID },
		SESSION_ID,
	),
	sequence: 3,
	eventId: createRuntimeId("event", "light-client"),
	eventHash: DIGEST,
} as const;

function command(): AgentCancelCommandV2 {
	return {
		kind: "command",
		type: "agent:cancel",
		commandId: createRuntimeId("command", "light-client"),
		idempotencyKey: createIdempotencyKey("light-client-command-key"),
		authorityId: AUTHORITY_ID,
		tenantId: TENANT_ID,
		principalId: PRINCIPAL_ID,
		expectedSessionRevision: {
			stream: CURSOR.stream,
			sequence: CURSOR.sequence,
			eventHash: CURSOR.eventHash,
		},
		expectedAgentGraphRevision: 2,
		sessionHandle: {
			handleId: "handle_0123456789abcdef",
			sessionId: SESSION_ID,
			generation: 1,
		},
		payload: {
			sessionId: SESSION_ID,
			agentId: AGENT_ID,
			reasonDigest: DIGEST,
		},
	};
}

function query(): AgentInspectQueryV2 {
	return {
		kind: "query",
		type: "agent:inspect",
		queryId: "light-client-inspect",
		authorityId: AUTHORITY_ID,
		tenantId: TENANT_ID,
		principalId: PRINCIPAL_ID,
		payload: {
			sessionId: SESSION_ID,
			sessionHandle: command().sessionHandle,
			agentId: AGENT_ID,
		},
	};
}

describe("schema-negotiated lightweight Control Plane client", () => {
	it("offers schemas 1 and 2 while preserving a typed feature-off legacy path", async () => {
		const frames: unknown[] = [];
		const client = new SchemaNegotiatedControlPlaneClient({
			transport: {
				dispatch: async (frame) => {
					frames.push(frame);
					return {
						kind: "handshake_result",
						requestId: "legacy-handshake",
						protocol: { major: 1, minor: 0 },
						controlPlaneSchemaVersion: 1,
						runtimeSchemaVersion: 3,
						features: ["session"],
						serverInstanceId: createRuntimeId("runtime", "legacy-light-client"),
					};
				},
			},
			clientName: "runledger-tui",
			clientVersion: "1.0.0",
			transportKind: "jsonl",
			requestedFeatures: ["session", "multi_agent"],
			requestId: "legacy-handshake",
		});
		expect(await client.connect()).toMatchObject({
			ok: true,
			value: { controlPlaneSchemaVersion: 1 },
		});
		expect(frames[0]).toMatchObject({
			protocol: { maxMinor: 1 },
			controlPlaneSchemaVersions: [1, 2],
		});
		expect(await client.executeAgent(command())).toMatchObject({
			ok: false,
			error: { code: "unsupported_schema" },
		});
		expect(frames).toHaveLength(1);
	});

	it("uses only correlated schema v2 command/query projections as client state", async () => {
		const frames: unknown[] = [];
		const responses: ControlPlaneResponse[] = [
			{
				kind: "handshake_result",
				requestId: "v2-handshake",
				protocol: { major: 1, minor: 1 },
				controlPlaneSchemaVersion: 2,
				runtimeSchemaVersion: 3,
				features: ["session", "multi_agent"],
				serverInstanceId: createRuntimeId("runtime", "v2-light-client"),
			},
			{
				kind: "command_result",
				commandId: command().commandId,
				type: "agent:cancel",
				status: "executed",
				result: {
					type: "agent:cancel",
					sessionId: SESSION_ID,
					agent: {
						agentId: AGENT_ID,
						parentAgentId: createRuntimeId("agent", "light-client-root"),
						sessionId: createRuntimeId("session", "light-client-child"),
						role: "build",
						state: "stopped",
						residency: "nonresident",
						artifactCount: 0,
					},
					graphRevision: 3,
					durableCursor: CURSOR,
					receiptDigest: DIGEST,
				},
			},
			{
				kind: "query_result",
				queryId: query().queryId,
				type: "agent:inspect",
				result: {
					type: "agent:inspect",
					sessionId: SESSION_ID,
					graphRevision: 3,
					durableCursor: CURSOR,
					agents: [],
					projectionDigest: DIGEST,
				},
			},
		];
		const client = new SchemaNegotiatedControlPlaneClient({
			transport: {
				dispatch: async (frame) => {
					frames.push(frame);
					const response = responses.shift();
					if (!response) throw new Error("unexpected client dispatch");
					return response;
				},
			},
			clientName: "runledger-tui",
			clientVersion: "1.0.0",
			transportKind: "jsonl",
			requestedFeatures: ["session", "multi_agent"],
			requiredFeatures: ["multi_agent"],
			requestId: "v2-handshake",
		});
		expect((await client.connect()).ok).toBe(true);
		expect(await client.executeAgent(command())).toMatchObject({
			ok: true,
			value: { result: { graphRevision: 3 } },
		});
		expect(await client.inspectAgent(query())).toMatchObject({
			ok: true,
			value: { result: { agents: [] } },
		});
		expect(frames.map((frame) =>
			typeof frame === "object" && frame !== null && "type" in frame
				? frame.type
				: "handshake"
		)).toEqual(["handshake", "agent:cancel", "agent:inspect"]);
	});
});
