import { describe, expect, it } from "vitest";
import type { ApprovalReceiptRef, ApprovalTicket } from "../../src/runtime/protocol/v3/capability.ts";
import { canonicalDigest } from "../../src/runtime/protocol/v3/canonical-json.ts";
import { createRuntimeId } from "../../src/runtime/protocol/v3/ids.ts";
import type { ApprovalRequestEventEvidence } from "../../src/runtime/protocol/v3/security-events.ts";
import { PendingApprovalRegistry } from "../../src/security/integration/pending-approval-registry.ts";
import { RuntimeApprovalCoordinatorAdapter } from "../../src/security/integration/runtime-approval-adapter.ts";
import {
	ApprovalCoordinator,
	type ApprovalStateStorePort,
	MemoryApprovalStateStore,
	SYSTEM_APPROVAL_PRINCIPAL_ID,
} from "../../src/security/permission/approval-coordinator.ts";
import type { PermissionPrompt, PermissionPrompter, PermissionPromptResponse } from "../../src/security/types.ts";

const NOW = new Date("2026-07-23T00:00:00.000Z");
const requesterId = createRuntimeId("principal", "runtime-approval-requester");
const fallbackId = createRuntimeId("principal", "runtime-approval-fallback");

function ticket(seed: string): ApprovalTicket {
	const authorityId = createRuntimeId("authority", seed);
	const tenantId = createRuntimeId("tenant", seed);
	const approvalId = createRuntimeId("approval", seed);
	return {
		authorityId,
		tenantId,
		principalId: requesterId,
		approvalId,
		request: {
			authorityId,
			tenantId,
			principalId: requesterId,
			requestId: createRuntimeId("command", seed),
			approvalId,
			sessionId: createRuntimeId("session", seed),
			runtimeId: createRuntimeId("runtime", seed),
			runtimeGeneration: 1,
			turnId: createRuntimeId("turn", seed),
			toolCallId: createRuntimeId("toolCall", seed),
			capability: "workspace_write",
			argumentsDigest: canonicalDigest("arguments"),
			workspaceEnvelopeDigest: canonicalDigest("workspace"),
			policyDigest: canonicalDigest("policy"),
			serverScope: "tool_server",
			resourceScopeDigest: canonicalDigest("resource"),
			commandScopeDigest: canonicalDigest("command"),
		},
		scope: "once",
		createdAt: NOW.toISOString(),
		expiresAt: new Date(NOW.getTime() + 60_000).toISOString(),
	};
}

function prompt(value: ApprovalTicket): PermissionPrompt {
	return {
		requestId: value.request.requestId,
		sessionId: value.request.sessionId,
		toolCallId: value.request.toolCallId,
		toolName: "write",
		summary: "fixture",
		requests: [{ kind: "filesystem", operation: "write", path: "fixture.ts" }],
		argumentsDigest: value.request.argumentsDigest,
		cwd: "/workspace",
		policyDigest: value.request.policyDigest,
		createdAt: value.createdAt,
		expiresAt: value.expiresAt,
	};
}

class RecordingEvents {
	public readonly terminals: ApprovalReceiptRef[] = [];
	public async recordApprovalRequested(_ticket: ApprovalTicket, _evidence: ApprovalRequestEventEvidence): Promise<void> {}
	public async recordApprovalTerminal(_ticket: ApprovalTicket, receipt: ApprovalReceiptRef): Promise<void> {
		this.terminals.push(structuredClone(receipt));
	}
}

interface Deferred {
	promise: Promise<void>;
	resolve(): void;
}

function deferred(): Deferred {
	let resolve = (): void => undefined;
	const promise = new Promise<void>((next) => {
		resolve = next;
	});
	return { promise, resolve };
}

class CallerCancellationBarrierStore implements ApprovalStateStorePort {
	readonly #inner = new MemoryApprovalStateStore();
	readonly #callerId: ApprovalReceiptRef["decidedBy"];
	readonly #entered = deferred();
	readonly #release = deferred();
	#blockCallerCommit = true;
	public readonly commitEntered = this.#entered.promise;

	public constructor(callerId: ApprovalReceiptRef["decidedBy"]) {
		this.#callerId = callerId;
	}

	public read(approvalId: ApprovalTicket["approvalId"]) {
		return this.#inner.read(approvalId);
	}

	public async commit(receipt: ApprovalReceiptRef, expectedRevision: number) {
		if (this.#blockCallerCommit && receipt.decision === "cancelled" && receipt.decidedBy === this.#callerId) {
			this.#blockCallerCommit = false;
			this.#entered.resolve();
			await this.#release.promise;
		}
		return this.#inner.commit(receipt, expectedRevision);
	}

	public withCurrentApproval<T>(receipt: ApprovalReceiptRef, operation: () => Promise<T>) {
		return this.#inner.withCurrentApproval(receipt, operation);
	}

	public releaseCommit(): void {
		this.#release.resolve();
	}
}

function adapterFixture(
	prompter: PermissionPrompter,
	store: ApprovalStateStorePort = new MemoryApprovalStateStore(),
) {
	const registry = new PendingApprovalRegistry();
	const events = new RecordingEvents();
	const coordinator = new ApprovalCoordinator({
		prompter,
		store,
		clock: () => NOW,
		timeoutMs: 5_000,
		fallbackPrincipalId: fallbackId,
	});
	return {
		store,
		registry,
		events,
		adapter: new RuntimeApprovalCoordinatorAdapter({
			coordinator,
			registry,
			events,
		}),
	};
}

describe("RuntimeApprovalCoordinatorAdapter", () => {
	it("performs live revalidation after the prompt resolves", async () => {
		let resolvePrompt: ((response: PermissionPromptResponse) => void) | undefined;
		const fixture = adapterFixture({
			request: async () => new Promise((resolve) => { resolvePrompt = resolve; }),
		});
		const value = ticket("runtime-approval-revalidate");
		let policyDigest = value.request.policyDigest;
		fixture.registry.register({
			ticket: value,
			prompt: prompt(value),
			revalidate: async () => ({ argumentsDigest: value.request.argumentsDigest, cwd: "/workspace", policyDigest }),
		});
		const pending = fixture.adapter.request({
			ticket: value,
			expectedDecisionRevision: 0,
			idempotencyKey: createRuntimeId("command", "runtime-approval-revalidate"),
		});
		await Promise.resolve();
		policyDigest = canonicalDigest("changed-policy");
		resolvePrompt?.({ decision: "allow-once", decidedBy: createRuntimeId("principal", "runtime-approval-approver") });

		const result = await pending;
		expect(result.receipt.decision).toBe("cancelled");
		expect(result.receipt.decidedBy).toBe(SYSTEM_APPROVAL_PRINCIPAL_ID);
		expect(await fixture.store.read(value.approvalId)).toEqual(result.receipt);
		expect(fixture.events.terminals).toEqual([result.receipt]);
	});

	it("persists and journals cancellation before returning an accepted receipt", async () => {
		const fixture = adapterFixture({ request: async () => ({ decision: "allow-once", decidedBy: requesterId }) });
		const value = ticket("runtime-approval-cancel");
		fixture.registry.register({
			ticket: value,
			prompt: prompt(value),
			revalidate: async () => ({ argumentsDigest: value.request.argumentsDigest, cwd: "/workspace", policyDigest: value.request.policyDigest }),
		});

		const cancelled = await fixture.adapter.cancel({
			authorityId: value.authorityId,
			tenantId: value.tenantId,
			principalId: value.principalId,
			requestId: value.request.requestId,
			reasonDigest: canonicalDigest("cancelled by caller"),
		});

		expect(cancelled.status).toBe("accepted");
		const stored = await fixture.store.read(value.approvalId);
		expect(stored).toMatchObject({
			decision: "cancelled",
			principalId: requesterId,
			decidedBy: requesterId,
			receiptId: cancelled.receiptId,
		});
		expect(fixture.events.terminals).toEqual([stored]);
	});

	it("commits caller cancellation before aborting the active prompt", async () => {
		const store = new CallerCancellationBarrierStore(requesterId);
		const promptEntered = deferred();
		let promptAborted = false;
		const fixture = adapterFixture({
			request: async (_value, signal) => {
				promptEntered.resolve();
				return new Promise<PermissionPromptResponse>((_resolve, reject) => {
					const onAbort = (): void => {
						promptAborted = true;
						reject(new Error("prompt aborted"));
					};
					if (signal?.aborted) onAbort();
					else signal?.addEventListener("abort", onAbort, { once: true });
				});
			},
		}, store);
		const value = ticket("runtime-approval-cancel-race");
		fixture.registry.register({
			ticket: value,
			prompt: prompt(value),
			revalidate: async () => ({
				argumentsDigest: value.request.argumentsDigest,
				cwd: "/workspace",
				policyDigest: value.request.policyDigest,
			}),
		});

		const activeRequest = fixture.adapter.request({
			ticket: value,
			expectedDecisionRevision: 0,
			idempotencyKey: createRuntimeId("command", "runtime-approval-cancel-race"),
		});
		const activeOutcome = activeRequest.then(
			(result) => ({ result }),
			(error: unknown) => ({ error }),
		);
		await promptEntered.promise;
		const cancellation = fixture.adapter.cancel({
			authorityId: value.authorityId,
			tenantId: value.tenantId,
			principalId: value.principalId,
			requestId: value.request.requestId,
			reasonDigest: canonicalDigest("caller cancellation wins"),
		});

		await store.commitEntered;
		expect(promptAborted).toBe(false);
		expect(fixture.events.terminals).toEqual([]);
		expect(await store.read(value.approvalId)).toBeUndefined();

		store.releaseCommit();
		const cancelled = await cancellation;
		expect(cancelled.status).toBe("accepted");
		const stored = await store.read(value.approvalId);
		expect(stored).toMatchObject({
			decision: "cancelled",
			decidedBy: value.principalId,
			receiptId: cancelled.receiptId,
		});
		expect(promptAborted).toBe(true);
		expect(fixture.events.terminals).toEqual([stored]);

		const outcome = await activeOutcome;
		expect(outcome).toHaveProperty("error");
		if (!("error" in outcome) || !(outcome.error instanceof Error)) {
			throw new TypeError("active approval request unexpectedly resolved");
		}
		expect(outcome.error.message).toMatch(/stale/u);
		expect(await store.read(value.approvalId)).toEqual(stored);
		expect(fixture.events.terminals).toEqual([stored]);
	});

	it("does not cancel a pending ticket from another authorization scope", async () => {
		const fixture = adapterFixture({ request: async () => ({ decision: "allow-once", decidedBy: requesterId }) });
		const value = ticket("runtime-approval-cross-scope");
		fixture.registry.register({
			ticket: value,
			prompt: prompt(value),
			revalidate: async () => ({ argumentsDigest: value.request.argumentsDigest, cwd: "/workspace", policyDigest: value.request.policyDigest }),
		});

		expect(await fixture.adapter.cancel({
			authorityId: value.authorityId,
			tenantId: value.tenantId,
			principalId: createRuntimeId("principal", "runtime-approval-attacker"),
			requestId: value.request.requestId,
			reasonDigest: canonicalDigest("cross scope"),
		})).toMatchObject({ status: "not_found" });
		expect(await fixture.store.read(value.approvalId)).toBeUndefined();
		expect(fixture.registry.read(value)).toBeDefined();
	});

	it("rejects a coordinator request that lacks the durable pending record", async () => {
		const fixture = adapterFixture({ request: async () => ({ decision: "allow-once", decidedBy: requesterId }) });
		const value = ticket("runtime-approval-missing");
		await expect(fixture.adapter.request({
			ticket: value,
			expectedDecisionRevision: 0,
			idempotencyKey: createRuntimeId("command", "runtime-approval-missing"),
		})).rejects.toThrow(/durable pending/u);
		expect(await fixture.store.read(value.approvalId)).toBeUndefined();
		expect(fixture.events.terminals).toEqual([]);
	});
});
