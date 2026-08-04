import { describe, expect, it } from "vitest";
import { runtimeDigest } from "../../../../src/runtime/protocol/foundation.ts";
import { createRuntimeId } from "../../../../src/runtime/protocol/ids.ts";
import type { PlanArtifactRef, PlanModeState } from "../../../../src/runtime/modes/plan/types.ts";
import { reducePlanModeState, restorePlanModeState, snapshotPlanModeState, type PlanModeCommand } from "../../../../src/runtime/modes/plan/reducer.ts";
import type { PlanResult } from "../../../../src/runtime/modes/plan/errors.ts";
import { PlanArtifactStore } from "../../../../src/runtime/modes/plan/artifact-store.ts";

const digest = runtimeDigest("plan-mode-red");
const sessionId = createRuntimeId("session", "plan-mode-red");
const goalId = createRuntimeId("goal", "plan-mode-red");
const workspaceId = createRuntimeId("workspace", "plan-mode-red");
const timestamp = "2026-08-04T00:00:00.000Z";

function unwrap<T>(result: PlanResult<T>): T {
	if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
	return result.value;
}

function plan(content: string, revision: number): PlanArtifactRef {
	const digest = runtimeDigest(content);
	return {
		goalId,
		workspaceId: createRuntimeId("workspace", "plan-mode-red"),
		revision,
		digest,
		artifactRef: { subjectKind: "artifact", digest, mediaType: "text/markdown", size: Buffer.byteLength(content, "utf8") },
	};
}

const inactiveState: PlanModeState = {
	status: "inactive",
	sessionId,
	goalId,
	revision: 0,
	policyCeilingDigest: digest,
	sourceHead: { streamId: sessionId, sequence: 0, eventHash: digest },
	projectionDigest: digest,
	completeness: "complete",
	updatedAt: timestamp,
};

describe("Plan Mode behavior", () => {
	it("arms Plan Mode from inactive with the expected state revision", () => {
		const result = reducePlanModeState(inactiveState, {
			type: "request_activation",
			expectedRevision: 0,
			requestedBy: "user",
			updatedAt: timestamp,
		});

		expect(result).toMatchObject({
			ok: true,
			value: { status: "pending", revision: 1 },
		});
	});

	it("stores immutable plan revisions and rejects drift or invalid snapshot restore", () => {
		const store = new PlanArtifactStore();
		const first = store.put({ goalId, workspaceId, content: "# plan v0", expectedRevision: null });
		expect(first).toMatchObject({ ok: true, value: { revision: 0, digest: runtimeDigest("# plan v0") } });
		if (!first.ok) return;

		const second = store.put({ goalId, workspaceId, content: "# plan revision-one", expectedRevision: 0 });
		expect(second).toMatchObject({ ok: true, value: { revision: 1, digest: runtimeDigest("# plan revision-one") } });
		if (!second.ok) return;
		expect(store.read(first.value)).toMatchObject({ ok: true, value: "# plan v0" });
		expect(store.put({ goalId, workspaceId, content: "# stale", expectedRevision: 0 })).toMatchObject({
			ok: false,
			error: { code: "stale_expected_plan_revision", retryable: true },
		});
		expect(store.verify(second.value, "# externally changed")).toMatchObject({ ok: false, error: { code: "artifact_digest_drift" } });

		const snapshot = store.snapshot();
		const restored = new PlanArtifactStore();
		expect(restored.restore(snapshot)).toMatchObject({ ok: true });
		expect(restored.working(goalId, workspaceId)).toMatchObject({ ok: true, value: second.value });

		const corrupted = {
			...snapshot,
			revisions: snapshot.revisions.map((entry, index) => index === 1 ? { ...entry, content: "tampered" } : entry),
		};
		expect(restored.restore(corrupted)).toMatchObject({ ok: false, error: { code: "invalid_snapshot" } });
		expect(restored.working(goalId, workspaceId)).toMatchObject({ ok: true, value: second.value });
	});

	it("reduces a plan revision through approval and safe exit", () => {
		const pending = unwrap(reducePlanModeState(inactiveState, {
			type: "request_activation",
			expectedRevision: 0,
			requestedBy: "user",
			updatedAt: timestamp,
		}));
		const active = unwrap(reducePlanModeState(pending, {
			type: "activate",
			expectedRevision: 1,
			plan: plan("# plan v0", 0),
			updatedAt: timestamp,
		}));
		const revised = unwrap(reducePlanModeState(active, {
			type: "write_plan",
			expectedRevision: 2,
			expectedPlanRevision: 0,
			plan: plan("# plan revision-one", 1),
			updatedAt: timestamp,
		}));
		const awaiting = unwrap(reducePlanModeState(revised, {
			type: "request_approval",
			expectedRevision: 3,
			expectedPlanRevision: 1,
			expectedPlanDigest: revised.plan!.digest,
			updatedAt: timestamp,
		}));

		expect(awaiting.status).toBe("awaiting_approval");
		expect(awaiting.approval).toMatchObject({
			status: "pending",
			revision: 1,
			digest: revised.plan!.digest,
		});

		const approved = unwrap(reducePlanModeState(awaiting, {
			type: "resolve_approval",
			expectedRevision: 4,
			approval: {
				...awaiting.approval!,
				status: "approved",
				receiptRef: { subjectKind: "receipt", digest },
			},
			updatedAt: timestamp,
		}));
		expect(approved).toMatchObject({ status: "exit_pending", approval: { status: "approved" } });

		const inactive = unwrap(reducePlanModeState(approved, {
			type: "settle_exit",
			expectedRevision: 5,
			updatedAt: timestamp,
		}));
		expect(inactive).toMatchObject({ status: "inactive", revision: 6 });
		expect(inactive.plan).toBeUndefined();
		expect(inactive.approval).toBeUndefined();
	});

	it("returns typed failures for stale revisions and illegal transitions", () => {
		const stale = reducePlanModeState(inactiveState, {
			type: "request_activation",
			expectedRevision: 1,
			requestedBy: "user",
			updatedAt: timestamp,
		});
		expect(stale).toMatchObject({ ok: false, error: { code: "stale_expected_revision", retryable: true } });

		const illegal = reducePlanModeState(inactiveState, {
			type: "activate",
			expectedRevision: 0,
			plan: plan("# plan", 0),
			updatedAt: timestamp,
		} as PlanModeCommand);
		expect(illegal).toMatchObject({ ok: false, error: { code: "illegal_transition" } });
	});

	it("does not restore a semantically invalid Plan Mode snapshot", () => {
		const snapshot = snapshotPlanModeState(inactiveState);
		expect(snapshot).toMatchObject({ ok: true, value: inactiveState });
		if (!snapshot.ok) return;
		expect(restorePlanModeState(snapshot.value)).toMatchObject({ ok: true, value: inactiveState });

		const invalid = restorePlanModeState({ ...inactiveState, status: "active" });
		expect(invalid).toMatchObject({ ok: false, error: { code: "invalid_snapshot" } });
	});

	it("invalidates a pending approval when the observed plan digest drifts", () => {
		const pending = unwrap(reducePlanModeState(inactiveState, {
			type: "request_activation",
			expectedRevision: 0,
			requestedBy: "user",
			updatedAt: timestamp,
		}));
		const active = unwrap(reducePlanModeState(pending, {
			type: "activate",
			expectedRevision: 1,
			plan: plan("# plan", 0),
			updatedAt: timestamp,
		}));
		const awaiting = unwrap(reducePlanModeState(active, {
			type: "request_approval",
			expectedRevision: 2,
			expectedPlanRevision: 0,
			expectedPlanDigest: active.plan!.digest,
			updatedAt: timestamp,
		}));
		const mismatchedApproval = reducePlanModeState(awaiting, {
			type: "resolve_approval",
			expectedRevision: 3,
			approval: {
				...awaiting.approval!,
				digest: runtimeDigest("externally changed"),
				status: "approved",
				receiptRef: { subjectKind: "receipt", digest },
			},
			updatedAt: timestamp,
		});
		expect(mismatchedApproval).toMatchObject({ ok: false, error: { code: "approval_mismatch" } });

		const invalidated = unwrap(reducePlanModeState(awaiting, {
			type: "invalidate_approval",
			expectedRevision: 3,
			observedDigest: runtimeDigest("externally changed"),
			updatedAt: timestamp,
		}));
		expect(invalidated).toMatchObject({ status: "active", approval: { status: "invalidated" } });
	});
});
