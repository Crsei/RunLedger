import { EventEmitter } from "node:events";
import { PassThrough, type Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { createTestHeadlessDaemonComposition } from "../../../src/daemon/composition-root.ts";
import {
	createStdioParentPeerEvidence,
	runStdioControlPlaneHost,
	type StdioEventDeliveryFrame,
} from "../../../src/daemon/stdio-host.ts";
import { controlPlaneFailure } from "../../../src/runtime/control-plane/errors.ts";
import { LocalPeerIdentityResolver } from "../../../src/runtime/control-plane/local-peer.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/v3/ids.ts";
import { createIdempotencyKey } from "../../../src/runtime/protocol/v3/coordination.ts";
import { canonicalDigest } from "../../../src/runtime/protocol/v3/canonical-json.ts";
import {
	computeRuntimeEventHash,
	computeRuntimeEventPayloadDigest,
} from "../../../src/runtime/protocol/v3/event-hash.ts";
import {
	createSessionEventStreamRef,
	RUNTIME_SCHEMA_VERSION,
	type EventCursor,
	type RuntimeEventV3,
} from "../../../src/runtime/protocol/v3/events.ts";
import type { ControlPlaneResponse } from "../../../src/runtime/control-plane/types.ts";

const AUTHORITY_ID = createRuntimeId("authority", "stdio-host");
const TENANT_ID = createRuntimeId("tenant", "stdio-host");
const PRINCIPAL_ID = createRuntimeId("principal", "stdio-host");
const SESSION_ID = createRuntimeId("session", "stdio-host");
const DIGEST = "a".repeat(64);
const STREAM = createSessionEventStreamRef({ authorityId: AUTHORITY_ID, tenantId: TENANT_ID }, SESSION_ID);

function composition() {
	return createTestHeadlessDaemonComposition({
		testOnly: true,
		authorityId: AUTHORITY_ID,
		tenantId: TENANT_ID,
		serverInstanceId: createRuntimeId("runtime", "stdio-host"),
		peerIdentity: new LocalPeerIdentityResolver(PRINCIPAL_ID),
		sessionFactory: {
			start: async () => controlPlaneFailure("adapter_unavailable", "unused"),
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
							type: "health" as const,
							status: "ok" as const,
							protocolMajor: 1,
							protocolMinor: 0,
							uptimeMs: 1,
							shuttingDown: false,
						},
					}
				: controlPlaneFailure("unsupported_feature", "unused"),
		},
		eventSource: { subscribe: async function* () { /* unreachable */ } },
		features: ["health"],
	});
}

function subscriptionEvents(): readonly [RuntimeEventV3, RuntimeEventV3] {
	const traceId = createRuntimeId("trace", "stdio-host");
	const genesisPayload = {
		origin: "test" as const,
		runtimeId: createRuntimeId("runtime", "stdio-subscription"),
		featureDigest: DIGEST,
		initialGoalId: createRuntimeId("goal", "stdio-subscription"),
		rootAgentId: createRuntimeId("agent", "stdio-subscription"),
	};
	const genesisInput = {
		schemaVersion: RUNTIME_SCHEMA_VERSION,
		authorityId: AUTHORITY_ID,
		tenantId: TENANT_ID,
		principalId: PRINCIPAL_ID,
		eventId: createRuntimeId("event", "stdio-subscription-0"),
		stream: STREAM,
		sequence: 0,
		timestamp: "2026-07-22T00:00:00.000Z",
		type: "session.created" as const,
		previousEventHash: null,
		payloadDigest: computeRuntimeEventPayloadDigest(genesisPayload),
		traceId,
	};
	const first = {
		...genesisInput,
		currentEventHash: computeRuntimeEventHash(genesisInput),
		payload: genesisPayload,
	};
	const messageJson = JSON.stringify({ role: "user", content: "reconnected" });
	const messagePayload = {
		role: "user" as const,
		messageJson,
		contentDigest: canonicalDigest({ role: "user", content: "reconnected" }),
	};
	const messageInput = {
		schemaVersion: RUNTIME_SCHEMA_VERSION,
		authorityId: AUTHORITY_ID,
		tenantId: TENANT_ID,
		principalId: PRINCIPAL_ID,
		eventId: createRuntimeId("event", "stdio-subscription-1"),
		stream: STREAM,
		sequence: 1,
		timestamp: "2026-07-22T00:00:01.000Z",
		type: "conversation.message_recorded" as const,
		previousEventHash: first.currentEventHash,
		payloadDigest: computeRuntimeEventPayloadDigest(messagePayload),
		traceId,
	};
	const second = {
		...messageInput,
		currentEventHash: computeRuntimeEventHash(messageInput),
		payload: messagePayload,
	};
	return [first, second];
}

function subscriptionComposition(visible: () => readonly RuntimeEventV3[]) {
	return createTestHeadlessDaemonComposition({
		testOnly: true,
		authorityId: AUTHORITY_ID,
		tenantId: TENANT_ID,
		serverInstanceId: createRuntimeId("runtime", "stdio-subscription"),
		peerIdentity: new LocalPeerIdentityResolver(PRINCIPAL_ID),
		sessionFactory: {
			start: async () => ({
				ok: true,
				value: {
					sessionId: SESSION_ID,
					head: () => {
						const event = visible()[0];
						return event
							? {
								stream: event.stream,
								sequence: event.sequence,
								eventId: event.eventId,
								eventHash: event.currentEventHash,
							}
							: null;
					},
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
		queryExecutor: { execute: async () => controlPlaneFailure("adapter_unavailable", "unused") },
		eventSource: {
			subscribe: async function* (_sessionId, afterSequence, signal) {
				for (const event of visible()) {
					if (event.sequence > afterSequence) yield { event, origin: "replay" as const };
				}
				await new Promise<void>((resolve) => {
					if (signal.aborted) resolve();
					else signal.addEventListener("abort", () => resolve(), { once: true });
				});
			},
		},
		features: ["session", "event_subscription"],
	});
}

class ControlledBackpressureOutput extends EventEmitter {
	public readonly writes: string[] = [];
	public destroyed = false;
	public writableEnded = false;
	#blocked = true;

	public write(chunk: string | Uint8Array): boolean {
		this.writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
		return !this.#blocked;
	}

	public release(): void {
		this.#blocked = false;
		this.emit("drain");
	}
}

async function waitFor(predicate: () => boolean): Promise<void> {
	const deadline = Date.now() + 2_000;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error("condition timed out");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

describe("stdio Control Plane host", () => {
	it("does not write the next response until stdout signals drain", async () => {
		const daemon = composition();
		const input = new PassThrough();
		const output = new ControlledBackpressureOutput();
		const hello = {
			kind: "handshake",
			requestId: "stdio-hello",
			clientName: "stdio-test",
			clientVersion: "1.0.0",
			protocol: { major: 1, minMinor: 0, maxMinor: 0 },
			controlPlaneSchemaVersions: [1],
			runtimeSchemaVersions: [3],
			requestedFeatures: ["health"],
			requiredFeatures: ["health"],
			transport: "jsonl",
		};
		const health = {
			kind: "query",
			type: "health",
			queryId: "stdio-health",
			authorityId: AUTHORITY_ID,
			tenantId: TENANT_ID,
			principalId: PRINCIPAL_ID,
			payload: {},
		};
		const running = runStdioControlPlaneHost({
			server: daemon.server,
			shutdown: daemon.shutdown,
			input,
			output: output as unknown as Writable,
			evidence: createStdioParentPeerEvidence(),
			shutdownTimeoutMs: 1_000,
		});
		input.end(`${JSON.stringify(hello)}\n${JSON.stringify(health)}\n`);

		await waitFor(() => output.writes.length === 1);
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(output.writes).toHaveLength(1);
		output.release();

		await expect(running).resolves.toMatchObject({
			reason: "stdin_eof",
			responsesWritten: 2,
			shutdown: { recoveryRequired: false },
		});
		expect(output.writes.map((line) => JSON.parse(line) as { kind: string }).map((frame) => frame.kind)).toEqual([
			"handshake_result",
			"query_result",
		]);
	});

	it("replaces a live stdio delivery pump and redelivers from the reconnect cursor", async () => {
		const [firstEvent, secondEvent] = subscriptionEvents();
		let events: readonly RuntimeEventV3[] = [firstEvent];
		const daemon = subscriptionComposition(() => events);
		const input = new PassThrough();
		const output = new PassThrough();
		const frames: Array<ControlPlaneResponse | StdioEventDeliveryFrame> = [];
		let buffered = "";
		output.on("data", (chunk: Buffer) => {
			buffered += chunk.toString("utf8");
			while (true) {
				const newline = buffered.indexOf("\n");
				if (newline < 0) break;
				const line = buffered.slice(0, newline);
				buffered = buffered.slice(newline + 1);
				frames.push(JSON.parse(line) as ControlPlaneResponse | StdioEventDeliveryFrame);
			}
		});
		const running = runStdioControlPlaneHost({
			server: daemon.server,
			shutdown: daemon.shutdown,
			input,
			output,
			evidence: createStdioParentPeerEvidence(),
			shutdownTimeoutMs: 1_000,
		});
		const hello = {
			kind: "handshake",
			requestId: "stdio-reconnect-hello",
			clientName: "stdio-test",
			clientVersion: "1.0.0",
			protocol: { major: 1, minMinor: 0, maxMinor: 0 },
			controlPlaneSchemaVersions: [1],
			runtimeSchemaVersions: [3],
			requestedFeatures: ["session", "event_subscription"],
			requiredFeatures: ["session", "event_subscription"],
			transport: "jsonl",
		};
		const start = {
			kind: "command",
			type: "session:start",
			commandId: createRuntimeId("command", "stdio-reconnect-start"),
			idempotencyKey: createIdempotencyKey("stdio-reconnect-start-key"),
			authorityId: AUTHORITY_ID,
			tenantId: TENANT_ID,
			principalId: PRINCIPAL_ID,
			expectedSessionRevision: null,
			expectedTurnId: null,
			sessionHandle: null,
			payload: { cwdDigest: DIGEST, configurationDigest: DIGEST },
		};
		input.write(`${JSON.stringify(hello)}\n${JSON.stringify(start)}\n`);
		await waitFor(() => frames.length >= 2);
		const started = frames[1];
		if (started?.kind !== "command_result" || started.result.type !== "session:start") {
			throw new Error("stdio session bootstrap failed");
		}
		const subscribe = (fromCursor: EventCursor | null) => ({
			kind: "subscription",
			type: "events:subscribe",
			subscriptionId: "events-reconnect",
			authorityId: AUTHORITY_ID,
			tenantId: TENANT_ID,
			principalId: PRINCIPAL_ID,
			sessionId: SESSION_ID,
			sessionHandle: started.result.bootstrap.handle,
			fromCursor,
			bufferCapacity: 4,
		});
		input.write(`${JSON.stringify(subscribe(null))}\n`);
		await waitFor(() => frames.some((frame) => frame.kind === "event_delivery" && frame.sequence === 0));

		events = [firstEvent, secondEvent];
		input.write(`${JSON.stringify(subscribe({
			stream: firstEvent.stream,
			sequence: 0,
			eventId: firstEvent.eventId,
			eventHash: firstEvent.currentEventHash,
		}))}\n`);
		await waitFor(() => frames.filter((frame) => frame.kind === "subscription_result").length === 2);
		await waitFor(() => frames.some((frame) => frame.kind === "event_delivery" && frame.sequence === 1));
		const deliveries = frames.filter((frame) => frame.kind === "event_delivery");
		expect(deliveries.map((frame) => frame.sequence)).toEqual([0, 0, 1]);
		input.end();
		await expect(running).resolves.toMatchObject({ reason: "stdin_eof", shutdown: { recoveryRequired: false } });
	});
});
