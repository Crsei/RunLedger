import { describe, expect, it } from "vitest";
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
import type { HostConnectionPrincipal } from "../../../src/runtime/host/types.ts";
import { JsonLineHostClient } from "../../../src/cli/runtime-host-transport.ts";
import { ResidentRuntimeHost, type HostProcessPort, type HostSessionRuntime } from "../../../src/cli/runtime-host-service.ts";

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

function fakeSession(sessionId = createRuntimeId("session", "service")): HostSessionRuntime {
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
			const event: AgentEvent = {
				type: "agent_end",
				timestamp: Date.now(),
				message: { role: "assistant", content: [{ type: "text", text }], stopReason: "stop" },
			};
			for (const listener of listeners) await listener(event);
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

describe("production Resident Runtime Host service", () => {
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
			const claimed = await first.request({
				frameId: "claim",
				kind: "command_request",
				protocolVersion: HOST_PROTOCOL_VERSION,
				body: { operation: "session.claim_driver", commandId: "claim-command", sessionId },
			});
			expect(claimed.body.ok).toBe(true);
			const prompt = {
				frameId: "prompt",
				kind: "command_request" as const,
				protocolVersion: HOST_PROTOCOL_VERSION,
				body: { operation: "session.prompt", commandId: "prompt-command", sessionId, text: "hello" },
			};
			const promptResult = await first.request(prompt);
			const duplicateResult = await first.request({ ...prompt, frameId: "prompt-retry" });
			expect({ ...promptResult.body, requestFrameId: undefined }).toEqual({ ...duplicateResult.body, requestFrameId: undefined });
			await expect(second.request({
				frameId: "observer-prompt",
				kind: "command_request",
				protocolVersion: HOST_PROTOCOL_VERSION,
				body: { operation: "session.prompt", commandId: "observer-command", sessionId, text: "forbidden" },
			})).resolves.toMatchObject({ body: { ok: false, code: "observer_mutation_forbidden" } });
			await new Promise((resolve) => setTimeout(resolve, 10));
			expect(firstEvents).toContain("agent_end");
			expect(secondEvents).toContain("agent_end");
			expect(sessions.get(String(sessionId))?.promptCount).toBe(1);
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

	it("keeps the Host resident after client detach and only accepts explicit shutdown", async () => {
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
			await first.close();
			await new Promise((resolve) => setTimeout(resolve, 10));
			expect(shutdownRequests).toBe(0);

			const second = await JsonLineHostClient.connect(socketPath);
			await second.request({
				frameId: "residency-init-second",
				kind: "initialize_request",
				protocolVersion: HOST_PROTOCOL_VERSION,
				body: { compatibility: hostScope },
			});
			await expect(second.request({
				frameId: "residency-shutdown",
				kind: "command_request",
				protocolVersion: HOST_PROTOCOL_VERSION,
				body: { operation: "host.shutdown", commandId: "residency-shutdown-command" },
			})).resolves.toMatchObject({ body: { ok: true, accepted: true } });
			for (let attempt = 0; attempt < 20 && shutdownRequests === 0; attempt += 1) {
				await new Promise((resolve) => setTimeout(resolve, 5));
			}
			expect(shutdownRequests).toBe(1);
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
