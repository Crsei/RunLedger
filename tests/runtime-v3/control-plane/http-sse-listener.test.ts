import { afterEach, describe, expect, it } from "vitest";
import { canonicalDigest } from "../../../src/runtime/protocol/v3/canonical-json.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/v3/ids.ts";
import { LocalPeerIdentityResolver } from "../../../src/runtime/control-plane/local-peer.ts";
import {
	peerCredentialAttestationRequestDigest,
	peerCredentialAttestorDescriptorDigest,
	type PeerCredentialAttestationRequest,
	type PeerCredentialAttestorDescriptor,
	type PeerCredentialAttestorPort,
} from "../../../src/runtime/control-plane/peer-attestor.ts";
import { controlPlaneFailure } from "../../../src/runtime/control-plane/errors.ts";
import { createTestHeadlessDaemonComposition } from "../../../src/daemon/composition-root.ts";
import { HttpSseControlPlaneListener } from "../../../src/daemon/http-sse-listener.ts";
import type { ControlPlaneFeature } from "../../../src/runtime/control-plane/types.ts";
import { createSessionEventStreamRef } from "../../../src/runtime/protocol/v3/events.ts";

const AUTHORITY_ID = createRuntimeId("authority", "http-listener");
const TENANT_ID = createRuntimeId("tenant", "http-listener");
const PRINCIPAL_ID = createRuntimeId("principal", "http-listener");
const SESSION_ID = createRuntimeId("session", "http-listener");
const DIGEST = "a".repeat(64);
const HEAD = {
	stream: createSessionEventStreamRef(
		{ authorityId: AUTHORITY_ID, tenantId: TENANT_ID },
		SESSION_ID,
	),
	sequence: 0,
	eventId: createRuntimeId("event", "http-listener-head"),
	eventHash: DIGEST,
};
const listeners: HttpSseControlPlaneListener[] = [];

afterEach(async () => {
	await Promise.allSettled(listeners.splice(0).map((listener) => listener.close()));
});

class TestPeerAttestor implements PeerCredentialAttestorPort {
	public readonly environment = "test" as const;
	public readonly descriptor: PeerCredentialAttestorDescriptor;
	public forge = false;

	public constructor() {
		const body = {
			contractId: "runledger.peer-credential-attestor" as const,
			schemaVersion: 1 as const,
			environment: "test" as const,
			adapterId: "runledger.test.peer-attestor",
			implementationId: "tests/runtime-v3/control-plane/http-sse-listener.test.ts",
			generation: 1,
			generationDigest: DIGEST,
			principalId: PRINCIPAL_ID,
		};
		this.descriptor = {
			...body,
			descriptorDigest: peerCredentialAttestorDescriptorDigest(body),
		};
	}

	public preflight() {
		return Promise.resolve({
			ok: true as const,
			value: {
				descriptorDigest: this.descriptor.descriptorDigest,
				recoveryEvidenceDigest: DIGEST,
			},
		});
	}

	public attest(request: PeerCredentialAttestationRequest) {
		const now = new Date();
		const body = {
			receiptId: createRuntimeId("receipt", `peer-${canonicalDigest(request).slice(0, 48)}`),
			requestId: request.requestId,
			requestDigest: peerCredentialAttestationRequestDigest(request),
			descriptorDigest: this.descriptor.descriptorDigest,
			generation: this.descriptor.generation,
			channelBindingDigest: request.channelBindingDigest,
			principalId: PRINCIPAL_ID,
			evidence: {
				transport: "sse" as const,
				remoteAddress: request.remoteAddress,
				pid: process.pid,
				...(typeof process.getuid === "function" ? { uid: process.getuid() } : {}),
				peerCredentialsVerified: true,
			},
			attestedAt: now.toISOString(),
			expiresAt: new Date(now.getTime() + 30_000).toISOString(),
		};
		return Promise.resolve({
			ok: true as const,
			value: {
				...body,
				receiptDigest: this.forge ? DIGEST : canonicalDigest(body),
			},
		});
	}
}

function composition(features: readonly ControlPlaneFeature[] = ["session", "health", "event_subscription"]) {
	return createTestHeadlessDaemonComposition({
		testOnly: true,
		authorityId: AUTHORITY_ID,
		tenantId: TENANT_ID,
		serverInstanceId: createRuntimeId("runtime", "http-listener"),
		peerIdentity: new LocalPeerIdentityResolver(PRINCIPAL_ID),
		sessionFactory: {
			start: async () => ({
				ok: true,
				value: {
					sessionId: SESSION_ID,
					head: () => HEAD,
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
							protocolMinor: 1,
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
		features,
	});
}

async function post(url: string, connectionId: string, value: unknown) {
	return fetch(url, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"x-runledger-connection-id": connectionId,
		},
		body: JSON.stringify(value),
	});
}

function hello() {
	return {
		kind: "handshake",
		requestId: "http-hello",
		clientName: "http-test",
		clientVersion: "1.0.0",
		protocol: { major: 1, minMinor: 0, maxMinor: 1 },
		controlPlaneSchemaVersions: [1, 2],
		runtimeSchemaVersions: [3],
		requestedFeatures: ["session", "health", "event_subscription"],
		requiredFeatures: ["health"],
		transport: "sse",
	};
}

describe("real HTTP/SSE Control Plane listener", () => {
	it("does not bind without a matching production peer attestor", async () => {
		const missing = new HttpSseControlPlaneListener({
			environment: "production",
			server: composition().server,
		});
		listeners.push(missing);
		expect(await missing.start()).toMatchObject({
			ok: false,
			error: { code: "unsupported_feature" },
		});
		expect(missing.address()).toBeUndefined();

		const testOnly = new HttpSseControlPlaneListener({
			environment: "production",
			server: composition().server,
			attestor: new TestPeerAttestor(),
		});
		listeners.push(testOnly);
		expect(await testOnly.start()).toMatchObject({
			ok: false,
			error: { code: "adapter_contract_violation" },
		});
	});

	it("serves the shared handshake/query schema, bounds bodies, and rejects forged peer receipts", async () => {
		const attestor = new TestPeerAttestor();
		const listener = new HttpSseControlPlaneListener({
			environment: "test",
			server: composition().server,
			attestor,
			maxRequestBytes: 1024,
		});
		listeners.push(listener);
		const started = await listener.start();
		if (!started.ok) throw new Error(started.error.message);
		const handshake = await post(started.value.commandUrl, "client-one", hello());
		expect(handshake.status).toBe(200);
		expect(await handshake.json()).toMatchObject({
			kind: "handshake_result",
			controlPlaneSchemaVersion: 2,
		});
		const health = await post(started.value.commandUrl, "client-one", {
			kind: "query",
			type: "health",
			queryId: "http-health",
			authorityId: AUTHORITY_ID,
			tenantId: TENANT_ID,
			principalId: PRINCIPAL_ID,
			payload: {},
		});
		expect(health.status).toBe(200);
		expect(await health.json()).toMatchObject({
			kind: "query_result",
			result: { type: "health", protocolMinor: 1 },
		});
		const oversized = await fetch(started.value.commandUrl, {
			method: "POST",
			headers: { "x-runledger-connection-id": "client-large" },
			body: JSON.stringify({ value: "x".repeat(2_000) }),
		});
		expect(oversized.status).toBe(413);

		attestor.forge = true;
		const forged = await post(started.value.commandUrl, "client-forged", hello());
		expect(forged.status).toBe(401);
		expect(await forged.json()).toMatchObject({
			kind: "error",
			error: { code: "unauthorized_peer" },
		});
	});

	it("opens and drains a real SSE response for an accepted bounded subscription", async () => {
		const listener = new HttpSseControlPlaneListener({
			environment: "test",
			server: composition().server,
			attestor: new TestPeerAttestor(),
		});
		listeners.push(listener);
		const started = await listener.start();
		if (!started.ok) throw new Error(started.error.message);
		await post(started.value.commandUrl, "client-events", hello());
		const session = await post(started.value.commandUrl, "client-events", {
			kind: "command",
			type: "session:start",
			commandId: createRuntimeId("command", "http-session-start"),
			idempotencyKey: "http-session-start-key",
			authorityId: AUTHORITY_ID,
			tenantId: TENANT_ID,
			principalId: PRINCIPAL_ID,
			expectedSessionRevision: null,
			expectedTurnId: null,
			sessionHandle: null,
			payload: { cwdDigest: DIGEST, configurationDigest: DIGEST },
		});
		const sessionBody = await session.json() as {
			result: { bootstrap: { handle: unknown } };
		};
		const subscribed = await post(started.value.commandUrl, "client-events", {
			kind: "subscription",
			type: "events:subscribe",
			subscriptionId: "events-main",
			authorityId: AUTHORITY_ID,
			tenantId: TENANT_ID,
			principalId: PRINCIPAL_ID,
			sessionId: SESSION_ID,
			sessionHandle: sessionBody.result.bootstrap.handle,
			fromCursor: null,
			bufferCapacity: 1,
		});
		expect(subscribed.status).toBe(200);
		const controller = new AbortController();
		const stream = await fetch(
			`${started.value.eventUrl}?connectionId=client-events&subscriptionId=events-main`,
			{ signal: controller.signal },
		);
		expect(stream.status).toBe(200);
		expect(stream.headers.get("content-type")).toContain("text/event-stream");
		controller.abort();
		await listener.close();
	});
});
