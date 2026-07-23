import { describe, expect, it } from "vitest";
import { createIdempotencyKey } from "../../../src/runtime/protocol/v3/coordination.ts";
import { createSessionEventStreamRef } from "../../../src/runtime/protocol/v3/events.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/v3/ids.ts";
import { createTestHeadlessDaemonComposition } from "../../../src/daemon/composition-root.ts";
import { LocalPeerIdentityResolver } from "../../../src/runtime/control-plane/local-peer.ts";
import { controlPlaneFailure } from "../../../src/runtime/control-plane/errors.ts";
import { DEFAULT_MAX_SUBSCRIPTIONS_PER_CONNECTION } from "../../../src/daemon/server.ts";
import type { ControlPlaneFeature } from "../../../src/runtime/control-plane/types.ts";
import type {
	AgentCancelCommandV2,
	AgentInspectQueryV2,
	MultiAgentControlPlanePort,
} from "../../../src/runtime/control-plane/multi-agent-contracts.ts";

const AUTHORITY_ID = createRuntimeId("authority", "server");
const TENANT_ID = createRuntimeId("tenant", "server");
const PRINCIPAL_ID = createRuntimeId("principal", "server");
const SESSION_ID = createRuntimeId("session", "server");
const DIGEST = "a".repeat(64);
const SESSION_HEAD = {
	stream: createSessionEventStreamRef({ authorityId: AUTHORITY_ID, tenantId: TENANT_ID }, SESSION_ID),
	sequence: 0,
	eventId: createRuntimeId("event", "server-genesis"),
	eventHash: DIGEST,
} as const;

function composition(
	features: readonly ControlPlaneFeature[] = ["session", "health"],
	multiAgent?: MultiAgentControlPlanePort,
) {
	return createTestHeadlessDaemonComposition({
		testOnly: true,
		authorityId: AUTHORITY_ID,
		tenantId: TENANT_ID,
		serverInstanceId: createRuntimeId("runtime", "server"),
		peerIdentity: new LocalPeerIdentityResolver(PRINCIPAL_ID),
		sessionFactory: {
			start: async () => ({
				ok: true,
				value: {
					sessionId: SESSION_ID,
					head: () => SESSION_HEAD,
					teardown: async () => ({ ok: true, value: undefined }),
				},
			}),
			resume: async () => controlPlaneFailure("adapter_unavailable", "unused"),
			fork: async () => controlPlaneFailure("adapter_unavailable", "unused"),
		},
		sessionState: { inspect: async () => controlPlaneFailure("adapter_unavailable", "unused") },
		mutationExecutor: { execute: async () => controlPlaneFailure("adapter_unavailable", "unused") },
		prompts: {
			preflight: async () => controlPlaneFailure("adapter_unavailable", "unused"),
			enqueueDurable: async () => controlPlaneFailure("adapter_unavailable", "unused"),
		},
		approvals: { resolve: async () => controlPlaneFailure("adapter_unavailable", "unused") },
		queryExecutor: {
			execute: async (query) => query.type === "health"
				? {
						ok: true,
						value: {
							type: "health",
							status: "ok",
							protocolMajor: 1,
							protocolMinor: 0,
							uptimeMs: 10,
							shuttingDown: false,
						},
					}
				: controlPlaneFailure("adapter_unavailable", "unused"),
		},
		eventSource: {
			subscribe: async function* (_sessionId, _afterSequence, signal) {
				await new Promise<void>((resolve) => {
					if (signal.aborted) resolve();
					else signal.addEventListener("abort", () => resolve(), { once: true });
				});
			},
		},
		...(multiAgent ? { multiAgent } : {}),
		features,
	});
}

function agentCommand(principalId = PRINCIPAL_ID): AgentCancelCommandV2 {
	return {
		kind: "command",
		type: "agent:cancel",
		commandId: createRuntimeId("command", "server-agent-cancel"),
		idempotencyKey: createIdempotencyKey("server-agent-cancel-key"),
		authorityId: AUTHORITY_ID,
		tenantId: TENANT_ID,
		principalId,
		expectedSessionRevision: {
			stream: SESSION_HEAD.stream,
			sequence: SESSION_HEAD.sequence,
			eventHash: SESSION_HEAD.eventHash,
		},
		expectedAgentGraphRevision: 2,
		sessionHandle: {
			handleId: "handle_0123456789abcdef",
			sessionId: SESSION_ID,
			generation: 1,
		},
		payload: {
			sessionId: SESSION_ID,
			agentId: createRuntimeId("agent", "server-child"),
			reasonDigest: DIGEST,
		},
	};
}

function agentQuery(principalId = PRINCIPAL_ID): AgentInspectQueryV2 {
	return {
		kind: "query",
		type: "agent:inspect",
		queryId: "server-agent-inspect",
		authorityId: AUTHORITY_ID,
		tenantId: TENANT_ID,
		principalId,
		payload: {
			sessionId: SESSION_ID,
			sessionHandle: {
				handleId: "handle_0123456789abcdef",
				sessionId: SESSION_ID,
				generation: 1,
			},
			agentId: null,
		},
	};
}

async function handshake(
	dispatcher: ReturnType<ReturnType<typeof composition>["server"]["createDispatcher"]>,
	options: { schema: 1 | 2; features: readonly ControlPlaneFeature[] },
) {
	return dispatcher.dispatch({
		kind: "handshake",
		requestId: `hello-agent-${options.schema}-${options.features.length}`,
		clientName: "test-client",
		clientVersion: "1.0.0",
		protocol: { major: 1, minMinor: 0, maxMinor: 1 },
		controlPlaneSchemaVersions: [options.schema],
		runtimeSchemaVersions: [3],
		requestedFeatures: options.features,
		requiredFeatures: [],
		transport: "jsonl",
	});
}

describe("headless daemon server", () => {
	it("requires handshake, binds request scope to local peer, and returns a session bootstrap", async () => {
		const daemon = composition();
		const dispatcher = daemon.server.createDispatcher("connection-1", {
			transport: "jsonl",
			pid: 42,
			uid: 1000,
			peerCredentialsVerified: true,
		});
		const health = {
			kind: "query",
			type: "health",
			queryId: "health-1",
			authorityId: AUTHORITY_ID,
			tenantId: TENANT_ID,
			principalId: PRINCIPAL_ID,
			payload: {},
		};
		expect(await dispatcher.dispatch(health)).toMatchObject({ kind: "error", error: { code: "handshake_required" } });
		expect(
			await dispatcher.dispatch({
				kind: "handshake",
				requestId: "hello-1",
				clientName: "test-client",
				clientVersion: "1.0.0",
				protocol: { major: 1, minMinor: 0, maxMinor: 0 },
				controlPlaneSchemaVersions: [1],
				runtimeSchemaVersions: [3],
				requestedFeatures: ["session", "health"],
				requiredFeatures: ["session"],
				transport: "jsonl",
			}),
		).toMatchObject({ kind: "handshake_result", features: ["session", "health"] });
		expect(await dispatcher.dispatch(health)).toMatchObject({ kind: "query_result", result: { type: "health" } });
		expect(await dispatcher.dispatch({ ...health, queryId: "health-2", principalId: createRuntimeId("principal", "other") })).toMatchObject({
			kind: "error",
			error: { code: "unauthorized_peer" },
		});
		expect(
			await dispatcher.dispatch({
				kind: "command",
				type: "session:start",
				commandId: createRuntimeId("command", "session-start"),
				idempotencyKey: createIdempotencyKey("session-start-key-0001"),
				authorityId: AUTHORITY_ID,
				tenantId: TENANT_ID,
				principalId: PRINCIPAL_ID,
				expectedSessionRevision: null,
				expectedTurnId: null,
				sessionHandle: null,
				payload: { cwdDigest: DIGEST, configurationDigest: DIGEST },
			}),
		).toMatchObject({
			kind: "command_result",
			result: { type: "session:start", bootstrap: { sessionId: SESSION_ID } },
		});
	});

	it("rejects excess live subscriptions with a typed retryable overload", async () => {
		const daemon = composition(["session", "event_subscription"]);
		const dispatcher = daemon.server.createDispatcher("connection-overload", {
			transport: "jsonl",
			pid: 42,
			uid: 1000,
			peerCredentialsVerified: true,
		});
		await dispatcher.dispatch({
			kind: "handshake",
			requestId: "hello-overload",
			clientName: "test-client",
			clientVersion: "1.0.0",
			protocol: { major: 1, minMinor: 0, maxMinor: 0 },
			controlPlaneSchemaVersions: [1],
			runtimeSchemaVersions: [3],
			requestedFeatures: ["session", "event_subscription"],
			requiredFeatures: ["session", "event_subscription"],
			transport: "jsonl",
		});
		const started = await dispatcher.dispatch({
			kind: "command",
			type: "session:start",
			commandId: createRuntimeId("command", "session-overload-start"),
			idempotencyKey: createIdempotencyKey("session-overload-start-key"),
			authorityId: AUTHORITY_ID,
			tenantId: TENANT_ID,
			principalId: PRINCIPAL_ID,
			expectedSessionRevision: null,
			expectedTurnId: null,
			sessionHandle: null,
			payload: { cwdDigest: DIGEST, configurationDigest: DIGEST },
		});
		if (started.kind !== "command_result" || started.result.type !== "session:start") {
			throw new Error("session bootstrap failed");
		}
		for (let index = 0; index < DEFAULT_MAX_SUBSCRIPTIONS_PER_CONNECTION; index += 1) {
			await expect(dispatcher.dispatch({
				kind: "subscription",
				type: "events:subscribe",
				subscriptionId: `events-${index}`,
				authorityId: AUTHORITY_ID,
				tenantId: TENANT_ID,
				principalId: PRINCIPAL_ID,
				sessionId: SESSION_ID,
				sessionHandle: started.result.bootstrap.handle,
				fromCursor: null,
				bufferCapacity: 1,
			})).resolves.toMatchObject({ kind: "subscription_result", status: "accepted" });
		}
		await expect(dispatcher.dispatch({
			kind: "subscription",
			type: "events:subscribe",
			subscriptionId: "events-over-limit",
			authorityId: AUTHORITY_ID,
			tenantId: TENANT_ID,
			principalId: PRINCIPAL_ID,
			sessionId: SESSION_ID,
			sessionHandle: started.result.bootstrap.handle,
			fromCursor: null,
			bufferCapacity: 1,
		})).resolves.toMatchObject({
			kind: "error",
			error: { code: "overloaded", retryable: true },
		});
		await daemon.server.closeConnection("connection-overload");
	});

	it("keeps schema v1 blind to Agent commands and requires negotiated multi_agent in v2", async () => {
		const daemon = composition(["session", "multi_agent"]);
		const v1 = daemon.server.createDispatcher("connection-agent-v1", {
			transport: "jsonl",
			peerCredentialsVerified: true,
		});
		await handshake(v1, { schema: 1, features: ["session", "multi_agent"] });
		await expect(v1.dispatch(agentCommand())).resolves.toMatchObject({
			kind: "error",
			error: { code: "unsupported_schema" },
		});

		const v2 = daemon.server.createDispatcher("connection-agent-v2-no-feature", {
			transport: "jsonl",
			peerCredentialsVerified: true,
		});
		await handshake(v2, { schema: 2, features: ["session"] });
		await expect(v2.dispatch(agentCommand())).resolves.toMatchObject({
			kind: "error",
			error: { code: "unsupported_feature" },
		});
	});

	it("routes schema v2 Agent mutations and queries through one injected port with peer scope checks", async () => {
		const calls: string[] = [];
		const port: MultiAgentControlPlanePort = {
			execute: async (command) => {
				calls.push(command.type);
				return {
					ok: true,
					value: {
						kind: "command_result",
						commandId: command.commandId,
						type: command.type,
						status: "executed",
						result: {
							type: command.type,
							sessionId: SESSION_ID,
							agent: {
								agentId: command.payload.agentId,
								parentAgentId: createRuntimeId("agent", "server-root"),
								sessionId: createRuntimeId("session", "server-child"),
								role: "build",
								state: "stopped",
								residency: "nonresident",
								artifactCount: 0,
							},
							graphRevision: 3,
							durableCursor: SESSION_HEAD,
							receiptDigest: DIGEST,
						},
					},
				};
			},
			inspect: async (query) => {
				calls.push(query.type);
				return {
					ok: true,
					value: {
						kind: "query_result",
						queryId: query.queryId,
						type: "agent:inspect",
						result: {
							type: "agent:inspect",
							sessionId: SESSION_ID,
							graphRevision: 3,
							durableCursor: SESSION_HEAD,
							agents: [],
							projectionDigest: DIGEST,
						},
					},
				};
			},
		};
		const daemon = composition(["session", "multi_agent"], port);
		const dispatcher = daemon.server.createDispatcher("connection-agent-v2", {
			transport: "jsonl",
			peerCredentialsVerified: true,
		});
		await handshake(dispatcher, { schema: 2, features: ["session", "multi_agent"] });
		await expect(dispatcher.dispatch(agentQuery())).resolves.toMatchObject({
			kind: "query_result",
			type: "agent:inspect",
		});
		await expect(dispatcher.dispatch(agentCommand())).resolves.toMatchObject({
			kind: "command_result",
			type: "agent:cancel",
		});
		await expect(
			dispatcher.dispatch(agentCommand(createRuntimeId("principal", "wrong-peer"))),
		).resolves.toMatchObject({
			kind: "error",
			error: { code: "unauthorized_peer" },
		});
		expect(calls).toEqual(["agent:inspect", "agent:cancel"]);
	});
});
