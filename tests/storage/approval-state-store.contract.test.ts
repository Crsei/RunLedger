import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	approvalTicketDigest,
	approvalTicketRequestDigest,
	type ApprovalReceiptRef,
	type ApprovalTicket,
} from "../../src/runtime/protocol/v3/capability.ts";
import { canonicalDigest } from "../../src/runtime/protocol/v3/canonical-json.ts";
import { createRuntimeId } from "../../src/runtime/protocol/v3/ids.ts";
import {
	createApprovalReceipt,
	MemoryApprovalStateStore,
	type ApprovalStateStorePort,
} from "../../src/security/permission/approval-coordinator.ts";
import { FileApprovalStateStore } from "../../src/storage/security-runtime-state.ts";

const CREATED_AT = "2026-07-23T00:00:00.000Z";
const DECIDED_AT = "2026-07-23T00:00:01.000Z";
const EXPIRES_AT = "2026-07-23T00:01:00.000Z";
const REVOKED_AT = "2026-07-23T00:00:02.000Z";

const temporaryRoots: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function ticket(seed: string): ApprovalTicket {
	const authorityId = createRuntimeId("authority", seed);
	const tenantId = createRuntimeId("tenant", seed);
	const principalId = createRuntimeId("principal", seed);
	const approvalId = createRuntimeId("approval", seed);
	return {
		authorityId,
		tenantId,
		principalId,
		approvalId,
		request: {
			authorityId,
			tenantId,
			principalId,
			requestId: createRuntimeId("command", seed),
			approvalId,
			sessionId: createRuntimeId("session", seed),
			runtimeId: createRuntimeId("runtime", seed),
			runtimeGeneration: 1,
			turnId: createRuntimeId("turn", seed),
			toolCallId: createRuntimeId("toolCall", seed),
			capability: "workspace_write",
			argumentsDigest: canonicalDigest({ seed, kind: "arguments" }),
			workspaceEnvelopeDigest: canonicalDigest({ seed, kind: "workspace" }),
			policyDigest: canonicalDigest({ seed, kind: "policy" }),
			serverScope: "tool_server",
			resourceScopeDigest: canonicalDigest({ seed, kind: "resource" }),
			commandScopeDigest: canonicalDigest({ seed, kind: "command" }),
		},
		scope: "once",
		createdAt: CREATED_AT,
		expiresAt: EXPIRES_AT,
	};
}

function initialReceipt(value: ApprovalTicket, decision: "allow-once" | "deny" = "allow-once"): ApprovalReceiptRef {
	return createApprovalReceipt(
		value,
		{ decision, decidedBy: createRuntimeId("principal", `${value.approvalId}-${decision}`) },
		DECIDED_AT,
	);
}

function supersedingReceipt(
	current: ApprovalReceiptRef,
	decision: "revoked" | "expired",
): ApprovalReceiptRef {
	const decidedBy = createRuntimeId("principal", `${current.approvalId}-${decision}-actor`);
	const body: Omit<ApprovalReceiptRef, "receiptDigest"> = decision === "revoked"
		? {
			...current,
			receiptId: createRuntimeId("receipt", `${current.approvalId}-revoked-2`),
			decision,
			decisionRevision: 2,
			decidedBy,
			decidedAt: REVOKED_AT,
			revokedAt: REVOKED_AT,
		}
		: {
			...current,
			receiptId: createRuntimeId("receipt", `${current.approvalId}-expired-2`),
			decision,
			decisionRevision: 2,
			decidedBy,
			decidedAt: EXPIRES_AT,
			expiresAt: EXPIRES_AT,
		};
	delete (body as Partial<ApprovalReceiptRef>).receiptDigest;
	return { ...body, receiptDigest: canonicalDigest(body) };
}

function conflictingInitialReceipt(value: ApprovalTicket): ApprovalReceiptRef {
	const receipt = initialReceipt(value, "deny");
	expect(receipt.requestDigest).toBe(approvalTicketRequestDigest(value));
	expect(receipt.ticketDigest).toBe(approvalTicketDigest(value));
	return receipt;
}

interface StoreHarness {
	store: ApprovalStateStorePort;
	reopen(): Promise<ApprovalStateStorePort>;
}

interface StoreContract {
	name: string;
	create(): Promise<StoreHarness>;
}

const contracts: readonly StoreContract[] = [
	{
		name: "MemoryApprovalStateStore",
		create: async () => {
			const store = new MemoryApprovalStateStore();
			return { store, reopen: async () => store };
		},
	},
	{
		name: "FileApprovalStateStore",
		create: async () => {
			const root = await mkdtemp(join(tmpdir(), "runledger-approval-state-"));
			temporaryRoots.push(root);
			const store = new FileApprovalStateStore(root);
			return { store, reopen: async () => new FileApprovalStateStore(root) };
		},
	},
];

for (const contract of contracts) {
	describe(contract.name, () => {
		it("commits absent -> revision 1 and makes the exact retry idempotent", async () => {
			const { store } = await contract.create();
			const receipt = initialReceipt(ticket(`${contract.name}-create`));

			const created = await store.commit(receipt, 0);
			const retried = await store.commit(structuredClone(receipt), 0);

			expect(created).toEqual({ ok: true, value: receipt });
			expect(retried).toEqual({ ok: true, value: receipt });
		});

		it("rejects a revoked receipt without an allowed predecessor", async () => {
			const { store } = await contract.create();
			const allowed = initialReceipt(ticket(`${contract.name}-initial-revoked`));
			const revoked = supersedingReceipt(allowed, "revoked");
			const body = { ...revoked, decisionRevision: 1 };
			const { receiptDigest: _digest, ...withoutDigest } = body;
			const initialRevoked = { ...withoutDigest, receiptDigest: canonicalDigest(withoutDigest) };

			expect(await store.commit(initialRevoked, 0)).toMatchObject({
				ok: false,
				error: { code: "approval_stale" },
			});
			expect(await store.read(initialRevoked.approvalId)).toBeUndefined();
		});

		it.each(["revoked", "expired"] as const)("commits allowed@1 -> %s@2", async (decision) => {
			const { store } = await contract.create();
			const allowed = initialReceipt(ticket(`${contract.name}-${decision}`));
			const next = supersedingReceipt(allowed, decision);
			expect(await store.commit(allowed, 0)).toMatchObject({ ok: true });

			expect(await store.commit(next, 1)).toEqual({ ok: true, value: next });
			expect(await store.commit(structuredClone(next), 1)).toEqual({ ok: true, value: next });
			expect(await store.read(allowed.approvalId)).toEqual(next);
		});

		it("rejects stale, skipped, and conflicting revisions", async () => {
			const { store } = await contract.create();
			const value = ticket(`${contract.name}-conflicts`);
			const allowed = initialReceipt(value);
			const revoked = supersedingReceipt(allowed, "revoked");
			const skippedBody = { ...revoked, decisionRevision: 3 };
			const { receiptDigest: _discardedDigest, ...skippedWithoutDigest } = skippedBody;
			const skipped = { ...skippedWithoutDigest, receiptDigest: canonicalDigest(skippedWithoutDigest) };
			const driftedBody = {
				...revoked,
				requestDigest: canonicalDigest(`${contract.name}-different-request`),
			};
			const { receiptDigest: _driftedDigest, ...driftedWithoutDigest } = driftedBody;
			const drifted = { ...driftedWithoutDigest, receiptDigest: canonicalDigest(driftedWithoutDigest) };
			expect(await store.commit(allowed, 0)).toMatchObject({ ok: true });

			for (const result of [
				await store.commit(revoked, 0),
				await store.commit(skipped, 1),
				await store.commit(conflictingInitialReceipt(value), 0),
				await store.commit(drifted, 1),
			]) {
				expect(result).toMatchObject({ ok: false, error: { code: "approval_stale", retryable: false } });
			}
			expect(await store.read(value.approvalId)).toEqual(allowed);
		});

		it("allows only one concurrent CAS winner", async () => {
			const { store, reopen } = await contract.create();
			const competingStore = await reopen();
			const value = ticket(`${contract.name}-concurrent`);
			const candidates = [initialReceipt(value), conflictingInitialReceipt(value)];

			const results = await Promise.all([
				store.commit(candidates[0]!, 0),
				competingStore.commit(candidates[1]!, 0),
			]);

			expect(results.filter((result) => result.ok)).toHaveLength(1);
			expect(results.filter((result) => !result.ok)).toHaveLength(1);
			const stored = await store.read(value.approvalId);
			expect(candidates.some((candidate) => candidate.receiptDigest === stored?.receiptDigest)).toBe(true);
		});

		it("allows only one concurrent revoke-or-expire winner", async () => {
			const { store, reopen } = await contract.create();
			const competingStore = await reopen();
			const allowed = initialReceipt(ticket(`${contract.name}-concurrent-transition`));
			expect(await store.commit(allowed, 0)).toMatchObject({ ok: true });
			const revoked = supersedingReceipt(allowed, "revoked");
			const expired = supersedingReceipt(allowed, "expired");

			const results = await Promise.all([
				store.commit(revoked, 1),
				competingStore.commit(expired, 1),
			]);

			expect(results.filter((result) => result.ok)).toHaveLength(1);
			expect(results.filter((result) => !result.ok)).toHaveLength(1);
			const stored = await store.read(allowed.approvalId);
			expect([revoked.receiptDigest, expired.receiptDigest]).toContain(stored?.receiptDigest);
		});

		it("holds the approval identity fence through the guarded operation before committing revocation", async () => {
			const { store, reopen } = await contract.create();
			const competingStore = await reopen();
			const allowed = initialReceipt(ticket(`${contract.name}-linearization-fence`));
			const revoked = supersedingReceipt(allowed, "revoked");
			expect(await store.commit(allowed, 0)).toMatchObject({ ok: true });
			let signalEntered: () => void = () => undefined;
			const entered = new Promise<void>((resolve) => {
				signalEntered = resolve;
			});
			let releaseOperation: () => void = () => undefined;
			const release = new Promise<void>((resolve) => {
				releaseOperation = resolve;
			});
			const guarded = store.withCurrentApproval(allowed, async () => {
				signalEntered();
				await release;
				return "claimed" as const;
			});
			await entered;
			let revocationSettled = false;
			const revocation = competingStore.commit(revoked, allowed.decisionRevision).finally(() => {
				revocationSettled = true;
			});
			await Promise.resolve();

			expect(revocationSettled).toBe(false);
			releaseOperation();
			expect(await guarded).toEqual({ ok: true, value: "claimed" });
			expect(await revocation).toEqual({ ok: true, value: revoked });
			expect(await store.read(allowed.approvalId)).toEqual(revoked);
		});

		it("rejects a stale approval fence without invoking its operation", async () => {
			const { store } = await contract.create();
			const allowed = initialReceipt(ticket(`${contract.name}-stale-fence`));
			const revoked = supersedingReceipt(allowed, "revoked");
			expect(await store.commit(allowed, 0)).toMatchObject({ ok: true });
			expect(await store.commit(revoked, allowed.decisionRevision)).toMatchObject({ ok: true });
			let invoked = false;

			expect(await store.withCurrentApproval(allowed, async () => {
				invoked = true;
			})).toMatchObject({ ok: false, error: { code: "approval_stale" } });
			expect(invoked).toBe(false);
		});

		it("returns defensive clones and preserves state across reopen", async () => {
			const harness = await contract.create();
			const receipt = initialReceipt(ticket(`${contract.name}-clone`));
			const committed = await harness.store.commit(receipt, 0);
			expect(committed.ok).toBe(true);
			if (!committed.ok) return;

			committed.value.decisionRevision = 99;
			receipt.decisionRevision = 98;
			const firstRead = await harness.store.read(receipt.approvalId);
			expect(firstRead?.decisionRevision).toBe(1);
			if (firstRead) firstRead.decisionRevision = 97;

			const reopened = await harness.reopen();
			expect((await reopened.read(receipt.approvalId))?.decisionRevision).toBe(1);
		});
	});
}
