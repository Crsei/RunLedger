import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	DirectoryV3SessionLocator,
	V3SessionRuntimeFactoryAdapter,
} from "../../../src/daemon/v3-session-adapters.ts";
import type { RuntimeIdentityContext } from "../../../src/runtime/identity/types.ts";
import {
	createApprovedPlanForkSeed,
} from "../../../src/runtime/modes/plan/implementation-handoff.ts";
import type {
	ApprovedPlanForkSeed,
	ApprovedPlanRef,
} from "../../../src/runtime/modes/plan/types.ts";
import {
	DurableControlJournal,
	type ControlJournalRecord,
} from "../../../src/runtime/orchestrator/control-journal.ts";
import { SessionDurableOrchestratorJournal } from "../../../src/runtime/orchestrator/session-journal.ts";
import type {
	ApprovalReceiptRef,
	ArtifactRef,
} from "../../../src/runtime/protocol/v3/capability.ts";
import { canonicalDigest } from "../../../src/runtime/protocol/v3/canonical-json.ts";
import {
	createSessionEventStreamRef,
	type EventCursor,
} from "../../../src/runtime/protocol/v3/events.ts";
import {
	createRuntimeId,
	type AuthorityId,
	type SessionId,
	type TenantId,
} from "../../../src/runtime/protocol/v3/ids.ts";
import {
	DEFAULT_RUNTIME_FEATURES,
	type RuntimeFeatureFlags,
} from "../../../src/runtime/runtime-features.ts";
import { readAllRuntimeEvents } from "../../../src/runtime/session/snapshot.ts";
import { V3SessionManager } from "../../../src/storage/v3-session-manager.ts";

const AUTHORITY_ID = createRuntimeId("authority", "approved-plan-fork");
const TENANT_ID = createRuntimeId("tenant", "approved-plan-fork");
const PRINCIPAL_ID = createRuntimeId("principal", "approved-plan-fork");
const WORKSPACE_ID = createRuntimeId("workspace", "approved-plan-fork");
const NOW = "2026-07-24T00:00:00.000Z";
const FEATURES: RuntimeFeatureFlags = { ...DEFAULT_RUNTIME_FEATURES, sessionV3: true };
const IDENTITY: RuntimeIdentityContext = {
	authorityId: AUTHORITY_ID,
	tenantId: TENANT_ID,
	principalId: PRINCIPAL_ID,
	source: "managed",
	issuedAt: NOW,
};
const roots: string[] = [];

function scopedArtifact(
	authorityId: AuthorityId,
	tenantId: TenantId,
	content: string,
): ArtifactRef {
	const storedDigest = canonicalDigest(content);
	return {
		authorityId,
		tenantId,
		artifactId: createRuntimeId("artifact", `approved-plan-${storedDigest.slice(0, 24)}`),
		storedDigest,
		kind: "change_proposal",
		originalSize: content.length,
		storedSize: content.length,
		mediaType: "text/markdown",
		redaction: "metadata_only",
		transformReceipt: createRuntimeId("receipt", `approved-plan-${storedDigest.slice(0, 24)}`),
		workspaceId: WORKSPACE_ID,
	};
}

function scopedApproval(
	authorityId: AuthorityId,
	tenantId: TenantId,
): ApprovalReceiptRef {
	const body: Omit<ApprovalReceiptRef, "receiptDigest"> = {
		authorityId,
		tenantId,
		principalId: PRINCIPAL_ID,
		receiptId: createRuntimeId("receipt", "approved-plan-fork-approval"),
		approvalId: createRuntimeId("approval", "approved-plan-fork"),
		requestId: createRuntimeId("command", "approved-plan-fork-request"),
		requestDigest: canonicalDigest("approved-plan-fork-request"),
		ticketDigest: canonicalDigest("approved-plan-fork-ticket"),
		decision: "allowed",
		decisionRevision: 1,
		decidedBy: PRINCIPAL_ID,
		decidedAt: NOW,
		evidenceComplete: true,
		evidenceTruncated: false,
		originalInputDigest: canonicalDigest("approved-plan-fork-original-input"),
	};
	return { ...body, receiptDigest: canonicalDigest(body) };
}

function approvedPlan(
	authorityId: AuthorityId = AUTHORITY_ID,
	tenantId: TenantId = TENANT_ID,
): ApprovedPlanRef {
	const artifact = scopedArtifact(authorityId, tenantId, "Implement the approved production plan.");
	return {
		schemaVersion: 1,
		authorityId,
		tenantId,
		planId: createRuntimeId("plan", "approved-plan-v3-fork"),
		workspaceId: WORKSPACE_ID,
		revision: 4,
		contentDigest: artifact.storedDigest,
		artifact,
		approvalReceipt: scopedApproval(authorityId, tenantId),
	};
}

function cursor(manager: V3SessionManager): EventCursor {
	const head = manager.writer().currentHead();
	if (!head) throw new Error("fixture parent has no durable cursor");
	return head;
}

function factory(root: string): V3SessionRuntimeFactoryAdapter {
	const sessionDir = join(root, "sessions");
	return new V3SessionRuntimeFactoryAdapter({
		cwd: root,
		sessionDir,
		features: FEATURES,
		identity: IDENTITY,
		locator: new DirectoryV3SessionLocator({ cwd: root, sessionDir }),
	});
}

async function parentFixture(root: string): Promise<{
	factory: V3SessionRuntimeFactoryAdapter;
	parent: V3SessionManager;
}> {
	const sessions = factory(root);
	const started = await sessions.start();
	if (!started.ok) throw new Error(started.error.message);
	const parent = sessions.activeRuntime(started.value.sessionId)?.manager();
	if (!parent) throw new Error("fixture parent runtime is missing");
	await parent.sessionEvents().recordMessage({
		role: "user",
		content: [{ type: "text", text: "raw parent conversation must stay behind" }],
	});
	const parentSessionId = parent.sessionId();
	await teardown(sessions, parentSessionId);
	const resumed = await sessions.resume(parentSessionId);
	if (!resumed.ok) throw new Error(resumed.error.message);
	const stableParent = sessions.activeRuntime(parentSessionId)?.manager();
	if (!stableParent) throw new Error("fixture resumed parent runtime is missing");
	return { factory: sessions, parent: stableParent };
}

function seedFor(parent: V3SessionManager): ApprovedPlanForkSeed {
	return createApprovedPlanForkSeed({
		parentCursor: cursor(parent),
		approvedPlan: approvedPlan(),
		invariantArtifacts: [scopedArtifact(AUTHORITY_ID, TENANT_ID, "explicit invariant")],
		policySnapshotDigest: canonicalDigest("approved-plan-fork-policy"),
	});
}

async function teardown(
	sessions: V3SessionRuntimeFactoryAdapter,
	sessionId: SessionId,
): Promise<void> {
	const runtime = sessions.activeRuntime(sessionId);
	if (runtime) {
		const closed = await runtime.teardown("shutdown");
		if (!closed.ok) throw new Error(closed.error.message);
	}
}

afterEach(async () => {
	vi.restoreAllMocks();
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("production approved-plan-only V3 fork", () => {
	it("keeps generic history copy while publishing an approved-plan child with no parent conversation tail", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-approved-plan-fork-"));
		roots.push(root);
		const fixture = await parentFixture(root);
		const parentCursor = cursor(fixture.parent);

		const generic = await fixture.factory.fork(
			fixture.parent.sessionId(),
			parentCursor,
			"continue_existing_goal",
		);
		if (!generic.ok) throw new Error(generic.error.message);
		const genericChild = fixture.factory.activeRuntime(generic.value.sessionId)?.manager();
		expect(await genericChild?.replayMessages()).toEqual([{
			role: "user",
			content: [{ type: "text", text: "raw parent conversation must stay behind" }],
		}]);

		const seed = seedFor(fixture.parent);
		const approved = await fixture.factory.forkApprovedPlan(seed);
		if (!approved.ok) throw new Error(JSON.stringify(approved));
		const childRuntime = fixture.factory.activeRuntime(approved.value.sessionId);
		const child = childRuntime?.manager();
		if (!child || !childRuntime) throw new Error("approved-plan child runtime is missing");
		expect(await child.replayMessages()).toEqual([]);
		const childEvents = await readAllRuntimeEvents(child.eventStore());
		if (!childEvents.ok) throw new Error(childEvents.error.message);
		expect(childEvents.value.map((event) => event.type)).toEqual([
			"session.forked",
			"orchestrator.journal_committed",
		]);
		expect(childEvents.value.some((event) => JSON.stringify(event).includes(
			"raw parent conversation must stay behind",
		))).toBe(false);
		const childPath = child.filePath();
		const childIdentity = child.identity();
		await teardown(fixture.factory, approved.value.sessionId);

		const reopened = await V3SessionManager.open(childPath, FEATURES, childIdentity);
		const recovered = await new DurableControlJournal({
			journal: new SessionDurableOrchestratorJournal<ControlJournalRecord>({
				journalKind: "control",
				writer: reopened.writer(),
				store: reopened.eventStore(),
				principalId: PRINCIPAL_ID,
			}),
		}).snapshot();
		expect(recovered.ok && recovered.value.approvedPlanForkSeeds).toEqual([
			expect.objectContaining({
				kind: "control.approved_plan_fork_seed",
				seed,
			}),
		]);
		expect(await reopened.replayMessages()).toEqual([]);
		await reopened.closeAll();
		await teardown(fixture.factory, generic.value.sessionId);
		await teardown(fixture.factory, fixture.parent.sessionId());
	});

	it("rejects a tampered seed, foreign authority scope, and stale cursor before creating a child", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-approved-plan-reject-"));
		roots.push(root);
		const fixture = await parentFixture(root);
		const valid = seedFor(fixture.parent);
		const create = vi.spyOn(V3SessionManager, "create");

		await expect(fixture.factory.forkApprovedPlan({
			...valid,
			seedDigest: "0".repeat(64),
		})).resolves.toMatchObject({ ok: false, error: { code: "invalid_request" } });

		const foreignAuthority = createRuntimeId("authority", "foreign-approved-plan");
		const foreignTenant = createRuntimeId("tenant", "foreign-approved-plan");
		const foreignSeed = createApprovedPlanForkSeed({
			parentCursor: {
				...valid.parentCursor,
				stream: createSessionEventStreamRef(
					{ authorityId: foreignAuthority, tenantId: foreignTenant },
					fixture.parent.sessionId(),
				),
			},
			approvedPlan: approvedPlan(foreignAuthority, foreignTenant),
			invariantArtifacts: [scopedArtifact(foreignAuthority, foreignTenant, "foreign invariant")],
			policySnapshotDigest: canonicalDigest("foreign policy"),
		});
		await expect(fixture.factory.forkApprovedPlan(foreignSeed)).resolves.toMatchObject({
			ok: false,
			error: { code: "unauthorized_peer" },
		});

		const staleSeed = createApprovedPlanForkSeed({
			parentCursor: { ...valid.parentCursor, eventHash: "f".repeat(64) },
			approvedPlan: valid.approvedPlan,
			invariantArtifacts: valid.invariantArtifacts,
			policySnapshotDigest: valid.policySnapshotDigest,
		});
		await expect(fixture.factory.forkApprovedPlan(staleSeed)).resolves.toMatchObject({
			ok: false,
			error: { code: "cursor_mismatch" },
		});
		expect(create).not.toHaveBeenCalled();
		await teardown(fixture.factory, fixture.parent.sessionId());
	});

	it.each(["genesis", "seed", "publish"] as const)(
		"removes an unpublished child when the %s boundary fails",
		async (phase) => {
			const root = await mkdtemp(join(tmpdir(), `runledger-approved-plan-${phase}-`));
			roots.push(root);
			const fixture = await parentFixture(root);
			const realCreate = V3SessionManager.create.bind(V3SessionManager);
			let child: V3SessionManager | undefined;
			vi.spyOn(V3SessionManager, "create").mockImplementation(async (...args) => {
				child = await realCreate(...args);
				if (phase === "publish") {
					vi.spyOn(child, "publishStagedTarget").mockRejectedValueOnce(
						new Error("injected approved-plan publish failure"),
					);
				} else {
					const writer = child.writer();
					const append = writer.append.bind(writer);
					vi.spyOn(writer, "append").mockImplementation(async (draft) => {
						if (
							phase === "genesis" ||
							(phase === "seed" && draft.type === "orchestrator.journal_committed")
						) {
							return {
								ok: false,
								error: {
									code: "durable_write_failed",
									message: `injected approved-plan ${phase} failure`,
									retryable: false,
									effect: "none",
								},
							};
						}
						return append(draft);
					});
				}
				return child;
			});

			const result = await fixture.factory.forkApprovedPlan(seedFor(fixture.parent));
			expect(result.ok).toBe(false);
			expect(child?.isClosed()).toBe(true);
			if (!child) throw new Error("fault fixture did not create a child");
			await expect(access(child.filePath())).rejects.toThrow();
			expect(fixture.factory.activeRuntime(child.sessionId())).toBeUndefined();
			await teardown(fixture.factory, fixture.parent.sessionId());
		},
	);
});
