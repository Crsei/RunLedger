import { describe, expect, it } from "vitest";
import { canonicalDigest } from "../../../src/runtime/protocol/v3/canonical-json.ts";
import { createIdempotencyKey } from "../../../src/runtime/protocol/v3/coordination.ts";
import {
	createSessionEventStreamRef,
	type EventCursor,
} from "../../../src/runtime/protocol/v3/events.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/v3/ids.ts";
import { ControlPlaneCommandBus } from "../../../src/runtime/control-plane/command-bus.ts";
import { controlPlaneFailure, type ControlPlaneResult } from "../../../src/runtime/control-plane/errors.ts";
import {
	InMemoryCommandIdempotencyRepository,
	type CommandIdempotencyRepository,
} from "../../../src/runtime/control-plane/idempotency.ts";
import { ShutdownCoordinator } from "../../../src/runtime/control-plane/shutdown.ts";
import type {
	ApprovalResolveCommand,
	ControlPlaneCommand,
	ControlPlaneCommandEffect,
	ControlPlaneRequestContext,
	PromptPreflightReceipt,
	TurnStartCommand,
} from "../../../src/runtime/control-plane/types.ts";

const AUTHORITY_ID = createRuntimeId("authority", "command-bus");
const TENANT_ID = createRuntimeId("tenant", "command-bus");
const PRINCIPAL_ID = createRuntimeId("principal", "command-bus");
const APPROVER_ID = createRuntimeId("principal", "command-bus-approver");
const SESSION_ID = createRuntimeId("session", "command-bus");
const SESSION_STREAM = createSessionEventStreamRef({ authorityId: AUTHORITY_ID, tenantId: TENANT_ID }, SESSION_ID);
const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);
const HEAD: EventCursor = {
	stream: SESSION_STREAM,
	sequence: 4,
	eventId: createRuntimeId("event", "head"),
	eventHash: DIGEST_A,
};

const CONTEXT: ControlPlaneRequestContext = {
	peer: {
		kind: "local",
		transport: "jsonl",
		pid: 10,
		uid: 1000,
		principalId: PRINCIPAL_ID,
		authenticatedVia: "stdio_parent",
	},
	handshake: {
		kind: "handshake_result",
		requestId: "hello",
		protocol: { major: 1, minor: 0 },
		controlPlaneSchemaVersion: 1,
		runtimeSchemaVersion: 3,
		features: ["session", "turn", "approval", "shutdown"],
		serverInstanceId: createRuntimeId("runtime", "daemon"),
		remoteAccess: "disabled",
		deliveryGuarantee: "at_least_once",
	},
};

function promptCommand(seed = "one", text = "perform one bounded prompt"): TurnStartCommand {
	return {
		kind: "command",
		type: "turn:start",
		commandId: createRuntimeId("command", `prompt-${seed}`),
		idempotencyKey: createIdempotencyKey(`prompt-key-${seed.padEnd(16, "0")}`),
		authorityId: AUTHORITY_ID,
		tenantId: TENANT_ID,
		principalId: PRINCIPAL_ID,
		expectedSessionRevision: { stream: SESSION_STREAM, sequence: HEAD.sequence, eventHash: HEAD.eventHash },
		expectedTurnId: null,
		sessionHandle: { handleId: "handle_0123456789abcdef", sessionId: SESSION_ID, generation: 1 },
		payload: {
			sessionId: SESSION_ID,
			prompt: { storage: "bounded_text", text, contentDigest: canonicalDigest({ storage: "bounded_text", text }) },
		},
	};
}

function approvalCommand(): ApprovalResolveCommand {
	const resolutionBody = {
		authorityId: AUTHORITY_ID,
		tenantId: TENANT_ID,
		principalId: PRINCIPAL_ID,
		receiptId: createRuntimeId("receipt", "approval-resolution"),
		approvalId: createRuntimeId("approval", "one"),
		requestId: createRuntimeId("command", "tool-request"),
		requestDigest: DIGEST_B,
		ticketDigest: DIGEST_A,
		decision: "allowed" as const,
		decisionRevision: 3,
		decidedBy: APPROVER_ID,
		decidedAt: "2026-07-22T00:00:00.000Z",
		evidenceComplete: true as const,
		evidenceTruncated: false as const,
		originalInputDigest: DIGEST_B,
	};
	return {
		kind: "command",
		type: "approval:resolve",
		commandId: createRuntimeId("command", "approval-resolve"),
		idempotencyKey: createIdempotencyKey("approval-resolve-key-001"),
		authorityId: AUTHORITY_ID,
		tenantId: TENANT_ID,
		principalId: PRINCIPAL_ID,
		expectedSessionRevision: { stream: SESSION_STREAM, sequence: HEAD.sequence, eventHash: HEAD.eventHash },
		expectedTurnId: null,
		sessionHandle: { handleId: "handle_0123456789abcdef", sessionId: SESSION_ID, generation: 1 },
		payload: {
			sessionId: SESSION_ID,
			approvalId: resolutionBody.approvalId,
			requestId: resolutionBody.requestId,
			ticketDigest: DIGEST_A,
			expectedDecisionRevision: 2,
			resolutionReceipt: { ...resolutionBody, receiptDigest: canonicalDigest(resolutionBody) },
		},
	};
}

function createBus(options: {
	preflight?: (command: TurnStartCommand) => Promise<ControlPlaneResult<PromptPreflightReceipt>>;
	enqueue?: (
		command: TurnStartCommand,
		preflight: PromptPreflightReceipt,
	) => Promise<ControlPlaneResult<Extract<ControlPlaneCommandEffect, { type: "turn:start" }>>>;
	idempotency?: CommandIdempotencyRepository;
	approvalMismatch?: boolean;
	guardFailure?: boolean;
}) {
	let preflightCalls = 0;
	let enqueueCalls = 0;
	let approvalCalls = 0;
	const bus = new ControlPlaneCommandBus({
		idempotency: options.idempotency ?? new InMemoryCommandIdempotencyRepository(),
		shutdown: new ShutdownCoordinator(),
		stateGuard: {
			validate: async () => options.guardFailure
				? controlPlaneFailure("expected_revision_conflict", "stale", true)
				: { ok: true, value: undefined },
		},
		executor: {
			execute: async (_command: ControlPlaneCommand) => controlPlaneFailure("adapter_unavailable", "unused"),
		},
		prompts: {
			preflight: async (command) => {
				preflightCalls += 1;
				if (options.preflight) return options.preflight(command);
				return preflightSuccess(command);
			},
			enqueueDurable: async (command, preflight) => {
				enqueueCalls += 1;
				if (command.type === "turn:start" && options.enqueue) return options.enqueue(command, preflight);
				return {
					ok: true,
					value: {
						type: command.type,
						sessionId: command.payload.sessionId,
						queueItemId: createRuntimeId("queueItem", "durable"),
						durableCursor: HEAD,
						preflightDigest: preflight.preflightDigest,
					},
				};
			},
		},
		approvals: {
			resolve: async (request) => {
				approvalCalls += 1;
				return {
					ok: true,
					value: {
						type: "approval:resolve",
						approvalId: request.approvalId,
						requestId: request.requestId,
						ticketDigest: options.approvalMismatch ? DIGEST_B : request.ticketDigest,
						decisionRevision: request.expectedDecisionRevision + 1,
						receiptDigest: request.resolutionReceipt.receiptDigest,
					},
				};
			},
		},
	});
	return { bus, counts: () => ({ preflightCalls, enqueueCalls, approvalCalls }) };
}

function preflightSuccess(command: TurnStartCommand) {
	const value: PromptPreflightReceipt = {
		commandId: command.commandId,
		promptDigest: command.payload.prompt.contentDigest,
		preflightDigest: DIGEST_B,
		accepted: true,
	};
	return { ok: true as const, value };
}

describe("idempotent command bus", () => {
	it("returns accepted only after preflight and durable enqueue, then deduplicates commandId", async () => {
		const fixture = createBus({});
		const command = promptCommand();
		const first = await fixture.bus.execute(command, CONTEXT);
		const duplicate = await fixture.bus.execute(command, CONTEXT);
		expect(first).toMatchObject({ ok: true, value: { status: "executed", result: { type: "turn:start" } } });
		expect(duplicate).toMatchObject({ ok: true, value: { status: "duplicate" } });
		expect(fixture.counts()).toEqual({ preflightCalls: 1, enqueueCalls: 1, approvalCalls: 0 });
	});

	it("rejects idempotency reuse and never enqueues when preflight/state guard fail", async () => {
		const fixture = createBus({
			preflight: async () => ({
				ok: false as const,
				error: { code: "preflight_rejected" as const, message: "rejected", retryable: false },
				effect: "none" as const,
			}),
		});
		const command = promptCommand("same", "first");
		expect(await fixture.bus.execute(command, CONTEXT)).toMatchObject({ ok: false, error: { code: "preflight_rejected" } });
		expect(fixture.counts().enqueueCalls).toBe(0);

		const guarded = createBus({ guardFailure: true });
		expect(await guarded.bus.execute(promptCommand("guard"), CONTEXT)).toMatchObject({
			ok: false,
			error: { code: "expected_revision_conflict" },
		});
		expect(guarded.counts()).toEqual({ preflightCalls: 0, enqueueCalls: 0, approvalCalls: 0 });

		const normal = createBus({});
		expect((await normal.bus.execute(command, CONTEXT)).ok).toBe(true);
		const changed = promptCommand("same", "changed");
		expect(await normal.bus.execute(changed, CONTEXT)).toMatchObject({ ok: false, error: { code: "idempotency_conflict" } });
	});

	it("forwards approval resolution opaquely and rejects mismatched coordinator correlation", async () => {
		const good = createBus({});
		expect(await good.bus.execute(approvalCommand(), CONTEXT)).toMatchObject({
			ok: true,
			value: { result: { type: "approval:resolve", decisionRevision: 3 } },
		});
		expect(good.counts().approvalCalls).toBe(1);

		const bad = createBus({ approvalMismatch: true });
		expect(await bad.bus.execute(approvalCommand(), CONTEXT)).toMatchObject({
			ok: false,
			error: { code: "adapter_contract_violation" },
		});

		const forged = createBus({});
		const forgedCommand = approvalCommand();
		forgedCommand.payload.resolutionReceipt = {
			...forgedCommand.payload.resolutionReceipt,
			receiptDigest: DIGEST_B,
		};
		expect(await forged.bus.execute(forgedCommand, CONTEXT)).toMatchObject({
			ok: false,
			error: { code: "invalid_request" },
		});
		expect(forged.counts().approvalCalls).toBe(0);
	});

	it("retains an uncertain durable claim, blocks later session mutations, and rejects a changed retry", async () => {
		const idempotency = new InMemoryCommandIdempotencyRepository();
		let signalEnqueueEntered: (() => void) | undefined;
		const enqueueEntered = new Promise<void>((resolve) => { signalEnqueueEntered = resolve; });
		let releaseEnqueue: (() => void) | undefined;
		const enqueueRelease = new Promise<void>((resolve) => { releaseEnqueue = resolve; });
		const fixture = createBus({
			idempotency,
			enqueue: async () => {
				signalEnqueueEntered?.();
				await enqueueRelease;
				return controlPlaneFailure(
					"durable_enqueue_failed",
					"event bytes were written but sync was not confirmed",
					false,
					undefined,
					"uncertain",
				);
			},
		});
		const command = promptCommand("uncertain", "possibly durable");
		const requestDigest = canonicalDigest(command);
		const first = fixture.bus.execute(command, CONTEXT);
		await enqueueEntered;
		const admittedWhileFirstWasRunning = fixture.bus.execute(promptCommand("blocked"), CONTEXT);
		releaseEnqueue?.();

		expect(await first).toMatchObject({
			ok: false,
			error: { code: "durable_enqueue_failed" },
			effect: "uncertain",
		});
		expect(await admittedWhileFirstWasRunning).toMatchObject({
			ok: false,
			error: { code: "recovery_required" },
			effect: "none",
		});
		expect(await idempotency.listInFlight()).toMatchObject({
			ok: true,
			value: [{ commandId: command.commandId, requestDigest }],
		});
		expect(fixture.bus.sessionRecoveryState(SESSION_ID)).toEqual({
			sessionId: SESSION_ID,
			commandId: command.commandId,
			requestDigest,
			phase: "effect",
		});

		expect(await fixture.bus.execute(command, CONTEXT)).toMatchObject({
			ok: false,
			error: { code: "command_in_flight" },
			effect: "uncertain",
		});
		expect(await fixture.bus.execute(promptCommand("uncertain", "different body"), CONTEXT)).toMatchObject({
			ok: false,
			error: { code: "idempotency_conflict" },
		});
		expect(fixture.counts()).toEqual({ preflightCalls: 1, enqueueCalls: 1, approvalCalls: 0 });
	});

	it("reopens the session mutation gate only after an explicit terminal reconciliation", async () => {
		const idempotency = new InMemoryCommandIdempotencyRepository();
		let failFirst = true;
		const fixture = createBus({
			idempotency,
			enqueue: async (command, preflight) => {
				if (failFirst) {
					failFirst = false;
					return controlPlaneFailure(
						"durable_enqueue_failed",
						"injected unknown append outcome",
						false,
						undefined,
						"uncertain",
					);
				}
				return {
					ok: true,
					value: {
						type: "turn:start",
						sessionId: command.payload.sessionId,
						queueItemId: createRuntimeId("queueItem", "after-reconcile"),
						durableCursor: HEAD,
						preflightDigest: preflight.preflightDigest,
					},
				};
			},
		});
		const uncertain = promptCommand("reconcile", "unknown result");
		const requestDigest = canonicalDigest(uncertain);
		expect((await fixture.bus.execute(uncertain, CONTEXT)).ok).toBe(false);

		expect(await fixture.bus.reconcileSession({
			sessionId: SESSION_ID,
			commandId: uncertain.commandId,
			requestDigest: DIGEST_A,
			outcome: "no_effect",
		})).toMatchObject({ ok: false, error: { code: "idempotency_conflict" } });
		expect(fixture.bus.sessionRecoveryState(SESSION_ID)).toBeDefined();

		expect(await fixture.bus.reconcileSession({
			sessionId: SESSION_ID,
			commandId: uncertain.commandId,
			requestDigest,
			outcome: "no_effect",
		})).toEqual({ ok: true, value: undefined });
		expect(fixture.bus.sessionRecoveryState(SESSION_ID)).toBeUndefined();
		expect(await idempotency.listInFlight()).toEqual({ ok: true, value: [] });

		const afterRecovery = await fixture.bus.execute(promptCommand("after-reconcile"), CONTEXT);
		expect(afterRecovery).toMatchObject({ ok: true, value: { status: "executed" } });
	});
});
