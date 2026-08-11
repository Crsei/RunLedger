import { describe, expect, it } from "vitest";
import { IS_WINDOWS } from "../../helpers/platform.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRuntimeId } from "../../../src/runtime/protocol/ids.ts";
import { runtimeDigest, type RuntimeDigest } from "../../../src/runtime/protocol/foundation.ts";
import {
	createHostCompatibilityEnvelope,
	HOST_PROTOCOL_VERSION,
	type RuntimeHostScope,
} from "../../../src/runtime/host/contracts.ts";
import type { AgentEvent, AgentEventSink, AgentMessage, UserAgentMessage } from "../../../src/runtime/types.ts";
import type { Api, Model, ModelThinkingLevel } from "../../../src/types.ts";
import type { LedgerEntry } from "../../../src/runtime/ledger/types.ts";
import type {
	InteractiveSessionControllerPort,
	ProviderStatus,
	RuntimeSelection,
} from "../../../src/runtime/interactive-session-controller.ts";
import { RUNTIME_HOST_BOUNDS, type HostConnectionPrincipal, type HostFrameEnvelope } from "../../../src/runtime/host/types.ts";
import { JsonLineHostClient } from "../../../src/cli/runtime-host-transport.ts";
import { HostReversePermissionPrompter, ResidentRuntimeHost, type HostProcessPort, type HostSessionRuntime } from "../../../src/cli/runtime-host-service.ts";
import type { PermissionPrompt } from "../../../src/security/types.ts";
import { JsonlHostEventStore } from "../../../src/storage/host/event-store.ts";
import { JsonHostCommandStore } from "../../../src/storage/host/command-store.ts";
import { buildRunledgerLayout } from "../../../src/runtime/contracts/storage-layout.ts";

const digest = (seed: string): RuntimeDigest => runtimeDigest(seed);

function scope(): RuntimeHostScope {
	return {
		authorityId: createRuntimeId("authority", "service"),
		tenantId: createRuntimeId("tenant", "service"),
		workspaceId: createRuntimeId("workspace", "service"),
		repositoryId: createRuntimeId("repository", "service"),
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
		peerAttestor: { kind: "test", generation: 1, configDigest: digest("attestor") },
	};
}

function fakeSession(
	sessionId = createRuntimeId("session", "service"),
	eventsPerPrompt = 1,
): HostSessionRuntime {
	const listeners = new Set<AgentEventSink>();
	const messages: AgentMessage[] = [];
	let promptCount = 0;
	const selection: RuntimeSelection = { thinkingLevel: "off" };
	const controller: InteractiveSessionControllerPort = {
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		sessionId,
		inFlight: false,
		currentSelection: selection,
		messages,
		warnings: [],
		auditEntries: [] as LedgerEntry[],
		toolCount: 0,
		getSteeringMessages: () => [] as UserAgentMessage[],
		getFollowUpMessages: () => [] as UserAgentMessage[],
		getProviderStatuses: async (): Promise<ProviderStatus[]> => [],
		getProvider: () => undefined,
		getAvailableModels: async (): Promise<readonly Model<Api>[]> => [],
		login: async () => { throw new Error("not used"); },
		logout: async () => {},
		selectModel: async () => {},
		setThinkingLevel: async (level: ModelThinkingLevel) => level,
		prompt: async (text: string) => {
			promptCount += 1;
			for (let index = 0; index < eventsPerPrompt; index += 1) {
				const event: AgentEvent = {
					type: "agent_end",
					timestamp: Date.now(),
					message: { role: "assistant", content: [{ type: "text", text: `${text}-${index}` }], stopReason: "stop" },
				};
				for (const listener of listeners) await listener(event);
				if (eventsPerPrompt > 1) await new Promise<void>((resolve) => setImmediate(resolve));
			}
		},
		interrupt: () => {},
		clearAllQueues: () => ({ steering: [], followUp: [] }),
		waitForIdle: async () => {},
		dispose: () => {},
	};
	return {
		controller,
		get promptCount() { return promptCount; },
		close: async () => {},
	};
}

describe.skipIf(IS_WINDOWS)("production Resident Runtime Host service", () => {
	it("exposes bounded management status and shutdown without runtime admission", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-host-management-service-"));
		const socketPath = join(root, "host.sock");
		const hostScope = createHostCompatibilityEnvelope(scope());
		const runtimeId = createRuntimeId("runtime", "management-service");
		let shutdownReason = "";
		const host = new ResidentRuntimeHost({
			socketPath,
			scope: hostScope,
			hostRuntimeId: runtimeId,
			hostGeneration: 9,
			attestor: { attest: async () => ({
				principalId: createRuntimeId("principal", "management-service"),
				connectionId: createRuntimeId("connection", "management-service"),
				attestationDigest: digest("management-service"),
			}) },
			createSession: async () => fakeSession(),
			onShutdown: async (request) => { shutdownReason = request.reason; },
		});
		try {
			await host.start();
			const client = await JsonLineHostClient.connect(socketPath);
			await client.request({
				frameId: "management-service-init",
				kind: "initialize_request",
				protocolVersion: 1,
				body: { mode: "management", management: { protocolVersion: 1, workspaceStorageKey: hostScope.workspaceStorageKey, hostRuntimeId: runtimeId, hostGeneration: 9 } },
			});
			const inspected = await client.request({ frameId: "management-service-inspect", kind: "query_request", protocolVersion: 1, body: { operation: "host.inspect" } });
			expect(inspected.body).toMatchObject({
				ok: true,
				hostRuntimeId: runtimeId,
				hostGeneration: 9,
				buildDigest: hostScope.hostBuildDigest,
				loadedSessionCount: 0,
				activeTurnCount: 0,
			});
			const forbidden = await client.request({ frameId: "management-service-open", kind: "command_request", protocolVersion: 1, body: { operation: "session.open", commandId: "management-service-open", mode: "create" } });
			expect(forbidden.body).toMatchObject({ ok: false, code: "management_operation_forbidden" });
			const unfencedRestart = await client.request({
				frameId: "management-service-unfenced-restart",
				kind: "command_request",
				protocolVersion: 1,
				body: { operation: "host.shutdown", commandId: "management-service-unfenced-restart", expectedHostRuntimeId: runtimeId, expectedHostGeneration: 9, reason: "maintenance_restart", confirmActive: false },
			});
			expect(unfencedRestart.body).toMatchObject({ ok: false, code: "host_restart_target_required" });
			const stopped = await client.request({
				frameId: "management-service-stop",
				kind: "command_request",
				protocolVersion: 1,
				body: { operation: "host.shutdown", commandId: "management-service-stop", expectedHostRuntimeId: runtimeId, expectedHostGeneration: 9, reason: "manual_stop", confirmActive: false },
			});
			expect(stopped.body).toMatchObject({ ok: true, accepted: true, reason: "manual_stop" });
			for (let attempt = 0; attempt < 20 && shutdownReason === ""; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 2));
			expect(shutdownReason).toBe("manual_stop");
			await client.close();
		} finally {
			await host.close();
			await rm(root, { recursive: true, force: true });
		}
	});

	it("rebuilds the same session at the Host-owned worktree cwd and advances the session fence", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-host-worktree-rebind-"));
		const socketPath = join(root, "host.sock");
		const hostScope = createHostCompatibilityEnvelope(scope());
		const sessionId = createRuntimeId("session", "worktree-rebind");
		const opens: Array<{ readonly mode: string; readonly sessionId?: string; readonly cwd?: string; readonly sessionGeneration?: number }> = [];
		let closed = 0;
		const host = new ResidentRuntimeHost({
			socketPath,
			scope: hostScope,
			attestor: { attest: async () => ({
				principalId: createRuntimeId("principal", "worktree-rebind"),
				connectionId: createRuntimeId("connection", "worktree-rebind"),
				attestationDigest: digest("worktree-rebind"),
			}) },
			resolveWorkspaceCwd: async () => "/managed/worktree",
			createSession: async (input) => {
				opens.push(input);
				const runtime = fakeSession(sessionId);
				return { ...runtime, close: async () => { closed += 1; } };
			},
		});
		try {
			await host.start();
			const client = await JsonLineHostClient.connect(socketPath);
			await client.request({ frameId: "rebind-init", kind: "initialize_request", protocolVersion: 1, body: { compatibility: hostScope } });
			const opened = await client.request({
				frameId: "rebind-open",
				kind: "command_request",
				protocolVersion: 1,
				body: { operation: "session.open", commandId: "rebind-open-command", mode: "create", cwd: "/source" },
			});
			const claimed = await client.request({
				frameId: "rebind-claim",
				kind: "command_request",
				protocolVersion: 1,
				body: {
					operation: "session.claim_driver",
					commandId: "rebind-claim-command",
					sessionId,
					expectedHostGeneration: opened.body.hostGeneration,
					expectedSessionGeneration: opened.body.sessionGeneration,
					expectedDriverRevision: opened.body.driverRevision,
				},
			});
			const rebound = await client.request({
				frameId: "rebind-worktree",
				kind: "command_request",
				protocolVersion: 1,
				body: {
					operation: "session.rebind_workspace",
					commandId: "rebind-worktree-command",
					sessionId,
					expectedHostGeneration: 1,
					expectedSessionGeneration: 1,
					expectedDriverRevision: claimed.body.driverRevision,
				},
			});

			expect(rebound.body).toMatchObject({ ok: true, sessionId, sessionGeneration: 2, cwdDigest: runtimeDigest("/managed/worktree") });
			expect(opens).toEqual([
				expect.objectContaining({ mode: "create", cwd: "/source" }),
				expect.objectContaining({ mode: "open", sessionId, cwd: "/managed/worktree", sessionGeneration: 2 }),
			]);
			expect(closed).toBe(1);
			await client.close();
		} finally {
			await host.close();
			await rm(root, { recursive: true, force: true });
		}
	});

	it("maps a reverse approval response to the attested driver principal", async () => {
		let requestBody: Record<string, unknown> | undefined;
		const prompter = new HostReversePermissionPrompter(() => ({
			requestDriverResponse: async (_sessionId, body) => {
				requestBody = body;
				return {
					body: { ok: true, decision: "allow-once", decidedBy: "forged-client-principal" },
					principalId: createRuntimeId("principal", "attested-driver"),
				};
			},
		}));
		const prompt: PermissionPrompt = {
			requestId: createRuntimeId("command", "reverse-prompt"),
			sessionId: createRuntimeId("session", "reverse-prompt"),
			toolCallId: createRuntimeId("toolCall", "reverse-prompt"),
			toolName: "bash",
			summary: "write file",
			requests: [{ kind: "filesystem", operation: "write", path: "/workspace/file" }],
			argumentsDigest: digest("reverse-arguments"),
			cwd: "/workspace",
			policyDigest: digest("reverse-policy"),
			createdAt: "2026-08-05T00:00:00.000Z",
			expiresAt: "2026-08-05T00:01:00.000Z",
		};

		await expect(prompter.request(prompt)).resolves.toEqual({
			decision: "allow-once",
			decidedBy: createRuntimeId("principal", "attested-driver"),
		});
		expect(requestBody).toMatchObject({ requestType: "permission", requestId: prompt.requestId, toolName: "bash", summary: "write file" });
	});

	it("decodes session, exec-prefix, and network amendment responses from the driver", async () => {
		const principalId = createRuntimeId("principal", "approval-amendment-driver");
		const responses = [
			{ ok: true, decision: "allow-session" },
			{ ok: true, decision: "allow-with-prefix-rule", prefixRule: ["npm", "test"] },
			{ ok: true, decision: "allow-with-network-rule", host: "api.example", protocol: "https", port: 8443 },
		];
		let index = 0;
		const prompter = new HostReversePermissionPrompter(() => ({
			requestDriverResponse: async () => ({ principalId, body: responses[index++]! }),
		}));
		const approvalPrompt = {
			requestId: createRuntimeId("command", "approval-amendment"),
			sessionId: createRuntimeId("session", "approval-amendment"),
			toolCallId: createRuntimeId("toolCall", "approval-amendment"),
			toolName: "bash",
			summary: "run tests",
			requests: [{ kind: "shell" as const, command: "npm test", cwd: "/workspace", analysis: "known" as const }],
			argumentsDigest: runtimeDigest("approval-amendment-args"),
			cwd: "/workspace",
			policyDigest: runtimeDigest("approval-amendment-policy"),
			createdAt: "2026-08-11T00:00:00.000Z",
			expiresAt: "2026-08-11T00:01:00.000Z",
		} satisfies PermissionPrompt;
		await expect(prompter.request(approvalPrompt)).resolves.toMatchObject({ decision: "allow-session", decidedBy: principalId });
		await expect(prompter.request(approvalPrompt)).resolves.toMatchObject({ decision: "allow-with-prefix-rule", prefixRule: ["npm", "test"], decidedBy: principalId });
		await expect(prompter.request(approvalPrompt)).resolves.toMatchObject({ decision: "allow-with-network-rule", host: "api.example", protocol: "https", port: 8443, decidedBy: principalId });
	});

	it("delivers approval reverse requests only to the driver and resumes the same waiter after driver reconnect", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-host-reverse-approval-"));
		const socketPath = join(root, "host.sock");
		const hostScope = createHostCompatibilityEnvelope(scope());
		let principalCounter = 0;
		const host = new ResidentRuntimeHost({
			socketPath,
			scope: hostScope,
			attestor: {
				attest: async (): Promise<HostConnectionPrincipal> => {
					principalCounter += 1;
					return {
						principalId: createRuntimeId("principal", `reverse-${principalCounter}`),
						connectionId: createRuntimeId("connection", `reverse-${principalCounter}`),
						attestationDigest: digest(`reverse-channel-${principalCounter}`),
					};
				},
			},
			createSession: async () => fakeSession(createRuntimeId("session", "reverse-approval")),
		});
		try {
			await host.start();
			const driver = await JsonLineHostClient.connect(socketPath, {
				reverseRequestHandler: async () => new Promise<Record<string, unknown>>(() => undefined),
			});
			const observer = await JsonLineHostClient.connect(socketPath);
			const initialize = async (client: JsonLineHostClient, frameId: string): Promise<void> => {
				await client.request({
					frameId,
					kind: "initialize_request",
					protocolVersion: HOST_PROTOCOL_VERSION,
					body: { compatibility: hostScope },
				});
			};
			await initialize(driver, "reverse-init-driver");
			await initialize(observer, "reverse-init-observer");
			const opened = await driver.request({
				frameId: "reverse-open",
				kind: "command_request",
				protocolVersion: HOST_PROTOCOL_VERSION,
				body: { operation: "session.open", commandId: "reverse-open-command", mode: "create" },
			});
			const sessionId = String(opened.body.sessionId);
		const claimed = await driver.request({
				frameId: "reverse-claim",
				kind: "command_request",
				protocolVersion: HOST_PROTOCOL_VERSION,
				body: {
					operation: "session.claim_driver",
					commandId: "reverse-claim-command",
					sessionId,
					expectedHostGeneration: opened.body.hostGeneration,
					expectedSessionGeneration: opened.body.sessionGeneration,
					expectedDriverRevision: opened.body.driverRevision,
				},
			});

			const pending = host.requestDriverResponse(sessionId, { requestType: "permission", summary: "write file" }, { timeoutMs: 2_000 });
			await driver.close();
			const replacement = await JsonLineHostClient.connect(socketPath, {
				reverseRequestHandler: async (frame) => ({
					ok: true,
					requestType: frame.body.requestType,
					decision: "allow-once",
				}),
			});
			await initialize(replacement, "reverse-init-replacement");
			const reopened = await replacement.request({
				frameId: "reverse-open-replacement",
				kind: "command_request",
				protocolVersion: HOST_PROTOCOL_VERSION,
				body: { operation: "session.open", commandId: "reverse-open-replacement-command", mode: "open", sessionId },
			});
			const replacementClaim = await replacement.request({
				frameId: "reverse-claim-replacement",
				kind: "command_request",
				protocolVersion: HOST_PROTOCOL_VERSION,
				body: {
					operation: "session.claim_driver",
					commandId: "reverse-claim-replacement-command",
					sessionId,
					expectedHostGeneration: reopened.body.hostGeneration,
					expectedSessionGeneration: reopened.body.sessionGeneration,
					expectedDriverRevision: reopened.body.driverRevision,
				},
			});

			expect(claimed.body.ok).toBe(true);
			expect(replacementClaim.body.ok).toBe(true);
			await expect(pending).resolves.toMatchObject({
				body: { ok: true, requestType: "permission", decision: "allow-once" },
				principalId: createRuntimeId("principal", "reverse-3"),
			});
			await observer.close();
			await replacement.close();
		} finally {
			await host.close();
			await rm(root, { recursive: true, force: true });
		}
	});

	it("forces resync when a subscriber does not acknowledge the bounded cursor window", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-host-ack-window-"));
		const socketPath = join(root, "host.sock");
		const hostScope = createHostCompatibilityEnvelope(scope());
		const runtime = fakeSession(createRuntimeId("session", "ack-window"));
		const host = new ResidentRuntimeHost({
			socketPath,
			scope: hostScope,
			attestor: { attest: async () => ({
				principalId: createRuntimeId("principal", "ack-window"),
				connectionId: createRuntimeId("connection", "ack-window"),
				attestationDigest: digest("ack-window"),
			}) },
			createSession: async () => runtime,
		});
		try {
			await host.start();
			const client = await JsonLineHostClient.connect(socketPath);
			await client.request({ frameId: "ack-init", kind: "initialize_request", protocolVersion: 1, body: { compatibility: hostScope } });
			const opened = await client.request({ frameId: "ack-open", kind: "command_request", protocolVersion: 1, body: { operation: "session.open", commandId: "ack-open-command", mode: "create" } });
			const resync: HostFrameEnvelope[] = [];
			client.onEvent((frame) => { if (frame.kind === "resync_required") resync.push(frame); });
			await client.request({ frameId: "ack-subscribe", kind: "command_request", protocolVersion: 1, body: { operation: "session.subscribe", commandId: "ack-subscribe-command", sessionId: opened.body.sessionId, cursor: 0 } });
			for (let index = 0; index <= 256; index += 1) await runtime.controller.prompt(`event-${index}`);
			for (let attempt = 0; attempt < 100 && resync.length === 0; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 2));
			expect(resync).toHaveLength(1);
			expect(resync[0]?.body).toMatchObject({ sessionId: opened.body.sessionId, safeCursor: 257 });
			client.close();
		} finally {
			await host.close();
			await rm(root, { recursive: true, force: true });
		}
	});

	it("keeps streaming prompt connections alive while subscription cursors are acknowledged", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-host-stream-acks-"));
		const socketPath = join(root, "host.sock");
		const hostScope = createHostCompatibilityEnvelope(scope());
		const sessionId = createRuntimeId("session", "stream-acks");
		const runtime = fakeSession(sessionId, RUNTIME_HOST_BOUNDS.maxPreActivationPending + 8);
		const host = new ResidentRuntimeHost({
			socketPath,
			scope: hostScope,
			attestor: { attest: async () => ({
				principalId: createRuntimeId("principal", "stream-acks"),
				connectionId: createRuntimeId("connection", "stream-acks"),
				attestationDigest: digest("stream-acks"),
			}) },
			createSession: async () => runtime,
		});
		let client: JsonLineHostClient | undefined;
		try {
			await host.start();
			client = await JsonLineHostClient.connect(socketPath);
			await client.request({ frameId: "stream-init", kind: "initialize_request", protocolVersion: 1, body: { compatibility: hostScope } });
			const opened = await client.request({ frameId: "stream-open", kind: "command_request", protocolVersion: 1, body: { operation: "session.open", commandId: "stream-open-command", mode: "create" } });
			await client.request({ frameId: "stream-subscribe", kind: "command_request", protocolVersion: 1, body: { operation: "session.subscribe", commandId: "stream-subscribe-command", sessionId, cursor: 0 } });
			const claimed = await client.request({
				frameId: "stream-claim",
				kind: "command_request",
				protocolVersion: 1,
				body: {
					operation: "session.claim_driver",
					commandId: "stream-claim-command",
					sessionId,
					expectedHostGeneration: opened.body.hostGeneration,
					expectedSessionGeneration: opened.body.sessionGeneration,
					expectedDriverRevision: opened.body.driverRevision,
				},
			});
			client.onEvent((frame) => {
				if (frame.kind !== "subscription_event") return;
				client?.notify({
					frameId: `stream-ack-${String(frame.body.sequence)}`,
					kind: "ack_cursor",
					protocolVersion: 1,
					body: { sessionId, cursor: frame.body.sequence },
				});
			});
			await expect(client.request({
				frameId: "stream-prompt",
				kind: "command_request",
				protocolVersion: 1,
				body: {
					operation: "session.prompt",
					commandId: "stream-prompt-command",
					sessionId,
					text: "stream",
					expectedHostGeneration: opened.body.hostGeneration,
					expectedSessionGeneration: opened.body.sessionGeneration,
					expectedDriverRevision: claimed.body.driverRevision,
				},
			})).resolves.toMatchObject({ body: { ok: true } });
			await expect(client.request({
				frameId: "stream-snapshot",
				kind: "command_request",
				protocolVersion: 1,
				body: { operation: "session.snapshot", commandId: "stream-snapshot-command", sessionId },
			})).resolves.toMatchObject({ body: { ok: true, sessionId } });
		} finally {
			await client?.close();
			await host.close();
			await rm(root, { recursive: true, force: true });
		}
	});

	it("returns prompt failures without closing the Host connection", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-host-prompt-failure-"));
		const socketPath = join(root, "host.sock");
		const hostScope = createHostCompatibilityEnvelope(scope());
		const sessionId = createRuntimeId("session", "prompt-failure");
		const runtime = fakeSession(sessionId);
		runtime.controller.prompt = async () => { throw new Error("model preflight failed"); };
		const host = new ResidentRuntimeHost({
			socketPath,
			scope: hostScope,
			attestor: { attest: async () => ({
				principalId: createRuntimeId("principal", "prompt-failure"),
				connectionId: createRuntimeId("connection", "prompt-failure"),
				attestationDigest: digest("prompt-failure"),
			}) },
			createSession: async () => runtime,
		});
		let client: JsonLineHostClient | undefined;
		try {
			await host.start();
			client = await JsonLineHostClient.connect(socketPath);
			await client.request({ frameId: "failure-init", kind: "initialize_request", protocolVersion: 1, body: { compatibility: hostScope } });
			const opened = await client.request({ frameId: "failure-open", kind: "command_request", protocolVersion: 1, body: { operation: "session.open", commandId: "failure-open-command", mode: "create" } });
			const claimed = await client.request({
				frameId: "failure-claim",
				kind: "command_request",
				protocolVersion: 1,
				body: {
					operation: "session.claim_driver",
					commandId: "failure-claim-command",
					sessionId,
					expectedHostGeneration: opened.body.hostGeneration,
					expectedSessionGeneration: opened.body.sessionGeneration,
					expectedDriverRevision: opened.body.driverRevision,
				},
			});
			await expect(client.request({
				frameId: "failure-prompt",
				kind: "command_request",
				protocolVersion: 1,
				body: {
					operation: "session.prompt",
					commandId: "failure-prompt-command",
					sessionId,
					text: "fail",
					expectedHostGeneration: opened.body.hostGeneration,
					expectedSessionGeneration: opened.body.sessionGeneration,
					expectedDriverRevision: claimed.body.driverRevision,
				},
			})).resolves.toMatchObject({ body: { ok: false, code: "model preflight failed" } });
			await expect(client.request({
				frameId: "failure-snapshot",
				kind: "command_request",
				protocolVersion: 1,
				body: { operation: "session.snapshot", commandId: "failure-snapshot-command", sessionId },
			})).resolves.toMatchObject({ body: { ok: true, sessionId } });
		} finally {
			await client?.close();
			await host.close();
			await rm(root, { recursive: true, force: true });
		}
	});

	it("does not re-execute a durable command after Host restart", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-host-command-restart-"));
		const socketPath = join(root, "host.sock");
		const hostScope = createHostCompatibilityEnvelope(scope());
		const layout = buildRunledgerLayout(root, "posix");
		const principal: HostConnectionPrincipal = {
			principalId: createRuntimeId("principal", "durable-command"),
			connectionId: createRuntimeId("connection", "durable-command"),
			attestationDigest: digest("durable-command-channel"),
		};
		let executions = 0;
		const createHost = (): ResidentRuntimeHost => new ResidentRuntimeHost({
			socketPath,
			scope: hostScope,
			attestor: { attest: async () => principal },
			commandStore: new JsonHostCommandStore({ layout, workspaceStorageKey: hostScope.workspaceStorageKey }),
			createSession: async () => {
				executions += 1;
				return fakeSession(createRuntimeId("session", `durable-${executions}`));
			},
		});
		const request = {
			frameId: "durable-open-first",
			kind: "command_request" as const,
			protocolVersion: HOST_PROTOCOL_VERSION,
			body: { operation: "session.open", commandId: "durable-open-command", mode: "create" },
		};
		try {
			const firstHost = createHost();
			await firstHost.start();
			const firstClient = await JsonLineHostClient.connect(socketPath);
			await firstClient.request({ frameId: "durable-init-first", kind: "initialize_request", protocolVersion: 1, body: { compatibility: hostScope } });
			const first = await firstClient.request(request);
			firstClient.close();
			await firstHost.close();

			const secondHost = createHost();
			await secondHost.start();
			const secondClient = await JsonLineHostClient.connect(socketPath);
			await secondClient.request({ frameId: "durable-init-second", kind: "initialize_request", protocolVersion: 1, body: { compatibility: hostScope } });
			const replay = await secondClient.request({ ...request, frameId: "durable-open-retry" });
			expect(replay.body).toEqual({ ...first.body, requestFrameId: "durable-open-retry" });
			expect(executions).toBe(1);
			secondClient.close();
			await secondHost.close();
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("shares one session controller, fences observer mutation, and deduplicates command retries", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-host-service-"));
		const socketPath = join(root, "host.sock");
		const hostScope = createHostCompatibilityEnvelope(scope());
		const sessions = new Map<string, HostSessionRuntime>();
		let principalCounter = 0;
		const host = new ResidentRuntimeHost({
			socketPath,
			scope: hostScope,
			attestor: {
				attest: async (): Promise<HostConnectionPrincipal> => {
					principalCounter += 1;
					return {
						principalId: createRuntimeId("principal", `service-${principalCounter}`),
						connectionId: createRuntimeId("connection", `service-${principalCounter}`),
						attestationDigest: digest(`channel-${principalCounter}`),
					};
				},
			},
			createSession: async ({ sessionId }) => {
				if (sessionId && sessions.has(sessionId)) return sessions.get(sessionId)!;
				const runtime = fakeSession(sessionId ?? createRuntimeId("session", "shared"));
				sessions.set(runtime.controller.sessionId, runtime);
				return runtime;
			},
		});
		try {
			await host.start();
			const first = await JsonLineHostClient.connect(socketPath);
			const second = await JsonLineHostClient.connect(socketPath);
			const initialize = async (client: JsonLineHostClient, id: string): Promise<void> => {
				const result = await client.request({
					frameId: id,
					kind: "initialize_request",
					protocolVersion: HOST_PROTOCOL_VERSION,
					body: { compatibility: hostScope },
				});
				expect(result.body.accepted).toBe(true);
			};
			await Promise.all([initialize(first, "init-first"), initialize(second, "init-second")]);
			const opened = await first.request({
				frameId: "open",
				kind: "command_request",
				protocolVersion: HOST_PROTOCOL_VERSION,
				body: { operation: "session.open", commandId: "open-command", mode: "create" },
			});
			const sessionId = opened.body.sessionId;
			expect(typeof sessionId).toBe("string");
			await second.request({
				frameId: "open-second",
				kind: "command_request",
				protocolVersion: HOST_PROTOCOL_VERSION,
				body: { operation: "session.open", commandId: "open-second-command", mode: "open", sessionId },
			});
			const firstEvents: string[] = [];
			const secondEvents: string[] = [];
			first.onEvent((frame) => { if (frame.kind === "subscription_event") firstEvents.push(String(frame.body.eventType)); });
			second.onEvent((frame) => { if (frame.kind === "subscription_event") secondEvents.push(String(frame.body.eventType)); });
			await first.request({
				frameId: "subscribe-first",
				kind: "command_request",
				protocolVersion: HOST_PROTOCOL_VERSION,
				body: { operation: "session.subscribe", commandId: "subscribe-first-command", sessionId },
			});
			await second.request({
				frameId: "subscribe-second",
				kind: "command_request",
				protocolVersion: HOST_PROTOCOL_VERSION,
				body: { operation: "session.subscribe", commandId: "subscribe-second-command", sessionId },
			});
			const missingClaimFence = await first.request({
				frameId: "claim-without-fence",
				kind: "command_request",
				protocolVersion: HOST_PROTOCOL_VERSION,
				body: { operation: "session.claim_driver", commandId: "claim-without-fence-command", sessionId },
			});
			expect(missingClaimFence.body).toMatchObject({ ok: false, code: "driver_fence_required" });
			const claimed = await first.request({
				frameId: "claim",
				kind: "command_request",
				protocolVersion: HOST_PROTOCOL_VERSION,
				body: { operation: "session.claim_driver", commandId: "claim-command", sessionId, expectedHostGeneration: opened.body.hostGeneration, expectedSessionGeneration: opened.body.sessionGeneration, expectedDriverRevision: opened.body.driverRevision },
			});
			expect(claimed.body.ok).toBe(true);
				const missingFence = await first.request({
					frameId: "prompt",
					kind: "command_request" as const,
					protocolVersion: HOST_PROTOCOL_VERSION,
					body: { operation: "session.prompt", commandId: "prompt-command", sessionId, text: "hello" },
				});
				expect(missingFence.body).toMatchObject({ ok: false, code: "driver_fence_required" });
				const prompt = {
					frameId: "prompt-fenced",
					kind: "command_request" as const,
					protocolVersion: HOST_PROTOCOL_VERSION,
					body: {
						operation: "session.prompt",
						commandId: "prompt-fenced-command",
						sessionId,
						text: "hello",
						expectedHostGeneration: 1,
						expectedSessionGeneration: 1,
						expectedDriverRevision: claimed.body.driverRevision,
					},
				};
				const promptResult = await first.request(prompt);
				const duplicateResult = await first.request({ ...prompt, frameId: "prompt-retry" });
			expect({ ...promptResult.body, requestFrameId: undefined }).toEqual({ ...duplicateResult.body, requestFrameId: undefined });
				await expect(second.request({
				frameId: "observer-prompt",
				kind: "command_request",
				protocolVersion: HOST_PROTOCOL_VERSION,
					body: {
						operation: "session.prompt",
						commandId: "observer-command",
						sessionId,
						text: "forbidden",
						expectedHostGeneration: 1,
						expectedSessionGeneration: 1,
						expectedDriverRevision: claimed.body.driverRevision,
					},
			})).resolves.toMatchObject({ body: { ok: false, code: "observer_mutation_forbidden" } });
			await new Promise((resolve) => setTimeout(resolve, 10));
				expect(firstEvents).toContain("agent_end");
				expect(secondEvents).toContain("agent_end");
				expect(sessions.get(String(sessionId))?.promptCount).toBe(1);
				const replayClient = await JsonLineHostClient.connect(socketPath);
				await initialize(replayClient, "init-replay");
				await replayClient.request({
					frameId: "open-replay",
					kind: "command_request",
					protocolVersion: HOST_PROTOCOL_VERSION,
					body: { operation: "session.open", commandId: "open-replay-command", mode: "open", sessionId },
				});
				const replay = await replayClient.request({
					frameId: "subscribe-replay",
					kind: "command_request",
					protocolVersion: HOST_PROTOCOL_VERSION,
					body: { operation: "session.subscribe", commandId: "subscribe-replay-command", sessionId, cursor: 0 },
				});
				expect(replay.body).toMatchObject({ ok: true, cursor: 1 });
				expect(replay.body.events).toEqual([
					expect.objectContaining({ sequence: 1, eventType: "agent_end" }),
				]);
				await replayClient.close();
				await first.close();
			await second.close();
		} finally {
			await host.close();
			await rm(root, { recursive: true, force: true });
		}
	});

	it("reuses the resident session for resume instead of reacquiring its ledger", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-host-resume-"));
		const socketPath = join(root, "host.sock");
		const hostScope = createHostCompatibilityEnvelope(scope());
		const runtime = fakeSession(createRuntimeId("session", "resident-resume"));
		let createCalls = 0;
		let principalCounter = 0;
		const host = new ResidentRuntimeHost({
			socketPath,
			scope: hostScope,
			attestor: {
				attest: async (): Promise<HostConnectionPrincipal> => {
					principalCounter += 1;
					return {
						principalId: createRuntimeId("principal", `resume-${principalCounter}`),
						connectionId: createRuntimeId("connection", `resume-${principalCounter}`),
						attestationDigest: digest(`resume-channel-${principalCounter}`),
					};
				},
			},
			createSession: async () => {
				createCalls += 1;
				return runtime;
			},
		});
		try {
			await host.start();
			const client = await JsonLineHostClient.connect(socketPath);
			const initialize = await client.request({
				frameId: "resume-init",
				kind: "initialize_request",
				protocolVersion: HOST_PROTOCOL_VERSION,
				body: { compatibility: hostScope },
			});
			expect(initialize.body.accepted).toBe(true);
			const created = await client.request({
				frameId: "resume-create",
				kind: "command_request",
				protocolVersion: HOST_PROTOCOL_VERSION,
				body: { operation: "session.open", commandId: "resume-create-command", mode: "create" },
			});
			const resumed = await client.request({
				frameId: "resume-open",
				kind: "command_request",
				protocolVersion: HOST_PROTOCOL_VERSION,
				body: { operation: "session.open", commandId: "resume-open-command", mode: "resume" },
			});
			expect(resumed.body.sessionId).toBe(created.body.sessionId);
			expect(createCalls).toBe(1);
			await client.close();
		} finally {
			await host.close();
			await rm(root, { recursive: true, force: true });
		}
	});

	it("replays subscription events from durable storage after a Host restart", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-host-event-restart-"));
		const socketPath = join(root, "host.sock");
		const hostScope = createHostCompatibilityEnvelope(scope());
		const layout = buildRunledgerLayout(join(root, "home"), "posix");
		const eventStore = new JsonlHostEventStore({ layout, workspaceStorageKey: hostScope.workspaceStorageKey });
		const sessionId = createRuntimeId("session", "event-restart");
		const principal = {
			principalId: createRuntimeId("principal", "event-restart"),
			connectionId: createRuntimeId("connection", "event-restart"),
			attestationDigest: digest("event-restart-channel"),
		};
		const createHost = (): ResidentRuntimeHost => new ResidentRuntimeHost({
			socketPath,
			scope: hostScope,
			eventStore,
			attestor: { attest: async () => principal },
			createSession: async () => fakeSession(sessionId),
		});
		let host = createHost();
		try {
			await host.start();
			let client = await JsonLineHostClient.connect(socketPath);
			await client.request({ frameId: "restart-init-1", kind: "initialize_request", protocolVersion: 1, body: { compatibility: hostScope } });
			const opened = await client.request({ frameId: "restart-open-1", kind: "command_request", protocolVersion: 1, body: { operation: "session.open", commandId: "restart-open-command-1", mode: "create" } });
			const claimed = await client.request({ frameId: "restart-claim-1", kind: "command_request", protocolVersion: 1, body: { operation: "session.claim_driver", commandId: "restart-claim-command-1", sessionId, expectedHostGeneration: opened.body.hostGeneration, expectedSessionGeneration: opened.body.sessionGeneration, expectedDriverRevision: opened.body.driverRevision } });
			await client.request({
				frameId: "restart-prompt-1",
				kind: "command_request",
				protocolVersion: 1,
				body: { operation: "session.prompt", commandId: "restart-prompt-command-1", sessionId, text: "persist", expectedHostGeneration: 1, expectedSessionGeneration: 1, expectedDriverRevision: claimed.body.driverRevision },
			});
			await client.close();
			await host.close();

			host = createHost();
			await host.start();
			client = await JsonLineHostClient.connect(socketPath);
			await client.request({ frameId: "restart-init-2", kind: "initialize_request", protocolVersion: 1, body: { compatibility: hostScope } });
			await client.request({ frameId: "restart-open-2", kind: "command_request", protocolVersion: 1, body: { operation: "session.open", commandId: "restart-open-command-2", mode: "open", sessionId } });
			const replay = await client.request({ frameId: "restart-subscribe-2", kind: "command_request", protocolVersion: 1, body: { operation: "session.subscribe", commandId: "restart-subscribe-command-2", sessionId, cursor: 0 } });
			expect(replay.body).toMatchObject({ ok: true, cursor: 1 });
			expect(replay.body.events).toEqual([expect.objectContaining({ sequence: 1, eventType: "agent_end" })]);
			await client.close();
		} finally {
			await host.close();
			await rm(root, { recursive: true, force: true });
		}
	});

	it("keeps the Host resident after client detach and accepts shutdown only from a fenced driver", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-host-residency-"));
		const socketPath = join(root, "host.sock");
		const hostScope = createHostCompatibilityEnvelope(scope());
		let shutdownRequests = 0;
		let principalCounter = 0;
		const host = new ResidentRuntimeHost({
			socketPath,
			scope: hostScope,
			attestor: {
				attest: async (): Promise<HostConnectionPrincipal> => {
					principalCounter += 1;
					return {
						principalId: createRuntimeId("principal", `residency-${principalCounter}`),
						connectionId: createRuntimeId("connection", `residency-${principalCounter}`),
						attestationDigest: digest(`residency-channel-${principalCounter}`),
					};
				},
			},
			createSession: async () => fakeSession(createRuntimeId("session", "residency")),
			onShutdown: async () => { shutdownRequests += 1; },
		});
		try {
			await host.start();
			const first = await JsonLineHostClient.connect(socketPath);
			await first.request({
				frameId: "residency-init-first",
				kind: "initialize_request",
				protocolVersion: HOST_PROTOCOL_VERSION,
				body: { compatibility: hostScope },
			});
				const second = await JsonLineHostClient.connect(socketPath);
			await second.request({
				frameId: "residency-init-second",
				kind: "initialize_request",
				protocolVersion: HOST_PROTOCOL_VERSION,
				body: { compatibility: hostScope },
			});
				const opened = await first.request({
					frameId: "residency-open",
					kind: "command_request",
					protocolVersion: HOST_PROTOCOL_VERSION,
					body: { operation: "session.open", commandId: "residency-open-command", mode: "create" },
				});
				const sessionId = String(opened.body.sessionId);
				const claimed = await first.request({
					frameId: "residency-claim",
					kind: "command_request",
					protocolVersion: HOST_PROTOCOL_VERSION,
					body: { operation: "session.claim_driver", commandId: "residency-claim-command", sessionId, expectedHostGeneration: opened.body.hostGeneration, expectedSessionGeneration: opened.body.sessionGeneration, expectedDriverRevision: opened.body.driverRevision },
				});
				await expect(second.request({
					frameId: "residency-shutdown",
				kind: "command_request",
				protocolVersion: HOST_PROTOCOL_VERSION,
					body: {
						operation: "host.shutdown",
						commandId: "residency-shutdown-command",
						sessionId,
						expectedHostGeneration: 1,
						expectedSessionGeneration: 1,
						expectedDriverRevision: claimed.body.driverRevision,
					},
				})).resolves.toMatchObject({ body: { ok: false, code: "observer_mutation_forbidden" } });
				expect(shutdownRequests).toBe(0);
				await expect(first.request({
					frameId: "residency-driver-shutdown",
					kind: "command_request",
					protocolVersion: HOST_PROTOCOL_VERSION,
					body: {
						operation: "host.shutdown",
						commandId: "residency-driver-shutdown-command",
						sessionId,
						expectedHostGeneration: 1,
						expectedSessionGeneration: 1,
						expectedDriverRevision: claimed.body.driverRevision,
					},
				})).resolves.toMatchObject({ body: { ok: true, accepted: true } });
			for (let attempt = 0; attempt < 20 && shutdownRequests === 0; attempt += 1) {
				await new Promise((resolve) => setTimeout(resolve, 5));
			}
				expect(shutdownRequests).toBe(1);
				await first.close();
			await second.close();
		} finally {
			await host.close();
			await rm(root, { recursive: true, force: true });
		}
	});

	it("rejects an invalid process output cursor before reaching the process port", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-host-output-bound-"));
		const socketPath = join(root, "host.sock");
		const hostScope = createHostCompatibilityEnvelope(scope());
		const runtime = fakeSession(createRuntimeId("session", "output-bound"));
		let outputCalls = 0;
		let waitCalls = 0;
		let createCalls = 0;
		const processPort: HostProcessPort = {
			create: async () => {
				createCalls += 1;
				return { ok: false, code: "unused" };
			},
			list: async () => [],
			output: async () => {
				outputCalls += 1;
				return {
					ok: true,
					page: "",
					startCursor: { sequence: 0, byteOffset: 0 },
					endCursor: { sequence: 0, byteOffset: 0 },
					nextCursor: { sequence: 0, byteOffset: 0 },
					head: { sequence: 0, byteOffset: 0 },
					truncated: false,
				};
			},
			wait: async () => {
				waitCalls += 1;
				return { ok: true as const, outcome: "timed_out" as const, summary: {}, nextCursor: { sequence: 0, byteOffset: 0 } };
			},
			write: async () => ({ ok: false, code: "unused" }),
			eof: async () => ({ ok: false, code: "unused" }),
			resize: async () => ({ ok: false, code: "unused" }),
			stop: async () => ({ ok: false, code: "unused" }),
		};
		let principalCounter = 0;
		const host = new ResidentRuntimeHost({
			socketPath,
			scope: hostScope,
			processPort,
			attestor: {
				attest: async (): Promise<HostConnectionPrincipal> => {
					principalCounter += 1;
					return {
						principalId: createRuntimeId("principal", `output-bound-${principalCounter}`),
						connectionId: createRuntimeId("connection", `output-bound-${principalCounter}`),
						attestationDigest: digest(`output-bound-channel-${principalCounter}`),
					};
				},
			},
			createSession: async () => ({ ...runtime }),
		});
		try {
			await host.start();
			const client = await JsonLineHostClient.connect(socketPath);
			await client.request({
				frameId: "output-bound-init",
				kind: "initialize_request",
				protocolVersion: HOST_PROTOCOL_VERSION,
				body: { compatibility: hostScope },
			});
			const opened = await client.request({
				frameId: "output-bound-open",
				kind: "command_request",
				protocolVersion: HOST_PROTOCOL_VERSION,
				body: { operation: "session.open", commandId: "output-bound-open-command", mode: "create" },
			});
			const result = await client.request({
				frameId: "output-bound-read",
				kind: "command_request",
				protocolVersion: HOST_PROTOCOL_VERSION,
				body: {
					operation: "process.output",
					commandId: "output-bound-read-command",
					sessionId: opened.body.sessionId,
					executionId: createRuntimeId("execution", "output-bound"),
					cursor: -1,
					maxBytes: 64,
				},
			});
			expect(result.body).toMatchObject({ ok: false, code: "output_cursor_invalid" });
			expect(outputCalls).toBe(0);
			const valid = await client.request({
				frameId: "output-bound-read-valid",
				kind: "command_request",
				protocolVersion: HOST_PROTOCOL_VERSION,
				body: {
					operation: "process.output",
					commandId: "output-bound-read-valid-command",
					sessionId: opened.body.sessionId,
					executionId: createRuntimeId("execution", "output-bound"),
					cursor: { sequence: 0, byteOffset: 0 },
					maxBytes: 64,
				},
			});
			expect(valid.body).toMatchObject({ ok: true, nextCursor: { sequence: 0, byteOffset: 0 }, head: { sequence: 0, byteOffset: 0 } });
			expect(outputCalls).toBe(1);
			const waited = await client.request({
				frameId: "output-bound-wait",
				kind: "command_request",
				protocolVersion: HOST_PROTOCOL_VERSION,
				body: {
					operation: "process.wait",
					commandId: "output-bound-wait-command",
					sessionId: opened.body.sessionId,
					executionId: createRuntimeId("execution", "output-bound"),
					timeoutMs: 10,
				},
			});
			expect(waited.body).toMatchObject({ ok: true, outcome: "timed_out" });
			expect(waitCalls).toBe(1);
			await host.closeAdmission();
			const claimed = await client.request({
				frameId: "output-bound-claim-driver",
				kind: "command_request",
				protocolVersion: HOST_PROTOCOL_VERSION,
				body: {
					operation: "session.claim_driver",
					commandId: "output-bound-claim-driver-command",
					sessionId: opened.body.sessionId,
					expectedHostGeneration: opened.body.hostGeneration,
					expectedSessionGeneration: opened.body.sessionGeneration,
					expectedDriverRevision: opened.body.driverRevision,
				},
			});
			expect(claimed.body.ok).toBe(true);
			const rejectedCreate = await client.request({
				frameId: "output-bound-create-after-drain",
				kind: "command_request",
				protocolVersion: HOST_PROTOCOL_VERSION,
				body: {
					operation: "process.create",
					commandId: "output-bound-create-after-drain-command",
					sessionId: opened.body.sessionId,
					command: "true",
					cwd: root,
					backend: "pipe",
					executionMode: "background",
				},
			});
			expect(rejectedCreate.body).toMatchObject({ ok: false, code: "host_admission_closed" });
			expect(createCalls).toBe(0);
			await client.close();
		} finally {
			await host.close();
			await rm(root, { recursive: true, force: true });
		}
	});
});
