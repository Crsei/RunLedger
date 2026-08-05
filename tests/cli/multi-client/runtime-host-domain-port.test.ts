import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRuntimeId } from "../../../src/runtime/protocol/ids.ts";
import { runtimeDigest } from "../../../src/runtime/protocol/foundation.ts";
import { buildRunledgerLayout } from "../../../src/runtime/contracts/storage-layout.ts";
import type { RuntimeEventAppendInput } from "../../../src/storage/host/runtime-event-store.ts";
import { JsonlRuntimeEventStore } from "../../../src/storage/host/runtime-event-store.ts";
import type { RuntimeEventPayloadFor } from "../../../src/runtime/contracts/public.ts";
import { createHostCompatibilityEnvelope, HOST_PROTOCOL_VERSION, type RuntimeHostScope } from "../../../src/runtime/host/contracts.ts";
import type { HostConnectionPrincipal, HostFrameEnvelope } from "../../../src/runtime/host/types.ts";
import { JsonLineHostClient } from "../../../src/cli/runtime-host-transport.ts";
import {
	ResidentRuntimeHost,
	type HostRuntimeDomainPort,
	type HostSessionRuntime,
} from "../../../src/cli/runtime-host-service.ts";
import { createHostModelContextDomainPort } from "../../../src/cli/runtime-host-model-context.ts";
import type { InteractiveSessionControllerPort } from "../../../src/runtime/interactive-session-controller.ts";

function scope(): RuntimeHostScope {
	const digest = (value: string) => runtimeDigest(value);
	return {
		authorityId: createRuntimeId("authority", "domain-port"),
		tenantId: createRuntimeId("tenant", "domain-port"),
		workspaceId: createRuntimeId("workspace", "domain-port"),
		repositoryId: createRuntimeId("repository", "domain-port"),
		workspaceStorageKey: `ws-${"d".repeat(64)}`,
		protocolVersion: HOST_PROTOCOL_VERSION,
		hostBuildDigest: digest("host"),
		compositionDigest: digest("composition"),
		settingsDigest: digest("settings"),
		modelCatalogDigest: digest("models"),
		tracePolicyDigest: digest("trace"),
		securityAdapterDigest: digest("security"),
		extensionProfileDigest: digest("extensions"),
		sessionStorageContractVersion: 1,
		peerAttestor: { kind: "test", generation: 1, configDigest: digest("attestor") },
	};
}

function session(): HostSessionRuntime {
	const controller: InteractiveSessionControllerPort = {
		subscribe: () => () => {},
		sessionId: createRuntimeId("session", "domain-port"),
		inFlight: false,
		currentSelection: { thinkingLevel: "off" },
		messages: [],
		warnings: [],
		auditEntries: [],
		toolCount: 0,
		getSteeringMessages: () => [],
		getFollowUpMessages: () => [],
		getProviderStatuses: async () => [],
		getProvider: () => undefined,
		getAvailableModels: async () => [],
		login: async () => { throw new Error("unused"); },
		logout: async () => {},
		selectModel: async () => {},
		setThinkingLevel: async (level) => level,
		prompt: async () => {},
		interrupt: () => {},
		clearAllQueues: () => ({ steering: [], followUp: [] }),
		waitForIdle: async () => {},
		dispose: () => {},
	};
	return { controller, close: async () => {} };
}

async function request(client: JsonLineHostClient, frameId: string, body: Record<string, unknown>): Promise<HostFrameEnvelope> {
	return client.request({ frameId, kind: "command_request", protocolVersion: HOST_PROTOCOL_VERSION, body: { commandId: frameId, ...body } });
}

describe("resident Host domain ports", () => {
	it("routes a query and a driver-only mutation through the durable Host boundary", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-domain-port-"));
		const hostScope = createHostCompatibilityEnvelope(scope());
		const calls: string[] = [];
		const domain: HostRuntimeDomainPort = {
			name: "fixture-domain",
			queryOperations: new Set(["fixture.inspect"]),
			mutationOperations: new Set(["fixture.apply"]),
			execute: async (context) => {
				calls.push(`${context.operation}:${context.mutation ? "mutation" : "query"}`);
				return {
					ok: true,
					body: { value: context.operation === "fixture.apply" ? "applied" : "inspected" },
					mutated: context.mutation,
				};
			},
		};
		let principalNumber = 0;
		const host = new ResidentRuntimeHost({
			socketPath: join(root, "host.sock"),
			scope: hostScope,
			domainPorts: [domain],
			attestor: {
				attest: async (): Promise<HostConnectionPrincipal> => {
					principalNumber += 1;
					return {
						principalId: createRuntimeId("principal", `domain-${principalNumber}`),
						connectionId: createRuntimeId("connection", `domain-${principalNumber}`),
						attestationDigest: runtimeDigest(`attestation-${principalNumber}`),
					};
				},
			},
			createSession: async () => session(),
		});
		try {
			await host.start();
			const client = await JsonLineHostClient.connect(join(root, "host.sock"));
			await client.request({ frameId: "domain-init", kind: "initialize_request", protocolVersion: HOST_PROTOCOL_VERSION, body: { compatibility: hostScope } });
			const opened = await request(client, "domain-open", { operation: "session.open", mode: "create" });
			const sessionId = opened.body.sessionId;
			const inspected = await request(client, "domain-inspect", { operation: "fixture.inspect", sessionId });
			expect(inspected.body).toMatchObject({ ok: true, value: "inspected" });
			const rejected = await request(client, "domain-apply-observer", { operation: "fixture.apply", sessionId });
			expect(rejected.body).toMatchObject({ ok: false, code: "driver_fence_required" });
			const claimed = await request(client, "domain-claim", {
				operation: "session.claim_driver",
				sessionId,
				expectedHostGeneration: opened.body.hostGeneration,
				expectedSessionGeneration: opened.body.sessionGeneration,
				expectedDriverRevision: opened.body.driverRevision,
			});
			expect(claimed.body.ok).toBe(true);
			const applied = await request(client, "domain-apply", {
				operation: "fixture.apply",
				sessionId,
				expectedHostGeneration: claimed.body.hostGeneration ?? opened.body.hostGeneration,
				expectedSessionGeneration: claimed.body.sessionGeneration ?? opened.body.sessionGeneration,
				expectedDriverRevision: claimed.body.driverRevision,
				expectedDomainRevision: 0,
			});
			expect(applied.body).toMatchObject({ ok: true, value: "applied" });
			expect(calls).toEqual(["fixture.inspect:query", "fixture.apply:mutation"]);
			const replay = await request(client, "domain-apply", {
				operation: "fixture.apply",
				sessionId,
				expectedHostGeneration: claimed.body.hostGeneration ?? opened.body.hostGeneration,
				expectedSessionGeneration: claimed.body.sessionGeneration ?? opened.body.sessionGeneration,
				expectedDriverRevision: claimed.body.driverRevision,
				expectedDomainRevision: 0,
			});
			expect(replay.body).toMatchObject({ ok: true, value: "applied" });
			expect(calls).toHaveLength(2);
			const query = await client.request({
				frameId: "domain-query-frame",
				kind: "query_request",
				protocolVersion: HOST_PROTOCOL_VERSION,
				body: { operation: "fixture.inspect", sessionId },
			});
			expect(query.kind).toBe("query_result");
			expect(query.body).toMatchObject({ ok: true, value: "inspected" });
			expect(calls).toEqual(["fixture.inspect:query", "fixture.apply:mutation", "fixture.inspect:query"]);
			await client.close();
		} finally {
			await host.close();
			await rm(root, { recursive: true, force: true });
		}
	});

	it("writes domain events through the injected canonical writer and returns its receipt", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-domain-events-"));
		const hostScope = createHostCompatibilityEnvelope(scope());
		const eventStore = new JsonlRuntimeEventStore({
			layout: buildRunledgerLayout(root, "posix"),
			workspaceStorageKey: hostScope.workspaceStorageKey,
		});
		const eventSessionId = createRuntimeId("session", "domain-event");
		const traceId = createRuntimeId("trace", "domain-event");
		const approvalId = createRuntimeId("approval", "domain-event");
		const payload: RuntimeEventPayloadFor<"permission.requested"> = {
			subject: { kind: "approval", id: approvalId },
			correlationId: traceId,
			effect: "none",
			idempotencyKey: "domain-event-requested",
			transition: { revision: 0, previousStatus: null, nextStatus: "pending" },
			bindings: [{ role: "session", subjectId: eventSessionId }],
			refs: [{ subjectKind: "receipt", digest: runtimeDigest("domain-event-ref"), mediaType: "application/json", size: 0 }],
		};
		const event: RuntimeEventAppendInput = {
			authorityId: hostScope.authorityId,
			tenantId: hostScope.tenantId,
			principalId: createRuntimeId("principal", "domain-event"),
			sessionId: eventSessionId,
			traceId,
			type: "permission.requested",
			payload,
		};
		const domain: HostRuntimeDomainPort = {
			name: "event-domain",
			mutationOperations: new Set(["event.apply"]),
			execute: async () => ({ ok: true, body: { value: "applied" }, events: [event] }),
		};
		let principalNumber = 0;
		const host = new ResidentRuntimeHost({
			socketPath: join(root, "host.sock"),
			scope: hostScope,
			domainPorts: [domain],
			runtimeEventWriter: eventStore,
			attestor: {
				attest: async (): Promise<HostConnectionPrincipal> => {
					principalNumber += 1;
					return {
						principalId: createRuntimeId("principal", `event-${principalNumber}`),
						connectionId: createRuntimeId("connection", `event-${principalNumber}`),
						attestationDigest: runtimeDigest(`attestation-event-${principalNumber}`),
					};
				},
			},
			createSession: async () => session(),
		});
		try {
			await host.start();
			const client = await JsonLineHostClient.connect(join(root, "host.sock"));
			await client.request({ frameId: "event-init", kind: "initialize_request", protocolVersion: HOST_PROTOCOL_VERSION, body: { compatibility: hostScope } });
			const opened = await request(client, "event-open", { operation: "session.open", mode: "create" });
			const sessionId = opened.body.sessionId;
			const claimed = await request(client, "event-claim", {
				operation: "session.claim_driver",
				sessionId,
				expectedHostGeneration: opened.body.hostGeneration,
				expectedSessionGeneration: opened.body.sessionGeneration,
				expectedDriverRevision: opened.body.driverRevision,
			});
			const applied = await request(client, "event-apply", {
				operation: "event.apply",
				sessionId,
				expectedHostGeneration: claimed.body.hostGeneration,
				expectedSessionGeneration: claimed.body.sessionGeneration,
				expectedDriverRevision: claimed.body.driverRevision,
				expectedDomainRevision: 0,
			});
			expect(applied.body).toMatchObject({ ok: true, value: "applied", domainRevision: 1 });
			expect(applied.body.eventReceipts).toHaveLength(1);
			expect(await eventStore.read(eventSessionId)).toHaveLength(1);
			await client.close();
		} finally {
			await host.close();
			await rm(root, { recursive: true, force: true });
		}
	});

	it("runs Plan Mode through the resident Host command journal and canonical event writer", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-host-plan-command-"));
		const layout = buildRunledgerLayout(root, "posix");
		const hostScope = createHostCompatibilityEnvelope(scope());
		const eventStore = new JsonlRuntimeEventStore({ layout, workspaceStorageKey: hostScope.workspaceStorageKey });
		const domain = createHostModelContextDomainPort({
			layout,
			workspaceStorageKey: hostScope.workspaceStorageKey,
			authorityId: hostScope.authorityId,
			tenantId: hostScope.tenantId,
			workspaceId: hostScope.workspaceId,
			policyCeilingDigest: runtimeDigest("plan-policy"),
			clock: () => new Date("2026-08-05T00:00:00.000Z"),
		});
		let principalNumber = 0;
		const host = new ResidentRuntimeHost({
			socketPath: join(root, "host.sock"),
			scope: hostScope,
			domainPorts: [domain],
			runtimeEventWriter: eventStore,
			attestor: {
				attest: async (): Promise<HostConnectionPrincipal> => {
					principalNumber += 1;
					return {
						principalId: createRuntimeId("principal", `plan-command-${principalNumber}`),
						connectionId: createRuntimeId("connection", `plan-command-${principalNumber}`),
						attestationDigest: runtimeDigest(`plan-attestation-${principalNumber}`),
					};
				},
			},
			createSession: async () => session(),
		});
		try {
			await host.start();
			const client = await JsonLineHostClient.connect(join(root, "host.sock"));
			await client.request({ frameId: "plan-init", kind: "initialize_request", protocolVersion: HOST_PROTOCOL_VERSION, body: { compatibility: hostScope } });
			const opened = await request(client, "plan-open", { operation: "session.open", mode: "create" });
			const sessionId = opened.body.sessionId as string;
			const claimed = await request(client, "plan-claim", {
				operation: "session.claim_driver",
				sessionId,
				expectedHostGeneration: opened.body.hostGeneration,
				expectedSessionGeneration: opened.body.sessionGeneration,
				expectedDriverRevision: opened.body.driverRevision,
			});
			const fence = {
				expectedHostGeneration: claimed.body.hostGeneration,
				expectedSessionGeneration: claimed.body.sessionGeneration,
				expectedDriverRevision: claimed.body.driverRevision,
			};
			const entered = await request(client, "plan-enter", {
				operation: "plan.enter",
				sessionId,
				expectedRevision: 0,
				requestedBy: "user",
				expectedDomainRevision: 0,
				...fence,
			});
			expect(entered.body).toMatchObject({ ok: true, state: { status: "pending", revision: 1 }, domainRevision: 1 });
			expect(entered.body.eventReceipts).toHaveLength(1);
			expect(await eventStore.read(sessionId as ReturnType<typeof createRuntimeId<"session">>)).toHaveLength(1);

			const replay = await request(client, "plan-enter", {
				operation: "plan.enter",
				sessionId,
				expectedRevision: 0,
				requestedBy: "user",
				expectedDomainRevision: 0,
				...fence,
			});
			expect(replay.body).toMatchObject({ ok: true, state: { status: "pending", revision: 1 }, domainRevision: 1 });
			expect(await eventStore.read(sessionId as ReturnType<typeof createRuntimeId<"session">>)).toHaveLength(1);

			const inspected = await client.request({ frameId: "plan-inspect", kind: "query_request", protocolVersion: HOST_PROTOCOL_VERSION, body: { operation: "plan.inspect", sessionId } });
			expect(inspected.body).toMatchObject({ ok: true, state: { status: "pending", revision: 1 } });
			await client.close();
		} finally {
			await host.close();
			await rm(root, { recursive: true, force: true });
		}
	});
});
