import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRuntimeId } from "../../../src/runtime/protocol/ids.ts";
import type { RuntimeDigest } from "../../../src/runtime/protocol/foundation.ts";
import {
	createHostCompatibilityEnvelope,
	HOST_PROTOCOL_VERSION,
	type RuntimeHostScope,
} from "../../../src/runtime/host/contracts.ts";
import {
	JsonLineHostClient,
	JsonLineHostServer,
	type HostTransportAttestor,
} from "../../../src/cli/runtime-host-transport.ts";

const digest = (seed: string): RuntimeDigest => ({
	algorithm: "sha256",
	digest: seed.repeat(64).slice(0, 64) as RuntimeDigest["digest"],
});

function scope(): RuntimeHostScope {
	return {
		authorityId: createRuntimeId("authority", "transport"),
		tenantId: createRuntimeId("tenant", "transport"),
		workspaceId: createRuntimeId("workspace", "transport"),
		repositoryId: createRuntimeId("repository", "transport"),
		workspaceStorageKey: "ws-" + "a".repeat(64),
		protocolVersion: HOST_PROTOCOL_VERSION,
		hostBuildDigest: digest("a"),
		compositionDigest: digest("b"),
		settingsDigest: digest("c"),
		modelCatalogDigest: digest("d"),
		tracePolicyDigest: digest("e"),
		securityAdapterDigest: digest("f"),
		extensionProfileDigest: digest("1"),
		sessionStorageContractVersion: 1,
		peerAttestor: { kind: "test", generation: 1, configDigest: digest("2") },
	};
}

const principal = {
	principalId: createRuntimeId("principal", "transport"),
	connectionId: createRuntimeId("connection", "transport"),
	attestationDigest: digest("attestation"),
} as const;

const attestor: HostTransportAttestor = {
	attest: async () => principal,
};

async function waitForClose(socket: net.Socket): Promise<void> {
	if (socket.destroyed) return;
	await new Promise<void>((resolve) => socket.once("close", () => resolve()));
}

describe("R3 bounded authenticated local Host transport", () => {
	it("routes a Host reverse request to the client handler and resolves the targeted waiter", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-host-transport-reverse-"));
		const socketPath = join(root, "host.sock");
		const hostScope = createHostCompatibilityEnvelope(scope());
		try {
			const server = new JsonLineHostServer({
				socketPath,
				scope: hostScope,
				attestor,
				handleFrame: async () => [],
			});
			await server.listen();
			const client = await JsonLineHostClient.connect(socketPath, {
				reverseRequestHandler: async (frame) => ({
					ok: true,
					requestType: frame.body.requestType,
					decision: "allow-once",
				}),
			});
			await client.request({
				frameId: "reverse-init",
				kind: "initialize_request",
				protocolVersion: HOST_PROTOCOL_VERSION,
				body: { compatibility: hostScope },
			});

			const response = await server.requestToConnection(principal.connectionId, {
				frameId: "reverse-permission-1",
				kind: "reverse_request",
				protocolVersion: HOST_PROTOCOL_VERSION,
				body: { requestType: "permission", prompt: "write file" },
			});

			expect(response.kind).toBe("reverse_response");
			expect(response.body).toMatchObject({
				requestFrameId: "reverse-permission-1",
				ok: true,
				requestType: "permission",
				decision: "allow-once",
			});
			await client.close();
			await server.close();
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("attests before routing, handshakes the complete compatibility envelope, and serves commands", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-host-transport-"));
		const socketPath = join(root, "host.sock");
		const hostScope = createHostCompatibilityEnvelope(scope());
		try {
			let routedPrincipal = "";
			const server = new JsonLineHostServer({
				socketPath,
				scope: hostScope,
				attestor,
				handleFrame: async ({ principal: currentPrincipal, frame }) => {
					routedPrincipal = currentPrincipal.principalId;
					return [{
						frameId: `result_${frame.frameId}`,
						kind: "command_result",
						protocolVersion: HOST_PROTOCOL_VERSION,
						body: { requestFrameId: frame.frameId, accepted: true },
					}];
				},
			});
			await server.listen();
			const client = await JsonLineHostClient.connect(socketPath);
			const initialize = await client.request({
				frameId: "initialize",
				kind: "initialize_request",
				protocolVersion: HOST_PROTOCOL_VERSION,
				body: { compatibility: hostScope },
			});
			expect(initialize.kind).toBe("initialize_response");
			expect(initialize.body).toMatchObject({ accepted: true });

			const result = await client.request({
				frameId: "command",
				kind: "command_request",
				protocolVersion: HOST_PROTOCOL_VERSION,
				body: { operation: "observe", principalId: "forged_payload_principal" },
			});
			expect(result.body).toMatchObject({ requestFrameId: "command", accepted: true });
			expect(routedPrincipal).toBe(principal.principalId);
			await client.close();
			await server.close();
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("closes an attestation failure and never invokes the frame handler", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-host-transport-attest-"));
		const socketPath = join(root, "host.sock");
		try {
			let handled = false;
			const server = new JsonLineHostServer({
				socketPath,
				scope: createHostCompatibilityEnvelope(scope()),
				attestor: { attest: async () => undefined },
				handleFrame: async () => {
					handled = true;
					return [];
				},
			});
			await server.listen();
			const socket = net.createConnection(socketPath);
			await new Promise<void>((resolve, reject) => socket.once("connect", resolve).once("error", reject));
			socket.write("{}\n");
			await waitForClose(socket);
			expect(handled).toBe(false);
			await server.close();
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("rejects a frame larger than the frozen bound instead of growing a connection buffer", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-host-transport-bound-"));
		const socketPath = join(root, "host.sock");
		try {
			const server = new JsonLineHostServer({
				socketPath,
				scope: createHostCompatibilityEnvelope(scope()),
				attestor,
				maxFrameBytes: 128,
				handleFrame: async () => [],
			});
			await server.listen();
			const socket = net.createConnection(socketPath);
			await new Promise<void>((resolve, reject) => socket.once("connect", resolve).once("error", reject));
			socket.write(`${"x".repeat(256)}\n`);
			await waitForClose(socket);
			await server.close();
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("closes a connection whose pre-attestation bytes exceed one frame", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-host-transport-pre-attest-bound-"));
		const socketPath = join(root, "host.sock");
		let releaseAttestation: (() => void) | undefined;
		try {
			const server = new JsonLineHostServer({
				socketPath,
				scope: createHostCompatibilityEnvelope(scope()),
				attestor: {
					attest: async () => {
						await new Promise<void>((resolve) => { releaseAttestation = resolve; });
						return principal;
					},
				},
				maxFrameBytes: 64,
				handleFrame: async () => [],
			});
			await server.listen();
			const socket = net.createConnection(socketPath);
			await new Promise<void>((resolve, reject) => socket.once("connect", resolve).once("error", reject));
			const closed = new Promise<boolean>((resolve) => {
				socket.once("close", () => resolve(true));
				setTimeout(() => resolve(false), 50);
			});
			socket.write("{}\n".repeat(32));
			expect(await closed).toBe(true);
			releaseAttestation?.();
			await server.close();
		} finally {
			releaseAttestation?.();
			await rm(root, { recursive: true, force: true });
		}
	});

	it("delivers unsolicited bounded subscription events without confusing request replies", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-host-transport-events-"));
		const socketPath = join(root, "host.sock");
		try {
			const server = new JsonLineHostServer({
				socketPath,
				scope: createHostCompatibilityEnvelope(scope()),
				attestor,
				handleFrame: async ({ frame }) => [{
					frameId: `result_${frame.frameId}`,
					kind: "command_result" as const,
					protocolVersion: HOST_PROTOCOL_VERSION,
					body: { requestFrameId: frame.frameId, accepted: true },
				}],
			});
			await server.listen();
			const client = await JsonLineHostClient.connect(socketPath);
			const events: string[] = [];
			const removeListener = client.onEvent((frame) => {
				if (frame.kind === "subscription_event" && typeof frame.body.eventType === "string") events.push(frame.body.eventType);
			});
			await client.request({
				frameId: "initialize-events",
				kind: "initialize_request",
				protocolVersion: HOST_PROTOCOL_VERSION,
				body: { compatibility: createHostCompatibilityEnvelope(scope()) },
			});
			await client.request({
				frameId: "command-events",
				kind: "command_request",
				protocolVersion: HOST_PROTOCOL_VERSION,
				body: { operation: "observe" },
			});
			const sent = server.sendToConnection(principal.connectionId, {
				frameId: "event-1",
				kind: "subscription_event",
				protocolVersion: HOST_PROTOCOL_VERSION,
				body: { eventType: "agent_start" },
			});
			expect(sent).toBe(true);
			await new Promise((resolve) => setTimeout(resolve, 5));
			expect(events).toEqual(["agent_start"]);
			removeListener();
			await client.close();
			await server.close();
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("sends acknowledgement frames without allocating a pending request", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-host-transport-ack-"));
		const socketPath = join(root, "host.sock");
		try {
			let acknowledgedCursor: number | undefined;
			const server = new JsonLineHostServer({
				socketPath,
				scope: createHostCompatibilityEnvelope(scope()),
				attestor,
				handleFrame: async ({ frame }) => {
					if (frame.kind === "ack_cursor") acknowledgedCursor = Number(frame.body.cursor);
					return [];
				},
			});
			await server.listen();
			const client = await JsonLineHostClient.connect(socketPath);
			await client.request({ frameId: "initialize-ack", kind: "initialize_request", protocolVersion: 1, body: { compatibility: createHostCompatibilityEnvelope(scope()) } });
			client.notify({ frameId: "ack-1", kind: "ack_cursor", protocolVersion: 1, body: { sessionId: "session_ack", cursor: 7 } });
			for (let attempt = 0; attempt < 20 && acknowledgedCursor === undefined; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 2));
			expect(acknowledgedCursor).toBe(7);
			await client.close();
			await server.close();
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("removes only its own Unix socket on close so a restarted Host can bind", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-host-transport-restart-"));
		const socketPath = join(root, "host.sock");
		const hostScope = createHostCompatibilityEnvelope(scope());
		const createServer = (): JsonLineHostServer => new JsonLineHostServer({
			socketPath,
			scope: hostScope,
			attestor,
			handleFrame: async () => [],
		});
		try {
			const first = createServer();
			await first.listen();
			await first.close();
			const second = createServer();
			await expect(second.listen()).resolves.toBeUndefined();
			await second.close();
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
