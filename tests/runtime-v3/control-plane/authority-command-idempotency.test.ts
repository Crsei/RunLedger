import { describe, expect, it, vi } from "vitest";
import { createLocalIdentityContext } from "../../../src/runtime/identity/local-principal.ts";
import { canonicalDigest } from "../../../src/runtime/protocol/v3/canonical-json.ts";
import {
	AGENT_CONTROL_PLANE_COMMAND_TYPES,
	CONTROL_PLANE_COMMAND_TYPES,
	createIdempotencyKey,
	type AgentControlPlaneCommandType,
	type ControlPlaneCommandType,
} from "../../../src/runtime/protocol/v3/coordination.ts";
import {
	createAuthorityTenantEventStreamRef,
	createSessionEventStreamRef,
	type EventCursor,
} from "../../../src/runtime/protocol/v3/events.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/v3/ids.ts";
import {
	AuthorityCommandIdempotencyRepository,
} from "../../../src/runtime/control-plane/authority-command-idempotency.ts";
import type { ControlPlaneErrorShape } from "../../../src/runtime/control-plane/errors.ts";
import type {
	CommandClaimContext,
	CommandClaimRequest,
	CommandClaimToken,
} from "../../../src/runtime/control-plane/idempotency.ts";
import type { ControlPlaneCommandEffect } from "../../../src/runtime/control-plane/types.ts";
import type { ControlPlaneAgentMutationEffectV2 } from "../../../src/runtime/control-plane/multi-agent-contracts.ts";
import { AuthorityLifecycleRepository } from "../../../src/runtime/session/authority-lifecycle-repository.ts";
import { EventWriter } from "../../../src/runtime/session/event-writer.ts";
import { MemoryEventStore } from "../../../src/runtime/session/memory-event-store.ts";
import type { SessionResult, WriterFence } from "../../../src/runtime/session/types.ts";

const NOW = new Date("2026-07-22T13:00:00.000Z");

function sessionValue<T>(result: SessionResult<T>): T {
	if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
	return result.value;
}

async function fixture(seed: string) {
	const identity = createLocalIdentityContext(NOW);
	const stream = createAuthorityTenantEventStreamRef(identity);
	const fence: WriterFence = {
		authorityId: identity.authorityId,
		tenantId: identity.tenantId,
		stream,
		leaseId: createRuntimeId("lease", `${seed}-authority-command`),
		ownerRuntimeId: createRuntimeId("runtime", `${seed}-writer`),
		writerEpoch: 1,
		fencingToken: `authority-command-${seed}-fencing-token`,
	};
	const store = new MemoryEventStore({
		authorityId: identity.authorityId,
		tenantId: identity.tenantId,
		stream,
		validateFence: (candidate) => candidate.fencingToken === fence.fencingToken,
		clock: () => NOW,
	});
	const writer = new EventWriter({
		authorityId: identity.authorityId,
		tenantId: identity.tenantId,
		stream,
		store,
		fence,
		clock: () => NOW,
	});
	const authority = sessionValue(await AuthorityLifecycleRepository.open({
		authorityId: identity.authorityId,
		tenantId: identity.tenantId,
		store,
		writer,
	}));
	const sessionId = createRuntimeId("session", `${seed}-session`);
	const sessionStream = createSessionEventStreamRef(identity, sessionId);
	return { identity, authority, store, sessionId, sessionStream };
}

function request(seed: string, overrides: Partial<CommandClaimRequest> = {}): CommandClaimRequest {
	return {
		commandId: createRuntimeId("command", `${seed}-command`),
		idempotencyKey: createIdempotencyKey(`${seed}-idempotency-key`),
		commandType: "turn:start",
		requestDigest: canonicalDigest({ request: seed }),
		...overrides,
	};
}

function context(
	test: Awaited<ReturnType<typeof fixture>>,
	seed: string,
	overrides: Partial<CommandClaimContext> = {},
): CommandClaimContext {
	return {
		authorityId: test.identity.authorityId,
		tenantId: test.identity.tenantId,
		principalId: test.identity.principalId,
		runtimeId: createRuntimeId("runtime", `${seed}-runtime`),
		runtimeGeneration: 1,
		domain: "session",
		subjectSessionId: test.sessionId,
		domainExpectedRevision: {
			stream: test.sessionStream,
			sequence: 0,
			eventHash: canonicalDigest({ session: seed, sequence: 0 }),
		},
		traceId: createRuntimeId("trace", `${seed}-trace`),
		...overrides,
	};
}

function domainCursor(test: Awaited<ReturnType<typeof fixture>>, seed: string, sequence = 1): EventCursor {
	return {
		stream: test.sessionStream,
		sequence,
		eventId: createRuntimeId("event", `${seed}-domain-event`),
		eventHash: canonicalDigest({ domain: seed, sequence }),
	};
}

function contextForCommand(
	test: Awaited<ReturnType<typeof fixture>>,
	commandType: ControlPlaneCommandType,
	seed: string,
): CommandClaimContext {
	return commandType === "shutdown"
		? context(test, seed, { domain: "lifecycle", subjectSessionId: null, domainExpectedRevision: null })
		: context(test, seed);
}

function effect(
	test: Awaited<ReturnType<typeof fixture>>,
	seed: string,
): Extract<ControlPlaneCommandEffect, { type: "turn:start" }> {
	return {
		type: "turn:start",
		sessionId: test.sessionId,
		queueItemId: createRuntimeId("queueItem", `${seed}-queue-item`),
		durableCursor: domainCursor(test, seed),
		preflightDigest: canonicalDigest({ preflight: seed }),
	};
}

function agentEffect(
	test: Awaited<ReturnType<typeof fixture>>,
	commandType: AgentControlPlaneCommandType,
	seed: string,
): ControlPlaneAgentMutationEffectV2 {
	const body = {
		type: commandType,
		sessionId: test.sessionId,
		agent: {
			agentId: createRuntimeId("agent", `${seed}-child`),
			parentAgentId: createRuntimeId("agent", `${seed}-root`),
			sessionId: createRuntimeId("session", `${seed}-child`),
			role: "build" as const,
			state: commandType === "agent:cancel" ? "stopped" as const : "running" as const,
			residency: commandType === "agent:cancel" ? "nonresident" as const : "resident" as const,
			artifactCount: commandType === "agent:handoff" ? 1 : 0,
		},
		graphRevision: 4,
		durableCursor: domainCursor(test, seed),
	};
	return { ...body, receiptDigest: canonicalDigest(body) };
}

function effectFor(
	test: Awaited<ReturnType<typeof fixture>>,
	commandType: ControlPlaneCommandType,
	seed: string,
): ControlPlaneCommandEffect {
	const cursor = domainCursor(test, seed);
	const digest = canonicalDigest({ commandType, seed });
	const handle = {
		handleId: `handle_${seed.padEnd(16, "x")}`,
		sessionId: test.sessionId,
		generation: 1,
	};
	switch (commandType) {
		case "session:start":
			return { type: commandType, bootstrap: { sessionId: test.sessionId, handle, head: cursor, recovery: "new" } };
		case "session:resume":
			return { type: commandType, bootstrap: { sessionId: test.sessionId, handle, head: cursor, recovery: "resumed" } };
		case "session:fork":
			return { type: commandType, bootstrap: { sessionId: test.sessionId, handle, head: cursor, recovery: "forked" } };
		case "session:stop":
			return { type: commandType, sessionId: test.sessionId, terminalCursor: cursor };
		case "turn:start":
		case "turn:steer":
		case "turn:followUp":
			return {
				type: commandType,
				sessionId: test.sessionId,
				queueItemId: createRuntimeId("queueItem", `${seed}-queue-item`),
				durableCursor: cursor,
				preflightDigest: digest,
			};
		case "turn:interrupt":
			return { type: commandType, sessionId: test.sessionId, status: "accepted", durableCursor: cursor };
		case "queue:cancel":
			return {
				type: commandType,
				sessionId: test.sessionId,
				previousQueueRevision: canonicalDigest({ queue: seed, revision: 0 }),
				queueRevision: canonicalDigest({ queue: seed, revision: 1 }),
				receipts: [{
					queueItemId: createRuntimeId("queueItem", `${seed}-cancelled`),
					sourceCommandId: createRuntimeId("command", `${seed}-source`),
					kind: "steer",
					contentDigest: digest,
					durableCursor: cursor,
				}],
			};
		case "approval:resolve":
			return {
				type: commandType,
				approvalId: createRuntimeId("approval", seed),
				requestId: createRuntimeId("command", `${seed}-approval-request`),
				ticketDigest: canonicalDigest({ ticket: seed }),
				decisionRevision: 1,
				receiptDigest: digest,
			};
		case "changeProposal:requestDraftPr":
			return {
				type: commandType,
				receipt: {
					schemaVersion: 1,
					authorityId: test.identity.authorityId,
					tenantId: test.identity.tenantId,
					receiptId: createRuntimeId("receipt", `${seed}-draft-pr`),
					requestId: createRuntimeId("command", `${seed}-draft-pr`),
					providerId: "fixture-provider",
					proposalId: createRuntimeId("changeProposal", seed),
					proposalDigest: canonicalDigest({ proposal: seed }),
					sealId: createRuntimeId("episodeSeal", seed),
					sealDigest: canonicalDigest({ seal: seed }),
					repositoryId: createRuntimeId("repository", seed),
					candidateCommit: "0123456789abcdef",
					draft: true,
					externalReferenceDigest: canonicalDigest({ external: seed }),
					providerRevision: 1,
					createdAt: NOW.toISOString(),
					receiptDigest: digest,
				},
			};
		case "humanGate:resolve":
			return {
				type: commandType,
				decision: {
					schemaVersion: 1,
					authorityId: test.identity.authorityId,
					tenantId: test.identity.tenantId,
					humanGateId: createRuntimeId("humanGate", seed),
					requestId: createRuntimeId("command", `${seed}-human-gate`),
					proposalId: createRuntimeId("changeProposal", seed),
					proposalDigest: canonicalDigest({ proposal: seed }),
					action: "merge",
					decision: "approved",
					decisionAuthority: "human",
					decidedBy: test.identity.principalId,
					receiptId: createRuntimeId("receipt", `${seed}-human-gate`),
					decisionReasonDigest: canonicalDigest({ reason: seed }),
					decidedAt: NOW.toISOString(),
					receiptDigest: digest,
				},
			};
		case "shutdown":
			return {
				type: commandType,
				acceptedAt: NOW.toISOString(),
				drainDeadline: new Date(NOW.getTime() + 30_000).toISOString(),
			};
	}
}

function claimed(value: Awaited<ReturnType<AuthorityCommandIdempotencyRepository["claim"]>>): CommandClaimToken {
	if (!value.ok || value.value.status !== "claimed") throw new Error("expected a fresh canonical claim");
	return value.value.claim;
}

async function eventTypes(store: MemoryEventStore): Promise<readonly string[]> {
	const page = await store.readPage(store.streamRef(), { limit: 100 });
	if (!page.ok) throw new Error(page.error.message);
	return page.value.events.map((event) => event.type);
}

describe("AuthorityCommandIdempotencyRepository", () => {
	it("durably claims before returning and rebuilds in-flight state after restart", async () => {
		const test = await fixture("claim-restart");
		const flush = vi.spyOn(test.store, "flushThrough");
		const repository = new AuthorityCommandIdempotencyRepository(test.authority, { clock: () => NOW });
		const input = request("claim-restart");
		const first = claimed(await repository.claim(input, context(test, "claim-restart")));

		expect(first.claimToken).toMatch(/^event_/);
		expect(first.claimedAt).toBe(NOW.toISOString());
		expect(flush).toHaveBeenCalledTimes(1);
		expect(await eventTypes(test.store)).toEqual(["command.claimed"]);

		const restarted = new AuthorityCommandIdempotencyRepository(test.authority, { clock: () => NOW });
		expect(await restarted.listInFlight()).toEqual({ ok: true, value: [first] });
		expect(await restarted.lookup(input, context(test, "claim-restart", {
			runtimeId: createRuntimeId("runtime", "replacement-runtime"),
			runtimeGeneration: 2,
			traceId: createRuntimeId("trace", "after-restart-trace"),
		}))).toEqual({ ok: true, value: { status: "in_flight", claim: first } });
	});

	it("fails closed on either commandId or idempotency-key reuse without another append", async () => {
		const test = await fixture("conflict");
		const repository = new AuthorityCommandIdempotencyRepository(test.authority, { clock: () => NOW });
		const original = request("conflict");
		claimed(await repository.claim(original, context(test, "conflict")));
		const sameCommand = request("other-key", { commandId: original.commandId });
		const sameKey = request("other-command", { idempotencyKey: original.idempotencyKey });

		expect(await repository.lookup(sameCommand)).toEqual({ ok: true, value: { status: "conflict" } });
		expect(await repository.claim(sameKey, context(test, "other-command"))).toEqual({
			ok: true,
			value: { status: "conflict" },
		});
		expect(await repository.lookup(original, context(test, "wrong-principal", {
			principalId: createRuntimeId("principal", "different-principal"),
		}))).toEqual({ ok: true, value: { status: "conflict" } });
		expect(await eventTypes(test.store)).toEqual(["command.claimed"]);
	});

	it("commits a canonical cursor and restores duplicate output only through verified evidence", async () => {
		const test = await fixture("commit");
		const flush = vi.spyOn(test.store, "flushThrough");
		const repository = new AuthorityCommandIdempotencyRepository(test.authority, { clock: () => NOW });
		const input = request("commit");
		const token = claimed(await repository.claim(input, context(test, "commit")));
		const result = effect(test, "commit");

		expect(await repository.commit(token, result)).toMatchObject({
			ok: true,
			value: { result, appliedCursor: result.durableCursor },
		});
		expect(await repository.lookup(input)).toMatchObject({
			ok: true,
			value: { status: "duplicate", receipt: { result } },
		});
		expect(flush).toHaveBeenCalledTimes(2);
		expect(await eventTypes(test.store)).toEqual(["command.claimed", "command.applied"]);

		const unresolved = new AuthorityCommandIdempotencyRepository(test.authority, { clock: () => NOW });
		expect(await unresolved.lookup(input)).toMatchObject({
			ok: true,
			value: { status: "duplicate", receipt: { result } },
		});

		const restarted = new AuthorityCommandIdempotencyRepository(test.authority, {
			clock: () => NOW,
			resolveAppliedEffect: ({ command }) => command.claim.commandId === input.commandId ? result : null,
		});
		expect(await restarted.lookup(input)).toMatchObject({
			ok: true,
			value: { status: "duplicate", receipt: { result, appliedCursor: result.durableCursor } },
		});
		expect(await restarted.listInFlight()).toEqual({ ok: true, value: [] });

		const forged = new AuthorityCommandIdempotencyRepository(test.authority, {
			resolveAppliedEffect: () => ({ ...result, preflightDigest: "f".repeat(64) }),
		});
		expect(await forged.lookup(input)).toMatchObject({
			ok: true,
			value: { status: "duplicate", receipt: { result } },
		});
	});

	it("persists reconciliation and rejection terminals across repository restart", async () => {
		const test = await fixture("terminals");
		const flush = vi.spyOn(test.store, "flushThrough");
		const repository = new AuthorityCommandIdempotencyRepository(test.authority, { clock: () => NOW });
		const uncertainRequest = request("uncertain");
		const uncertainClaim = claimed(await repository.claim(uncertainRequest, context(test, "uncertain")));
		const reasonDigest = canonicalDigest({ reason: "effect-outcome-unknown" });
		expect(await repository.markReconciliationRequired(uncertainClaim, reasonDigest)).toEqual({
			ok: true,
			value: undefined,
		});

		const restarted = new AuthorityCommandIdempotencyRepository(test.authority, { clock: () => NOW });
		expect(await restarted.listInFlight()).toEqual({ ok: true, value: [uncertainClaim] });
		expect(await restarted.markReconciliationRequired(uncertainClaim, reasonDigest)).toEqual({
			ok: true,
			value: undefined,
		});
		expect(await restarted.commit(uncertainClaim, effect(test, "uncertain"))).toMatchObject({ ok: true });

		const rejectedRequest = request("rejected");
		const rejectedClaim = claimed(await repository.claim(rejectedRequest, context(test, "rejected")));
		const rejection: ControlPlaneErrorShape = {
			code: "preflight_rejected",
			message: "policy denied the command before mutation",
			retryable: false,
			details: { policyRevision: 7 },
		};
		expect(await repository.reject(rejectedClaim, rejection)).toMatchObject({
			ok: true,
			value: { error: rejection },
		});

		const rejectionRestart = new AuthorityCommandIdempotencyRepository(test.authority, {
			resolveRejectedError: () => ({ ...rejection, message: "forged cache value" }),
		});
		expect(await rejectionRestart.lookup(rejectedRequest)).toMatchObject({
			ok: true,
			value: { status: "rejected", receipt: { error: rejection } },
		});
		expect(await eventTypes(test.store)).toEqual([
			"command.claimed",
			"command.reconciliation_required",
			"command.applied",
			"command.claimed",
			"command.rejected",
		]);
		expect(flush).toHaveBeenCalledTimes(5);
	});

	it.each(CONTROL_PLANE_COMMAND_TYPES)(
		"restores the exact %s result from canonical terminal events after restart",
		async (commandType) => {
			const seed = `restart-${commandType.replaceAll(":", "-")}`;
			const test = await fixture(seed);
			const appliedCursor = domainCursor(test, `${seed}-resolved`);
			const repository = new AuthorityCommandIdempotencyRepository(test.authority, {
				clock: () => NOW,
				resolveAppliedCursor: () => appliedCursor,
			});
			const input = request(seed, { commandType });
			const claimContext = contextForCommand(test, commandType, seed);
			const token = claimed(await repository.claim(input, claimContext));
			const result = effectFor(test, commandType, seed);
			expect(await repository.commit(token, result)).toMatchObject({ ok: true, value: { result } });

			const restarted = new AuthorityCommandIdempotencyRepository(test.authority, { clock: () => NOW });
			expect(await restarted.lookup(input, claimContext)).toMatchObject({
				ok: true,
				value: { status: "duplicate", receipt: { result } },
			});
		},
	);

	it.each(AGENT_CONTROL_PLANE_COMMAND_TYPES)(
		"restores the exact schema v2 %s result from canonical terminal events after restart",
		async (commandType) => {
			const seed = `agent-restart-${commandType.replaceAll(":", "-")}`;
			const test = await fixture(seed);
			const repository = new AuthorityCommandIdempotencyRepository(test.authority, {
				clock: () => NOW,
			});
			const input = request(seed, { commandType });
			const claimContext = context(test, seed);
			const token = claimed(await repository.claim(input, claimContext));
			const result = agentEffect(test, commandType, seed);
			expect(await repository.commit(token, result)).toMatchObject({
				ok: true,
				value: { result },
			});

			const restarted = new AuthorityCommandIdempotencyRepository(
				test.authority,
				{ clock: () => NOW },
			);
			expect(await restarted.lookup(input, claimContext)).toMatchObject({
				ok: true,
				value: { status: "duplicate", receipt: { result } },
			});
		},
	);

	it.each(CONTROL_PLANE_COMMAND_TYPES)(
		"restores the exact %s rejection from canonical terminal events after restart",
		async (commandType) => {
			const seed = `reject-${commandType.replaceAll(":", "-")}`;
			const test = await fixture(seed);
			const repository = new AuthorityCommandIdempotencyRepository(test.authority, { clock: () => NOW });
			const input = request(seed, { commandType });
			const claimContext = contextForCommand(test, commandType, seed);
			const token = claimed(await repository.claim(input, claimContext));
			const error: ControlPlaneErrorShape = {
				code: "preflight_rejected",
				message: `policy rejected ${commandType}`,
				retryable: false,
				details: { policyRevision: 3 },
			};
			expect(await repository.reject(token, error)).toMatchObject({ ok: true, value: { error } });

			const restarted = new AuthorityCommandIdempotencyRepository(test.authority, { clock: () => NOW });
			expect(await restarted.lookup(input, claimContext)).toMatchObject({
				ok: true,
				value: { status: "rejected", receipt: { error } },
			});
		},
	);

	it.each(CONTROL_PLANE_COMMAND_TYPES)(
		"replays and reconciles an uncertain %s claim after restart",
		async (commandType) => {
			const seed = `reconcile-${commandType.replaceAll(":", "-")}`;
			const test = await fixture(seed);
			const initial = new AuthorityCommandIdempotencyRepository(test.authority, { clock: () => NOW });
			const input = request(seed, { commandType });
			const claimContext = contextForCommand(test, commandType, seed);
			const token = claimed(await initial.claim(input, claimContext));
			const reconciliationDigest = canonicalDigest({ uncertain: commandType });
			expect(await initial.markReconciliationRequired(token, reconciliationDigest)).toEqual({
				ok: true,
				value: undefined,
			});

			const reconciler = new AuthorityCommandIdempotencyRepository(test.authority, {
				clock: () => NOW,
				resolveAppliedCursor: () => domainCursor(test, `${seed}-resolved`),
			});
			expect(await reconciler.lookup(input, claimContext)).toMatchObject({
				ok: true,
				value: { status: "in_flight", claim: token },
			});
			const result = effectFor(test, commandType, seed);
			expect(await reconciler.commit(token, result)).toMatchObject({ ok: true, value: { result } });
			const restarted = new AuthorityCommandIdempotencyRepository(test.authority, { clock: () => NOW });
			expect(await restarted.lookup(input, claimContext)).toMatchObject({
				ok: true,
				value: { status: "duplicate", receipt: { result } },
			});
		},
	);

	it.each(CONTROL_PLANE_COMMAND_TYPES)(
		"rejects duplicate %s command ids whose canonical request digest changed",
		async (commandType) => {
			const seed = `digest-${commandType.replaceAll(":", "-")}`;
			const test = await fixture(seed);
			const repository = new AuthorityCommandIdempotencyRepository(test.authority, { clock: () => NOW });
			const input = request(seed, { commandType });
			const claimContext = contextForCommand(test, commandType, seed);
			claimed(await repository.claim(input, claimContext));
			expect(await repository.lookup({
				...input,
				requestDigest: canonicalDigest({ changed: seed }),
			}, claimContext)).toEqual({ ok: true, value: { status: "conflict" } });
		},
	);

	it("does not report a claim when its mandatory flush receipt fails", async () => {
		const test = await fixture("flush-failure");
		vi.spyOn(test.store, "flushThrough").mockResolvedValueOnce({
			ok: false,
			error: {
				code: "durable_write_failed",
				message: "injected canonical command flush failure",
				retryable: false,
				effect: "uncertain",
			},
		});
		const repository = new AuthorityCommandIdempotencyRepository(test.authority, { clock: () => NOW });
		expect(await repository.claim(request("flush-failure"), context(test, "flush-failure"))).toMatchObject({
			ok: false,
			error: { code: "recovery_required" },
			effect: "uncertain",
		});
	});
});
