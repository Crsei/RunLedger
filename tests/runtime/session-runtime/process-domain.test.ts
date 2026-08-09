import { afterEach, describe, expect, it } from "vitest";
import type { SessionProtocolOperationDescriptor } from "../../../src/runtime/session-server/protocol.ts";
import type { SessionDomainPort } from "../../../src/runtime/session-runtime/session-runtime.ts";
import { createRuntimeHarness, type RuntimeHarness } from "./harness.ts";
import { SessionClient } from "../../../src/cli/session-client.ts";
import { SessionInteractiveController } from "../../../src/cli/session-interactive-controller.ts";

let harness: RuntimeHarness | undefined;

afterEach(async () => {
	if (harness === undefined) return;
	await harness.server.close();
	harness.store.database().close();
	harness.cleanup();
	harness = undefined;
});

describe("S4 Session process domain", () => {
	it("advertises session.process only when a real process domain is composed", async () => {
		const operationManifest: readonly SessionProtocolOperationDescriptor[] = [
			{ operation: "session.process.list", capability: "session.process", access: "read" },
		];
		const domain = {
			controller: {
				subscribe: () => () => undefined,
			} as unknown as SessionDomainPort["controller"],
			process: {
				operationManifest,
			},
			snapshot: () => ({
				messages: [],
				warnings: [],
				auditEntries: [],
				selection: { thinkingLevel: "off" as const },
				toolCount: 0,
				inFlight: false,
				providerStatuses: [],
			}),
		} as unknown as SessionDomainPort;

		harness = await createRuntimeHarness("process-capability", { domain });
		const manifest = harness.runtime.protocolManifest();

		expect(manifest.protocolCapabilities).toContain("session.process");
		expect(manifest.operationManifest).toContainEqual(operationManifest[0]);
	});

	it("routes a bounded process list query through the Session process domain", async () => {
		const executionId = "execution_process-list";
		const domain = {
			controller: {
				subscribe: () => () => undefined,
			} as unknown as SessionDomainPort["controller"],
			process: {
				operationManifest: [
					{ operation: "session.process.list", capability: "session.process", access: "read" },
				],
				query: async (operation: string) => ({
					ok: true,
					status: "ok",
					operation,
					domainRevision: 7,
					value: { items: [{ executionId, state: "running" }] },
				}),
			},
			snapshot: () => ({
				messages: [], warnings: [], auditEntries: [], selection: { thinkingLevel: "off" as const },
				toolCount: 0, inFlight: false, providerStatuses: [],
			}),
		} as unknown as SessionDomainPort;
		harness = await createRuntimeHarness("process-list", { domain });

		const result = await harness.runtime.handleQuery({
			kind: "domain_query",
			body: {
				sessionId: harness.sessionId,
				generation: harness.fence.generation,
				correlationId: "correlation_process_list",
				effectId: "effect_process_list",
				operation: "session.process.list",
				payload: {},
			},
		});

		expect(result).toMatchObject({
			ok: true,
			status: "ok",
			operation: "session.process.list",
			value: { items: [{ executionId, state: "running" }] },
		});
	});

	it("routes driver process mutations and rejects observers before the process backend", async () => {
		let mutationCalls = 0;
		const domain = {
			controller: {
				subscribe: () => () => undefined,
			} as unknown as SessionDomainPort["controller"],
			process: {
				operationManifest: [
					{ operation: "session.process.stop", capability: "session.process", access: "mutate" },
				],
				query: async () => ({ ok: false, status: "unavailable", code: "not_used", operation: "session.process.stop" }),
				mutate: async (operation: string) => {
					mutationCalls += 1;
					return {
						ok: true,
						status: "ok",
						operation,
						domainRevision: 3,
						value: { executionId: "execution_stop", outcome: "accepted" },
					};
				},
			},
			snapshot: () => ({
				messages: [], warnings: [], auditEntries: [], selection: { thinkingLevel: "off" as const },
				toolCount: 0, inFlight: false, providerStatuses: [],
			}),
		} as unknown as SessionDomainPort;
		harness = await createRuntimeHarness("process-stop", { domain });
		const request = {
			commandId: "command_process_stop",
			kind: "domain_command",
			body: {
				sessionId: harness.sessionId,
				generation: harness.fence.generation,
				correlationId: "correlation_process_stop",
				effectId: "effect_process_stop",
				operation: "session.process.stop",
				expectedRevision: 2,
				payload: { executionId: "execution_stop" },
			},
		};
		const observer = await harness.runtime.handleCommand(request, {
			connectionId: "connection_process_observer" as never,
			clientId: "observer",
			isDriver: false,
		});
		expect(observer).toEqual({ ok: false, code: "observer_mutation_forbidden" });
		expect(mutationCalls).toBe(0);

		const driver = await harness.runtime.handleCommand(request, {
			connectionId: "connection_process_driver" as never,
			clientId: "driver",
			isDriver: true,
		});
		expect(driver).toMatchObject({
			ok: true,
			result: { ok: true, status: "ok", operation: "session.process.stop" },
		});
		expect(mutationCalls).toBe(1);
	});

	it("lets a TCP observer read process state but rejects mutation before domain dispatch", async () => {
		let mutationCalls = 0;
		const domain = {
			controller: { subscribe: () => () => undefined } as unknown as SessionDomainPort["controller"],
			process: {
				operationManifest: [
					{ operation: "session.process.list", capability: "session.process", access: "read" },
					{ operation: "session.process.stop", capability: "session.process", access: "mutate" },
				],
				query: async (operation: string) => ({
					ok: true, status: "ok", operation, domainRevision: 4,
					value: { items: [{ executionId: "execution_tcp_observer", state: "running" }] },
				}),
				mutate: async (operation: string) => {
					mutationCalls += 1;
					return { ok: true, status: "ok", operation, domainRevision: 5, value: {} };
				},
			},
			snapshot: () => ({
				messages: [], warnings: [], auditEntries: [], selection: { thinkingLevel: "off" as const },
				toolCount: 0, inFlight: false, providerStatuses: [],
			}),
		} as unknown as SessionDomainPort;
		harness = await createRuntimeHarness("process-tcp-observer", { domain });
		const owner = harness.ownerStore.readOwner(harness.sessionId);
		expect(owner).toBeDefined();
		if (owner === undefined) return;
		const client = new SessionClient({ store: harness.store, ownerStore: harness.ownerStore, claimTransport: harness.server });
		const attached = await client.attachTo(owner, harness.server.endpoint, harness.owner.currentAuthToken);
		expect(attached).toMatchObject({ ok: true });
		if (!attached.ok) return;
		const controller = new SessionInteractiveController(attached.handle, {
			sessionId: harness.sessionId,
			messages: [], warnings: [], auditEntries: [], selection: { thinkingLevel: "off" },
			toolCount: 0, eventCursor: 0, driverRevision: 0, agentRuns: [],
		});
		try {
			await expect(controller.querySessionDomain("session.process.list", {}, {
				correlationId: "correlation_tcp_process_list",
				effectId: "effect_tcp_process_list",
			})).resolves.toMatchObject({ ok: true, value: { items: [{ executionId: "execution_tcp_observer" }] } });
			await expect(controller.commandSessionDomain("session.process.stop", { executionId: "execution_tcp_observer" }, {
				correlationId: "correlation_tcp_process_stop",
				effectId: "effect_tcp_process_stop",
				expectedRevision: 4,
			})).resolves.toMatchObject({ ok: false, code: "driver_required" });
			expect(mutationCalls).toBe(0);
		} finally {
			controller.dispose();
			await attached.handle.close();
		}
	});

	it("keeps the recovery barrier open while a takeover has uncertain processes", async () => {
		let mutationCalls = 0;
		const domain = {
			controller: { subscribe: () => () => undefined } as unknown as SessionDomainPort["controller"],
			process: {
				operationManifest: [
					{ operation: "session.process.start", capability: "session.process", access: "mutate" },
				],
				query: async () => ({ ok: false, status: "unavailable", code: "not_used", operation: "session.process.start" }),
				mutate: async () => {
					mutationCalls += 1;
					return { ok: false, status: "failed", code: "must_not_run", operation: "session.process.start" };
				},
				hasRecoveryUncertainty: () => true,
			},
			snapshot: () => ({
				messages: [], warnings: [], auditEntries: [], selection: { thinkingLevel: "off" as const },
				toolCount: 0, inFlight: false, providerStatuses: [],
			}),
		} as unknown as SessionDomainPort;
		harness = await createRuntimeHarness("process-recovery-barrier", { crashTakeover: true, domain });

		expect(harness.runtime.recoveryAssess()).toMatchObject({ barrierState: "open" });
		const result = await harness.runtime.handleCommand({
			commandId: "command_process_recovery",
			kind: "domain_command",
			body: {
				sessionId: harness.sessionId,
				generation: harness.fence.generation,
				correlationId: "correlation_process_recovery",
				effectId: "effect_process_recovery",
				operation: "session.process.start",
				expectedRevision: 0,
				payload: { command: "must-not-run" },
			},
		}, {
			connectionId: "connection_process_recovery" as never,
			clientId: "driver",
			isDriver: true,
		});
		expect(result).toMatchObject({
			ok: true,
			result: { ok: false, status: "recovery_required", code: "recovery_barrier_active" },
		});
		expect(mutationCalls).toBe(0);
	});
});
