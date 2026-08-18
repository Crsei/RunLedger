import { afterEach, describe, expect, it } from "vitest";
import { SessionClient } from "../../../src/cli/session-client.ts";
import { SessionInteractiveController } from "../../../src/cli/session-interactive-controller.ts";
import type { AgentEvent, AgentMessage } from "../../../src/runtime/types.ts";
import type { EphemeralTurnDiagnostic } from "../../../src/runtime/agent.ts";
import type { EphemeralSessionTurnRequest, InteractiveSessionControllerPort, RuntimeSelection } from "../../../src/runtime/interactive-session-controller.ts";
import type { SessionDomainPort, SessionDomainSnapshot } from "../../../src/runtime/session-runtime/session-runtime.ts";
import type { Model, Api } from "../../../src/types.ts";
import { mockModel } from "../../../src/index.ts";
import { createRuntimeHarness, type RuntimeHarness } from "./harness.ts";

interface FakeRecapDomain {
	readonly domain: SessionDomainPort;
	readonly requests: EphemeralSessionTurnRequest[];
	emit(event: AgentEvent): void;
	resolveNext(reply: string | undefined): void;
	selectModel(model: Model<Api>): void;
}

function createFakeRecapDomain(): FakeRecapDomain {
	const listeners = new Set<(event: AgentEvent) => void>();
	const requests: EphemeralSessionTurnRequest[] = [];
	const resolvers: Array<(reply: string | undefined) => void> = [];
	const messages: readonly AgentMessage[] = [{ role: "user", content: [{ type: "text", text: "ship the feature" }] }];
	let selection: RuntimeSelection = { provider: mockModel.provider, model: mockModel, thinkingLevel: "off" };
	const controller = {
		sessionId: "fake-session",
		get inFlight() { return false; },
		get currentSelection() { return selection; },
		messages,
		warnings: [],
		auditEntries: [],
		toolCount: 1,
		subscribe(listener: (event: AgentEvent) => void) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		getSteeringMessages: () => [],
		getFollowUpMessages: () => [],
		getProviderStatuses: async () => [],
		getProvider: () => undefined,
		getAvailableModels: async () => [],
		login: async () => ({ type: "api_key" }),
		logout: async () => undefined,
		selectModel: async (model: Model<Api>) => { selection = { ...selection, provider: model.provider, model }; },
		setThinkingLevel: async (level: "off") => { selection = { ...selection, thinkingLevel: level }; return level; },
		prompt: async () => undefined,
		runEphemeralTurn: async (request: EphemeralSessionTurnRequest) => {
			requests.push(request);
			return await new Promise<string | undefined>((resolve) => resolvers.push(resolve));
		},
		notifyEditorActivity: () => undefined,
		interrupt: () => undefined,
		clearAllQueues: () => ({ steering: [], followUp: [] }),
		waitForIdle: async () => undefined,
		dispose: () => undefined,
	} as unknown as InteractiveSessionControllerPort;
	const domainSnapshot = (): SessionDomainSnapshot => ({
		messages,
		warnings: [],
		auditEntries: [],
		selection,
		toolCount: 1,
		inFlight: false,
		providerStatuses: [],
	});
	return {
		domain: { controller, snapshot: domainSnapshot },
		requests,
		emit(event) { for (const listener of listeners) listener(event); },
		resolveNext(reply) {
			const resolve = resolvers.shift();
			if (resolve === undefined) throw new Error("no pending recap request");
			resolve(reply);
		},
		selectModel(model) { selection = { ...selection, provider: model.provider, model }; },
	};
}

function frameId(prefix: string): string {
	return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

async function command(harness: RuntimeHarness, transport: { request(frame: any): Promise<any> }, kind: string, body: Record<string, unknown>): Promise<any> {
	return await transport.request({
		frameId: frameId(kind),
		kind: "command_request",
		protocolVersion: 3,
		body: { commandId: frameId(`command-${kind}`), kind, body },
	});
}

async function attachController(harness: RuntimeHarness, clientId: string, eventCursor = harness.runtime.currentHeadSequence(), onFrame?: (frame: unknown) => void): Promise<{ readonly handle: Awaited<ReturnType<SessionClient["attachTo"]>> extends { ok: true; handle: infer H } ? H : never; readonly controller: SessionInteractiveController }> {
	const client = new SessionClient({ store: harness.store, ownerStore: harness.ownerStore, claimTransport: harness.server, clientId: `client_${clientId}` as never });
	const record = harness.ownerStore.readOwner(harness.sessionId);
	if (record === undefined || harness.server.endpoint === undefined) throw new Error("owner is not attachable");
	const opened = await client.attachTo(record, harness.server.endpoint, harness.owner.currentAuthToken);
	if (!opened.ok) throw new Error(`attach failed: ${opened.code}`);
	onFrame && opened.handle.transport.onEvent(onFrame as (frame: any) => void);
	const snapshot = harness.runtime.domainSnapshot();
	const controller = new SessionInteractiveController(opened.handle, {
		sessionId: harness.sessionId,
		messages: snapshot.messages as AgentMessage[],
		warnings: snapshot.warnings as string[],
		auditEntries: snapshot.auditEntries as never[],
		selection: snapshot.selection as RuntimeSelection,
		toolCount: Number(snapshot.toolCount ?? 0),
		eventCursor,
		driverRevision: harness.server.driverRevision(),
	});
	await controller.resumeEvents();
	return { handle: opened.handle as never, controller };
}

async function waitForRequests(domain: FakeRecapDomain, count: number): Promise<void> {
	const deadline = Date.now() + 2_500;
	while (domain.requests.length < count && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	if (domain.requests.length < count) throw new Error(`expected ${count} recap request(s), got ${domain.requests.length}`);
}

async function closeHarness(harness: RuntimeHarness, controllers: readonly SessionInteractiveController[], handles: readonly { close(): Promise<void> }[]): Promise<void> {
	for (const controller of controllers) controller.dispose();
	for (const handle of handles) await handle.close().catch(() => undefined);
	await harness.server.close();
	harness.store.database().close();
	harness.cleanup();
}

describe("SessionRuntime idle recap production composition", () => {
	afterEach(() => {
		// Keep each test's real timer isolated; the production timer is intentionally real here.
	});

	it("arms after agent_end, sends transient status only to the driver, and leaves durable state unchanged", async () => {
		const domain = createFakeRecapDomain();
		const harness = await createRuntimeHarness("idle-recap-driver", { domain: domain.domain, recapSettings: { enabled: true, idleSeconds: 1 } });
		const driver = await attachController(harness, "idle-recap-driver-client");
		const observer = await attachController(harness, "idle-recap-observer-client");
		let late: Awaited<ReturnType<typeof attachController>> | undefined;
		const driverEvents: unknown[] = [];
		const observerEvents: unknown[] = [];
		driver.controller.subscribeIdleRecap?.((event) => driverEvents.push(event));
		observer.controller.subscribeIdleRecap?.((event) => observerEvents.push(event));
		try {
			const claim = await command(harness, driver.handle.transport, "driver_claim", {});
			expect(claim.body).toMatchObject({ ok: true });
			expect(driver.handle.supports("session.editor.activity")).toBe(true);
			const observerMutation = await command(harness, observer.handle.transport, "editor_activity", { empty: false });
			expect(observerMutation.body).toMatchObject({ ok: false, code: "observer_mutation_forbidden" });

			domain.emit({ type: "agent_end", timestamp: Date.now(), runId: "run-idle-recap", stopReason: "stop", messageCountAtEnd: 1 });
			await waitForRequests(domain, 1);
			const request = domain.requests[0]!;
			expect(request.kind).toBe("idle-recap");
			const durableBeforeReply = harness.store.replaySessionEvents(harness.sessionId);
			domain.resolveNext("Goal: ship the feature; next, run the focused tests.");
			await new Promise((resolve) => setTimeout(resolve, 50));

			expect(driverEvents).toEqual([expect.objectContaining({ text: "Goal: ship the feature; next, run the focused tests." })]);
			expect(observerEvents).toEqual([]);
			expect(harness.store.replaySessionEvents(harness.sessionId)).toEqual(durableBeforeReply);
			expect(harness.store.replaySessionEvents(harness.sessionId).some((event) => event.eventType === "session.idle_recap")).toBe(false);
			expect(harness.runtime.currentHeadSequence()).toBe(harness.store.replaySessionEvents(harness.sessionId).at(-1)?.sequence);

			const lateFrames: unknown[] = [];
			late = await attachController(harness, "idle-recap-late-client", 0, (frame) => lateFrames.push(frame));
			await new Promise((resolve) => setTimeout(resolve, 50));
			expect(lateFrames.some((frame) => (frame as { body?: { eventType?: string } }).body?.eventType === "session.idle_recap")).toBe(false);

			driver.controller.notifyEditorActivity?.(false);
			await new Promise((resolve) => setTimeout(resolve, 50));
			expect(driverEvents.at(-1)).toMatchObject({ cleared: true, activityGeneration: expect.any(Number) });
			expect(observerEvents).toEqual([]);

			expect((await command(harness, driver.handle.transport, "driver_release", {})).body).toMatchObject({ ok: true });
			domain.emit({ type: "agent_end", timestamp: Date.now(), runId: "run-without-driver", stopReason: "stop", messageCountAtEnd: 1 });
			await new Promise((resolve) => setTimeout(resolve, 50));
			expect(domain.requests).toHaveLength(1);
		} finally {
			await closeHarness(harness, [driver.controller, observer.controller, ...(late === undefined ? [] : [late.controller])], [driver.handle, observer.handle, ...(late === undefined ? [] : [late.handle])]);
		}
	});

	it("discards an in-flight completion after a selection change and accepts only the new idle epoch", async () => {
		const domain = createFakeRecapDomain();
		const harness = await createRuntimeHarness("idle-recap-selection", { domain: domain.domain, recapSettings: { enabled: true, idleSeconds: 1 } });
		const driver = await attachController(harness, "idle-recap-selection-client");
		const events: unknown[] = [];
		driver.controller.subscribeIdleRecap?.((event) => events.push(event));
		try {
			expect((await command(harness, driver.handle.transport, "driver_claim", {})).body).toMatchObject({ ok: true });
			domain.emit({ type: "agent_end", timestamp: Date.now(), runId: "run-selection-1", stopReason: "stop", messageCountAtEnd: 1 });
			await waitForRequests(domain, 1);
			const otherModel = { ...mockModel, id: `${mockModel.id}-changed` };
			const selectionChange = await command(harness, driver.handle.transport, "select_model", { provider: otherModel.provider, model: otherModel.id });
			expect(selectionChange.body).toMatchObject({ ok: true });
			domain.resolveNext("stale selection reply");
			await new Promise((resolve) => setTimeout(resolve, 50));
			expect(events).toEqual([]);

			domain.emit({ type: "agent_end", timestamp: Date.now(), runId: "run-selection-2", stopReason: "stop", messageCountAtEnd: 1 });
			await waitForRequests(domain, 2);
			domain.resolveNext("current selection reply");
			await new Promise((resolve) => setTimeout(resolve, 50));
			expect(events).toEqual([expect.objectContaining({ text: "current selection reply" })]);
		} finally {
			await closeHarness(harness, [driver.controller], [driver.handle]);
		}
	});

	it("publishes a typed provider diagnostic transiently without projecting success or mutating durable state", async () => {
		const domain = createFakeRecapDomain();
		const harness = await createRuntimeHarness("idle-recap-diagnostic", { domain: domain.domain, recapSettings: { enabled: true, idleSeconds: 1 } });
		const driver = await attachController(harness, "idle-recap-diagnostic-client");
		const events: unknown[] = [];
		driver.controller.subscribeIdleRecap?.((event) => events.push(event));
		try {
			expect((await command(harness, driver.handle.transport, "driver_claim", {})).body).toMatchObject({ ok: true });
			domain.emit({ type: "agent_end", timestamp: Date.now(), runId: "run-diagnostic", stopReason: "stop", messageCountAtEnd: 1 });
			await waitForRequests(domain, 1);
			const request = domain.requests[0]!;
			const durableBeforeDiagnostic = harness.store.replaySessionEvents(harness.sessionId);
			const diagnostic: EphemeralTurnDiagnostic = {
				kind: "idle-recap",
				requestId: request.requestId,
				ownerGeneration: request.ownerGeneration,
				activityGeneration: request.activityGeneration,
				code: "router_denied",
			};
			request.onDiagnostic?.(diagnostic);
			domain.resolveNext(undefined);
			await new Promise((resolve) => setTimeout(resolve, 50));

			expect(events).toEqual([expect.objectContaining({
				requestId: request.requestId,
				diagnostic,
			})]);
			expect(events[0]).not.toHaveProperty("text");
			expect(harness.store.replaySessionEvents(harness.sessionId)).toEqual(durableBeforeDiagnostic);
		} finally {
			await closeHarness(harness, [driver.controller], [driver.handle]);
		}
	});
});
