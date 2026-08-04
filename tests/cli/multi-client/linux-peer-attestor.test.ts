import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHostCompatibilityEnvelope, HOST_PROTOCOL_VERSION, type RuntimeHostScope } from "../../../src/runtime/host/contracts.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/ids.ts";
import { runtimeDigest, type RuntimeDigest } from "../../../src/runtime/protocol/foundation.ts";
import { JsonLineHostClient, JsonLineHostServer } from "../../../src/cli/runtime-host-transport.ts";
import {
	createLinuxSocketPeerAttestor,
} from "../../../src/cli/linux-peer-attestor.ts";
import { buildLinuxPeerCredentialHelper } from "../../../scripts/build-linux-peer-credential-helper.ts";

const digest = (seed: string): RuntimeDigest => runtimeDigest(seed);

function scope(): RuntimeHostScope {
	return {
		authorityId: createRuntimeId("authority", "linux-peer"),
		tenantId: createRuntimeId("tenant", "linux-peer"),
		workspaceId: createRuntimeId("workspace", "linux-peer"),
		repositoryId: createRuntimeId("repository", "linux-peer"),
		workspaceStorageKey: "ws-" + "a".repeat(64),
		protocolVersion: HOST_PROTOCOL_VERSION,
		hostBuildDigest: digest("host"),
		compositionDigest: digest("composition"),
		settingsDigest: digest("settings"),
		modelCatalogDigest: digest("models"),
		tracePolicyDigest: digest("trace"),
		securityAdapterDigest: digest("security"),
		extensionProfileDigest: digest("extension"),
		sessionStorageContractVersion: 1,
		peerAttestor: { kind: "linux-so-peercred", generation: 1, configDigest: digest("peer-config") },
	};
}

describe("R3 Linux production peer attestation", () => {
	it("binds the real Unix socket peer credential and channel evidence before routing", async () => {
		if (process.platform !== "linux") return;
		const root = await mkdtemp(join(tmpdir(), "runledger-linux-peer-attestor-"));
		try {
			const helper = join(root, "peer-credential-helper");
			await buildLinuxPeerCredentialHelper(helper);
			const hostScope = createHostCompatibilityEnvelope(scope());
			const server = new JsonLineHostServer({
				socketPath: join(root, "host.sock"),
				scope: hostScope,
				attestor: createLinuxSocketPeerAttestor({
					helperPath: helper,
					scopeDigest: hostScope.compatibilityDigest,
					hostGeneration: 1,
				}),
				handleFrame: async ({ principal, frame }) => [{
					frameId: `result_${frame.frameId}`,
					kind: "command_result",
					protocolVersion: HOST_PROTOCOL_VERSION,
					body: {
						requestFrameId: frame.frameId,
						accepted: true,
						principalId: principal.principalId,
						attestationDigest: principal.attestationDigest.digest,
					},
				}],
			});
			await server.listen();
			const client = await JsonLineHostClient.connect(join(root, "host.sock"));
			try {
				const initialized = await client.request({
					frameId: "initialize",
					kind: "initialize_request",
					protocolVersion: HOST_PROTOCOL_VERSION,
					body: { compatibility: hostScope },
				});
				expect(initialized.body.accepted).toBe(true);
				const result = await client.request({
					frameId: "command",
					kind: "command_request",
					protocolVersion: HOST_PROTOCOL_VERSION,
					body: { operation: "observe", principalId: "payload-forgery" },
				});
				expect(result.body.accepted).toBe(true);
				expect(result.body.principalId).toMatch(/^principal_uid_[0-9]+$/u);
				expect(result.body.attestationDigest).toMatch(/^[a-f0-9]{64}$/u);
			} finally {
				await client.close();
				await server.close();
			}
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("fails closed when the helper is missing or the configured uid is different", async () => {
		if (process.platform !== "linux") return;
		const root = await mkdtemp(join(tmpdir(), "runledger-linux-peer-attestor-negative-"));
		try {
			const missing = createLinuxSocketPeerAttestor({
				helperPath: join(root, "missing-helper"),
				scopeDigest: digest("scope"),
				hostGeneration: 1,
			});
			expect(await missing.preflight()).toEqual({ ok: false, code: "adapter_unavailable" });
			const helper = join(root, "peer-credential-helper");
			await buildLinuxPeerCredentialHelper(helper);
			const wrongUid = createLinuxSocketPeerAttestor({
				helperPath: helper,
				scopeDigest: digest("scope"),
				hostGeneration: 1,
				expectedUid: (typeof process.getuid === "function" ? process.getuid() : 0) + 1,
			});
			expect(await wrongUid.preflight()).toEqual({ ok: false, code: "peer_uid_mismatch" });
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("does not lose helper output when peers attest concurrently", async () => {
		if (process.platform !== "linux") return;
		const root = await mkdtemp(join(tmpdir(), "runledger-linux-peer-attestor-concurrent-"));
		const socketPath = join(root, "host.sock");
		try {
			const helper = join(root, "peer-credential-helper");
			await buildLinuxPeerCredentialHelper(helper);
			const hostScope = createHostCompatibilityEnvelope(scope());
			const server = new JsonLineHostServer({
				socketPath,
				scope: hostScope,
				attestor: createLinuxSocketPeerAttestor({
					helperPath: helper,
					scopeDigest: hostScope.compatibilityDigest,
					hostGeneration: 1,
				}),
				handleFrame: async ({ frame }) => [{
					frameId: `result_${frame.frameId}`,
					kind: "command_result",
					protocolVersion: HOST_PROTOCOL_VERSION,
					body: { requestFrameId: frame.frameId, accepted: true },
				}],
			});
			await server.listen();
			const clients = await Promise.all(Array.from({ length: 12 }, () => JsonLineHostClient.connect(socketPath)));
			try {
				const responses = await Promise.all(clients.map((client, index) => client.request({
					frameId: `initialize_${index}`,
					kind: "initialize_request",
					protocolVersion: HOST_PROTOCOL_VERSION,
					body: { compatibility: hostScope },
				})));
				expect(responses.every((response) => response.body.accepted === true)).toBe(true);
			} finally {
				await Promise.all(clients.map((client) => client.close()));
				await server.close();
			}
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
